export type ChannelRef =
  | { kind: 'handle'; value: string }
  | { kind: 'id'; value: string }
  | { kind: 'username'; value: string }

const CHANNEL_ID_RE = /^UC[\w-]{20,}$/
const HANDLE_RE = /^@[\p{L}\p{N}._-]+$/u

export function resolveChannelRef(input: string): ChannelRef {
  const value = input.trim()

  if (CHANNEL_ID_RE.test(value)) {
    return { kind: 'id', value }
  }

  if (HANDLE_RE.test(value)) {
    return { kind: 'handle', value }
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Enter a YouTube channel URL, @handle, or channel ID.')
  }

  const hostname = url.hostname.replace(/^www\./, '').replace(/^m\./, '')
  if (hostname !== 'youtube.com') {
    throw new Error('Only youtube.com channel URLs are supported.')
  }

  const parts = url.pathname.split('/').filter(Boolean)
  const first = parts[0]

  if (!first) {
    throw new Error('The URL does not identify a YouTube channel.')
  }

  if (first.startsWith('@') && HANDLE_RE.test(first)) {
    return { kind: 'handle', value: first }
  }

  if (first === 'channel' && parts[1] && CHANNEL_ID_RE.test(parts[1])) {
    return { kind: 'id', value: parts[1] }
  }

  if (first === 'user' && parts[1]) {
    return { kind: 'username', value: parts[1] }
  }

  throw new Error('Unsupported channel URL. Use /@handle, /channel/UC..., or /user/....')
}
