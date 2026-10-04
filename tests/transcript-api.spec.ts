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

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
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
})
