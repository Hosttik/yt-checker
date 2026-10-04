import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChannelCheckResponse } from '../shared/types/check'
import type { ContentEvent } from '../shared/types/content'
import { ScanStorage } from '../server/services/scan-storage'

const event: ContentEvent = {
  id: 'video-one11:event:0',
  sourceCandidateId: 'video-one11:candidate_0_1',
  sceneId: 'video-one11:scene_0',
  category: 'violence',
  subtype: 'weapon_presence',
  severity: 'low',
  context: 'game',
  confidence: 0.98,
  startMs: 0,
  endMs: 2_000,
  text: 'Мне подарили меч.',
  reason: 'Персонажу подарили меч.',
  evidenceStrength: 'explicit',
  evidenceSource: 'transcript',
  engagementLevel: 'depiction',
  portrayal: 'neutral',
  explicitness: 'mild',
  details: { harmLevel: 'none', targetType: 'object', weaponRole: 'possessed' },
  parentRelevance: 'minimal',
  displayLevel: 'hidden',
}

const result: ChannelCheckResponse = {
  storageMode: 'minimal',
  profile: 'normal',
  channel: { id: 'UC1', title: 'Test' },
  requestedVideos: 1,
  analyzedVideos: 1,
  failedVideos: 0,
  analysisMode: 'openai',
  creditUsage: { transcriptCredits: 1, channelVideosCredits: 0, totalCredits: 1, freeRequests: 2 },
  openaiUsage: {
    requests: 1,
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 2,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 17,
  },
  speechQuality: {
    totalWords: 0,
    fillerWordCount: 0,
    fillersPer1000Words: 0,
    repeatedWordCount: 0,
    repeatedWordsPer1000Words: 0,
    fillerBreakdown: [],
  },
  selection: {
    targetVideos: 1,
    inspectedVideos: 1,
    captionEligibleVideos: 1,
    transcriptAttempts: 1,
    transcriptVideosAttempted: 1,
    transcriptHttpRequests: 1,
    usedChannelVideosFallback: false,
    requestedLanguage: 'ru',
  },
  contentEvents: [event],
  videoReports: [{
    videoId: 'video-one11',
    categoryReports: [],
    scenes: [],
  }],
  channelReport: [],
  summary: [],
  videos: [{
    id: 'video-one11',
    title: 'One',
    publishedAt: '',
    url: 'https://www.youtube.com/watch?v=video-one11',
    status: 'analyzed',
    violations: [],
    detections: [],
  }],
  limitations: [],
}

describe('ScanStorage', () => {
  it('minimal mode writes the derived result without a full transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yt-checker-minimal-'))
    const storage = new ScanStorage('minimal', root, false)
    await storage.save({ ...result, scanId: storage.scanId })
    expect(await readdir(join(root, storage.scanId))).toEqual(['result.json'])
    const stored = await readFile(join(root, storage.scanId, 'result.json'), 'utf8')
    expect(stored).toContain('contentEvents')
    expect(stored).toContain('parentRelevance')
    expect(stored).not.toContain('Нормализованный transcript')
  })

  it('diagnostic mode preserves classification -> normalized event trace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yt-checker-diagnostic-'))
    expect(() => new ScanStorage('diagnostic', root, false)).toThrow(/disabled/i)
    const storage = new ScanStorage('diagnostic', root, true)
    storage.recordOpenAISuccess('video-one11', {
      classifiedEvents: [{
        category: 'violence',
        subtype: 'weapon_presence',
        sourceCandidateId: 'candidate_0_1',
        sceneId: 'scene_0',
        severity: 'low',
        context: 'game',
        confidence: 0.98,
        startMs: 0,
        endMs: 2_000,
        text: 'Мне подарили меч.',
        reason: 'Персонажу подарили меч.',
        evidenceStrength: 'explicit',
        evidenceSource: 'transcript',
        engagementLevel: 'depiction',
        portrayal: 'neutral',
        explicitness: 'mild',
        details: { harmLevel: 'none', targetType: 'object', weaponRole: 'possessed' },
      }],
      rejectedCandidates: [{
        candidateId: 'candidate_2_1',
        suspectedCategory: 'self_harm',
        startMs: 3_000,
        endMs: 5_000,
        text: 'Я сейчас умру со смеху.',
        reason: 'Эмоциональная идиома без self-directed intent.',
      }],
      outputText: '{"events":[{"category":"violence"}]}',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 2,
        cachedTokens: 4,
        cacheWriteTokens: 0,
        totalTokens: 17,
      },
      provider: { requestId: 'resp_1', status: 'completed', latencyMs: 123.4 },
      requestMetadata: {
        model: 'gpt-6-luna',
        reasoningEffort: 'low',
        transcriptLanguage: 'ru',
        enabledCategories: ['violence', 'self_harm'],
        diagnostic: true,
        promptVersion: 'test',
        schemaVersion: 'test',
      },
    }, '[0] Нормализованный transcript', [event])

    await storage.save({
      ...result,
      storageMode: 'diagnostic',
      profile: 'diagnostic',
      scanId: storage.scanId,
    })

    expect((await readdir(join(root, storage.scanId))).sort()).toEqual([
      'openai-analysis.json',
      'result.json',
      'transcriptapi-exchanges.json',
    ])
    const diagnostic = await readFile(join(root, storage.scanId, 'openai-analysis.json'), 'utf8')
    expect(diagnostic).toContain('Нормализованный transcript')
    expect(diagnostic).toContain('modelOutputText')
    expect(diagnostic).toContain('classifiedEvents')
    expect(diagnostic).toContain('normalizedContentEvents')
    expect(diagnostic).toContain('parentRelevance')
    expect(diagnostic).toContain('rejectedCandidates')
    expect(diagnostic).not.toContain('secret')
  })
})
