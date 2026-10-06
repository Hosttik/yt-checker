import { describe, expect, it, vi } from 'vitest'
import { normalizeTranscript } from '../server/domain/normalize-transcript'
import { BatchedOpenAIReviewer } from '../server/services/openai-batched-reviewer'
import type {
  OpenAIAnalysisProvider,
  OpenAIReviewBatchInput,
  OpenAIReviewBatchResult,
  OpenAIReviewResult,
} from '../server/services/openai-analysis'
import { ProviderScheduler } from '../server/utils/provider-scheduler'
import type { ClassifiedContentEvent } from '../shared/types/content'

function transcript(label: string) {
  return normalizeTranscript(Array.from({ length: 6 }, (_, index) => ({
    text: `${label} segment ${index}`,
    startMs: index * 10_000,
    endMs: index * 10_000 + 5_000,
  })))
}

function event(label: string): ClassifiedContentEvent {
  return {
    sourceCandidateId: `candidate_${label}`,
    sceneId: `scene_${label}`,
    category: 'violence',
    subtype: 'violent_threat',
    severity: 'medium',
    context: 'game',
    confidence: 0.95,
    startMs: 20_000,
    endMs: 25_000,
    evidenceRanges: [{ startMs: 20_000, endMs: 25_000 }],
    sceneStartMs: 20_000,
    sceneEndMs: 25_000,
    text: 'Угроза.',
    reason: 'Персонаж угрожает другому персонажу.',
    evidenceStrength: 'explicit',
    evidenceSource: 'transcript',
    engagementLevel: 'depiction',
    portrayal: 'discouraged',
    explicitness: 'mild',
    assertionStatus: 'threatened',
    details: {
      harmLevel: 'threatened',
      targetType: 'human_like_character',
      weaponRole: 'none',
      actionPurpose: 'threat',
    },
  }
}

describe('BatchedOpenAIReviewer', () => {
  it('coalesces candidate reviews from multiple videos into one provider request', async () => {
    const reviewBatch = vi.fn(async (
      inputs: OpenAIReviewBatchInput[],
    ): Promise<OpenAIReviewBatchResult> => ({
      items: inputs.map((input) => ({
        itemId: input.itemId,
        reviewedEvents: input.events,
        decisions: input.events.map((candidate, index) => ({
          reviewItemId: `${input.itemId}_review_${index}`,
          verdict: 'confirmed' as const,
          originalCandidateId: candidate.sourceCandidateId,
          originalCategory: candidate.category,
          originalSubtype: candidate.subtype,
          rationale: 'confirmed',
        })),
        totalCandidates: input.events.length,
        reviewedCandidates: input.events.length,
        rejectedCandidates: 0,
        uncertainCandidates: 0,
        complete: true,
      })),
      usage: {
        inputTokens: 900,
        outputTokens: 90,
        reasoningTokens: 0,
        cachedTokens: 400,
        cacheWriteTokens: 0,
        totalTokens: 990,
      },
      provider: { requestId: 'resp_review_batch', status: 'completed', latencyMs: 15 },
      requestCount: 1,
    }))
    const provider = {
      model: 'gpt-test',
      reasoningEffort: 'low',
      reviewBatch,
      review: vi.fn(),
    } as unknown as OpenAIAnalysisProvider
    const reviewer = new BatchedOpenAIReviewer(
      provider,
      new ProviderScheduler({ concurrency: 5, maxRetries: 0 }),
      {
        coalesceMs: 1,
        batchMaxEstimatedTokens: 70_000,
        batchConcurrency: 1,
        batchMaxItems: 32,
        batchMaxCandidates: 32,
        estimatedPromptTokens: 1,
      },
    )

    const results = await Promise.all(Array.from({ length: 9 }, (_, index) =>
      reviewer.review(transcript(`video-${index}`), 'any', ['violence'], [event(String(index))]),
    ))

    expect(reviewBatch).toHaveBeenCalledTimes(1)
    expect(reviewBatch.mock.calls[0]?.[0]).toHaveLength(9)
    expect(results.every((result) => result.complete)).toBe(true)
    expect(results.reduce((sum, result) => sum + result.requestCount, 0)).toBe(1)
    expect(results.reduce((sum, result) => sum + result.usage.inputTokens, 0)).toBe(900)
    expect(results.reduce((sum, result) => sum + result.usage.totalTokens, 0)).toBe(990)
  })

  it('recovers an incomplete shared batch with a targeted per-video fallback', async () => {
    const batchUsage = {
      inputTokens: 600,
      outputTokens: 60,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 660,
    }
    const reviewBatch = vi.fn(async (
      inputs: OpenAIReviewBatchInput[],
    ): Promise<OpenAIReviewBatchResult> => ({
      items: inputs.map((input, index) => ({
        itemId: input.itemId,
        reviewedEvents: input.events,
        decisions: input.events.map((candidate, candidateIndex) => ({
          reviewItemId: `${input.itemId}_review_${candidateIndex}`,
          verdict: index === 1 ? 'not_reviewed' as const : 'confirmed' as const,
          originalCandidateId: candidate.sourceCandidateId,
          originalCategory: candidate.category,
          originalSubtype: candidate.subtype,
          rationale: index === 1 ? 'omitted from model output' : 'confirmed',
        })),
        totalCandidates: input.events.length,
        reviewedCandidates: index === 1 ? 0 : input.events.length,
        rejectedCandidates: 0,
        uncertainCandidates: 0,
        complete: index !== 1,
      })),
      usage: batchUsage,
      provider: { requestId: 'resp_partial', status: 'completed', latencyMs: 20 },
      requestCount: 1,
    }))
    const review = vi.fn(async (
      inputTranscript,
      language,
      enabledCategories,
      events: ClassifiedContentEvent[],
    ): Promise<OpenAIReviewResult> => ({
      reviewedEvents: events,
      decisions: events.map((candidate, index) => ({
        reviewItemId: `review_${index}`,
        verdict: 'confirmed' as const,
        originalCandidateId: candidate.sourceCandidateId,
        originalCategory: candidate.category,
        originalSubtype: candidate.subtype,
        rationale: 'recovered',
      })),
      totalCandidates: events.length,
      reviewedCandidates: events.length,
      rejectedCandidates: 0,
      uncertainCandidates: 0,
      complete: true,
      requestCount: 1,
      retryCount: 0,
      missingBeforeRetry: 0,
      missingAfterRetry: 0,
      rescuedCandidates: 0,
      rescueRejectedCandidates: 0,
      rescuedEvents: [],
      usage: {
        inputTokens: 200,
        outputTokens: 20,
        reasoningTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 220,
      },
      provider: { requestId: 'resp_fallback', status: 'completed', latencyMs: 10 },
      requestMetadata: {
        model: 'gpt-test',
        reasoningEffort: 'low',
        transcriptLanguage: language,
        enabledCategories,
        promptVersion: 'test',
        schemaVersion: 'test',
        stage: 'review',
      },
    }))
    const provider = {
      model: 'gpt-test',
      reasoningEffort: 'low',
      reviewBatch,
      review,
    } as unknown as OpenAIAnalysisProvider
    const reviewer = new BatchedOpenAIReviewer(
      provider,
      new ProviderScheduler({ concurrency: 5, maxRetries: 0 }),
      {
        coalesceMs: 1,
        batchMaxEstimatedTokens: 70_000,
        batchConcurrency: 1,
        batchMaxItems: 4,
        batchMaxCandidates: 12,
        estimatedPromptTokens: 1,
      },
    )

    const results = await Promise.all(Array.from({ length: 3 }, (_, index) =>
      reviewer.review(transcript(`video-${index}`), 'ru', ['violence'], [event(String(index))]),
    ))

    expect(reviewBatch).toHaveBeenCalledTimes(1)
    expect(review).toHaveBeenCalledTimes(1)
    expect(results.every((result) => result.complete)).toBe(true)
    expect(results.reduce((sum, result) => sum + result.requestCount, 0)).toBe(2)
    expect(results.reduce((sum, result) => sum + result.usage.inputTokens, 0)).toBe(800)
    expect(results.reduce((sum, result) => sum + result.usage.totalTokens, 0)).toBe(880)
  })

  it('limits default batch complexity by video and candidate counts', async () => {
    const reviewBatch = vi.fn(async (
      inputs: OpenAIReviewBatchInput[],
    ): Promise<OpenAIReviewBatchResult> => ({
      items: inputs.map((input) => ({
        itemId: input.itemId,
        reviewedEvents: input.events,
        decisions: input.events.map((candidate, index) => ({
          reviewItemId: `${input.itemId}_review_${index}`,
          verdict: 'confirmed' as const,
          originalCandidateId: candidate.sourceCandidateId,
          originalCategory: candidate.category,
          originalSubtype: candidate.subtype,
          rationale: 'confirmed',
        })),
        totalCandidates: input.events.length,
        reviewedCandidates: input.events.length,
        rejectedCandidates: 0,
        uncertainCandidates: 0,
        complete: true,
      })),
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        reasoningTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 110,
      },
      provider: { requestId: 'resp', status: 'completed', latencyMs: 5 },
      requestCount: 1,
    }))
    const provider = {
      model: 'gpt-test',
      reasoningEffort: 'low',
      reviewBatch,
      review: vi.fn(),
    } as unknown as OpenAIAnalysisProvider
    const reviewer = new BatchedOpenAIReviewer(
      provider,
      new ProviderScheduler({ concurrency: 5, maxRetries: 0 }),
      { coalesceMs: 1, estimatedPromptTokens: 1 },
    )

    const results = await Promise.all(Array.from({ length: 9 }, (_, index) =>
      reviewer.review(transcript(`video-${index}`), 'any', ['violence'], [event(String(index))]),
    ))

    expect(reviewBatch).toHaveBeenCalledTimes(3)
    expect(reviewBatch.mock.calls.map((call) => call[0].length)).toEqual([4, 4, 1])
    expect(results.reduce((sum, result) => sum + result.requestCount, 0)).toBe(3)
  })

})
