import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChannelCheckResponse } from '../shared/types/check'
import { ScanStorage } from '../server/services/scan-storage'

const result: ChannelCheckResponse = {
  storageMode: 'minimal', channel: { id: 'UC1', title: 'Test' },
  requestedVideos: 1, analyzedVideos: 1, failedVideos: 0,
  analysisMode: 'openai', contextualFallbackVideos: 0,
  creditUsage: { transcriptCredits: 1, channelVideosCredits: 0, totalCredits: 1, freeRequests: 2 },
  openaiUsage: { requests: 1, inputTokens: 10, outputTokens: 5, reasoningTokens: 2, totalTokens: 17 },
  selection: {
    targetVideos: 1, inspectedVideos: 1, captionEligibleVideos: 1,
    transcriptAttempts: 1, transcriptVideosAttempted: 1, transcriptHttpRequests: 1,
    usedChannelVideosFallback: false, requestedLanguage: 'ru',
  },
  summary: [],
  videos: [{
    id: 'video-one11', title: 'One', publishedAt: '',
    url: 'https://www.youtube.com/watch?v=video-one11', status: 'analyzed',
    violations: [], detections: [],
  }],
  limitations: [],
}

describe('ScanStorage', () => {
  it('minimal mode writes only result.json without transcript text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yt-checker-minimal-'))
    const storage = new ScanStorage('minimal', root, false)
    await storage.save({ ...result, scanId: storage.scanId })
    expect(await readdir(join(root, storage.scanId))).toEqual(['result.json'])
  })

  it('diagnostic mode writes redacted provider data and OpenAI diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yt-checker-diagnostic-'))
    expect(() => new ScanStorage('diagnostic', root, false)).toThrow(/disabled/i)
    const storage = new ScanStorage('diagnostic', root, true)
    storage.recordOpenAISuccess('video-one11', {
      violations: [], rejectedCandidates: [],
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2, totalTokens: 17 },
      rawResponse: { id: 'resp_1', output_parsed: { violations: [], rejectedCandidates: [] } },
      requestMetadata: {
        model: 'gpt-6-luna', reasoningEffort: 'low', transcriptLanguage: 'ru',
        enabledCategories: ['violence'], diagnostic: true,
      },
    }, '[00:00:00.000] Нормализованный transcript')
    await storage.save({ ...result, storageMode: 'diagnostic', scanId: storage.scanId })
    expect((await readdir(join(root, storage.scanId))).sort()).toEqual([
      'openai-analysis.json', 'result.json', 'transcriptapi-exchanges.json',
    ])
    const diagnostic = await readFile(join(root, storage.scanId, 'openai-analysis.json'), 'utf8')
    expect(diagnostic).toContain('Нормализованный transcript')
    expect(diagnostic).toContain('reasoningTokens')
    expect(diagnostic).not.toContain('secret')
  })
})
