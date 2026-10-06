import { describe, expect, it } from 'vitest'
import { restoreSavedTranscript } from '../evals/saved-transcript'
import { buildReviewContextText } from '../server/services/openai-analysis'

describe('production transcript replay', () => {
  it('restores real timings and therefore excludes distant speech from review windows', () => {
    const entry = { videoId: 'v', normalizedTranscript: '[0] Угроза.\n[1] Позднее спасение.' }
    const transcript = restoreSavedTranscript(entry, [{
      operation: 'transcript', response: { status: 200, bodyJson: {
        video_id: 'v', transcript: [
          { text: 'Угроза.', start: 1, duration: 2 },
          { text: 'Позднее спасение.', start: 600, duration: 2 },
        ],
      } },
    }])
    expect(transcript.segments[1]!.startMs).toBe(600_000)
    const context = buildReviewContextText(transcript, [{ startMs: 1_000, endMs: 3_000 } as never])
    expect(context).toContain('Угроза.')
    expect(context).not.toContain('Позднее спасение.')
  })

  it('uses stored normalized timings without cleaning overlapping words a second time', () => {
    const entry = {
      videoId: 'v', normalizedTranscript: '[0] Нет.\n[1] Нет.',
      normalizedTimeline: [{ startMs: 0, endMs: 1000 }, { startMs: 500, endMs: 1500 }],
    }
    expect(restoreSavedTranscript(entry, []).text).toBe(entry.normalizedTranscript)
    expect(restoreSavedTranscript(entry, []).segments).toHaveLength(2)
  })

  it('rejects missing or mismatched timings instead of silently fabricating a timeline', () => {
    const entry = { videoId: 'v', normalizedTranscript: '[0] Угроза.' }
    expect(() => restoreSavedTranscript(entry, [])).toThrow('Cannot restore original timestamps')
    expect(() => restoreSavedTranscript({ ...entry, normalizedTimeline: [] }, [])).toThrow('length mismatch')
    expect(() => restoreSavedTranscript({ ...entry, normalizedTimeline: [{ startMs: 9, endMs: 1 }] }, [])).toThrow('Invalid saved transcript timeline')
  })
})
