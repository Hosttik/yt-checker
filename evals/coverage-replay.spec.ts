import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTENT_CATEGORIES, type ClassifiedContentEvent } from '../shared/types/content'
import { OpenAIAnalysisProvider } from '../server/services/openai-analysis'
import { restoreSavedTranscript } from './saved-transcript'
import { applyContentPolicy } from '../server/domain/content-policy'
import { normalizeClassifiedEvents } from '../server/domain/content-normalization'
import { validateClassifiedEvents } from '../server/domain/content-validation'
import { buildPresentationScenes } from '../server/domain/content-reporting'

describe.skipIf(process.env.RUN_COVERAGE_REPLAY !== '1')('verified coverage replay', () => {
  it('measures known omissions and a benign control without claiming human accuracy', async () => {
    const key = process.env.OPENAI_API_KEY || process.env.NUXT_OPENAI_API_KEY
    if (!key) throw new Error('API key required for paid opt-in replay.')
    const scan = 'scan-results/2026-10-06T15-25-28-310Z_ba7c44fb-580b-44ed-aab4-a6269dc01983'
    const entries = JSON.parse(await readFile(resolve(scan, 'openai-analysis.json'), 'utf8'))
    const exchanges = JSON.parse(await readFile(resolve(scan, 'transcriptapi-exchanges.json'), 'utf8'))
    const detector = JSON.parse(await readFile(resolve(process.env.COVERAGE_DETECTOR_RESULT
      ?? 'benchmark-results/detector-stability/2026-10-06T18-22-55-602Z.json'), 'utf8'))
    const provider = new OpenAIAnalysisProvider(key, process.env.OPENAI_MODEL ?? 'gpt-6-luna')
    const cases = [
      { videoId: 'MmdIhSW5B7Q', reverse: false, note: 'Nonempty detector missed pleas for help/cessation.' },
      { videoId: 'ed7JivZ43xs', reverse: true, note: 'Empty detector missed lightning and a request to stop.' },
      { videoId: 'B7PGgMjJyoQ', reverse: false, note: 'Benign sword demonstration control.' },
    ]
    const results: unknown[] = []
    const directory = resolve('benchmark-results/coverage-replay')
    await mkdir(directory, { recursive: true })
    const path = resolve(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    for (const item of cases) {
      const entry = entries.find((entry: { videoId: string }) => entry.videoId === item.videoId)
      const transcript = restoreSavedTranscript(entry, exchanges)
      const measurement = detector.measurements.find((m: { batchMaxItems: number; reverse: boolean }) => m.batchMaxItems === 1 && m.reverse === item.reverse)
      const existing: ClassifiedContentEvent[] = measurement.outputs.find((o: { videoId: string }) => o.videoId === item.videoId).classifiedEvents
      const result = await provider.verifiedCoverage(transcript, entry.requestMetadata.transcriptLanguage, [...CONTENT_CATEGORIES], existing)
      const validated = validateClassifiedEvents(result.rescuedEvents)
      const events = normalizeClassifiedEvents(validated.accepted).map((event, index) => applyContentPolicy(event, `replay:${index}`, 'normal'))
      const scenes = buildPresentationScenes(events)
      results.push({ ...item, detectorEvents: existing.length, result, scenes, validationRejections: validated.rejected })
      await writeFile(path, JSON.stringify({ note: 'Exploratory replay on saved detector outputs, not a human accuracy or end-to-end production evaluation.', results }, null, 2))
      console.log(JSON.stringify({ videoId: item.videoId, requests: result.requestCount, rescued: result.rescuedCandidates,
        verified: result.verificationComplete, main: scenes.filter(s => s.attention === 'main').length,
        summaries: scenes.map(s => s.summary) }))
    }
    console.log(`Coverage replay saved: ${path}`)
    expect(results).toHaveLength(3)
  }, 600_000)
})
