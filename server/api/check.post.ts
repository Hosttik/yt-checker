import { z } from 'zod'
import type {
  ChannelCheckResponse,
  RuleId,
  TranscriptUnavailableReason,
  VideoScanResult,
} from '../../shared/types/check'
import { RULE_IDS } from '../../shared/types/check'
import { analyzeTranscript, buildRuleSummary } from '../domain/analyze-transcript'
import {
  TranscriptApiClient,
  TranscriptApiError,
} from '../services/transcript-api'
import { mapWithConcurrency } from '../utils/concurrency'

const checkRequestSchema = z.object({
  channelUrl: z.string().trim().min(1).max(500),
  videoLimit: z.number().int().min(1).max(15).default(10),
  ruleIds: z.array(z.enum(RULE_IDS)).min(1).default([...RULE_IDS]),
})

function providerReason(error: unknown): TranscriptUnavailableReason {
  return error instanceof TranscriptApiError ? error.reason : 'provider_error'
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

  const provider = new TranscriptApiClient(
    config.transcriptApiKey,
    config.transcriptApiBaseUrl,
  )

  let source

  try {
    source = await provider.getRecentVideos(parsed.data.channelUrl, parsed.data.videoLimit)
  } catch {
    // Do not return or log upstream response bodies: they may contain provider/raw content.
    throw createError({
      statusCode: 502,
      statusMessage: 'Could not load this YouTube channel.',
    })
  }

  const enabledRuleIds = parsed.data.ruleIds as RuleId[]
  const videoResults = await mapWithConcurrency(
    source.videos,
    3,
    async (video): Promise<VideoScanResult> => {
      try {
        // Raw transcript text exists only in this scope and is never returned.
        const transcript = await provider.getTranscript(video.id)
        const detections = analyzeTranscript(transcript.segments, enabledRuleIds)

        return {
          ...video,
          status: 'analyzed',
          transcriptLanguage: transcript.language,
          detections,
        }
      } catch (error) {
        return {
          ...video,
          status: 'transcript_unavailable',
          unavailableReason: providerReason(error),
          detections: [],
        }
      }
    },
  )

  const analyzedVideos = videoResults.filter((video) => video.status === 'analyzed').length

  return {
    channel: source.channel,
    requestedVideos: source.videos.length,
    analyzedVideos,
    failedVideos: videoResults.length - analyzedVideos,
    summary: buildRuleSummary(videoResults, enabledRuleIds),
    videos: videoResults,
    limitations: [
      'Current checks analyze speech transcripts, not visual content.',
      'Keyword rules can produce false positives because they do not understand context yet.',
      'Filler speech, shouting, editing pace, and speech quality are not scored in this MVP.',
      'Raw transcript text is not included in results; use the YouTube timeline links to verify context.',
    ],
  }
})
