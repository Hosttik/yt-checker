import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ClassifiedContentEvent, ContentEvent } from '../shared/types/content'
import { restoreSavedTranscript } from './saved-transcript'
import { uncoveredRiskWindows } from '../server/domain/detector-risk-recall'

type ScanRecord = {
  videoId: string
  normalizedTranscript: string
  normalizedTimeline?: Array<{ startMs: number; endMs: number }>
}
type ScanResult = { scanId: string; contentEvents: ContentEvent[] }

function load(root: string) {
  const dir = resolve(root)
  return {
    result: JSON.parse(readFileSync(resolve(dir, 'result.json'), 'utf8')) as ScanResult,
    analysis: JSON.parse(readFileSync(resolve(dir, 'openai-analysis.json'), 'utf8')) as ScanRecord[],
  }
}

function overlapping(a: ContentEvent, b: ContentEvent): boolean {
  return a.startMs <= b.endMs + 3000 && b.startMs <= a.endMs + 3000
}

/** Compare only identical source transcripts. Does not call any provider. */
describe('offline cross-scan detector drift', () => {
  const previousDir = process.env.SCAN_DRIFT_PREVIOUS_DIR
  const currentDir = process.env.SCAN_DRIFT_CURRENT_DIR
  ;(previousDir && currentDir ? it : it.skip)('reports disappearing safety scenes and uncovered risk windows', () => {
    const previous = load(previousDir!)
    const current = load(currentDir!)
    const currentById = new Map(current.analysis.map(record => [record.videoId, record]))
    const diagnostics = previous.analysis.flatMap(old => {
      const next = currentById.get(old.videoId)
      if (!next || next.normalizedTranscript !== old.normalizedTranscript) return []
      const oldEvents = previous.result.contentEvents.filter(event => event.id.startsWith(old.videoId + ':'))
      const newEvents = current.result.contentEvents.filter(event => event.id.startsWith(old.videoId + ':'))
      const disappeared = oldEvents.filter(a => !newEvents.some(b =>
        a.category === b.category && overlapping(a, b)))
      const transcript = restoreSavedTranscript(next, [])
      const uncovered = uncoveredRiskWindows(transcript, newEvents as ClassifiedContentEvent[], 2)
      return [{
        videoId: old.videoId,
        transcriptSha256: createHash('sha256').update(old.normalizedTranscript).digest('hex'),
        oldEventCount: oldEvents.length,
        newEventCount: newEvents.length,
        disappeared: disappeared.map(event => ({
          subtype: event.subtype, category: event.category, startMs: event.startMs,
          parentRelevance: event.parentRelevance, displayLevel: event.displayLevel,
        })),
        proposedTargetedWindows: uncovered.map(window => ({
          startMs: window.startMs, endMs: window.endMs, cue: window.cue,
        })),
      }]
    })
    console.log(JSON.stringify({
      previous: previous.result.scanId, current: current.result.scanId,
      identicalTranscripts: diagnostics.length,
      diagnostics,
    }, null, 2))
    expect(diagnostics.length).toBeGreaterThan(0)
  })
})
