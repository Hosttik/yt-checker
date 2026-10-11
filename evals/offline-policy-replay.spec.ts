import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ClassifiedContentEvent, ContentEvent } from '../shared/types/content'
import { applyContentPolicy } from '../server/domain/content-policy'
import { groundEventCopy } from '../server/domain/content-evidence'
import { buildPresentationScenes } from '../server/domain/content-reporting'

/**
 * Offline deterministic policy replay from a saved result.json.
 *
 * Usage:
 * OFFLINE_POLICY_REPLAY_FILE=scan-results/<scan-id>/result.json npm run eval:offline-policy-replay
 *
 * This intentionally does not invoke TranscriptAPI or OpenAI; it cannot
 * measure detector recall. Human-labelled scenario tests cover calibration.
 */
describe('offline saved-scan policy replay', () => {
  const path = process.env.OFFLINE_POLICY_REPLAY_FILE
  ;(path ? it : it.skip)('reapplies current policy and grounded copy without provider calls', () => {
    const result = JSON.parse(readFileSync(resolve(path!), 'utf8')) as {
      scanId?: string
      profile?: 'normal' | 'strict' | 'diagnostic'
      contentEvents: ContentEvent[]
      videoReports?: Array<{ videoId: string }>
    }
    expect(Array.isArray(result.contentEvents)).toBe(true)
    const profile = result.profile ?? 'normal'
    const updated = result.contentEvents.map(event =>
      applyContentPolicy(groundEventCopy(event as ClassifiedContentEvent), event.id, profile),
    )
    const relevanceChanges = updated.flatMap((event, index) => {
      const old = result.contentEvents[index]!
      return event.parentRelevance !== old.parentRelevance
        ? [{ id: event.id, from: old.parentRelevance, to: event.parentRelevance }]
        : []
    })
    const copyFallbacks = updated.flatMap(event =>
      event.review?.copyGroundingFallback
        ? [{ id: event.id, reason: event.review.copyGroundingFallback }]
        : [],
    )
    const attention = updated.reduce((counts, event) => {
      counts[event.displayLevel]++
      return counts
    }, { hidden: 0, summary: 0, highlight: 0 })
    const perVideo = (result.videoReports ?? []).map(video => {
      const events = updated.filter(event => event.id.startsWith(video.videoId + ':'))
      const scenes = buildPresentationScenes(events)
      return { videoId: video.videoId,
        main: scenes.filter(scene => scene.attention === 'main').length,
        details: scenes.filter(scene => scene.attention === 'details').length }
    })
    console.log(JSON.stringify({
      source: result.scanId ?? path,
      events: updated.length,
      attention,
      relevanceChanges,
      copyFallbacks,
      perVideo,
    }, null, 2))
    expect(updated).toHaveLength(result.contentEvents.length)

    // Check locally curated labels only on their exact originating scan.
    // Other saved scans still produce diagnostic diffs without forced labels.
    const gold = JSON.parse(readFileSync(resolve('evals/gold/compot-2026-10-11.json'), 'utf8')) as {
      scanId: string
      cases: Array<{ videoId: string; startMs: number; attention: 'main' | 'details' | 'hidden' }>
    }
    if (result.scanId === gold.scanId) {
      for (const expected of gold.cases) {
        const events = updated.filter(event => event.id.startsWith(expected.videoId + ':'))
        const scenes = buildPresentationScenes(events)
        const actual = scenes.find(scene =>
          scene.startMs <= expected.startMs && scene.endMs >= expected.startMs,
        )
        expect(actual?.attention ?? 'hidden',
          `${expected.videoId}@${expected.startMs}`).toBe(expected.attention)
      }
    }
  })
})
