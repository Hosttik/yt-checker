import type {
  ChannelMetadata,
  ScanCreditUsage,
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
    thumbnail?: { url?: string }
  }>
}

interface TranscriptApiChannelVideosResponse {
  results?: Array<{
    videoId?: string
    title?: string
    channelId?: string
    channelTitle?: string
    thumbnails?: Array<{ url?: string }>
  }>
  continuation_token?: string | null
  has_more?: boolean
}

interface TranscriptApiInfoResponse {
  video_id?: string
  metadata?: {
    title?: string
    author_name?: string
    author_url?: string
    thumbnail_url?: string
  }
  available_languages?: Array<{ code?: string; name?: string }>
}

interface TranscriptApiTranscriptResponse {
  video_id?: string
  language?: string
  transcript?: Array<{
    text?: string
    start?: number
    duration?: number
  }>
  metadata?: unknown
  length_seconds?: number
  lengthText?: string
}

export type TranscriptApiOperation =
  | 'channel_latest'
  | 'video_info'
  | 'channel_videos'
  | 'transcript'

export interface TranscriptApiExchange {
  operation: TranscriptApiOperation
  request: {
    method: 'GET'
    url: string
    headers: { authorization: 'Bearer <redacted>'; accept: 'application/json' }
    startedAt: string
  }
  response: {
    receivedAt: string
    latencyMs: number
    status: number
    statusText: string
    headers: Record<string, string>
    bodyText: string
    bodyJson: unknown
  } | null
  networkError?: {
    name: string
    message: string
  }
  chargedCredits: number
}

export interface VideoInfoResult {
  available: boolean
  languages: string[]
  metadata?: {
    title?: string
    thumbnailUrl?: string
  }
}

export interface RecentVideosResult {
  channel: ChannelMetadata
  videos: VideoMetadata[]
}

export interface ChannelVideosPage {
  videos: VideoMetadata[]
  continuationToken?: string
  hasMore: boolean
}

export type TranscriptApiObserver = (exchange: TranscriptApiExchange) => void | Promise<void>

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

function headersToObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries())
}

export class TranscriptApiClient {
  private usage: ScanCreditUsage = {
    transcriptCredits: 0,
    channelVideosCredits: 0,
    totalCredits: 0,
    freeRequests: 0,
  }

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://transcriptapi.com/api/v2',
    private readonly observer?: TranscriptApiObserver,
  ) {
    if (!apiKey) throw new Error('TranscriptAPI key is not configured.')
  }

  getCreditUsage(): ScanCreditUsage {
    return { ...this.usage }
  }

  async getLatestVideos(channelInput: string): Promise<RecentVideosResult> {
    const data = await this.requestJson<TranscriptApiChannelLatestResponse>(
      'channel_latest',
      '/youtube/channel/latest',
      { channel: channelInput },
      'free',
    )
    const channelId = data.channel?.channelId

    if (!channelId) {
      throw new TranscriptApiError('provider_error', 'Provider returned an invalid channel response.')
    }

    return {
      channel: {
        id: channelId,
        title: data.channel?.title ?? data.channel?.author ?? channelId,
      },
      videos: (data.results ?? []).flatMap((item) => {
        if (!item.videoId) return []
        return [{
          id: item.videoId,
          title: item.title ?? item.videoId,
          publishedAt: item.published ?? '',
          thumbnailUrl: item.thumbnail?.url,
        }]
      }),
    }
  }

  async getVideoInfo(videoId: string): Promise<VideoInfoResult> {
    try {
      const data = await this.requestJson<TranscriptApiInfoResponse>(
        'video_info',
        '/youtube/info',
        { video_url: videoId },
        'free',
      )
      const languages = (data.available_languages ?? [])
        .map((language) => language.code)
        .filter((code): code is string => Boolean(code))

      return {
        available: languages.length > 0,
        languages,
        metadata: {
          title: data.metadata?.title,
          thumbnailUrl: data.metadata?.thumbnail_url,
        },
      }
    } catch (error) {
      if (error instanceof TranscriptApiError && error.reason === 'not_available') {
        return { available: false, languages: [] }
      }
      throw error
    }
  }

  async getChannelVideos(
    channelInput: string,
    continuation?: string,
  ): Promise<ChannelVideosPage> {
    const data = await this.requestJson<TranscriptApiChannelVideosResponse>(
      'channel_videos',
      '/youtube/channel/videos',
      continuation ? { continuation } : { channel: channelInput },
      'channel_videos',
    )

    return {
      videos: (data.results ?? []).flatMap((item) => {
        if (!item.videoId) return []
        return [{
          id: item.videoId,
          title: item.title ?? item.videoId,
          publishedAt: '',
          thumbnailUrl: item.thumbnails?.[0]?.url,
        }]
      }),
      continuationToken: data.continuation_token ?? undefined,
      hasMore: Boolean(data.has_more),
    }
  }

  async getTranscript(videoId: string): Promise<TranscriptResult> {
    const data = await this.requestJson<TranscriptApiTranscriptResponse>(
      'transcript',
      '/youtube/transcript',
      {
        video_url: videoId,
        format: 'json',
        include_timestamp: 'true',
        send_metadata: 'true',
      },
      'transcript',
    )

    if (!Array.isArray(data.transcript)) {
      throw new TranscriptApiError('provider_error', 'Provider returned an invalid transcript response.')
    }

    const segments = data.transcript.flatMap((segment) => {
      if (
        !segment.text
        || typeof segment.start !== 'number'
        || typeof segment.duration !== 'number'
      ) return []

      const startMs = Math.max(0, Math.round(segment.start * 1_000))
      const durationMs = Math.max(0, Math.round(segment.duration * 1_000))
      return [{ text: segment.text, startMs, endMs: startMs + durationMs }]
    })

    if (segments.length === 0) {
      throw new TranscriptApiError('not_available', 'Transcript is unavailable from the provider.')
    }

    return { language: data.language, segments }
  }

  private async requestJson<T>(
    operation: TranscriptApiOperation,
    path: string,
    params: Record<string, string>,
    billing: 'free' | 'transcript' | 'channel_videos',
  ): Promise<T> {
    const url = this.url(path)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

    const startedAt = new Date().toISOString()
    const started = performance.now()

    let response: Response
    try {
      response = await fetch(url, { headers: this.headers() })
    } catch (error) {
      await this.observer?.({
        operation,
        request: {
          method: 'GET',
          url: url.toString(),
          headers: { authorization: 'Bearer <redacted>', accept: 'application/json' },
          startedAt,
        },
        response: null,
        networkError: {
          name: error instanceof Error ? error.name : 'UnknownError',
          message: error instanceof Error ? error.message : 'Network error',
        },
        chargedCredits: 0,
      })
      throw new TranscriptApiError('provider_error', 'TranscriptAPI network request failed.')
    }

    const bodyText = await response.text()
    let bodyJson: unknown = null
    try {
      bodyJson = bodyText ? JSON.parse(bodyText) : null
    } catch {
      bodyJson = null
    }

    const chargedCredits = response.ok && billing !== 'free' ? 1 : 0
    if (response.ok) {
      if (billing === 'free') this.usage.freeRequests += 1
      if (billing === 'transcript') this.usage.transcriptCredits += 1
      if (billing === 'channel_videos') this.usage.channelVideosCredits += 1
      this.usage.totalCredits += chargedCredits
    }

    await this.observer?.({
      operation,
      request: {
        method: 'GET',
        url: url.toString(),
        headers: { authorization: 'Bearer <redacted>', accept: 'application/json' },
        startedAt,
      },
      response: {
        receivedAt: new Date().toISOString(),
        latencyMs: Math.round((performance.now() - started) * 100) / 100,
        status: response.status,
        statusText: response.statusText,
        headers: headersToObject(response.headers),
        bodyText,
        bodyJson,
      },
      chargedCredits,
    })

    if (!response.ok) {
      throw new TranscriptApiError(
        reasonForStatus(response.status),
        operation === 'channel_latest' || operation === 'channel_videos'
          ? 'Could not load the YouTube channel from the provider.'
          : 'Transcript data is unavailable from the provider.',
      )
    }

    if (bodyJson === null) {
      throw new TranscriptApiError('provider_error', 'Provider returned invalid JSON.')
    }

    return bodyJson as T
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
