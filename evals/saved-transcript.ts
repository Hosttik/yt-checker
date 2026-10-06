import { normalizeTranscript, type NormalizedTranscript } from '../server/domain/normalize-transcript'
import { parseTranscriptApiSegments } from '../server/services/transcript-api'

interface SavedTranscript {
  videoId: string
  normalizedTranscript: string
  normalizedTimeline?: Array<{ startMs: number; endMs: number }>
}

/** Replay uses the production timeline: review windows and chunk overlap depend on it. */
export function restoreSavedTranscript(entry: SavedTranscript, exchanges: unknown[]): NormalizedTranscript {
  if (entry.normalizedTimeline) {
    const lines = entry.normalizedTranscript.split('\n')
    if (lines.length !== entry.normalizedTimeline.length) throw new Error('Saved transcript timeline length mismatch.')
    const segments = lines.map((line, index) => {
      const prefix = `[${index}] `
      if (!line.startsWith(prefix)) throw new Error('Invalid saved transcript segment index.')
      return { ...entry.normalizedTimeline![index]!, text: line.slice(prefix.length) }
    })
    // Validate without normalizing twice: overlapping captions have already been cleaned.
    if (segments.some((s, i) => !Number.isFinite(s.startMs) || !Number.isFinite(s.endMs)
      || s.startMs < 0 || s.endMs < s.startMs || (i > 0 && s.startMs < segments[i - 1]!.startMs))) {
      throw new Error('Invalid saved transcript timeline.')
    }
    return { text: entry.normalizedTranscript, sourceText: segments.map(s => s.text).join(' '), segments }
  }

  for (const value of exchanges) {
    const exchange = value as {
      operation?: string
      response?: { status?: number; bodyJson?: Parameters<typeof parseTranscriptApiSegments>[0] }
    }
    const body = exchange.response?.bodyJson
    if (exchange.operation !== 'transcript' || exchange.response?.status !== 200 || body?.video_id !== entry.videoId) continue
    const normalized = normalizeTranscript(parseTranscriptApiSegments(body))
    if (normalized.text === entry.normalizedTranscript) return normalized
  }
  throw new Error(`Cannot restore original timestamps for ${entry.videoId}; save a diagnostic scan with a matching transcript exchange or normalizedTimeline. Synthetic timestamps cannot evaluate production review windows.`)
}
