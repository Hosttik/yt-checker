import type { ChannelMetadata, VideoMetadata } from '../../shared/types/check'
import { resolveChannelRef } from '../domain/channel-ref'

interface ChannelListResponse {
  items?: Array<{
    id: string
    snippet?: {
      title?: string
      thumbnails?: {
        default?: { url?: string }
        medium?: { url?: string }
        high?: { url?: string }
      }
    }
    contentDetails?: {
      relatedPlaylists?: {
        uploads?: string
      }
    }
  }>
  error?: {
    message?: string
  }
}

interface PlaylistItemsResponse {
  items?: Array<{
    snippet?: {
      title?: string
      publishedAt?: string
      resourceId?: {
        videoId?: string
      }
      thumbnails?: {
        default?: { url?: string }
        medium?: { url?: string }
        high?: { url?: string }
      }
    }
  }>
  error?: {
    message?: string
  }
}

function bestThumbnail(
  thumbnails?: {
    default?: { url?: string }
    medium?: { url?: string }
    high?: { url?: string }
  },
): string | undefined {
  return thumbnails?.high?.url ?? thumbnails?.medium?.url ?? thumbnails?.default?.url
}

export class YouTubeClient {
  private readonly baseUrl = 'https://www.googleapis.com/youtube/v3'

  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error('YouTube API key is not configured.')
    }
  }

  async resolveChannel(input: string): Promise<ChannelMetadata> {
    const ref = resolveChannelRef(input)
    const url = new URL(`${this.baseUrl}/channels`)
    url.searchParams.set('part', 'snippet,contentDetails')
    url.searchParams.set('key', this.apiKey)

    if (ref.kind === 'handle') {
      url.searchParams.set('forHandle', ref.value)
    } else if (ref.kind === 'id') {
      url.searchParams.set('id', ref.value)
    } else {
      url.searchParams.set('forUsername', ref.value)
    }

    const response = await fetch(url)
    const data = (await response.json()) as ChannelListResponse

    if (!response.ok) {
      throw new Error(data.error?.message ?? `YouTube API returned ${response.status}.`)
    }

    const item = data.items?.[0]
    const uploadsPlaylistId = item?.contentDetails?.relatedPlaylists?.uploads

    if (!item || !uploadsPlaylistId) {
      throw new Error('YouTube channel was not found or has no uploads playlist.')
    }

    return {
      id: item.id,
      title: item.snippet?.title ?? item.id,
      uploadsPlaylistId,
      thumbnailUrl: bestThumbnail(item.snippet?.thumbnails),
    }
  }

  async listRecentVideos(uploadsPlaylistId: string, limit: number): Promise<VideoMetadata[]> {
    const url = new URL(`${this.baseUrl}/playlistItems`)
    url.searchParams.set('part', 'snippet,contentDetails')
    url.searchParams.set('playlistId', uploadsPlaylistId)
    url.searchParams.set('maxResults', String(Math.min(Math.max(limit, 1), 50)))
    url.searchParams.set('key', this.apiKey)

    const response = await fetch(url)
    const data = (await response.json()) as PlaylistItemsResponse

    if (!response.ok) {
      throw new Error(data.error?.message ?? `YouTube API returned ${response.status}.`)
    }

    return (data.items ?? []).flatMap((item) => {
      const videoId = item.snippet?.resourceId?.videoId
      if (!videoId) return []

      return [{
        id: videoId,
        title: item.snippet?.title ?? videoId,
        publishedAt: item.snippet?.publishedAt ?? '',
        thumbnailUrl: bestThumbnail(item.snippet?.thumbnails),
      }]
    })
  }
}
