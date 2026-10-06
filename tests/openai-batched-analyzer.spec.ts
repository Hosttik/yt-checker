import { describe, expect, it, vi } from 'vitest'
import { normalizeTranscript } from '../server/domain/normalize-transcript'
import {
  BatchedOpenAIAnalyzer,
  estimateTextTokens,
  transcriptChunks,
} from '../server/services/openai-batched-analyzer'
import type {
  OpenAIAnalysisBatchInput,
  OpenAIAnalysisBatchResult,
  OpenAIAnalysisProvider,
} from '../server/services/openai-analysis'
import { ProviderScheduler } from '../server/utils/provider-scheduler'

function transcript(label: string, count = 3) {
  return normalizeTranscript(Array.from({ length: count }, (_, index) => ({
    text: `${label} segment ${index}`,
    startMs: index * 3_000,
    endMs: index * 3_000 + 2_000,
  })))
}

function fakeProvider() {
  const analyzeBatch = vi.fn(async (
    items: OpenAIAnalysisBatchInput[],
  ): Promise<OpenAIAnalysisBatchResult> => ({
    items: items.map((item) => ({
      itemId: item.itemId,
      classifiedEvents: [],
      outputText: JSON.stringify({ itemId: item.itemId, events: [] }),
    })),
    usage: {
      inputTokens: 1_000,
      outputTokens: 100,
      reasoningTokens: 10,
      cachedTokens: 500,
      cacheWriteTokens: 0,
      totalTokens: 1_100,
    },
    provider: { requestId: 'resp_batch', status: 'completed', latencyMs: 10 },
    requestCount: 1,
    requestMetadata: {
      model: 'gpt-test',
      reasoningEffort: 'low',
      transcriptLanguage: 'batch',
      enabledCategories: ['violence'],
      diagnostic: false,
      promptVersion: 'test',
      schemaVersion: 'test',
    },
  }))
  const provider = {
    model: 'gpt-test',
    reasoningEffort: 'low',
    analyzeBatch,
    analyze: vi.fn(),
  } as unknown as OpenAIAnalysisProvider
  return { provider, analyzeBatch }
}

describe('BatchedOpenAIAnalyzer', () => {
  it('uses a script-agnostic UTF-8 estimate', () => {
    expect(estimateTextTokens('hello')).toBeGreaterThan(0)
    expect(estimateTextTokens('Привет')).toBeGreaterThan(estimateTextTokens('hello'))
    expect(estimateTextTokens('こんにちは')).toBeGreaterThan(estimateTextTokens('hello'))
  })

  it('coalesces ten short videos into one provider request', async () => {
    const { provider, analyzeBatch } = fakeProvider()
    const scheduler = new ProviderScheduler({ concurrency: 5, maxRetries: 0 })
    const analyzer = new BatchedOpenAIAnalyzer(provider, scheduler, {
      coalesceMs: 1,
      chunkMaxEstimatedTokens: 30_000,
      batchMaxEstimatedTokens: 70_000,
      batchConcurrency: 2,
      estimatedPromptTokens: 1,
    })

    const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      analyzer.analyze(transcript(`video-${index}`), 'any', ['violence'], false),
    ))

    expect(analyzeBatch).toHaveBeenCalledTimes(1)
    expect(analyzeBatch.mock.calls[0]?.[0]).toHaveLength(10)
    expect(results.reduce((sum, result) => sum + result.requestCount, 0)).toBe(1)
    expect(results.reduce((sum, result) => sum + result.usage.inputTokens, 0)).toBe(1_000)
    expect(results.reduce((sum, result) => sum + result.usage.totalTokens, 0)).toBe(1_100)
  })

  it('splits a long transcript while preserving original segment indexes', () => {
    const long = normalizeTranscript(Array.from({ length: 20 }, (_, index) => ({
      text: `segment-${index} ${'x'.repeat(120)}`,
      startMs: index * 10_000,
      endMs: index * 10_000 + 8_000,
    })))
    const chunks = transcriptChunks(long, 'en', 7, 250, 15_000)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]?.transcriptText).toContain('[0] segment-0')
    const later = chunks.find((chunk) => /\[(?:[1-9]|1\d)\]/.test(chunk.transcriptText))
    expect(later).toBeDefined()

    const indexes = chunks.flatMap((chunk) =>
      [...chunk.transcriptText.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1])),
    )
    expect(Math.max(...indexes)).toBe(19)
    expect(indexes.every((index) => Number.isInteger(index) && index >= 0 && index < 20)).toBe(true)
  })
})
