import { z } from 'zod'
import type { ChannelCheckResponse, RuleId, VideoScanResult } from '../../shared/types/check'
import { RULE_IDS } from '../../shared/types/check'
import { analyzeTranscript, buildRuleSummary } from '../domain/analyze-transcript'
import { SupadataTranscriptProvider } from '../services/transcript'
import { YouTubeClient } from '../services/youtube'
import { mapWithConcurrency } from '../utils/concurrency'

const checkRequestSchema = z.object({
  channelUrl: z.string().trim().min(1).max(500),
  videoLimit: z.number().int().min(1).max(20).default(10),
  ruleIds: z.array(z.enum(RULE_IDS)).min(1).default([...RULE_IDS]),
})

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
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

  if (!config.youtubeApiKey || !config.supadataApiKey) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Server is missing NUXT_YOUTUBE_API_KEY or NUXT_SUPADATA_API_KEY.',
    })
  }

  const youtube = new YouTubeClient(config.youtubeApiKey)
  const transcriptProvider = new SupadataTranscriptProvider(
    config.supadataApiKey,
    config.supadataBaseUrl,
  )

  let channel
  let videos

  try {
    channel = await youtube.resolveChannel(parsed.data.channelUrl)
    videos = await youtube.listRecentVideos(channel.uploadsPlaylistId, parsed.data.videoLimit)
  } catch (error) {
    throw createError({
      statusCode: 502,
      statusMessage: errorMessage(error),
    })
  }

  const enabledRuleIds = parsed.data.ruleIds as RuleId[]
  const videoResults = await mapWithConcurrency(videos, 3, async (video): Promise<VideoScanResult> => {
    try {
      const transcript = await transcriptProvider.getTranscript(video.id)

      return {
        ...video,
        status: 'analyzed',
        transcriptLanguage: transcript.language,
        violations: analyzeTranscript(transcript.segments, enabledRuleIds),
      }
    } catch (error) {
      return {
        ...video,
        status: 'transcript_unavailable',
        violations: [],
        error: errorMessage(error),
      }
    }
  })

  const analyzedVideos = videoResults.filter((video) => video.status === 'analyzed').length

  return {
    channel: {
      id: channel.id,
      title: channel.title,
      thumbnailUrl: channel.thumbnailUrl,
    },
    requestedVideos: videos.length,
    analyzedVideos,
    failedVideos: videoResults.length - analyzedVideos,
    summary: buildRuleSummary(videoResults, enabledRuleIds),
    videos: videoResults,
    limitations: [
      'Current checks analyze speech transcripts, not visual content.',
      'Keyword rules can produce false positives because they do not understand context yet.',
      'Filler speech, shouting, editing pace, and speech quality are not scored in this MVP.',
    ],
  }
})
