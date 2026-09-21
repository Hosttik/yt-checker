import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranscriptApiClient, TranscriptApiError } from '../server/services/transcript-api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TranscriptApiClient', () => {
  it('uses the free latest-channel endpoint and maps only video metadata', async () => {
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
          description: 'This field must not be propagated.',
        },
      ],
    }), { status: 200 }))

    vi.stubGlobal('fetch', fetchMock)

    const client = new TranscriptApiClient('secret-key')
    const result = await client.getRecentVideos('@test', 10)

    expect(result).toEqual({
      channel: {
        id: 'UC123',
        title: 'Test channel',
      },
      videos: [
        {
          id: 'video-one11',
          title: 'Video one',
          publishedAt: '2026-09-20T10:00:00Z',
          thumbnailUrl: 'https://example.com/thumb.jpg',
        },
      ],
    })

    const requestUrl = String(fetchMock.mock.calls[0]?.[0])
    expect(requestUrl).toContain('/youtube/channel/latest')
    expect(requestUrl).toContain('channel=%40test')
  })

  it('normalizes transcript timestamps but keeps raw text server-side only', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      video_id: 'video-one11',
      language: 'ru',
      transcript: [
        { text: 'секретный сырой текст', start: 1.25, duration: 2.5 },
      ],
    }), { status: 200 }))

    vi.stubGlobal('fetch', fetchMock)

    const client = new TranscriptApiClient('secret-key')
    const result = await client.getTranscript('video-one11')

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

    const requestUrl = String(fetchMock.mock.calls[0]?.[0])
    expect(requestUrl).toContain('send_metadata=false')
    expect(requestUrl).toContain('include_timestamp=true')
  })

  it('does not expose upstream response bodies in provider errors', async () => {
    const secretUpstreamBody = 'DO NOT LEAK THIS TRANSCRIPT-LIKE BODY'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(secretUpstreamBody, { status: 404 }),
    ))

    const client = new TranscriptApiClient('secret-key')

    await expect(client.getTranscript('video-one11')).rejects.toMatchObject<Partial<TranscriptApiError>>({
      reason: 'not_available',
      message: 'Transcript is unavailable from the provider.',
    })

    try {
      await client.getTranscript('video-one11')
    } catch (error) {
      expect(String(error)).not.toContain(secretUpstreamBody)
    }
  })
})
