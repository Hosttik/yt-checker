import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChannelCheckResponse } from '../shared/types/check'
import { ScanStorage } from '../server/services/scan-storage'

const result: ChannelCheckResponse = {
  storageMode: 'minimal',
  channel: { id: 'UC1', title: 'Test' },
  requestedVideos: 10,
  analyzedVideos: 1,
  failedVideos: 0,
  analysisMode: 'regex_only',
  contextualFallbackVideos: 0,
  creditUsage: {
    transcriptCredits: 1,
    channelVideosCredits: 0,
    totalCredits: 1,
    freeRequests: 3,
  },
  selection: {
    targetVideos: 10,
    inspectedVideos: 1,
    captionEligibleVideos: 1,
    transcriptAttempts: 1,
    usedChannelVideosFallback: false,
  },
  summary: [],
  videos: [],
  limitations: [],
}

describe('ScanStorage', () => {
  it('minimal mode writes only the derived result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yt-checker-minimal-'))
    const storage = new ScanStorage('minimal', root, false)
    await storage.save({ ...result, scanId: storage.scanId })

    const files = await readdir(join(root, storage.scanId))
    expect(files).toEqual(['result.json'])

    const content = await readFile(join(root, storage.scanId, 'result.json'), 'utf8')
    expect(content).not.toContain('raw transcript')
  })

  it('diagnostic mode stores provider and Jev exchanges only when explicitly allowed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yt-checker-diagnostic-'))
    expect(() => new ScanStorage('diagnostic', root, false)).toThrow(/disabled/i)

    const storage = new ScanStorage('diagnostic', root, true)
    storage.recordProvider({
      operation: 'transcript',
      request: {
        method: 'GET',
        url: 'https://example.test',
        headers: { authorization: 'Bearer <redacted>', accept: 'application/json' },
        startedAt: '2026-10-04T00:00:00Z',
      },
      response: {
        receivedAt: '2026-10-04T00:00:01Z',
        latencyMs: 100,
        status: 200,
        statusText: 'OK',
        headers: {},
        bodyText: '{"transcript":"raw transcript"}',
        bodyJson: { transcript: 'raw transcript' },
      },
      chargedCredits: 1,
    })

    await storage.save({ ...result, storageMode: 'diagnostic', scanId: storage.scanId })
    const files = (await readdir(join(root, storage.scanId))).sort()
    expect(files).toEqual(['jev-exchanges.json', 'result.json', 'transcriptapi-exchanges.json'])

    const raw = await readFile(join(root, storage.scanId, 'transcriptapi-exchanges.json'), 'utf8')
    expect(raw).toContain('raw transcript')
    expect(raw).toContain('Bearer <redacted>')
  })
})
