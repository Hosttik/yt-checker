import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { uncoveredRiskWindows } from '../server/domain/detector-risk-recall'
import { restoreSavedTranscript } from './saved-transcript'
import type { ClassifiedContentEvent, ContentEvent } from '../shared/types/content'

type RecordWithSavedTranscript = {
  videoId: string
  normalizedTranscript: string
  normalizedTimeline?: Array<{ startMs: number; endMs: number }>
}
type StoredScan = { contentEvents: ContentEvent[] }

/**
 * Replays the EXACT normalized ASR text from the uploaded 2026-10-11 scan.
 * No model/API usage; saved full transcripts remain outside source control.
 *
 * DETECTOR_RECALL_REPLAY_ANALYSIS='/path/openai-analysis.json'
 * DETECTOR_RECALL_REPLAY_RESULT='/path/result.json'
 * npm run eval:detector-recall
 */
describe('offline targeted risk recall against real saved scan', () => {
  const analysisPath = process.env.DETECTOR_RECALL_REPLAY_ANALYSIS
  const resultPath = process.env.DETECTOR_RECALL_REPLAY_RESULT
  ;(analysisPath && resultPath ? it : it.skip)('finds unreported police aiming while ignoring covered armed pursuit', () => {
    const analyses = JSON.parse(readFileSync(resolve(analysisPath!), 'utf8')) as RecordWithSavedTranscript[]
    const result = JSON.parse(readFileSync(resolve(resultPath!), 'utf8')) as StoredScan

    const check = (videoId: string) => {
      const record = analyses.find(item => item.videoId === videoId)
      expect(record, 'Missing saved ' + videoId).toBeDefined()
      const transcript = restoreSavedTranscript(record!, [])
      const currentEvents = result.contentEvents.filter(item => item.id.startsWith(videoId + ':'))
      return uncoveredRiskWindows(transcript, currentEvents as ClassifiedContentEvent[], 1)
    }

    const police = check('edgRlTMnF0o')
    expect(police.some(window => window.startMs <= 480_000
      && window.endMs >= 480_000), 'Implicit aimed-threat window missing').toBe(true)

    const pursuit = check('_xR7fZ24O4g')
    expect(pursuit.some(window => window.startMs <= 578_720
      && window.endMs >= 578_720), 'Covered armed pursuit must not trigger redundant recall').toBe(false)
  })
})
