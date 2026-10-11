import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChannelCheckResponse } from '../shared/types/check'

interface Control {
  id: string
  videoId: string
  atMs?: number
  mode: 'required_main' | 'required_event' | 'no_main'
  notes: string
}
interface Fixture { status: string; cases: Control[] }

const fixture = JSON.parse(readFileSync(resolve('evals/gold/compot-recall-controls.json'), 'utf8')) as Fixture

function evaluate(scan: ChannelCheckResponse, control: Control) {
  const events = scan.contentEvents.filter(event => event.id.startsWith(control.videoId + ':'))
  const report = scan.videoReports.find(video => video.videoId === control.videoId)
  const available = scan.videos.some(video => video.id === control.videoId && video.status === 'analyzed')
  if (!available) return { status: 'not_in_scan' as const }
  const toleranceMs = 5_000
  const eventFound = control.atMs === undefined
    ? events.length > 0
    : events.some(event =>
      event.startMs <= control.atMs! + toleranceMs
      && event.endMs >= control.atMs! - toleranceMs)
  const mainFound = control.atMs === undefined
    ? Boolean(report?.scenes.some(scene => scene.attention === 'main'))
    : Boolean(report?.scenes.some(scene =>
      scene.attention === 'main'
      && scene.startMs <= control.atMs! + toleranceMs
      && scene.endMs >= control.atMs! - toleranceMs))
  const passed = control.mode === 'no_main'
    ? !mainFound
    : control.mode === 'required_main' ? eventFound && mainFound : eventFound
  return { status: passed ? 'pass' as const : 'miss' as const, eventFound, mainFound }
}

/**
 * Example:
 * SCAN_RECALL_RESULTS='/path/old/result.json;/path/new/result.json' npm run eval:scan-recall
 *
 * Opt-in because recorded full scans are intentionally not committed to Git.
 * Historical old-model misses remain useful diagnostics; use
 * SCAN_RECALL_ENFORCE=1 to enforce the selected scan's benchmark.
 */
describe('fixed-scene recall and attention controls', () => {
  const paths = process.env.SCAN_RECALL_RESULTS?.split(';').filter(Boolean) ?? []
  const enforce = process.env.SCAN_RECALL_ENFORCE === '1'
  ;(paths.length || enforce ? it : it.skip)('checks exact video/time against manually defined controls', () => {
    if (enforce) {
      expect(paths.length, 'Strict fixed-scene eval requires SCAN_RECALL_RESULTS').toBeGreaterThan(0)
    }
    let totalMeasured = 0
    let misses = 0
    let absentRequired = 0
    const runs = paths.map((path) => {
      const filename = path.endsWith('.json') ? resolve(path) : resolve(join(path, 'result.json'))
      const scan = JSON.parse(readFileSync(filename, 'utf8')) as ChannelCheckResponse
      const measurements = fixture.cases.map((control) => ({
        id: control.id, mode: control.mode, ...evaluate(scan, control),
      }))
      totalMeasured += measurements.filter(item => item.status !== 'not_in_scan').length
      misses += measurements.filter(item => item.status === 'miss').length
      absentRequired += measurements.filter(item =>
        item.mode !== 'no_main' && item.status === 'not_in_scan').length
      const required = measurements.filter(item =>
        item.mode !== 'no_main' && item.status !== 'not_in_scan')
      return {
        scan: scan.scanId ?? filename,
        totalMs: scan.timings?.totalMs,
        openaiRequests: scan.openaiUsage.requests,
        detectorRiskRecallRequests: scan.openaiRequests?.detectorRiskRecallRequests ?? 0,
        requiredFound: required.filter(item => item.status === 'pass').length,
        requiredTotal: required.length,
        failures: measurements.filter(item => item.status === 'miss'),
        measurements,
      }
    })
    console.log(JSON.stringify({ reference: fixture.status, totalMeasured, misses, runs }, null, 2))
    expect(totalMeasured, 'No videos matching the benchmark controls').toBeGreaterThan(0)
    if (enforce) {
      expect(absentRequired, 'Strict benchmark cannot pass with missing mandatory videos').toBe(0)
      expect(misses, 'Fixed-scene mandatory recall/attention regressions').toBe(0)
    }
  })
  it('identifies missing and present mandatory scene controls using time-aligned evidence', () => {
    const sample = {
      videos: [{ id: 'edgRlTMnF0o', status: 'analyzed' }],
      contentEvents: [],
      videoReports: [{ videoId: 'edgRlTMnF0o', scenes: [] }],
    } as unknown as ChannelCheckResponse
    const police = fixture.cases.find(control => control.id === 'directed-police-weapon-threat')!
    expect(evaluate(sample, police).status).toBe('miss')
    const absent = fixture.cases.find(control => control.id === 'armed-pursuit')!
    expect(evaluate(sample, absent).status).toBe('not_in_scan')
  })
})
