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
} from '../domain/analyze-transcript'
import { JevContextFilter } from '../services/jev-context-filter'
import { ScanStorage } from '../services/scan-storage'
import {
  TranscriptApiClient,
  TranscriptApiError,
} from '../services/transcript-api'

const checkRequestSchema = z.object({
  channelUrl: z.string().trim().min(1).max(500),
  videoLimit: z.number().int().min(1).max(10).default(10),
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

  const provider = new TranscriptApiClient(
    config.transcriptApiKey,
    config.transcriptApiBaseUrl,
    storage.recordProvider,
  )

  const contextFilter = config.typesafeApiKey
    ? new JevContextFilter(
        config.typesafeApiKey,
        config.typesafeBaseUrl,
        config.typesafeModel,
        Number(config.typesafeBenignDropProbability),
        storage.recordJev,
      )
    : null

  const targetVideos = parsed.data.videoLimit
  let latest
  try {
    latest = await provider.getLatestVideos(parsed.data.channelUrl)
  } catch {
    throw createError({
      statusCode: 502,
      statusMessage: 'Could not load this YouTube channel.',
    })
  }

  const inspectedIds = new Set<string>()
  const eligibleVideos: VideoMetadata[] = []

  async function inspectVideos(videos: VideoMetadata[]): Promise<void> {
    for (const video of videos) {
      if (inspectedIds.has(video.id)) continue
      inspectedIds.add(video.id)

      try {
        const info = await provider.getVideoInfo(video.id)
        if (info.available) eligibleVideos.push(mergeMetadata(video, info))
      } catch {
        // A failed free preflight is skipped; raw details are available in diagnostic mode.
      }
    }
  }

  await inspectVideos(latest.videos)

  let usedChannelVideosFallback = false
  if (eligibleVideos.length < targetVideos) {
    usedChannelVideosFallback = true
    try {
      const page = await provider.getChannelVideos(parsed.data.channelUrl)
      await inspectVideos(page.videos)
    } catch {
      // Keep whatever the free latest feed provided. Paid page errors cost no credits.
    }
  }

  const enabledRuleIds = parsed.data.ruleIds as RuleId[]
  const videoResults: VideoScanResult[] = []
  let contextualFallbackVideos = 0
  let transcriptAttempts = 0

  for (const video of eligibleVideos) {
    if (videoResults.filter((item) => item.status === 'analyzed').length >= targetVideos) break
    transcriptAttempts += 1

    try {
      const transcript = await provider.getTranscript(video.id)
      const candidates = findTranscriptCandidates(transcript.segments, enabledRuleIds)

      let filteredCandidates = candidates
      let contextFilterStatus: ContextFilterStatus = contextFilter ? 'not_needed' : 'disabled'

      if (contextFilter && candidates.length > 0) {
        try {
          filteredCandidates = await contextFilter.filter(candidates)
          contextFilterStatus = 'applied'
        } catch {
          contextualFallbackVideos += 1
          contextFilterStatus = 'fallback'
        }
      }

      videoResults.push({
        ...video,
        status: 'analyzed',
        transcriptLanguage: transcript.language,
        contextFilterStatus,
        detections: buildDetections(filteredCandidates, enabledRuleIds),
      })
    } catch (error) {
      videoResults.push({
        ...video,
        status: 'transcript_unavailable',
        unavailableReason: providerReason(error),
        contextFilterStatus: contextFilter ? 'not_needed' : 'disabled',
        detections: [],
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
    },
    summary: buildRuleSummary(videoResults, enabledRuleIds),
    videos: videoResults,
    limitations: [
      'The scan targets the latest videos with available captions, not simply the latest videos regardless of transcript availability.',
      usedChannelVideosFallback
        ? 'The latest 15 videos did not contain enough captioned videos, so one paid /youtube/channel/videos page was used to find replacements.'
        : 'The scan was satisfied from the free /youtube/channel/latest feed and free /youtube/info preflights.',
      contextFilter
        ? 'Regex finds candidates; Jev removes only high-confidence contextual false positives. Ambiguous cases are kept for parental review.'
        : 'Contextual Jev filtering is disabled because NUXT_TYPESAFE_API_KEY is not configured.',
      storageMode === 'diagnostic'
        ? 'Diagnostic mode stores raw TranscriptAPI/Jev exchanges on the server for debugging and must not be used as the production default.'
        : 'Raw transcript text is not persisted in this storage mode.',
      'Current checks analyze speech transcripts, not visual content.',
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

  return result
})
