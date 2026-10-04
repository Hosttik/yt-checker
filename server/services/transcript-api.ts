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
    tStartMs?: number
    dDurationMs?: number
    segs?: Array<{ utf8?: string; tOffsetMs?: number }>
  }>
  events?: TranscriptApiTranscriptResponse['transcript']
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
  matchedLanguage?: string
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

export type TranscriptApiTraceEvent =
  | { event: 'transcript.request'; videoId: string; language: string; attempt: number; maxAttempts: number }
  | { event: 'transcript.retry'; videoId: string; language: string; attempt: number; status?: number; providerMessage?: string; retryInMs: number }
  | { event: 'transcript.success'; videoId: string; language: string; attempt: number; chargedCredits: number }
  | { event: 'transcript.failed'; videoId: string; attempts: number; status?: number; failureReason: TranscriptUnavailableReason; providerMessage?: string }

export interface TranscriptApiRetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  requestTimeoutMs?: number
  sleep?: (delayMs: number) => Promise<void>
  traceObserver?: (event: TranscriptApiTraceEvent) => void | Promise<void>
}

export class TranscriptApiError extends Error {
  constructor(
    public readonly reason: TranscriptUnavailableReason,
    message: string,
    public readonly status?: number,
    public readonly providerMessage?: string,
    public readonly retryAfterMs?: number,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'TranscriptApiError'
  }
}

function reasonForStatus(status: number): TranscriptUnavailableReason {
  if (status === 408) return 'provider_timeout'
  if (status === 404) return 'not_available'
  if (status === 429) return 'rate_limited'
  if (status === 402) return 'billing'
  // 422 is a validation error (invalid video URL/ID), not "no captions".
  return 'provider_error'
}

function providerMessage(bodyJson: unknown): string | undefined {
  if (!bodyJson || typeof bodyJson !== 'object') return undefined
  const body = bodyJson as Record<string, unknown>
  for (const key of ['message', 'detail', 'error']) {
    if (typeof body[key] === 'string') return body[key]
    if (body[key] && typeof body[key] === 'object') {
      const nested = body[key] as Record<string, unknown>
      if (typeof nested.message === 'string') return nested.message
    }
  }
  return undefined
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

function isRetryableTranscriptError(error: unknown): error is TranscriptApiError {
  if (!(error instanceof TranscriptApiError)) return false
  if (error.retryable) return true
  if (error.status === undefined) return false
  return error.status === 408
    || error.status === 429
    || [500, 502, 503, 504].includes(error.status)
}

function headersToObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries())
}

function chargedCreditsFromResponse(
  response: Response,
  billing: 'free' | 'transcript' | 'channel_videos',
): number {
  const header = response.headers.get('x-credits-charged')
  if (header !== null) {
    const parsed = Number(header)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return response.ok && billing !== 'free' ? 1 : 0
}

function parseLanguagePriority(languagePriority: string): string[] {
  return languagePriority
    .split(',')
    .map((code) => code.trim().toLowerCase().replace(/_/g, '-'))
    .filter(Boolean)
}

function languageParts(code: string): { asr: boolean; base?: string } {
  const normalized = code.trim().toLowerCase().replace(/_/g, '-')

  if (normalized === 'asr') return { asr: true }
  if (normalized.startsWith('asr-')) {
    return {
      asr: true,
      base: normalized.slice(4).split('-')[0],
    }
  }

  return {
    asr: false,
    base: normalized.split('-')[0],
  }
}

export function selectAvailableLanguage(
  availableLanguages: string[],
  languagePriority: string,
): string | undefined {
  const available = availableLanguages.map((code) => ({
    code,
    ...languageParts(code),
  }))
  const requested = parseLanguagePriority(languagePriority)

  if (requested.length === 0) return available[0]?.code

  for (const requestCode of requested) {
    const request = languageParts(requestCode)

    if (requestCode === 'asr') {
      const automatic = available.find((item) => item.asr)
      if (automatic) return automatic.code
      continue
    }

    if (request.asr) {
      const automatic = available.find(
        (item) => item.asr && item.base === request.base,
      )
      if (automatic) return automatic.code
      continue
    }

    const manual = available.find(
      (item) => !item.asr && item.base === request.base,
    )
    if (manual) return manual.code

    const automatic = available.find(
      (item) => item.asr && item.base === request.base,
    )
    if (automatic) return automatic.code
  }

  return undefined
}

export class TranscriptApiClient {
  private usage: ScanCreditUsage = {
    transcriptCredits: 0,
    channelVideosCredits: 0,
    totalCredits: 0,
    freeRequests: 0,
  }
  private transcriptHttpRequests = 0
  private readonly maxTranscriptAttempts: number
  private readonly retryBaseDelayMs: number
  private readonly requestTimeoutMs: number
  private readonly sleep: (delayMs: number) => Promise<void>
  private readonly traceObserver?: TranscriptApiRetryOptions['traceObserver']

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://transcriptapi.com/api/v2',
    private readonly observer?: TranscriptApiObserver,
    retry: TranscriptApiRetryOptions = {},
  ) {
    if (!apiKey) throw new Error('TranscriptAPI key is not configured.')
    this.maxTranscriptAttempts = Math.max(1, Math.floor(retry.maxAttempts ?? 3))
    this.retryBaseDelayMs = Math.max(0, retry.baseDelayMs ?? 1_000)
    this.requestTimeoutMs = Math.max(1_000, Math.floor(retry.requestTimeoutMs ?? 60_000))
    this.sleep = retry.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)))
    this.traceObserver = retry.traceObserver
  }

  getCreditUsage(): ScanCreditUsage {
    return { ...this.usage }
  }

  getTranscriptHttpRequestCount(): number {
    return this.transcriptHttpRequests
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

  async getVideoInfo(
    videoId: string,
    languagePriority = '',
  ): Promise<VideoInfoResult> {
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
      const matchedLanguage = selectAvailableLanguage(languages, languagePriority)

      return {
        available: Boolean(matchedLanguage),
        languages,
        matchedLanguage,
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

  async getTranscript(
    videoId: string,
    languagePriority = '',
  ): Promise<TranscriptResult> {
    const params: Record<string, string> = {
      video_url: videoId,
      format: 'json',
      include_timestamp: 'true',
      send_metadata: 'true',
    }

    if (languagePriority) params.language = languagePriority

    let lastError: TranscriptApiError | undefined

    for (let attempt = 1; attempt <= this.maxTranscriptAttempts; attempt += 1) {
      await this.traceObserver?.({
        event: 'transcript.request',
        videoId,
        language: languagePriority || 'auto',
        attempt,
        maxAttempts: this.maxTranscriptAttempts,
      })
      this.transcriptHttpRequests += 1

      try {
        const creditsBefore = this.usage.transcriptCredits
        const data = await this.requestJson<TranscriptApiTranscriptResponse>(
          'transcript',
          '/youtube/transcript',
          params,
          'transcript',
        )

        const captions = data.transcript ?? data.events
        if (!Array.isArray(captions)) {
          throw new TranscriptApiError('provider_error', 'Provider returned an invalid transcript response.')
        }

        const segments = captions.flatMap((segment) => {
          if (Array.isArray(segment.segs)) {
            if (!Number.isFinite(segment.tStartMs) || !Number.isFinite(segment.dDurationMs)
              || segment.tStartMs! < 0 || segment.dDurationMs! < 0) return []
            const text = segment.segs.map((part) => typeof part.utf8 === 'string' ? part.utf8 : '').join('')
            if (!text.trim()) return []
            return [{
              text,
              startMs: Math.round(segment.tStartMs!),
              endMs: Math.round(segment.tStartMs! + segment.dDurationMs!),
            }]
          }
          if (typeof segment.text !== 'string' || !segment.text.trim()
            || !Number.isFinite(segment.start) || !Number.isFinite(segment.duration)
            || typeof segment.start !== 'number' || typeof segment.duration !== 'number') {
            return []
          }
          const startMs = Math.max(0, Math.round(segment.start * 1_000))
          const durationMs = Math.max(0, Math.round(segment.duration * 1_000))
          return [{ text: segment.text, startMs, endMs: startMs + durationMs }]
        })

        if (segments.length === 0) {
          throw new TranscriptApiError('not_available', 'Transcript is unavailable from the provider.')
        }

        await this.traceObserver?.({
          event: 'transcript.success',
          videoId,
          language: data.language ?? (languagePriority || 'auto'),
          attempt,
          chargedCredits: this.usage.transcriptCredits - creditsBefore,
        })
        return { language: data.language, segments }
      } catch (error) {
        lastError = error instanceof TranscriptApiError
          ? error
          : new TranscriptApiError('provider_error', 'TranscriptAPI request failed.')

        if (attempt < this.maxTranscriptAttempts && isRetryableTranscriptError(lastError)) {
          const delayMs = lastError.retryAfterMs ?? this.retryBaseDelayMs * (2 ** (attempt - 1))
          await this.traceObserver?.({
            event: 'transcript.retry',
            videoId,
            language: languagePriority || 'auto',
            attempt,
            status: lastError.status,
            providerMessage: lastError.providerMessage,
            retryInMs: delayMs,
          })
          await this.sleep(delayMs)
          continue
        }

        await this.traceObserver?.({
          event: 'transcript.failed',
          videoId,
          attempts: attempt,
          status: lastError.status,
          failureReason: lastError.reason,
          providerMessage: lastError.providerMessage,
        })
        throw lastError
      }
    }

    throw lastError ?? new TranscriptApiError('provider_error', 'TranscriptAPI request failed.')
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
      response = await fetch(url, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError'
      const timedOut = errorName === 'TimeoutError' || errorName === 'AbortError'
      await this.observer?.({
        operation,
        request: {
          method: 'GET',
          url: url.toString(),
          headers: { authorization: 'Bearer <redacted>'; accept: 'application/json' } as const,
          startedAt,
        },
        response: null,
        networkError: {
          name: errorName,
          message: timedOut ? 'Request timed out' : 'Network error',
        },
        chargedCredits: 0,
      })
      // Do not retry an ambiguous client-side network failure: the upstream may have
      // completed and billed the request even though this process never received it.
      throw new TranscriptApiError(
        timedOut ? 'provider_timeout' : 'provider_error',
        timedOut ? 'TranscriptAPI request timed out.' : 'TranscriptAPI network request failed.',
      )
    }

    // Prefer the provider's authoritative billing header. Fall back to the documented
    // endpoint cost when the header is absent (for example in tests/mocks).
    const chargedCredits = chargedCreditsFromResponse(response, billing)
    if (response.ok) {
      if (billing === 'free') this.usage.freeRequests += 1
      if (billing === 'transcript') this.usage.transcriptCredits += chargedCredits
      if (billing === 'channel_videos') this.usage.channelVideosCredits += chargedCredits
      this.usage.totalCredits += chargedCredits
    }
    let bodyText = ''
    let bodyReadError: unknown
    try {
      bodyText = await response.text()
    } catch (error) {
      bodyReadError = error
    }
    let bodyJson: unknown = null
    try {
      bodyJson = bodyText ? JSON.parse(bodyText) : null
    } catch {
      bodyJson = null
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
      networkError: bodyReadError ? { name: 'BodyReadError', message: 'Response body interrupted.' } : undefined,
    })

    if (!response.ok) {
      throw new TranscriptApiError(
        reasonForStatus(response.status),
        operation === 'channel_latest' || operation === 'channel_videos'
          ? 'Could not load the YouTube channel from the provider.'
          : 'Transcript data is unavailable from the provider.',
        response.status,
        providerMessage(bodyJson),
        retryAfterMs(response.headers),
      )
    }

    if (bodyJson === null) {
      throw new TranscriptApiError('provider_error', 'Provider returned invalid or interrupted JSON.', response.status)
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
