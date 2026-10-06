import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTENT_CATEGORIES } from '../shared/types/content'
import { OpenAIAnalysisProvider, OPENAI_PROMPT_VERSION, OPENAI_SCHEMA_VERSION } from '../server/services/openai-analysis'
import { BatchedOpenAIAnalyzer } from '../server/services/openai-batched-analyzer'
import { ProviderScheduler } from '../server/utils/provider-scheduler'
import { restoreSavedTranscript } from './saved-transcript'

// Bounded exploratory measurement of detector variance, not a human accuracy score.
describe.skipIf(process.env.RUN_DETECTOR_STABILITY_EVAL !== '1')('detector batch composition experiment', () => {
  it('compares the same five transcripts alone and together in forward/reverse order', async () => {
    const key = process.env.OPENAI_API_KEY || process.env.NUXT_OPENAI_API_KEY
    if (!key) throw new Error('OpenAI key is required for this paid opt-in experiment.')
    const scan = process.env.DETECTOR_SCAN_DIR ?? 'scan-results/2026-10-06T15-25-28-310Z_ba7c44fb-580b-44ed-aab4-a6269dc01983'
    const [raw, exchangeRaw] = await Promise.all([
      readFile(resolve(scan, 'openai-analysis.json'), 'utf8'),
      readFile(resolve(scan, 'transcriptapi-exchanges.json'), 'utf8'),
    ])
    const entries = JSON.parse(raw) as Array<{
      videoId: string; normalizedTranscript: string
      normalizedTimeline?: Array<{ startMs: number; endMs: number }>
      requestMetadata: { transcriptLanguage: string }
    }>
    const ids = ['edgRlTMnF0o', 'MmdIhSW5B7Q', 'ed7JivZ43xs', 'B7PGgMjJyoQ', 'RmGCg3FRdb8']
    const records = ids.map(videoId => {
      const entry = entries.find(item => item.videoId === videoId)
      if (!entry) throw new Error(`Missing experiment video: ${videoId}`)
      const transcript = restoreSavedTranscript(entry, JSON.parse(exchangeRaw))
      return { videoId, transcript, language: entry.requestMetadata.transcriptLanguage,
        hash: createHash('sha256').update(JSON.stringify(transcript)).digest('hex') }
    })
    const model = process.env.OPENAI_MODEL ?? 'gpt-6-luna'
    const provider = new OpenAIAnalysisProvider(key, model)
    const measurements: unknown[] = []
    const outDir = resolve('benchmark-results/detector-stability')
    await mkdir(outDir, { recursive: true })
    const outputPath = resolve(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    const persist = () => writeFile(outputPath, JSON.stringify({
      model, reasoningEffort: 'low', prompt: OPENAI_PROMPT_VERSION, schema: OPENAI_SCHEMA_VERSION,
      scan, transcriptHashes: Object.fromEntries(records.map(r => [r.videoId, r.hash])),
      note: 'Two orders per configuration; exploratory detector measurement, no reviewer and no human accuracy claim.',
      measurements,
    }, null, 2))
    for (const reverse of [false, true]) {
      // Alternate which configuration runs first to reduce time/order confounding.
      for (const batchMaxItems of reverse ? [5, 1] : [1, 5]) {
        const analyzer = new BatchedOpenAIAnalyzer(provider, new ProviderScheduler({ concurrency: 1, maxRetries: 0 }), {
          batchMaxItems, coalesceMs: 10, batchConcurrency: 1,
        })
        const ordered = reverse ? [...records].reverse() : records
        const started = performance.now()
        try {
          const outputs = await Promise.all(ordered.map(async record => {
            const result = await analyzer.analyze(record.transcript, record.language, [...CONTENT_CATEGORIES], false)
            return { videoId: record.videoId, language: record.language, ...result }
          }))
          measurements.push({ batchMaxItems, reverse, order: ordered.map(r => r.videoId),
            wallMs: Math.round(performance.now() - started), outputs })
          await persist()
          console.log(JSON.stringify({ batchMaxItems, reverse,
            requests: outputs.reduce((sum, r) => sum + r.requestCount, 0),
            candidates: Object.fromEntries(outputs.map(r => [r.videoId, r.classifiedEvents.length])),
          }))
        } catch (error) {
          measurements.push({ batchMaxItems, reverse, failed: true,
            error: error instanceof Error ? error.message : 'Provider failure' })
          await persist()
          throw error
        }
      }
    }
    console.log(`Detector experiment saved: ${outputPath}`)
    expect(measurements).toHaveLength(4)
  }, 900_000)
})
