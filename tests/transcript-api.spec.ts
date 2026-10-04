import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  selectAvailableLanguage,
  TranscriptApiClient,
  TranscriptApiError,
} from '../server/services/transcript-api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TranscriptAPI language selection', () => {
  it('matches plain language codes to manual captions first and ASR as fallback', () => {
    expect(selectAvailableLanguage(['asr-ru', 'ru', 'en'], 'ru')).toBe('ru')
    expect(selectAvailableLanguage(['asr-ru', 'en'], 'ru')).toBe('asr-ru')
    expect(selectAvailableLanguage(['en', 'asr-ru'], 'ru,en')).toBe('asr-ru')
    expect(selectAvailableLanguage(['en', 'asr-ru'], 'asr')).toBe('asr-ru')
    expect(selectAvailableLanguage(['en'], 'ru')).toBeUndefined()
  })
})

describe('TranscriptApiClient', () => {
  it('decodes JSON3 fragments without breaking split words or leaking technical fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      language: 'ru',
      events: [{ tStartMs: 199, dDurationMs: 2000, segs: [
        { utf8: 'Лё', tOffsetMs: 0 }, { utf8: 'ня дурёня.', tOffsetMs: 200 },
      ] }],
    }))))
    const client = new TranscriptApiClient('key')
    expect(await client.getTranscript('video')).toEqual({
      language: 'ru', segments: [{ text: 'Лёня дурёня.', startMs: 199, endMs: 2199 }],
    })
    expect(client.getCreditUsage().transcriptCredits).toBe(1)
  })

  it('accounts for a billed successful HTTP response even when captions are invalid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      transcript: [{ text: 42, start: 0, duration: 1 }],
    }))))
    const client = new TranscriptApiClient('key')
    await expect(client.getTranscript('video')).rejects.toMatchObject({ reason: 'not_available' })
    expect(client.getCreditUsage().transcriptCredits).toBe(1)
    expect(client.getTranscriptHttpRequestCount()).toBe(1)
  })

  it('uses X-Credits-Charged as the authoritative provider billing value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      video_id: 'video-one11',
      language: 'ru',
      transcript: [{ text: 'тест', start: 0, duration: 1 }],
    }), {
      status: 200,
      headers: { 'X-Credits-Charged': '2' },
    })))
    const client = new TranscriptApiClient('key')
    await client.getTranscript('video-one11')
    expect(client.getCreditUsage()).toMatchObject({
      transcriptCredits: 2,
      totalCredits: 2,
    })
  })
  it.each([200, 503])('records interrupted HTTP %s bodies and accounts for paid responses', async (status) => {
    const response = new Response('', { status })
    vi.spyOn(response, 'text').mockRejectedValue(new Error('socket closed'))
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)
    const exchanges: unknown[] = []
    const client = new TranscriptApiClient('key', undefined, (item) => { exchanges.push(item) }, {
      sleep: async () => {},
    })
    await expect(client.getTranscript('video')).rejects.toMatchObject({ reason: 'provider_error', status })
    expect(fetchMock).toHaveBeenCalledTimes(status === 200 ? 1 : 3)
    expect(client.getCreditUsage().transcriptCredits).toBe(status === 200 ? 1 : 0)
    expect(exchanges).toHaveLength(status === 200 ? 1 : 3)
  })
  const successfulTranscript = () => new Response(JSON.stringify({
    video_id: 'video-one11',
    language: 'asr-ru',
    transcript: [{ text: 'тест', start: 1, duration: 1 }],
  }), { status: 200 })

  it('uses the free latest-channel endpoint and tracks it as a free request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      channel: {
        channelId: 'UC123',
        title: 'Test channel',
      },
      results: [
        {
          videoId: 'video-one11',
          title: 'Video one',
          published: '2026-09-20T10:00:00Z',
          thumbnail: { url: 'https://example.com/thumb.jpg' },
        },
      ],
    }), { status: 200 }))

    vi.stubGlobal('fetch', fetchMock)

    const client = new TranscriptApiClient('secret-key')
    const result = await client.getLatestVideos('@test')

    expect(result.channel).toEqual({
      id: 'UC123',
      title: 'Test channel',
    })
    expect(result.videos[0]).toEqual({
      id: 'video-one11',
      title: 'Video one',
      publishedAt: '2026-09-20T10:00:00Z',
      thumbnailUrl: 'https://example.com/thumb.jpg',
    })
    expect(client.getCreditUsage()).toEqual({
      transcriptCredits: 0,
      channelVideosCredits: 0,
      totalCredits: 0,
      freeRequests: 1,
    })

    const requestUrl = String(fetchMock.mock.calls[0]?.[0])
    expect(requestUrl).toContain('/youtube/channel/latest')
    expect(requestUrl).toContain('channel=%40test')
  })

  it('treats /youtube/info 404 as no available captions without charging credits', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'No captions' }), { status: 404 }),
    ))

    const client = new TranscriptApiClient('secret-key')
    await expect(client.getVideoInfo('video-one11')).resolves.toEqual({
      available: false,
      languages: [],
    })

    expect(client.getCreditUsage().totalCredits).toBe(0)
  })

  it('uses /youtube/info to filter for the requested transcript language', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      available_languages: [
        { code: 'en', name: 'English' },
        { code: 'asr-ru', name: 'Russian (auto-generated)' },
      ],
    }), { status: 200 })))

    const client = new TranscriptApiClient('secret-key')
    await expect(client.getVideoInfo('video-one11', 'ru')).resolves.toMatchObject({
      available: true,
      matchedLanguage: 'asr-ru',
      languages: ['en', 'asr-ru'],
    })

    expect(client.getCreditUsage().totalCredits).toBe(0)
  })

  it('charges one credit for a successful channel/videos fallback page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [
        {
          videoId: 'video-one11',
          title: 'Video one',
          thumbnails: [{ url: 'https://example.com/thumb.jpg' }],
        },
      ],
      continuation_token: null,
      has_more: false,
    }), { status: 200 })))

    const client = new TranscriptApiClient('secret-key')
    const page = await client.getChannelVideos('@test')

    expect(page.videos).toHaveLength(1)
    expect(client.getCreditUsage()).toMatchObject({
      channelVideosCredits: 1,
      totalCredits: 1,
    })
  })

  it('normalizes transcript timestamps and charges one credit only for success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      video_id: 'video-one11',
      language: 'ru',
      transcript: [
        { text: 'секретный сырой текст', start: 1.25, duration: 2.5 },
      ],
    }), { status: 200 }))

    vi.stubGlobal('fetch', fetchMock)

    const client = new TranscriptApiClient('secret-key')
    const result = await client.getTranscript('video-one11', 'ru,en')

    expect(result).toEqual({
      language: 'ru',
      segments: [
        {
          text: 'секретный сырой текст',
          startMs: 1_250,
          endMs: 3_750,
        },
      ],
    })
    expect(client.getCreditUsage()).toMatchObject({
      transcriptCredits: 1,
      totalCredits: 1,
    })

    const requestUrl = String(fetchMock.mock.calls[0]?.[0])
    expect(requestUrl).toContain('send_metadata=true')
    expect(requestUrl).toContain('include_timestamp=true')
    expect(requestUrl).toContain('language=ru%2Cen')
  })

  it('captures raw diagnostic exchange with a redacted auth header without leaking it through errors', async () => {
    const secretUpstreamBody = 'DO NOT LEAK THIS TRANSCRIPT-LIKE BODY'
    const exchanges: unknown[] = []

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      new Response(secretUpstreamBody, { status: 404 }),
    ))

    const client = new TranscriptApiClient(
      'secret-key',
      undefined,
      (exchange) => exchanges.push(exchange),
    )

    await expect(client.getTranscript('video-one11')).rejects.toMatchObject<Partial<TranscriptApiError>>({
      reason: 'not_available',
    })

    expect(JSON.stringify(exchanges)).toContain(secretUpstreamBody)
    expect(JSON.stringify(exchanges)).toContain('Bearer <redacted>')
    expect(JSON.stringify(exchanges)).not.toContain('secret-key')

    try {
      await client.getTranscript('video-one11')
    } catch (error) {
      expect(String(error)).not.toContain(secretUpstreamBody)
    }
  })

  it.each([
    { statuses: [408, 200], requests: 2 },
    { statuses: [408, 408, 200], requests: 3 },
    { statuses: [503, 200], requests: 2 },
  ])('retries $statuses and charges only the successful transcript', async ({ statuses, requests }) => {
    const fetchMock = vi.fn()
    for (const status of statuses) {
      fetchMock.mockResolvedValueOnce(status === 200
        ? successfulTranscript()
        : new Response(JSON.stringify({ message: 'Request failed, please retry' }), { status }))
    }
    vi.stubGlobal('fetch', fetchMock)
    const trace: unknown[] = []
    const client = new TranscriptApiClient('secret', undefined, undefined, {
      sleep: async () => {},
      traceObserver: (event) => trace.push(event),
    })

    await expect(client.getTranscript('video-one11', 'ru')).resolves.toMatchObject({
      language: 'asr-ru',
    })
    expect(fetchMock).toHaveBeenCalledTimes(requests)
    expect(client.getTranscriptHttpRequestCount()).toBe(requests)
    expect(client.getCreditUsage()).toMatchObject({ transcriptCredits: 1, totalCredits: 1 })
    expect(trace[0]).toEqual({
      event: 'transcript.request',
      videoId: 'video-one11',
      language: 'ru',
      attempt: 1,
      maxAttempts: 3,
    })
    expect(trace).toContainEqual(expect.objectContaining({
      event: 'transcript.retry',
      attempt: 1,
      status: statuses[0],
      providerMessage: 'Request failed, please retry',
      retryInMs: 1_000,
    }))
    expect(trace).toContainEqual(expect.objectContaining({
      event: 'transcript.success',
      attempt: requests,
      language: 'asr-ru',
      chargedCredits: 1,
    }))
  })

  it('emits a deterministic failed trace after three 408 responses', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ message: 'Request failed, please retry' }), { status: 408 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const trace: unknown[] = []
    const client = new TranscriptApiClient('secret', undefined, undefined, {
      sleep: async () => {},
      traceObserver: (event) => trace.push(event),
    })

    await expect(client.getTranscript('video-one11', 'ru')).rejects.toMatchObject({
      reason: 'provider_timeout',
      status: 408,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(client.getCreditUsage().transcriptCredits).toBe(0)
    expect(trace.at(-1)).toEqual(expect.objectContaining({
      event: 'transcript.failed',
      attempts: 3,
      status: 408,
      failureReason: 'provider_timeout',
      providerMessage: 'Request failed, please retry',
    }))
  })

  it('honors Retry-After for 429 and then succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Slow down' }), {
        status: 429,
        headers: { 'Retry-After': '2' },
      }))
      .mockResolvedValueOnce(successfulTranscript()))
    const client = new TranscriptApiClient('secret', undefined, undefined, { sleep })

    await client.getTranscript('video-one11')
    expect(sleep).toHaveBeenCalledWith(2_000)
    expect(client.getCreditUsage().transcriptCredits).toBe(1)
  })

  it('does not retry a 404 transcript response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'No captions' }), { status: 404 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = new TranscriptApiClient('secret', undefined, undefined, {
      sleep: async () => {},
    })

    await expect(client.getTranscript('video-one11')).rejects.toMatchObject({
      reason: 'not_available',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
