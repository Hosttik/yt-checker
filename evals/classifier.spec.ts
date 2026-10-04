import { mkdir, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import cases from './content-cases.json'
import { OpenAIAnalysisProvider } from '../server/services/openai-analysis'
import { normalizeTranscript } from '../server/domain/normalize-transcript'
import { validateClassifiedEvents } from '../server/domain/content-validation'
import { applyContentPolicy } from '../server/domain/content-policy'
import type { ContentCategory } from '../shared/types/content'

// Explicit opt-in: these tests make paid provider calls; ordinary npm test stays offline.
describe.skipIf(process.env.RUN_CLASSIFIER_EVAL !== '1')('real classifier regression corpus', () => {
  it.each(cases)('$name', async (fixture) => {
    const key = process.env.OPENAI_API_KEY || process.env.NUXT_OPENAI_API_KEY
    if (!key) throw new Error('OPENAI_API_KEY is required for classifier evaluation')
    const provider = new OpenAIAnalysisProvider(key, process.env.OPENAI_MODEL)
    const transcript = normalizeTranscript(fixture.lines.map((text, index) => ({
      text, startMs: index * 3000, endMs: index * 3000 + 2500,
    })))
    const result = await provider.analyze(transcript, 'asr-ru', fixture.categories as ContentCategory[], false)
    await mkdir('benchmark-results/classifier', { recursive: true })
    await writeFile(`benchmark-results/classifier/${fixture.name}.json`, JSON.stringify({
      result, validation: validateClassifiedEvents(result.classifiedEvents),
    }, null, 2))
    // Required discoveries are checked before validation; missing detections cannot be repaired by policy.
    for (const subtype of fixture.required) {
      expect(result.classifiedEvents.some((event) => event.subtype === subtype)).toBe(true)
    }
    const shown = validateClassifiedEvents(result.classifiedEvents).accepted
      .map((event, index) => applyContentPolicy(event, String(index), 'normal'))
      .filter((event) => event.displayLevel !== 'hidden')
    for (const subtype of fixture.required) expect(shown.some((event) => event.subtype === subtype)).toBe(true)
    for (const forbidden of fixture.forbidden) {
      expect(shown.filter((event) => event.category === forbidden || event.subtype === forbidden)).toEqual([])
    }
  }, 90000)
})
