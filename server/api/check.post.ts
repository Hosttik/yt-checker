import { z } from 'zod'
import type {
  AggregateOpenAIUsage,
  ChannelCheckResponse,
  RuleId,
  ScanStorageMode,
  TranscriptUnavailableReason,
  VideoMetadata,
  VideoScanResult,
} from '../../shared/types/check'
import { RULE_IDS, SCAN_STORAGE_MODES } from '../../shared/types/check'
import { buildDetections, buildRuleSummary } from '../domain/analyze-transcript'
import { normalizeTranscript } from '../domain/normalize-transcript'
import { analyzeSpeechQuality, summarizeSpeechQuality } from '../domain/speech-quality'
import { OpenAIAnalysisError, OpenAIAnalysisProvider } from '../services/openai-analysis'
import { ScanStorage } from '../services/scan-storage'
import {
  TranscriptApiClient,
  TranscriptApiError,
  type TranscriptApiExchange,
} from '../services/transcript-api'
import { createScanLogger } from '../utils/logger'
import { mapWithConcurrency } from '../utils/concurrency'

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
  ruleIds: z.array(z.enum(RULE_IDS)).min(1).default([...RULE_IDS]),
  storageMode: z.enum(SCAN_STORAGE_MODES).default('minimal'),
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
    expectedCaptionLanguage: info.matchedLanguage,
  }
}

function captionSource(language?: string): 'manual' | 'asr' | 'unknown' {
  if (!language) return 'unknown'
  return language.toLowerCase().startsWith('asr-') || language.toLowerCase() === 'asr' ? 'asr' : 'manual'
}

function captionLanguageMismatch(expected?: string, resolved?: string): boolean {
  if (!expected || !resolved) return false
  return expected.toLowerCase().replace(/_/g, '-') !== resolved.toLowerCase().replace(/_/g, '-')
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

export default defineEventHandler(async (event): Promise<ChannelCheckResponse> => {
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
  const transcriptProvider = new TranscriptApiClient(
    config.transcriptApiKey,
    config.transcriptApiBaseUrl,
    async (exchange) => {
      storage.recordProvider(exchange)
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
  const analyzer = new OpenAIAnalysisProvider(openaiApiKey, openaiModel)
  const languagePriority = request.language
  const targetVideos = request.videoLimit
  const enabledRuleIds = request.ruleIds as RuleId[]

  logger.info('scan.started', {
    storageMode,
    targetVideos,
    requestedLanguage: languagePriority || 'auto',
    enabledRules: enabledRuleIds,
    analysisProvider: 'openai',
    model: openaiModel,
    reasoningEffort: 'low',
  })

  let latest
  try {
    latest = await transcriptProvider.getLatestVideos(request.channelUrl)
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
    const concurrency = 4

    for (let offset = 0; offset < pending.length && eligibleVideos.length < desiredEligible; offset += concurrency) {
      const batch = pending.slice(offset, offset + concurrency)
      const inspected = await mapWithConcurrency(batch, concurrency, async (video) => {
        inspectedIds.add(video.id)
        try {
          const info = await transcriptProvider.getVideoInfo(video.id, languagePriority)
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
  async function loadFallbackVideos(): Promise<void> {
    // Inspect any remaining free latest-video candidates before buying a fallback page.
    await inspectVideos(latest.videos, 'latest')
    if (eligibleVideos.length > candidateIndex || usedChannelVideosFallback) return

    usedChannelVideosFallback = true
    try {
      const page = await transcriptProvider.getChannelVideos(request.channelUrl)
      await inspectVideos(page.videos, 'fallback', candidateIndex + targetVideos)
    } catch (error) {
      logger.warn('channel.fallback.failed', { reason: transcriptReason(error) })
    }
  }

  if (eligibleVideos.length < targetVideos) {
    await loadFallbackVideos()
  }

  const videoResults: VideoScanResult[] = []
  const openaiUsage: AggregateOpenAIUsage = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  }
  let transcriptAttempts = 0
  let successfulAnalyses = 0
  let candidateIndex = 0
  let stoppedForOpenAIProviderError = false
  let stoppedForTranscriptProviderError = false
  let transcriptCreditBudgetExhausted = false
  const transcriptCreditBudget = targetVideos

  while (successfulAnalyses < targetVideos) {
    if (transcriptProvider.getCreditUsage().transcriptCredits >= transcriptCreditBudget) {
      transcriptCreditBudgetExhausted = true
      break
    }
    if (candidateIndex >= eligibleVideos.length) {
      await loadFallbackVideos()
      if (candidateIndex >= eligibleVideos.length) break
    }

    const video = eligibleVideos[candidateIndex]!
    candidateIndex += 1
    transcriptAttempts += 1
    const url = `https://www.youtube.com/watch?v=${video.id}`
    let transcript
    try {
      transcript = await transcriptProvider.getTranscript(video.id, languagePriority)
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
      if (unavailableReason === 'not_available') continue
      stoppedForTranscriptProviderError = true
      break
    }

    let normalized: ReturnType<typeof normalizeTranscript> | undefined
    try {
      normalized = normalizeTranscript(transcript.segments)
      if (!normalized.text.trim()) throw new OpenAIAnalysisError('schema', 'Transcript has no speech to analyze.')
      openaiUsage.requests += 1
      const resolvedLanguage = transcript.language ?? languagePriority
      const speechQuality = analyzeSpeechQuality(normalized, resolvedLanguage)
      const analysis = await analyzer.analyze(
        normalized,
        resolvedLanguage,
        enabledRuleIds,
        storageMode === 'diagnostic',
      )
      storage.recordOpenAISuccess(video.id, analysis, normalized.text)
      addUsage(openaiUsage, analysis.usage)
      const detections = buildDetections(analysis.violations, enabledRuleIds)
      videoResults.push({
        ...video,
        url,
        status: 'analyzed',
        transcriptLanguage: transcript.language,
        captionSource: captionSource(transcript.language),
        captionSourceMismatch: captionLanguageMismatch(video.expectedCaptionLanguage, transcript.language),
        openaiUsage: analysis.usage,
        speechQuality,
        violations: analysis.violations,
        detections,
      })
      successfulAnalyses += 1
      logger.info('video.analysis.completed', {
        videoId: video.id,
        violationCount: analysis.violations.length,
        inputTokens: analysis.usage.inputTokens,
        outputTokens: analysis.usage.outputTokens,
        reasoningTokens: analysis.usage.reasoningTokens,
      })
    } catch (error) {
      const analysisError = error instanceof OpenAIAnalysisError
        ? error
        : new OpenAIAnalysisError('provider', 'OpenAI request failed.')
      addUsage(openaiUsage, analysisError.usage)
      storage.recordOpenAIError(video.id, analysisError, {
        model: openaiModel,
        reasoningEffort: 'low',
        transcriptLanguage: transcript.language ?? (languagePriority || 'unknown'),
        enabledCategories: enabledRuleIds,
        diagnostic: storageMode === 'diagnostic',
      }, normalized?.text ?? '')
      videoResults.push({
        ...video,
        url,
        status: 'provider_error',
        openaiUsage: analysisError.usage,
        transcriptLanguage: transcript.language,
        captionSource: captionSource(transcript.language),
        captionSourceMismatch: captionLanguageMismatch(video.expectedCaptionLanguage, transcript.language),
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
      break
    }
  }

  const analyzedVideos = videoResults.filter((video) => video.status === 'analyzed').length
  const result: ChannelCheckResponse = {
    scanId: storageMode === 'none' ? undefined : storage.scanId,
    storageMode,
    channel: latest.channel,
    requestedVideos: targetVideos,
    analyzedVideos,
    failedVideos: videoResults.length - analyzedVideos,
    analysisMode: 'openai',
    creditUsage: transcriptProvider.getCreditUsage(),
    openaiUsage,
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
    summary: buildRuleSummary(videoResults, enabledRuleIds),
    videos: videoResults,
    limitations: [
      'Each transcript is normalized and analyzed by one OpenAI Responses API request.',
      `Paid transcript credits are capped at ${transcriptCreditBudget} for this scan.`,
      'Transcript retrieval failures are replaced with the next caption-eligible video only while the paid transcript budget remains.',
      transcriptCreditBudgetExhausted
        ? 'The scan stopped because its paid TranscriptAPI transcript-credit budget was exhausted.'
        : 'The paid TranscriptAPI transcript-credit budget was not exhausted.',
      stoppedForTranscriptProviderError
        ? 'The scan stopped after a systemic or ambiguous TranscriptAPI failure to avoid further paid requests.'
        : 'TranscriptAPI did not produce a scan-stopping provider failure.',
      stoppedForOpenAIProviderError
        ? 'The scan stopped after an OpenAI analysis error to avoid consuming more TranscriptAPI credits.'
        : 'OpenAI analysis completed without a scan-stopping provider error.',
      'The analyzer uses transcript speech only; it does not inspect video frames or audio beyond captions.',
      'Speech-quality metrics are local heuristics, not safety violations or an overall quality score.',
      storageMode === 'diagnostic'
        ? 'Diagnostic mode stores normalized transcripts and redacted provider diagnostics on the server.'
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
  })
  return result
})
