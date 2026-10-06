import { z } from 'zod'
import type {
  AggregateOpenAIUsage,
  ChannelCheckResponse,
  ContentReviewSummary,
  OpenAIStageUsage,
  OpenAIUsage,
  RuleId,
  ScanStorageMode,
  TranscriptUnavailableReason,
  VideoContentReview,
  VideoMetadata,
  VideoScanResult,
} from '../../shared/types/check'
import { ANALYSIS_PROFILES, RULE_IDS, SCAN_STORAGE_MODES, SELECTABLE_RULE_IDS } from '../../shared/types/check'
import type { AnalysisProfile, ClassifiedContentEvent, ContentEvent, RejectedContentCandidate } from '../../shared/types/content'
import { buildDetections, buildLegacyViolations, buildRuleSummary } from '../domain/analyze-transcript'
import { normalizeRequestedCategories, ruleMatchesClassification } from '../domain/content-categories'
import { applyContentPolicy } from '../domain/content-policy'
import { normalizeClassifiedEvents } from '../domain/content-normalization'
import { validateClassifiedEvents } from '../domain/content-validation'
import {
  buildChannelCategoryReports,
  buildPresentationScenes,
  buildVideoCategoryReports,
  buildVideoContentSummary,
} from '../domain/content-reporting'
import { captionLanguageResolution, captionSource } from '../domain/caption-language'
import { normalizeTranscript } from '../domain/normalize-transcript'
import { analyzeSpeechQuality, summarizeSpeechQuality } from '../domain/speech-quality'
import {
  OPENAI_COVERAGE_PROMPT_VERSION,
  OPENAI_COVERAGE_SCHEMA_VERSION,
  OPENAI_PROMPT_VERSION,
  OPENAI_REVIEW_PROMPT_VERSION,
  OPENAI_REVIEW_SCHEMA_VERSION,
  OPENAI_SCHEMA_VERSION,
  OpenAIAnalysisError,
  OpenAIAnalysisProvider,
  type OpenAICoverageResult,
  type OpenAIReviewResult,
} from '../services/openai-analysis'
import { BatchedOpenAIAnalyzer, estimateTextTokens } from '../services/openai-batched-analyzer'
import { BatchedOpenAIReviewer } from '../services/openai-batched-reviewer'
import { ScanStorage } from '../services/scan-storage'
import {
  TranscriptApiClient,
  TranscriptApiError,
  type TranscriptApiExchange,
} from '../services/transcript-api'
import { createScanLogger } from '../utils/logger'
import { mapWithConcurrency } from '../utils/concurrency'
import { ProviderScheduler, optionalPositiveIntegerEnv, type ProviderSchedulerTiming } from '../utils/provider-scheduler'
import { positiveIntegerEnv, Semaphore } from '../utils/semaphore'

const languageSchema = z.string().trim().max(100).default('').refine((value) => {
  if (!value) return true
  const codes = value.split(',').map((code) => code.trim())
  return codes.length <= 10
    && codes.every((code) => /^(?:asr(?:-[a-z0-9_-]+)?|[a-z0-9_-]+)$/i.test(code))
}, 'Language must be a comma-separated list of up to 10 language codes.')

const checkRequestSchema = z.object({
  channelUrl: z.string().trim().min(1).max(500),
  videoLimit: z.number().int().min(1).max(10).default(10),
  language: languageSchema,
  ruleIds: z.array(z.enum(RULE_IDS)).min(1).default([...SELECTABLE_RULE_IDS]),
  storageMode: z.enum(SCAN_STORAGE_MODES).default('minimal'),
  profile: z.enum(ANALYSIS_PROFILES).default('normal'),
})

function transcriptReason(error: unknown): TranscriptUnavailableReason {
  return error instanceof TranscriptApiError ? error.reason : 'provider_error'
}

function runtimeBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === '1'
}

function mergeMetadata(video: VideoMetadata, info: {
  matchedLanguage?: string
  metadata?: { title?: string; thumbnailUrl?: string }
}): VideoMetadata {
  return {
    ...video,
    title: info.metadata?.title ?? video.title,
    thumbnailUrl: info.metadata?.thumbnailUrl ?? video.thumbnailUrl,
    preflightCaptionLanguage: info.matchedLanguage,
    expectedCaptionLanguage: info.matchedLanguage,
  }
}

function providerLogFields(exchange: TranscriptApiExchange): Record<string, unknown> {
  return {
    operation: exchange.operation,
    status: exchange.response?.status ?? null,
    statusText: exchange.response?.statusText ?? null,
    latencyMs: exchange.response?.latencyMs ?? null,
    chargedCredits: exchange.chargedCredits,
    networkError: exchange.networkError?.name ?? null,
  }
}

function addUsage(total: AggregateOpenAIUsage, usage: VideoScanResult['openaiUsage']): void {
  if (!usage) return
  total.inputTokens += usage.inputTokens
  total.outputTokens += usage.outputTokens
  total.reasoningTokens += usage.reasoningTokens
  total.cachedTokens += usage.cachedTokens
  total.cacheWriteTokens += usage.cacheWriteTokens
  total.totalTokens += usage.totalTokens
}

function aggregateUsage(): AggregateOpenAIUsage {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  }
}

function combinedUsage(...items: Array<OpenAIUsage | undefined>): OpenAIUsage {
  const total = aggregateUsage()
  for (const item of items) addUsage(total, item)
  const { requests: _requests, ...usage } = total
  return usage
}

function unreviewedEvents(events: ClassifiedContentEvent[]): ClassifiedContentEvent[] {
  return events.map((event) => ({ ...event, review: undefined }))
}

interface TimingInterval {
  startMs: number
  endMs: number
}

async function timed<T>(intervals: TimingInterval[], task: () => Promise<T>): Promise<T> {
  const startMs = performance.now()
  try {
    return await task()
  } finally {
    intervals.push({ startMs, endMs: performance.now() })
  }
}

function wallDurationMs(intervals: TimingInterval[]): number {
  if (intervals.length === 0) return 0
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs)
  let start = sorted[0]!.startMs
  let end = sorted[0]!.endMs
  let total = 0

  for (const interval of sorted.slice(1)) {
    if (interval.startMs <= end) {
      end = Math.max(end, interval.endMs)
      continue
    }
    total += Math.max(0, end - start)
    start = interval.startMs
    end = interval.endMs
  }
  total += Math.max(0, end - start)
  return Math.round(total)
}

const scanVideoConcurrency = positiveIntegerEnv('SCAN_VIDEO_CONCURRENCY', 10)
const openAIRequestScheduler = new ProviderScheduler({
  concurrency: positiveIntegerEnv('OPENAI_GLOBAL_CONCURRENCY', 5),
  requestsPerMinute: optionalPositiveIntegerEnv('OPENAI_RPM_BUDGET'),
  tokensPerMinute: optionalPositiveIntegerEnv('OPENAI_TPM_BUDGET'),
  maxRetries: optionalPositiveIntegerEnv('OPENAI_RATE_LIMIT_RETRIES') ?? 2,
})
const transcriptRequestLimiter = new Semaphore(positiveIntegerEnv('TRANSCRIPT_GLOBAL_CONCURRENCY', 10))

export default defineEventHandler(async (event): Promise<ChannelCheckResponse> => {
  const scanStartedAt = Date.now()
  const parsed = checkRequestSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: parsed.error.issues.map((issue) => issue.message).join('; '),
    })
  }
  const request = parsed.data

  const config = useRuntimeConfig(event)
  const openaiApiKey = process.env.OPENAI_API_KEY || config.openaiApiKey
  const openaiModel = process.env.OPENAI_MODEL || config.openaiModel
  const openaiReviewModel = process.env.OPENAI_REVIEW_MODEL || config.openaiReviewModel || openaiModel
  const openaiReasoningEffort = process.env.OPENAI_REASONING_EFFORT || config.openaiReasoningEffort
  if (!config.transcriptApiKey) {
    throw createError({ statusCode: 503, statusMessage: 'Server is missing NUXT_TRANSCRIPT_API_KEY.' })
  }
  if (!openaiApiKey) {
    throw createError({ statusCode: 503, statusMessage: 'Server is missing OPENAI_API_KEY.' })
  }
  if (openaiReasoningEffort !== 'low') {
    throw createError({ statusCode: 503, statusMessage: 'OPENAI_REASONING_EFFORT must be low.' })
  }

  const storageMode = request.storageMode as ScanStorageMode
  let storage: ScanStorage
  try {
    storage = new ScanStorage(
      storageMode,
      config.scanStorageDir,
      runtimeBoolean(config.allowDiagnosticStorage),
    )
  } catch (error) {
    throw createError({
      statusCode: 403,
      statusMessage: error instanceof Error ? error.message : 'Storage mode is not allowed.',
    })
  }

  const logger = createScanLogger(storage.scanId, config.logLevel)
  const transcriptIntervals: TimingInterval[] = []
  const detectionIntervals: TimingInterval[] = []
  const reviewIntervals: TimingInterval[] = []
  const coverageIntervals: TimingInterval[] = []
  let openaiSchedulerWaitMs = 0
  let openaiProviderMs = 0
  const recordSchedulerTiming = (timing: ProviderSchedulerTiming) => {
    openaiSchedulerWaitMs += timing.waitMs
    openaiProviderMs += timing.providerMs
  }

  const transcriptProvider = new TranscriptApiClient(
    config.transcriptApiKey,
    config.transcriptApiBaseUrl,
    async (exchange) => {
      storage.recordProvider(exchange)
      const transcriptStartedAt = Date.parse(exchange.request.startedAt)
      const transcriptReceivedAt = exchange.response?.receivedAt
        ? Date.parse(exchange.response.receivedAt)
        : Number.NaN
      if (Number.isFinite(transcriptStartedAt) && Number.isFinite(transcriptReceivedAt)) {
        transcriptIntervals.push({ startMs: transcriptStartedAt, endMs: transcriptReceivedAt })
      }
      logger.debug('transcriptapi.exchange', providerLogFields(exchange))
    },
    {
      traceObserver: (traceEvent) => {
        const { providerMessage: _providerMessage, ...safeFields } = traceEvent as
          typeof traceEvent & { providerMessage?: string }
        logger.debug(traceEvent.event, safeFields)
      },
    },
  )
  const batchingEnabled = process.env.OPENAI_BATCHING_ENABLED !== 'false'
  const detectorProvider = new OpenAIAnalysisProvider(openaiApiKey, openaiModel)
  const batchedAnalyzer = new BatchedOpenAIAnalyzer(detectorProvider, openAIRequestScheduler, {
    chunkMaxEstimatedTokens: positiveIntegerEnv('OPENAI_DETECTOR_CHUNK_MAX_ESTIMATED_TOKENS', 30_000),
    batchMaxEstimatedTokens: positiveIntegerEnv('OPENAI_DETECTOR_BATCH_MAX_ESTIMATED_TOKENS', 70_000),
    batchMaxItems: positiveIntegerEnv('OPENAI_DETECTOR_BATCH_MAX_ITEMS', 5),
    chunkOverlapMs: positiveIntegerEnv('OPENAI_DETECTOR_CHUNK_OVERLAP_MS', 90_000),
    coalesceMs: positiveIntegerEnv('OPENAI_DETECTOR_COALESCE_MS', 100),
    batchConcurrency: positiveIntegerEnv('OPENAI_SCAN_BATCH_CONCURRENCY', 2),
    onSchedulerTiming: recordSchedulerTiming,
  })
  const analyzer = batchingEnabled ? batchedAnalyzer : detectorProvider
  const reviewerProvider = new OpenAIAnalysisProvider(openaiApiKey, openaiReviewModel)
  const batchedReviewer = new BatchedOpenAIReviewer(reviewerProvider, openAIRequestScheduler, {
    batchMaxEstimatedTokens: positiveIntegerEnv('OPENAI_REVIEW_BATCH_MAX_ESTIMATED_TOKENS', 70_000),
    batchMaxItems: positiveIntegerEnv('OPENAI_REVIEW_BATCH_MAX_ITEMS', 4),
    batchMaxCandidates: positiveIntegerEnv('OPENAI_REVIEW_BATCH_MAX_CANDIDATES', 24),
    batchMaxScenes: positiveIntegerEnv('OPENAI_REVIEW_BATCH_MAX_SCENES', 8),
    coalesceMs: positiveIntegerEnv('OPENAI_REVIEW_COALESCE_MS', 100),
    batchConcurrency: positiveIntegerEnv('OPENAI_SCAN_REVIEW_BATCH_CONCURRENCY', 2),
    onSchedulerTiming: recordSchedulerTiming,
  })
  const reviewer = batchingEnabled ? batchedReviewer : reviewerProvider
  const languagePriority = request.language
  const targetVideos = request.videoLimit
  const enabledRuleIds = request.ruleIds as RuleId[]
  const enabledCategories = normalizeRequestedCategories(enabledRuleIds)
  const profile = request.profile as AnalysisProfile
  const diagnosticAnalysis = profile === 'diagnostic'

  logger.info('scan.started', {
    storageMode,
    targetVideos,
    requestedLanguage: languagePriority || 'auto',
    enabledRules: enabledRuleIds,
    enabledCategories,
    profile,
    analysisProvider: 'openai',
    model: openaiModel,
    reviewModel: openaiReviewModel,
    reasoningEffort: 'low',
    batchingEnabled,
  })

  let latest: Awaited<ReturnType<TranscriptApiClient['getLatestVideos']>>
  try {
    latest = await transcriptRequestLimiter.run(() => transcriptProvider.getLatestVideos(request.channelUrl))
  } catch (error) {
    logger.error('channel.latest.failed', { reason: transcriptReason(error) })
    throw createError({ statusCode: 502, statusMessage: 'Could not load this YouTube channel.' })
  }

  const inspectedIds = new Set<string>()
  const eligibleVideos: VideoMetadata[] = []
  async function inspectVideos(
    videos: VideoMetadata[],
    source: 'latest' | 'fallback',
    desiredEligible = Number.POSITIVE_INFINITY,
  ): Promise<void> {
    const pending = videos.filter((video) => !inspectedIds.has(video.id))
    const concurrency = Math.min(scanVideoConcurrency, 10)

    for (let offset = 0; offset < pending.length && eligibleVideos.length < desiredEligible; offset += concurrency) {
      const batch = pending.slice(offset, offset + concurrency)
      const inspected = await mapWithConcurrency(batch, concurrency, async (video) => {
        inspectedIds.add(video.id)
        try {
          const info = await transcriptRequestLimiter.run(() => transcriptProvider.getVideoInfo(video.id, languagePriority))
          logger.debug('video.preflight.completed', {
            videoId: video.id,
            source,
            captionAvailable: info.available,
            matchedLanguage: info.matchedLanguage ?? null,
          })
          return info.available ? mergeMetadata(video, info) : null
        } catch (error) {
          logger.warn('video.preflight.failed', { videoId: video.id, reason: transcriptReason(error) })
          throw error
        }
      })
      eligibleVideos.push(...inspected.filter((video): video is VideoMetadata => Boolean(video)))
    }
  }

  try {
    await inspectVideos(latest.videos, 'latest', targetVideos + 2)
  } catch (error) {
    logger.error('channel.preflight.failed', { reason: transcriptReason(error) })
    throw createError({ statusCode: 502, statusMessage: 'Could not inspect video captions from TranscriptAPI.' })
  }
  let usedChannelVideosFallback = false
  async function loadFallbackVideos(requiredCandidateCount: number): Promise<void> {
    // Inspect any remaining free latest-video candidates before buying a fallback page.
    await inspectVideos(latest.videos, 'latest', requiredCandidateCount)
    if (eligibleVideos.length >= requiredCandidateCount || usedChannelVideosFallback) return

    usedChannelVideosFallback = true
    try {
      const page = await transcriptRequestLimiter.run(() => transcriptProvider.getChannelVideos(request.channelUrl))
      await inspectVideos(page.videos, 'fallback', Math.max(requiredCandidateCount, targetVideos + 2))
    } catch (error) {
      logger.warn('channel.fallback.failed', { reason: transcriptReason(error) })
    }
  }

  if (eligibleVideos.length < targetVideos) {
    await loadFallbackVideos(targetVideos)
  }

  const videoResults: VideoScanResult[] = []
  const contentEventsByVideo = new Map<string, ContentEvent[]>()
  const rejectedCandidatesByVideo = new Map<string, RejectedContentCandidate[]>()
  const openaiUsage = aggregateUsage()
  const openaiStages: OpenAIStageUsage = {
    detection: aggregateUsage(),
    review: aggregateUsage(),
  }
  let reviewFallbackRequests = 0
  let coverageRequests = 0
  let reviewDisabledAfterFailure = false
  let transcriptAttempts = 0
  let successfulAnalyses = 0
  let candidateIndex = 0
  let stoppedForOpenAIProviderError = false
  let stoppedForTranscriptProviderError = false
  let transcriptCreditBudgetExhausted = false
  const transcriptCreditBudget = targetVideos

  async function processVideo(video: VideoMetadata): Promise<void> {
    transcriptAttempts += 1
    const url = `https://www.youtube.com/watch?v=${video.id}`
    let transcript
    try {
      transcript = await transcriptRequestLimiter.run(() => transcriptProvider.getTranscript(video.id, languagePriority))
    } catch (error) {
      const unavailableReason = transcriptReason(error)
      videoResults.push({
        ...video,
        url,
        status: 'transcript_unavailable',
        unavailableReason,
        violations: [],
        detections: [],
      })

      // A confirmed 404/not_available response costs 0 credits and is specific to this
      // video, so trying the next candidate is safe. Other failures are systemic or
      // ambiguous; stop instead of risking repeated requests or hidden billing.
      if (unavailableReason === 'not_available') return
      stoppedForTranscriptProviderError = true
      return
    }

    let normalized: ReturnType<typeof normalizeTranscript> | undefined
    try {
      const normalizedTranscript = normalizeTranscript(transcript.segments)
      normalized = normalizedTranscript
      if (!normalizedTranscript.text.trim()) throw new OpenAIAnalysisError('schema', 'Transcript has no speech to analyze.')
      const resolvedLanguage = transcript.language ?? languagePriority
      const speechQuality = analyzeSpeechQuality(normalized, resolvedLanguage)
      const analysis = await timed(detectionIntervals, () => analyzer.analyze(
        normalizedTranscript,
        resolvedLanguage,
        enabledCategories,
        diagnosticAnalysis,
      ))
      openaiUsage.requests += analysis.requestCount
      openaiStages.detection.requests += analysis.requestCount
      addUsage(openaiUsage, analysis.usage)
      addUsage(openaiStages.detection, analysis.usage)

      const firstPassEvents = analysis.classifiedEvents.filter((classifiedEvent) =>
        enabledRuleIds.some((ruleId) => ruleMatchesClassification(ruleId, classifiedEvent)),
      )
      let reviewedEvents = firstPassEvents
      let reviewResult: OpenAIReviewResult | undefined
      let reviewError: OpenAIAnalysisError | undefined
      let coverageResult: OpenAICoverageResult | undefined
      let coverageError: OpenAIAnalysisError | undefined
      let contentReview: VideoContentReview

      if (firstPassEvents.length === 0) {
        contentReview = {
          status: 'not_needed',
          candidateCount: 0,
          reviewedCount: 0,
          rejectedCount: 0,
          uncertainCount: 0,
        }
      } else if (reviewDisabledAfterFailure) {
        reviewedEvents = unreviewedEvents(firstPassEvents)
        contentReview = {
          status: 'skipped_after_failure',
          candidateCount: firstPassEvents.length,
          reviewedCount: 0,
          rejectedCount: 0,
          uncertainCount: 0,
          model: openaiReviewModel,
          promptVersion: OPENAI_REVIEW_PROMPT_VERSION,
          schemaVersion: OPENAI_REVIEW_SCHEMA_VERSION,
          error: {
            type: 'provider',
            message: 'Contextual review was skipped after an earlier reviewer failure in this scan.',
          },
        }
      } else {
        try {
          reviewResult = await timed(reviewIntervals, () => reviewer.review(
            normalizedTranscript,
            resolvedLanguage,
            enabledCategories,
            firstPassEvents,
          ))
          openaiUsage.requests += reviewResult.requestCount
          openaiStages.review.requests += reviewResult.requestCount
          reviewFallbackRequests += reviewResult.fallbackRequestCount ?? 0
          addUsage(openaiUsage, reviewResult.usage)
          addUsage(openaiStages.review, reviewResult.usage)
          reviewedEvents = reviewResult.reviewedEvents.filter((classifiedEvent) =>
            enabledRuleIds.some((ruleId) => ruleMatchesClassification(ruleId, classifiedEvent)),
          )
          const reviewIsPartial = !reviewResult.complete || reviewResult.uncertainCandidates > 0
          contentReview = {
            status: reviewIsPartial ? 'partial' : 'completed',
            candidateCount: reviewResult.totalCandidates,
            reviewedCount: reviewResult.reviewedCandidates,
            rejectedCount: reviewResult.rejectedCandidates,
            uncertainCount: reviewResult.uncertainCandidates,
            rescuedCount: reviewResult.rescuedCandidates,
            rescueRejectedCount: reviewResult.rescueRejectedCandidates,
            reviewRequestCount: reviewResult.requestCount,
            reviewFallbackRequestCount: reviewResult.fallbackRequestCount ?? 0,
            retryCount: reviewResult.retryCount,
            missingBeforeRetry: reviewResult.missingBeforeRetry,
            missingAfterRetry: reviewResult.missingAfterRetry,
            model: reviewResult.requestMetadata.model,
            promptVersion: reviewResult.requestMetadata.promptVersion,
            schemaVersion: reviewResult.requestMetadata.schemaVersion,
            latencyMs: reviewResult.provider.latencyMs,
          }
          logger.debug('content.review_completed', {
            videoId: video.id,
            status: contentReview.status,
            candidates: contentReview.candidateCount,
            reviewed: contentReview.reviewedCount,
            rejected: contentReview.rejectedCount,
            uncertain: contentReview.uncertainCount,
            rescued: contentReview.rescuedCount ?? 0,
            rescueRejected: contentReview.rescueRejectedCount ?? 0,
            reviewRequestCount: contentReview.reviewRequestCount ?? 0,
            reviewFallbackRequestCount: contentReview.reviewFallbackRequestCount ?? 0,
            retryCount: contentReview.retryCount ?? 0,
            missingBeforeRetry: contentReview.missingBeforeRetry ?? 0,
            missingAfterRetry: contentReview.missingAfterRetry ?? 0,
            latencyMs: contentReview.latencyMs,
          })
        } catch (error) {
          reviewError = error instanceof OpenAIAnalysisError
            ? error
            : new OpenAIAnalysisError('provider', 'OpenAI contextual review failed.')
          openaiUsage.requests += reviewError.requestCount ?? 0
          openaiStages.review.requests += reviewError.requestCount ?? 0
          addUsage(openaiUsage, reviewError.usage)
          addUsage(openaiStages.review, reviewError.usage)
          // A transient per-video rate limit/timeout must not disable review for
          // the rest of a concurrent scan. Only an authentication failure is
          // systemic enough to stop scheduling more review requests.
          reviewDisabledAfterFailure = reviewError.type === 'authentication'
          reviewedEvents = unreviewedEvents(firstPassEvents)
          contentReview = {
            status: 'failed',
            candidateCount: firstPassEvents.length,
            reviewedCount: 0,
            rejectedCount: 0,
            uncertainCount: 0,
            model: openaiReviewModel,
            promptVersion: OPENAI_REVIEW_PROMPT_VERSION,
            schemaVersion: OPENAI_REVIEW_SCHEMA_VERSION,
            latencyMs: reviewError.provider?.latencyMs,
            error: {
              type: reviewError.type,
              message: 'Contextual review failed; first-pass findings were retained.',
            },
          }
          logger.warn('content.review_failed', {
            videoId: video.id,
            type: reviewError.type,
            status: reviewError.status ?? null,
            code: reviewError.code ?? null,
          })
        }
      }

      if (diagnosticAnalysis && !reviewDisabledAfterFailure && !reviewError) {
        let scheduledCoverageAttempts = 0
        try {
          coverageResult = await timed(coverageIntervals, () => openAIRequestScheduler.run(
            16_000 + estimateTextTokens(normalizedTranscript.text),
            async () => {
              scheduledCoverageAttempts += 1
              return reviewerProvider.coverage(
                normalizedTranscript,
                resolvedLanguage,
                enabledCategories,
                reviewedEvents,
              )
            },
            recordSchedulerTiming,
          ))
          openaiUsage.requests += scheduledCoverageAttempts
          openaiStages.review.requests += scheduledCoverageAttempts
          coverageRequests += scheduledCoverageAttempts
          addUsage(openaiUsage, coverageResult.usage)
          addUsage(openaiStages.review, coverageResult.usage)
          reviewedEvents = [...reviewedEvents, ...coverageResult.rescuedEvents]
            .filter((classifiedEvent) =>
              enabledRuleIds.some((ruleId) => ruleMatchesClassification(ruleId, classifiedEvent)),
            )

          contentReview = {
            ...contentReview,
            status: contentReview.status === 'not_needed' && coverageResult.rescuedCandidates > 0
              ? 'completed'
              : contentReview.status,
            rescuedCount: coverageResult.rescuedCandidates,
            rescueRejectedCount: coverageResult.rejectedCandidates,
            reviewRequestCount: (contentReview.reviewRequestCount ?? 0) + coverageResult.requestCount,
            coverageRequestCount: coverageResult.requestCount,
            coveragePromptVersion: coverageResult.requestMetadata.promptVersion,
            coverageSchemaVersion: coverageResult.requestMetadata.schemaVersion,
            model: contentReview.model ?? coverageResult.requestMetadata.model,
          }
          logger.debug('content.coverage_completed', {
            videoId: video.id,
            rescued: coverageResult.rescuedCandidates,
            rejected: coverageResult.rejectedCandidates,
            requestCount: coverageResult.requestCount,
            latencyMs: coverageResult.provider.latencyMs,
          })
        } catch (error) {
          openaiUsage.requests += scheduledCoverageAttempts
          openaiStages.review.requests += scheduledCoverageAttempts
          coverageRequests += scheduledCoverageAttempts
          coverageError = error instanceof OpenAIAnalysisError
            ? error
            : new OpenAIAnalysisError('provider', 'OpenAI high-priority coverage failed.')
          addUsage(openaiUsage, coverageError.usage)
          addUsage(openaiStages.review, coverageError.usage)
          contentReview = {
            ...contentReview,
            status: contentReview.status === 'failed' || contentReview.status === 'skipped_after_failure'
              ? contentReview.status
              : 'partial',
            coverageRequestCount: 1,
            coveragePromptVersion: OPENAI_COVERAGE_PROMPT_VERSION,
            coverageSchemaVersion: OPENAI_COVERAGE_SCHEMA_VERSION,
            error: {
              type: coverageError.type,
              message: 'High-priority coverage pass failed; existing findings were retained.',
            },
          }
          logger.warn('content.coverage_failed', {
            videoId: video.id,
            type: coverageError.type,
            status: coverageError.status ?? null,
            code: coverageError.code ?? null,
          })
        }
      }

      const semanticValidation = validateClassifiedEvents(reviewedEvents)
      for (const adjusted of semanticValidation.adjustments) {
        logger.debug('content.validation_adjusted', {
          videoId: video.id,
          candidateId: adjusted.event.sourceCandidateId ?? null,
          sceneId: adjusted.event.sceneId ?? null,
          category: adjusted.event.category,
          subtype: adjusted.event.subtype,
          fromAssertionStatus: adjusted.originalEvent.assertionStatus,
          toAssertionStatus: adjusted.event.assertionStatus,
          reason: adjusted.reason,
        })
      }
      for (const rejected of semanticValidation.rejected) {
        logger.debug('content.validation_rejected', {
          videoId: video.id,
          candidateId: rejected.event.sourceCandidateId ?? null,
          sceneId: rejected.event.sceneId ?? null,
          category: rejected.event.category,
          subtype: rejected.event.subtype,
          assertionStatus: rejected.event.assertionStatus,
          reason: rejected.reason,
        })
      }
      const policyEvents = normalizeClassifiedEvents(semanticValidation.accepted)
        .map((classifiedEvent, eventIndex) => {
        const candidateId = classifiedEvent.sourceCandidateId
          ? `${video.id}:${classifiedEvent.sourceCandidateId}`
          : undefined
        const sceneId = classifiedEvent.sceneId
          ? `${video.id}:${classifiedEvent.sceneId}`
          : undefined
        const normalizedEvent = {
          ...classifiedEvent,
          sourceCandidateId: candidateId,
          sceneId,
        }
        logger.debug('content.candidate', {
          videoId: video.id,
          candidateId: candidateId ?? null,
          sceneId: sceneId ?? null,
          suspectedCategory: classifiedEvent.category,
          startMs: classifiedEvent.startMs,
          endMs: classifiedEvent.endMs,
          reviewStatus: classifiedEvent.review?.status ?? 'not_reviewed',
        })
        const eventId = `${video.id}:${classifiedEvent.sourceCandidateId ?? `event_${eventIndex}`}:${classifiedEvent.category}:${classifiedEvent.subtype}`
        const contentEvent = applyContentPolicy(normalizedEvent, eventId, profile)
        logger.debug('content.classified', {
          videoId: video.id,
          eventId,
          candidateId: candidateId ?? null,
          sceneId: sceneId ?? null,
          category: contentEvent.category,
          subtype: contentEvent.subtype,
          severity: contentEvent.severity,
          confidence: contentEvent.confidence,
        })
        logger.debug('content.relevance', {
          videoId: video.id,
          eventId,
          parentRelevance: contentEvent.parentRelevance,
          reviewerRecommendation: contentEvent.review?.recommendedParentRelevance ?? null,
        })
        logger.debug('content.display', {
          videoId: video.id,
          eventId,
          displayLevel: contentEvent.displayLevel,
        })
        return contentEvent
      })
      const rejectedCandidates = (analysis.rejectedCandidates ?? []).map((candidate) => ({
        ...candidate,
        candidateId: `${video.id}:${candidate.candidateId}`,
        sceneId: candidate.sceneId ? `${video.id}:${candidate.sceneId}` : undefined,
      }))
      for (const candidate of rejectedCandidates) {
        logger.debug('content.rejected', {
          videoId: video.id,
          candidateId: candidate.candidateId,
          sceneId: candidate.sceneId ?? null,
          category: candidate.suspectedCategory,
          reason: candidate.reason,
        })
      }
      contentEventsByVideo.set(video.id, policyEvents)
      rejectedCandidatesByVideo.set(video.id, rejectedCandidates)
      storage.recordOpenAISuccess(
        video.id,
        analysis,
        normalizedTranscript.text,
        policyEvents,
        semanticValidation.rejected,
        semanticValidation.adjustments,
        contentReview,
        reviewResult,
        reviewError,
        coverageResult,
        coverageError,
      )
      const videoUsage = combinedUsage(
        analysis.usage,
        reviewResult?.usage ?? reviewError?.usage,
        coverageResult?.usage ?? coverageError?.usage,
      )
      const legacyVisibleEvents = policyEvents.filter((event) => event.displayLevel !== 'hidden')
      const violations = buildLegacyViolations(legacyVisibleEvents, enabledRuleIds)
      const detections = buildDetections(violations, enabledRuleIds)
      videoResults.push({
        ...video,
        url,
        status: 'analyzed',
        transcriptLanguage: transcript.language,
        captionSource: captionSource(transcript.language),
        captionLanguageResolution: captionLanguageResolution(video.preflightCaptionLanguage, transcript.language),
        openaiUsage: videoUsage,
        contentReview,
        speechQuality,
        violations,
        detections,
      })
      successfulAnalyses += 1
      logger.info('video.analysis.completed', {
        videoId: video.id,
        classifiedEventCount: analysis.classifiedEvents.length,
        reviewedEventCount: reviewedEvents.length,
        normalizedEventCount: policyEvents.length,
        validationRejectedCount: semanticValidation.rejected.length,
        validationAdjustedCount: semanticValidation.adjustments.length,
        reviewStatus: contentReview.status,
        detectorTokens: analysis.usage.totalTokens,
        reviewTokens: reviewResult?.usage.totalTokens ?? reviewError?.usage?.totalTokens ?? 0,
      })
    } catch (error) {
      const analysisError = error instanceof OpenAIAnalysisError
        ? error
        : new OpenAIAnalysisError('provider', 'OpenAI request failed.')
      addUsage(openaiUsage, analysisError.usage)
      addUsage(openaiStages.detection, analysisError.usage)
      storage.recordOpenAIError(video.id, analysisError, {
        model: openaiModel,
        reasoningEffort: 'low',
        transcriptLanguage: transcript.language ?? (languagePriority || 'unknown'),
        enabledCategories,
        diagnostic: diagnosticAnalysis,
        promptVersion: OPENAI_PROMPT_VERSION,
        schemaVersion: OPENAI_SCHEMA_VERSION,
      }, normalized?.text ?? '')
      videoResults.push({
        ...video,
        url,
        status: 'provider_error',
        openaiUsage: analysisError.usage,
        transcriptLanguage: transcript.language,
        captionSource: captionSource(transcript.language),
        captionLanguageResolution: captionLanguageResolution(video.preflightCaptionLanguage, transcript.language),
        speechQuality: normalized ? analyzeSpeechQuality(normalized, transcript.language ?? languagePriority) : undefined,
        analysisError: {
          type: analysisError.type,
          status: analysisError.status,
          code: analysisError.code,
          message: analysisError.message,
        },
        violations: [],
        detections: [],
      })
      logger.warn('video.analysis.failed', {
        videoId: video.id,
        type: analysisError.type,
        status: analysisError.status ?? null,
        code: analysisError.code ?? null,
      })

      // OpenAI is downstream of the paid transcript fetch. If analysis fails for any reason,
      // stop the scan instead of spending more TranscriptAPI credits on videos we cannot
      // confidently classify.
      stoppedForOpenAIProviderError = true
      return
    }

  }

  while (successfulAnalyses < targetVideos) {
    if (stoppedForOpenAIProviderError || stoppedForTranscriptProviderError) break

    const usedTranscriptCredits = transcriptProvider.getCreditUsage().transcriptCredits
    const remainingTranscriptCredits = transcriptCreditBudget - usedTranscriptCredits
    if (remainingTranscriptCredits <= 0) {
      transcriptCreditBudgetExhausted = true
      break
    }

    const remainingVideos = targetVideos - successfulAnalyses
    const desiredBatchSize = Math.min(
      scanVideoConcurrency,
      remainingVideos,
      remainingTranscriptCredits,
    )

    if (eligibleVideos.length - candidateIndex < desiredBatchSize) {
      await loadFallbackVideos(candidateIndex + desiredBatchSize)
    }

    const availableCandidates = eligibleVideos.length - candidateIndex
    if (availableCandidates <= 0) break

    const batchSize = Math.min(desiredBatchSize, availableCandidates)
    const batch = eligibleVideos.slice(candidateIndex, candidateIndex + batchSize)
    candidateIndex += batch.length

    await mapWithConcurrency(batch, batch.length, processVideo)
  }

  const videoOrder = new Map(eligibleVideos.map((video, index) => [video.id, index]))
  videoResults.sort((left, right) => (videoOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
    - (videoOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER))

  const analyzedVideos = videoResults.filter((video) => video.status === 'analyzed').length
  const contentEvents = videoResults.flatMap((video) => contentEventsByVideo.get(video.id) ?? [])
  const videoReports = videoResults
    .filter((video) => video.status === 'analyzed')
    .map((video) => {
      const events = contentEventsByVideo.get(video.id) ?? []
      const scenes = buildPresentationScenes(events)
      const report = {
        videoId: video.id,
        categoryReports: buildVideoCategoryReports(events, enabledCategories),
        scenes,
        contentSummary: buildVideoContentSummary(scenes),
        mainSceneCount: scenes.filter((scene) => scene.attention === 'main').length,
        detailSceneCount: scenes.filter((scene) => scene.attention === 'details').length,
        ...(profile === 'diagnostic'
          ? {
              candidates: events.map((event) => ({
                candidateId: event.sourceCandidateId ?? event.id,
                sceneId: event.sceneId,
                suspectedCategory: event.category,
                startMs: event.startMs,
                endMs: event.endMs,
                text: event.text,
              })),
              rejectedCandidates: rejectedCandidatesByVideo.get(video.id) ?? [],
            }
          : {}),
      }
      logger.debug('content.aggregate', {
        videoId: video.id,
        sceneCount: report.scenes.length,
        categoryCount: report.categoryReports.filter((item) => item.rawEventCount > 0).length,
      })
      return report
    })
  const analyzedReviewStatuses = videoResults
    .filter((video) => video.status === 'analyzed')
    .map((video) => video.contentReview)
    .filter((review): review is VideoContentReview => Boolean(review))
  const contentReview: ContentReviewSummary = {
    model: openaiReviewModel,
    promptVersion: OPENAI_REVIEW_PROMPT_VERSION,
    schemaVersion: OPENAI_REVIEW_SCHEMA_VERSION,
    completedVideos: analyzedReviewStatuses.filter((review) => review.status === 'completed').length,
    partialVideos: analyzedReviewStatuses.filter((review) => review.status === 'partial').length,
    failedVideos: analyzedReviewStatuses.filter((review) => review.status === 'failed').length,
    skippedVideos: analyzedReviewStatuses.filter((review) => review.status === 'skipped_after_failure').length,
    notNeededVideos: analyzedReviewStatuses.filter((review) => review.status === 'not_needed').length,
    rescuedEvents: analyzedReviewStatuses.reduce((sum, review) => sum + (review.rescuedCount ?? 0), 0),
    rescueRejectedEvents: analyzedReviewStatuses.reduce((sum, review) => sum + (review.rescueRejectedCount ?? 0), 0),
  }

  const channelReport = buildChannelCategoryReports(
    videoResults
      .filter((video) => video.status === 'analyzed')
      .map((video) => ({ videoId: video.id, events: contentEventsByVideo.get(video.id) ?? [] })),
    enabledCategories,
    analyzedVideos,
    profile,
  )

  logger.debug('content.aggregate', {
    scope: 'channel',
    categories: channelReport.map((item) => ({
      category: item.category,
      level: item.level,
      rawAffectedVideos: item.rawAffectedVideos,
      affectedVideos: item.affectedVideos,
      rawEventCount: item.rawEventCount,
      displayedEventCount: item.displayedEventCount,
    })),
  })

  const legacySummaryBase = buildRuleSummary(videoResults, enabledRuleIds)
  const legacySummary = legacySummaryBase.map((item) => {
    const normalizedRuleCategories = normalizeRequestedCategories([item.ruleId])
    const canonical = channelReport.find((report) => normalizedRuleCategories.includes(report.category))
    if (!canonical) return item
    const severity = canonical.level === 'none'
      ? null
      : canonical.level === 'moderate'
        ? 'medium' as const
        : canonical.level
    return {
      ...item,
      severity,
      violationCount: canonical.displayedEventCount,
      affectedVideoCount: canonical.affectedVideos,
    }
  })

  const result: ChannelCheckResponse = {
    scanId: storageMode === 'none' ? undefined : storage.scanId,
    storageMode,
    profile,
    channel: latest.channel,
    requestedVideos: targetVideos,
    analyzedVideos,
    failedVideos: videoResults.length - analyzedVideos,
    analysisMode: 'openai',
    creditUsage: transcriptProvider.getCreditUsage(),
    openaiUsage,
    openaiStages,
    openaiRequests: {
      detectorRequests: openaiStages.detection.requests,
      reviewRequests: Math.max(
        0,
        openaiStages.review.requests - reviewFallbackRequests - coverageRequests,
      ),
      reviewFallbackRequests,
      coverageRequests,
    },
    timings: {
      totalMs: Date.now() - scanStartedAt,
      transcriptWallMs: wallDurationMs(transcriptIntervals),
      detectionWallMs: wallDurationMs(detectionIntervals),
      reviewWallMs: wallDurationMs(reviewIntervals),
      coverageWallMs: wallDurationMs(coverageIntervals),
      openaiSchedulerWaitMs: Math.round(openaiSchedulerWaitMs),
      openaiProviderMs: Math.round(openaiProviderMs),
    },
    contentReview,
    speechQuality: summarizeSpeechQuality(
      videoResults.flatMap((video) => video.speechQuality ? [video.speechQuality] : []),
    ),
    selection: {
      targetVideos,
      inspectedVideos: inspectedIds.size,
      captionEligibleVideos: eligibleVideos.length,
      transcriptAttempts,
      transcriptVideosAttempted: transcriptAttempts,
      transcriptHttpRequests: transcriptProvider.getTranscriptHttpRequestCount(),
      usedChannelVideosFallback,
      requestedLanguage: languagePriority || 'auto',
    },
    contentEvents,
    videoReports,
    channelReport,
    summary: legacySummary,
    videos: videoResults,
    limitations: [
      'Transcripts are split and coalesced into language-agnostic token-aware detector batches. Videos with detected candidates are contextually reviewed using local transcript windows; the additional coverage pass runs only in diagnostic profile, not in the normal production scan.',
      `Paid transcript credits are capped at ${transcriptCreditBudget} for this scan.`,
      'Transcript retrieval failures are replaced with the next caption-eligible video only while the paid transcript budget remains.',
      transcriptCreditBudgetExhausted
        ? 'The scan stopped because its paid TranscriptAPI transcript-credit budget was exhausted.'
        : 'The paid TranscriptAPI transcript-credit budget was not exhausted.',
      stoppedForTranscriptProviderError
        ? 'The scan stopped after a systemic or ambiguous TranscriptAPI failure to avoid further paid requests.'
        : 'TranscriptAPI did not produce a scan-stopping provider failure.',
      stoppedForOpenAIProviderError
        ? 'The scan stopped after a first-pass OpenAI detection error to avoid consuming more TranscriptAPI credits.'
        : 'First-pass OpenAI detection completed without a scan-stopping provider error.',
      contentReview.failedVideos + contentReview.skippedVideos > 0
        ? `Contextual review was unavailable for ${contentReview.failedVideos + contentReview.skippedVideos} analyzed video(s); their first-pass findings were retained and must not be interpreted as independently verified.`
        : contentReview.partialVideos > 0
          ? `Contextual review was partial for ${contentReview.partialVideos} analyzed video(s); uncertain or incomplete findings were retained conservatively.`
          : 'Contextual review completed for videos that contained first-pass candidates.',
      'The analyzer uses transcript speech only; it does not inspect video frames or audio beyond captions. Absence of transcript evidence is not a claim about unseen visuals.',
      `Channel-level wording covers only the ${analyzedVideos} analyzed video transcript(s), not the entire channel.`,
      'Speech-quality metrics are local heuristics, not safety violations or an overall quality score.',
      storageMode === 'diagnostic'
        ? 'Diagnostic storage stores normalized transcripts and provider diagnostics on the server without changing classifier behavior.'
        : 'Normalized and raw transcript text is not persisted in this storage mode.',
    ],
  }

  try {
    await storage.save(result)
  } catch {
    throw createError({
      statusCode: 500,
      statusMessage: 'Scan completed but its requested result could not be stored.',
    })
  }
  logger.info('scan.completed', {
    analyzedVideos,
    failedVideos: result.failedVideos,
    openaiRequests: openaiUsage.requests,
    openaiTotalTokens: openaiUsage.totalTokens,
    durationMs: result.timings?.totalMs ?? Date.now() - scanStartedAt,
    timings: result.timings,
    openaiRequestsByStage: result.openaiRequests,
  })
  return result
})
