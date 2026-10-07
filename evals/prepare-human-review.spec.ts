import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { restoreSavedTranscript } from './saved-transcript'
import { transcriptFingerprint, validateHumanGold, type HumanGold } from './human-gold'
import type { NormalizedTranscript } from '../server/domain/normalize-transcript'

// No model/API calls. The existing local corpus is tuning data, never holdout.
describe.skipIf(process.env.PREPARE_HUMAN_REVIEW !== '1')('prepare blind human review', () => {
  it('exports complete transcripts and blank annotations without model findings', async () => {
    const root = resolve('scan-results')
    const output = resolve('benchmark-results/human-review')
    const sources = new Map<string, NormalizedTranscript>()
    const gold: HumanGold = { version: 1, videos: [] }
    const inventory: Array<{ scan: string; videoId: string; channelId: string; transcriptHash: string }> = []
    const skipped: Array<{ scan: string; reason: string }> = []
    await mkdir(join(output, 'transcripts'), { recursive: true })
    const scanDirs = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse()
    for (const scan of scanDirs) {
      try {
        const result = JSON.parse(await readFile(join(root, scan, 'result.json'), 'utf8'))
        const diagnostics = JSON.parse(await readFile(join(root, scan, 'openai-analysis.json'), 'utf8'))
        const exchanges = JSON.parse(await readFile(join(root, scan, 'transcriptapi-exchanges.json'), 'utf8'))
        for (const entry of diagnostics) {
          if (!entry.normalizedTranscript || sources.has(entry.videoId)) continue
          // Video ids are used in filenames; only accept YouTube's identifier alphabet.
          if (!/^[A-Za-z0-9_-]{11}$/.test(entry.videoId)) throw new Error('Invalid video id')
          const transcript = restoreSavedTranscript(entry, exchanges)
          const fingerprint = transcriptFingerprint(transcript)
          const channelId = result.channel?.id
          if (!channelId) throw new Error('Missing channel id')
          sources.set(entry.videoId, transcript)
          gold.videos.push({ videoId: entry.videoId, channelId, transcriptHash: fingerprint,
            split: 'tuning', previouslyUsedForTuning: true, complete: false,
            reviewerId: null, reviewedAt: null, blindedToModelOutput: null, reviewedEntireTranscript: null, labels: [] })
          inventory.push({ scan, videoId: entry.videoId, channelId, transcriptHash: fingerprint })
          const lines = transcript.segments.map((s, i) => `[${i}] ${(s.startMs / 1000).toFixed(3)}–${(s.endMs / 1000).toFixed(3)} сек. ${s.text}`)
          await writeFile(join(output, 'transcripts', `${entry.videoId}.md`), `# ${entry.videoId}\n\nПолные субтитры. Ответов модели здесь нет.\n\n${lines.join('\n\n')}\n`)
        }
      } catch (error) {
        skipped.push({ scan, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    validateHumanGold(gold, sources)
    // Never overwrite a human's edited answers; the template has a distinct filename.
    await writeFile(join(output, 'annotations.template.json'), JSON.stringify(gold, null, 2))
    await writeFile(join(output, 'inventory.json'), JSON.stringify({ inventory, skipped }, null, 2))
    const instructions = await readFile(resolve('docs/audit/human-review-guide.md'), 'utf8')
    await writeFile(join(output, 'README.md'), instructions + '\n\n## Доступные транскрипты\n\n'
      + gold.videos.map(v => `- [${v.videoId}](transcripts/${v.videoId}.md) — tuning`).join('\n') + '\n')
    console.log(JSON.stringify({ output, videos: gold.videos.length, channels: new Set(gold.videos.map(v => v.channelId)).size, holdout: 0, humanCompleted: 0 }))
    expect(gold.videos.length).toBeGreaterThan(0)
  })
})
