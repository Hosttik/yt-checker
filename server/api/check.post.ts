import { z } from 'zod'
import type {
  ChannelCheckResponse,
  ContextFilterStatus,
  RuleId,
  ScanStorageMode,
  TranscriptUnavailableReason,
  VideoMetadata,
  VideoScanResult,
} from '../../shared/types/check'
import { RULE_IDS, SCAN_STORAGE_MODES } from '../../shared/types/check'
import {
  buildDetections,
  buildRuleSummary,
  findTranscriptCandidates,
  type TranscriptCandidate,
} from '../domain/analyze-transcript'
import { getRule } from '../domain/rules'
import { JevContextFilter } from '../services/jev-context-filter'
import { ScanStorage } from '../services/scan-storage'
import {
  TranscriptApiClient,
  TranscriptApiError,
  type TranscriptApiExchange,
} from '../services/transcript-api'
import { createScanLogger } from '../utils/logger'

const languageSchema = z.string()
  .trim()
  .max(100)
  .default('')
  .refine((value) => {
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

function providerReason(error: unknown): TranscriptUnavailableReason {
  return error instanceof TranscriptApiError ? error.reason : 'provider_error'
}

function runtimeBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === '1'
}

function mergeMetadata(video: VideoMetadata, info: {
  metadata?: { title?: string; thumbnailUrl?: string }
}): VideoMetadata {
  return {
    ...video,
    title: info.metadata?.title ?? video.title,
    thumbnailUrl: info.metadata?.thumbnailUrl ?? video.thumbnailUrl,
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

export default defineEventHandler(async (event): Promise<ChannelCheckResponse> => {
  const parsed = checkRequestSchema.safeParse(await readBody(event))

  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: parsed.error.issues.map((issue) => issue.message).join('; '),
    })
  }

  const config = useRuntimeConfig(event)
  if (!config.transcriptApiKey) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Server is missing NUXT_TRANSCRIPT_API_KEY.',
    })
  }

  const storageMode = parsed.data.storageMode as ScanStorageMode
  const languagePriority = parsed.data.language
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
  const logRawCandidates = storageMode === 'diagnostic'
    && runtimeBoolean(config.logRawCandidates)

  function candidateFields(
    videoId: string,
    candidate: TranscriptCandidate,
  ): Record<string, unknown> {
    const rule = getRule(candidate.ruleId)
    return {
      videoId,
      candidateId: candidate.id,
      ruleId: candidate.ruleId,
      ruleLabel: rule.label,
      hitCount: candidate.hitCount,
      matchedTerms: candidate.matchedTerms,
      phrase: candidate.segmentText,
      context: candidate.context,
      startMs: candidate.startMs,
      endMs: candidate.endMs,
    }
  }

  function traceCandidate(
    eventName: string,
    videoId: string,
    candidate: TranscriptCandidate,
    extra: Record<string, unknown> = {},
  ): void {
    const fields = {
      ...candidateFields(videoId, candidate),
      ...extra,
    }

    storage.recordAnalysisTrace({
      timestamp: new Date().toISOString(),
      event: eventName,
      ...fields,
    })

    if (logRawCandidates) logger.debug(eventName, fields)
  }

  logger.info('scan.started', {
    storageMode,
    targetVideos: parsed.data.videoLimit,
    requestedLanguage: languagePriority || 'auto',
    enabledRules: parsed.data.ruleIds,
    jevEnabled: Boolean(config.typesafeApiKey),
    rawCandidateLogging: logRawCandidates,
  })

  const provider = new TranscriptApiClient(
    config.transcriptApiKey,
    config.transcriptApiBaseUrl,
    async (exchange) => {
      storage.recordProvider(exchange)
      logger.debug('transcriptapi.exchange', providerLogFields(exchange))
    },
  )

  const contextFilter = config.typesafeApiKey
    ? new JevContextFilter(
        config.typesafeApiKey,
        config.typesafeBaseUrl,
        config.typesafeModel,
        Number(config.typesafeBenignDropProbability),
        async (exchange) => {
          storage.recordJev(exchange)
          logger.debug('jev.exchange', {
            status: exchange.response.status,
            statusText: exchange.response.statusText,
            candidateCount: Object.keys(
              (exchange.request.body as { questions?: Record<string, unknown> }).questions ?? {},
            ).length,
          })
        },
      )
    : null

  const targetVideos = parsed.data.videoLimit
  let latest
  try {
    latest = await provider.getLatestVideos(parsed.data.channelUrl)
    logger.info('channel.latest.loaded', {
      channelId: latest.channel.id,
      channelTitle: latest.channel.title,
      videoCount: latest.videos.length,
    })
  } catch (error) {
    logger.error('channel.latest.failed', {
      reason: providerReason(error),
    })
    throw createError({
      statusCode: 502,
      statusMessage: 'Could not load this YouTube channel.',
    })
  }

  const inspectedIds = new Set<string>()
  const eligibleVideos: VideoMetadata[] = []

  async function inspectVideos(videos: VideoMetadata[], source: 'latest' | 'fallback'): Promise<void> {
    for (const video of videos) {
      if (inspectedIds.has(video.id)) continue
      inspectedIds.add(video.id)

      try {
        const info = await provider.getVideoInfo(video.id, languagePriority)
        logger.debug('video.preflight.completed', {
          videoId: video.id,
          source,
          captionAvailable: info.available,
          requestedLanguage: languagePriority || 'auto',
          matchedLanguage: info.matchedLanguage ?? null,
          languages: info.languages,
        })
        if (info.available) eligibleVideos.push(mergeMetadata(video, info))
      } catch (error) {
        logger.warn('video.preflight.failed', {
          videoId: video.id,
          source,
          requestedLanguage: languagePriority || 'auto',
          reason: providerReason(error),
        })
      }
    }
  }

  await inspectVideos(latest.videos, 'latest')

  let usedChannelVideosFallback = false
  if (eligibleVideos.length < targetVideos) {
    usedChannelVideosFallback = true
    logger.info('channel.fallback.started', {
      eligibleVideos: eligibleVideos.length,
      targetVideos,
    })

    try {
      const page = await provider.getChannelVideos(parsed.data.channelUrl)
      logger.info('channel.fallback.loaded', {
        videoCount: page.videos.length,
        hasMore: page.hasMore,
      })
      await inspectVideos(page.videos, 'fallback')
    } catch (error) {
      logger.warn('channel.fallback.failed', {
        reason: providerReason(error),
      })
    }
  }

  logger.info('scan.selection.completed', {
    inspectedVideos: inspectedIds.size,
    captionEligibleVideos: eligibleVideos.length,
    targetVideos,
    requestedLanguage: languagePriority || 'auto',
    usedChannelVideosFallback,
  })

  const enabledRuleIds = parsed.data.ruleIds as RuleId[]
  const videoResults: VideoScanResult[] = []
  let contextualFallbackVideos = 0
  let transcriptAttempts = 0

  for (const video of eligibleVideos) {
    if (videoResults.filter((item) => item.status === 'analyzed').length >= targetVideos) break
    transcriptAttempts += 1
    logger.debug('video.analysis.started', {
      videoId: video.id,
      transcriptAttempt: transcriptAttempts,
      requestedLanguage: languagePriority || 'auto',
    })

    try {
      const transcript = await provider.getTranscript(video.id, languagePriority)
      const candidates = findTranscriptCandidates(transcript.segments, enabledRuleIds)

      logger.debug('video.regex.completed', {
        videoId: video.id,
        requestedLanguage: languagePriority || 'auto',
        transcriptLanguage: transcript.language ?? null,
        segmentCount: transcript.segments.length,
        candidateCount: candidates.length,
      })

      for (const candidate of candidates) {
        traceCandidate('candidate.regex_match', video.id, candidate)
      }

      let filteredCandidates = candidates
      let contextFilterStatus: ContextFilterStatus = contextFilter ? 'not_needed' : 'disabled'

      if (contextFilter && candidates.length > 0) {
        try {
          filteredCandidates = await contextFilter.filter(candidates)
          contextFilterStatus = 'applied'
          const keptIds = new Set(filteredCandidates.map((candidate) => candidate.id))

          for (const candidate of candidates) {
            traceCandidate('candidate.jev_result', video.id, candidate, {
              result: keptIds.has(candidate.id) ? 'kept' : 'removed_as_benign',
            })
          }

          logger.debug('video.jev.completed', {
            videoId: video.id,
            inputCandidates: candidates.length,
            keptCandidates: filteredCandidates.length,
            removedCandidates: candidates.length - filteredCandidates.length,
          })
        } catch {
          contextualFallbackVideos += 1
          contextFilterStatus = 'fallback'

          for (const candidate of candidates) {
            traceCandidate('candidate.jev_result', video.id, candidate, {
              result: 'kept_on_jev_fallback',
            })
          }

          logger.warn('video.jev.fallback', {
            videoId: video.id,
            candidateCount: candidates.length,
          })
        }
      }

      for (const candidate of filteredCandidates) {
        traceCandidate('candidate.final_violation', video.id, candidate, {
          resolution: contextFilterStatus === 'applied'
            ? 'kept_after_jev'
            : contextFilterStatus === 'fallback'
              ? 'kept_on_jev_fallback'
              : 'regex_only',
        })
      }

      const detections = buildDetections(filteredCandidates, enabledRuleIds)
      videoResults.push({
        ...video,
        status: 'analyzed',
        transcriptLanguage: transcript.language,
        contextFilterStatus,
        detections,
      })

      logger.info('video.analysis.completed', {
        videoId: video.id,
        transcriptLanguage: transcript.language ?? null,
        detectionCategories: detections.length,
        detectionCount: detections.reduce((sum, detection) => sum + detection.count, 0),
        contextFilterStatus,
      })
    } catch (error) {
      const reason = providerReason(error)
      videoResults.push({
        ...video,
        status: 'transcript_unavailable',
        unavailableReason: reason,
        contextFilterStatus: contextFilter ? 'not_needed' : 'disabled',
        detections: [],
      })
      logger.warn('video.analysis.failed', {
        videoId: video.id,
        requestedLanguage: languagePriority || 'auto',
        reason,
      })
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
    analysisMode: contextFilter ? 'regex_jev' : 'regex_only',
    contextualFallbackVideos,
    creditUsage: provider.getCreditUsage(),
    selection: {
      targetVideos,
      inspectedVideos: inspectedIds.size,
      captionEligibleVideos: eligibleVideos.length,
      transcriptAttempts,
      usedChannelVideosFallback,
      requestedLanguage: languagePriority || 'auto',
    },
    summary: buildRuleSummary(videoResults, enabledRuleIds),
    videos: videoResults,
    limitations: [
      languagePriority
        ? `Only videos offering the requested transcript language priority "${languagePriority}" are selected.`
        : 'Transcript language is automatic: TranscriptAPI chooses English when available, otherwise the first available track.',
      'The scan targets the latest videos with a matching transcript track, not simply the latest videos regardless of transcript availability.',
      usedChannelVideosFallback
        ? 'The latest 15 videos did not contain enough matching captioned videos, so one paid /youtube/channel/videos page was used to find replacements.'
        : 'The scan was satisfied from the free /youtube/channel/latest feed and free /youtube/info preflights.',
      contextFilter
        ? 'Regex finds candidates; Jev removes only high-confidence contextual false positives. Ambiguous cases are kept for parental review.'
        : 'Contextual Jev filtering is disabled because NUXT_TYPESAFE_API_KEY is not configured.',
      storageMode === 'diagnostic'
        ? 'Diagnostic mode stores raw TranscriptAPI/Jev exchanges and analysis trace on the server for debugging.'
        : 'Raw transcript text is not persisted in this storage mode.',
      'Current checks analyze speech transcripts, not visual content.',
    ],
  }

  try {
    await storage.save(result)
    logger.info('scan.storage.completed', {
      storageMode,
      persisted: storageMode !== 'none',
    })
  } catch {
    logger.error('scan.storage.failed', {
      storageMode,
    })
    throw createError({
      statusCode: 500,
      statusMessage: 'Scan completed but its requested result could not be stored.',
    })
  }

  logger.info('scan.completed', {
    analyzedVideos,
    failedVideos: result.failedVideos,
    requestedLanguage: languagePriority || 'auto',
    transcriptAttempts,
    contextualFallbackVideos,
    totalCredits: result.creditUsage.totalCredits,
    transcriptCredits: result.creditUsage.transcriptCredits,
    channelVideosCredits: result.creditUsage.channelVideosCredits,
    freeRequests: result.creditUsage.freeRequests,
  })

  return result
})
