import type { TranscriptSegment } from './transcript'

const NON_SEMANTIC_MUSIC = /^\s*(?:\[(?:музыка|music|instrumental)\]|\((?:музыка|music|instrumental)\))\s*[.!…-]*\s*$/iu

export interface NormalizedTranscript {
  text: string
  sourceText: string
  segments: TranscriptSegment[]
}

function cleanCaption(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function overlapWordCount(previous: string, current: string): number {
  const left = previous.split(/\s+/)
  const right = current.split(/\s+/)
  const max = Math.min(left.length, right.length)
  for (let count = max; count > 0; count -= 1) {
    const suffix = left.slice(-count).join(' ').toLocaleLowerCase()
    const prefix = right.slice(0, count).join(' ').toLocaleLowerCase()
    if (suffix === prefix) return count
  }
  return 0
}

export function formatTranscriptTimestamp(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms))
  const hours = Math.floor(safeMs / 3_600_000)
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000)
  const seconds = Math.floor((safeMs % 60_000) / 1_000)
  const millis = safeMs % 1_000
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
    + `.${String(millis).padStart(3, '0')}`
}

export function normalizeTranscript(input: TranscriptSegment[]): NormalizedTranscript {
  const sorted = [...input].sort((a, b) => a.startMs - b.startMs)
  const normalized: TranscriptSegment[] = []

  for (const segment of sorted) {
    if (typeof segment.text !== 'string' || !Number.isFinite(segment.startMs)
      || !Number.isFinite(segment.endMs) || segment.startMs < 0 || segment.endMs < segment.startMs) {
      throw new Error('Invalid caption segment.')
    }
    let text = cleanCaption(segment.text)
    if (!text || NON_SEMANTIC_MUSIC.test(text)) continue

    const previous = normalized.at(-1)
    if (previous && segment.startMs < previous.endMs) {
      const recentText = normalized.filter((item) => item.endMs > segment.startMs).map((item) => item.text).join(' ')
      const overlap = overlapWordCount(recentText, text)
      if (overlap > 0) text = text.split(/\s+/).slice(overlap).join(' ').trim()
      if (!text) continue
    }

    normalized.push({
      text,
      startMs: Math.max(0, Math.round(segment.startMs)),
      endMs: Math.max(Math.round(segment.endMs), Math.round(segment.startMs)),
    })
  }

  return {
    text: normalized.map((segment, index) => `[${index}] ${segment.text}`).join('\n'),
    sourceText: normalized.map((segment) => segment.text).join(' '),
    segments: normalized,
  }
}
