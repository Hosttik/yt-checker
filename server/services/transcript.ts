import type { TranscriptSegment } from '../../shared/types/check'

export interface TranscriptResult {
  language?: string
  segments: TranscriptSegment[]
}

export interface TranscriptProvider {
  getTranscript(videoId: string): Promise<TranscriptResult>
}

interface SupadataSegment {
  text?: string
  offset?: number
  duration?: number
  lang?: string
}

interface SupadataResponse {
  content?: SupadataSegment[]
  lang?: string
  availableLangs?: string[]
  jobId?: string
  status?: 'queued' | 'processing' | 'completed' | 'failed'
  error?: string
  message?: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class SupadataTranscriptProvider implements TranscriptProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.supadata.ai/v1',
  ) {
    if (!apiKey) {
      throw new Error('Supadata API key is not configured.')
    }
  }

  async getTranscript(videoId: string): Promise<TranscriptResult> {
    const videoUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
    const url = new URL(`${this.baseUrl.replace(/\/$/, '')}/transcript`)
    url.searchParams.set('url', videoUrl)
    url.searchParams.set('mode', 'auto')

    const response = await this.request(url)

    if (response.jobId) {
      return this.poll(response.jobId)
    }

    return this.toTranscriptResult(response)
  }

  private async poll(jobId: string): Promise<TranscriptResult> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/transcript/${encodeURIComponent(jobId)}`

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(1500)
      const response = await this.request(url)

      if (response.status === 'failed') {
        throw new Error(response.message ?? 'Transcript generation failed.')
      }

      if (response.content) {
        return this.toTranscriptResult(response)
      }
    }

    throw new Error('Transcript generation did not finish in time.')
  }

  private async request(url: URL | string): Promise<SupadataResponse> {
    const response = await fetch(url, {
      headers: {
        'x-api-key': this.apiKey,
        accept: 'application/json',
      },
    })

    const data = (await response.json()) as SupadataResponse

    if (!response.ok || data.error) {
      throw new Error(data.message ?? data.error ?? `Transcript provider returned ${response.status}.`)
    }

    return data
  }

  private toTranscriptResult(response: SupadataResponse): TranscriptResult {
    if (!response.content || !Array.isArray(response.content)) {
      throw new Error('Transcript provider returned no timestamped transcript.')
    }

    const segments = response.content.flatMap((segment) => {
      if (!segment.text || typeof segment.offset !== 'number') return []

      return [{
        text: segment.text,
        offsetMs: segment.offset,
        durationMs: typeof segment.duration === 'number' ? segment.duration : 0,
        lang: segment.lang ?? response.lang,
      }]
    })

    if (segments.length === 0) {
      throw new Error('Transcript is empty.')
    }

    return {
      language: response.lang,
      segments,
    }
  }
}
