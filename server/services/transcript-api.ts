import type {
  ChannelMetadata,
  TranscriptUnavailableReason,
  VideoMetadata,
} from '../../shared/types/check'
import type { TranscriptResult } from '../domain/transcript'

interface TranscriptApiChannelLatestResponse {
  channel?: {
    channelId?: string
    title?: string
    author?: string
  }
  results?: Array<{
    videoId?: string
    title?: string
    published?: string
    thumbnail?: {
      url?: string
    }
  }>
}

interface TranscriptApiTranscriptResponse {
  video_id?: string
  language?: string
  transcript?: Array<{
    text?: string
    start?: number
    duration?: number
  }>
}

export interface RecentVideosResult {
  channel: ChannelMetadata
  videos: VideoMetadata[]
}

export interface VideoSource {
  getRecentVideos(channelInput: string, limit: number): Promise<RecentVideosResult>
}

export interface TranscriptProvider {
  getTranscript(videoId: string): Promise<TranscriptResult>
}

export class TranscriptApiError extends Error {
  constructor(
    public readonly reason: TranscriptUnavailableReason,
    message: string,
  ) {
    super(message)
    this.name = 'TranscriptApiError'
  }
}

function reasonForStatus(status: number): TranscriptUnavailableReason {
  if (status === 404 || status === 422) return 'not_available'
  if (status === 429) return 'rate_limited'
  if (status === 402) return 'billing'
  return 'provider_error'
}

export class TranscriptApiClient implements VideoSource, TranscriptProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://transcriptapi.com/api/v2',
  ) {
    if (!apiKey) {
      throw new Error('TranscriptAPI key is not configured.')
    }
  }

  async getRecentVideos(channelInput: string, limit: number): Promise<RecentVideosResult> {
    const url = this.url('/youtube/channel/latest')
    url.searchParams.set('channel', channelInput)

    const response = await fetch(url, {
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new TranscriptApiError(
        reasonForStatus(response.status),
        'Could not load the YouTube channel from the provider.',
      )
    }

    const data = (await response.json()) as TranscriptApiChannelLatestResponse
    const channelId = data.channel?.channelId

    if (!channelId) {
      throw new TranscriptApiError('provider_error', 'Provider returned an invalid channel response.')
    }

    const videos = (data.results ?? []).slice(0, limit).flatMap((item) => {
      if (!item.videoId) return []

      return [{
        id: item.videoId,
        title: item.title ?? item.videoId,
        publishedAt: item.published ?? '',
        thumbnailUrl: item.thumbnail?.url,
      }]
    })

    return {
      channel: {
        id: channelId,
        title: data.channel?.title ?? data.channel?.author ?? channelId,
      },
      videos,
    }
  }

  async getTranscript(videoId: string): Promise<TranscriptResult> {
    const url = this.url('/youtube/transcript')
    url.searchParams.set('video_url', videoId)
    url.searchParams.set('format', 'json')
    url.searchParams.set('include_timestamp', 'true')
    url.searchParams.set('send_metadata', 'false')

    const response = await fetch(url, {
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new TranscriptApiError(
        reasonForStatus(response.status),
        'Transcript is unavailable from the provider.',
      )
    }

    const data = (await response.json()) as TranscriptApiTranscriptResponse

    if (!Array.isArray(data.transcript)) {
      throw new TranscriptApiError('provider_error', 'Provider returned an invalid transcript response.')
    }

    const segments = data.transcript.flatMap((segment) => {
      if (
        !segment.text
        || typeof segment.start !== 'number'
        || typeof segment.duration !== 'number'
      ) {
        return []
      }

      const startMs = Math.max(0, Math.round(segment.start * 1_000))
      const durationMs = Math.max(0, Math.round(segment.duration * 1_000))

      return [{
        text: segment.text,
        startMs,
        endMs: startMs + durationMs,
      }]
    })

    if (segments.length === 0) {
      throw new TranscriptApiError('not_available', 'Transcript is unavailable from the provider.')
    }

    return {
      language: data.language,
      segments,
    }
  }

  private url(path: string): URL {
    return new URL(`${this.baseUrl.replace(/\/$/, '')}${path}`)
  }

  private headers(): HeadersInit {
    return {
      authorization: `Bearer ${this.apiKey}`,
      accept: 'application/json',
    }
  }
}
