import exposure from '../evals/tuning-exposure.json'
import { describe, expect, it } from 'vitest'
import { auditHumanGold, transcriptFingerprint, validateHumanGold, type HumanGold } from '../evals/human-gold'
import { normalizeTranscript } from '../server/domain/normalize-transcript'
import type { PresentationScene } from '../shared/types/content'

const transcript = normalizeTranscript([{ text: 'An event.', startMs: 1000, endMs: 2000 }])
const sources = new Map([['video', transcript]])
function gold(): HumanGold {
  return { version: 1, videos: [{ videoId: 'video', channelId: 'channel', transcriptHash: transcriptFingerprint(transcript),
    split: 'holdout', previouslyUsedForTuning: false, complete: true, reviewerId: 'human-1', reviewedAt: '2026-10-07T00:00:00Z',
    blindedToModelOutput: true, reviewedEntireTranscript: true,
    labels: [{ id: 'scene', categories: ['violence'], evidence: [{ firstSegment: 0, lastSegment: 0 }], priority: 'main', level: 'moderate', rationale: 'Test gold.' }] }] }
}
function card(): PresentationScene {
  return { attention: 'main', level: 'moderate', events: [{ category: 'violence', startMs: 1000, endMs: 2000 }] } as PresentationScene
}
function audit(value: HumanGold, cards: PresentationScene[]) {
  return auditHumanGold(value, sources, new Map([['video', cards]]), 'holdout')
}
describe('human gold evaluation', () => {
  it('rejects an exposed channel even when the input claims it was never used for tuning', () => {
    const value = gold(); value.videos[0]!.channelId = exposure.channelIds[0]!
    expect(() => validateHumanGold(value, sources)).toThrow('cannot be holdout')
  })

  it('does not count duplicates as multiple useful warnings', () => {
    expect(audit(gold(), [card(), card()])).toMatchObject({ candidateMainPrecision: 0.5, candidateMainRecall: 1, unmatchedMainCards: 1 })
  })
  it('does not give a main warning credit for a detail-only label', () => {
    const value = gold(); value.videos[0]!.labels[0]!.priority = 'details'
    expect(audit(value, [card()])).toMatchObject({ candidateMainPrecision: 0, unmatchedMainCards: 1, candidateMainRecall: null })
  })
  it('reports excessive high separately and records misses', () => {
    expect(audit(gold(), [{ ...card(), level: 'high' }]).excessiveHighCards).toBe(1)
    expect(audit(gold(), [])).toMatchObject({ candidateMainPrecision: null, candidateMainRecall: 0, missedMainScenes: 1 })
  })
  it('does not score an incomplete empty template as a negative example', () => {
    const value = gold(); value.videos[0]!.complete = false; value.videos[0]!.labels = []
    expect(audit(value, [card()])).toMatchObject({ evaluatedVideos: 0, candidateMainPrecision: null, pendingVideos: 1 })
  })
  it('counts warnings on a fully reviewed negative video as unmatched', () => {
    const value = gold(); value.videos[0]!.labels = []
    expect(audit(value, [card()])).toMatchObject({ evaluatedVideos: 1, unmatchedMainCards: 1, candidateMainPrecision: 0 })
  })
  it('rejects contamination, changed timing, incomplete provenance and invalid ranges', () => {
    const contaminated = gold(); contaminated.videos[0]!.previouslyUsedForTuning = true
    expect(() => validateHumanGold(contaminated, sources)).toThrow('cannot be holdout')
    const changed = normalizeTranscript([{ text: 'An event.', startMs: 9000, endMs: 10000 }])
    expect(() => validateHumanGold(gold(), new Map([['video', changed]]))).toThrow('mismatch')
    const anonymous = gold(); anonymous.videos[0]!.reviewerId = null
    expect(() => validateHumanGold(anonymous, sources)).toThrow('named human')
    const invalid = gold(); invalid.videos[0]!.labels[0]!.evidence[0]!.lastSegment = 9
    expect(() => validateHumanGold(invalid, sources)).toThrow('Invalid gold evidence')
  })
  it('does not match an adjacent event touching only the evidence boundary', () => {
    const scene = card(); scene.events[0]!.startMs = 2000; scene.events[0]!.endMs = 3000
    expect(audit(gold(), [scene]).matchedMainCards).toBe(0)
  })
})
