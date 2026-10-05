import { describe, expect, it, vi } from 'vitest'
import type { ClassifiedContentEvent } from '../shared/types/content'
import { normalizeTranscript } from '../server/domain/normalize-transcript'
import { OpenAIAnalysisProvider } from '../server/services/openai-analysis'

function confirmedReviewItem(reviewItemId: string, parentSummary = 'Подтверждённая сцена.') {
  return {
    reviewItemId,
    verdict: 'confirmed' as const,
    event: null,
    parentRelevance: 'moderate' as const,
    evidenceSufficiency: 'sufficient' as const,
    contextSegments: [],
    actor: null,
    target: null,
    aggressionDirection: 'unclear' as const,
    intent: 'unclear' as const,
    distress: 'clear' as const,
    consequence: 'threatened_harm' as const,
    duration: 'brief' as const,
    repetition: 'single' as const,
    narrativeFraming: 'neutral' as const,
    parentSummary,
    mitigatingContext: null,
    highPriorityReason: null,
    rationale: 'Сцена подтверждена по исходному транскрипту.',
  }
}

function violentThreat(candidateId: string, startMs: number): ClassifiedContentEvent {
  return {
    sourceCandidateId: candidateId,
    sceneId: `scene_${candidateId}`,
    category: 'violence',
    subtype: 'violent_threat',
    severity: 'medium',
    context: 'game',
    confidence: 0.98,
    startMs,
    endMs: startMs + 1_000,
    evidenceRanges: [{ startMs, endMs: startMs + 1_000 }],
    sceneStartMs: startMs,
    sceneEndMs: startMs + 1_000,
    text: 'Если не сделаешь это, жителям конец.',
    reason: 'Персонаж угрожает жителям вредом, чтобы добиться выполнения условия.',
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

describe('OpenAI contextual reviewer', () => {
  it('reviews a candidate against the original full transcript and separates direct evidence from context', async () => {
    const transcript = normalizeTranscript([
      { text: 'Как же вы глупые и наивные.', startMs: 1_000, endMs: 2_000 },
      { text: 'Я не настоящий мэр. Я клон мэра.', startMs: 2_100, endMs: 3_000 },
      { text: 'Теперь выход из деревни вам запрещён.', startMs: 3_100, endMs: 4_000 },
    ])
    const event: ClassifiedContentEvent = {
      sourceCandidateId: 'candidate_0_1',
      sceneId: 'scene_0_1',
      category: 'insults',
      subtype: 'degrading_statement',
      severity: 'low',
      context: 'game',
      confidence: 0.95,
      startMs: 1_000,
      endMs: 2_000,
      evidenceRanges: [{ startMs: 1_000, endMs: 2_000 }],
      sceneStartMs: 1_000,
      sceneEndMs: 4_000,
      text: 'Как же вы глупые и наивные.',
      reason: 'Персонаж называет группу глупой и наивной.',
      evidenceStrength: 'explicit',
      evidenceSource: 'transcript',
      engagementLevel: 'participation',
      portrayal: 'neutral',
      explicitness: 'none',
      assertionStatus: 'actual',
      details: { targetType: 'group' },
    }

    const parse = vi.fn(async () => ({
      id: 'resp_review_1',
      status: 'completed',
      output_text: '{"reviews":[]}',
      output_parsed: {
        reviews: [{
          reviewItemId: 'review_0',
          verdict: 'confirmed',
          event: {
            candidateId: 'candidate_0_1',
            sceneId: 'scene_0_1',
            category: 'insults',
            subtype: 'degrading_statement',
            severity: 'low',
            context: 'game',
            confidence: 0.99,
            evidenceStrength: 'explicit',
            engagementLevel: 'participation',
            portrayal: 'neutral',
            explicitness: 'none',
            assertionStatus: 'actual',
            evidenceSegments: [0],
            sceneStartSegment: 0,
            sceneEndSegment: 2,
            reason: 'Персонаж называет группу глупой и наивной.',
            details: { targetType: 'group' },
          },
          parentRelevance: 'low',
          evidenceSufficiency: 'sufficient',
          contextSegments: [1, 2],
          actor: 'клон мэра',
          target: 'жители',
          aggressionDirection: 'actor_to_target',
          intent: 'aggressive',
          distress: 'none',
          consequence: 'none',
          duration: 'momentary',
          repetition: 'single',
          narrativeFraming: 'neutral',
          rationale: 'Одиночная мягкая насмешка полезна только как дополнительная деталь.',
        }],
      },
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        total_tokens: 140,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 10 },
      },
    }))
    const fakeClient = { responses: { parse } }
    const provider = new OpenAIAnalysisProvider(
      'test-key',
      'gpt-test',
      undefined,
      fakeClient as never,
    )

    const result = await provider.review(transcript, 'ru', ['insults'], [event])

    expect(result.complete).toBe(true)
    expect(result.reviewedEvents).toHaveLength(1)
    expect(result.reviewedEvents[0]?.review?.recommendedParentRelevance).toBe('low')
    expect(result.reviewedEvents[0]?.evidenceRanges).toEqual([{ startMs: 1_000, endMs: 2_000 }])
    expect(result.reviewedEvents[0]?.review?.contextRanges).toEqual([{ startMs: 2_100, endMs: 4_000 }])

    const request = parse.mock.calls[0]?.[0] as { input?: Array<{ role: string; content: Array<{ text: string }> }> }
    const userText = request.input?.find((item) => item.role === 'user')?.content[0]?.text ?? ''
    expect(userText).toContain('First-pass hypotheses (untrusted)')
    expect(userText).toContain('Original transcript:')
    expect(userText).toContain('[2] Теперь выход из деревни вам запрещён.')
  })

  it('retries only omitted review items and recovers a partial batch', async () => {
    const transcript = normalizeTranscript([
      { text: 'Первый эпизод.', startMs: 10_000, endMs: 11_000 },
      { text: 'Второй эпизод.', startMs: 20_000, endMs: 21_000 },
    ])
    const events = [
      violentThreat('candidate_0_1', 10_000),
      violentThreat('candidate_1_1', 20_000),
    ]

    const parse = vi.fn()
      .mockResolvedValueOnce({
        id: 'resp_review_partial',
        status: 'completed',
        output_text: '{"reviews":[{"reviewItemId":"review_0"}]}',
        output_parsed: { reviews: [confirmedReviewItem('review_0', 'Первый эпизод подтверждён.')] },
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      })
      .mockResolvedValueOnce({
        id: 'resp_review_retry',
        status: 'completed',
        output_text: '{"reviews":[{"reviewItemId":"review_1"}]}',
        output_parsed: { reviews: [confirmedReviewItem('review_1', 'Второй эпизод подтверждён.')] },
        usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
      })

    const provider = new OpenAIAnalysisProvider(
      'test-key',
      'gpt-test',
      undefined,
      { responses: { parse } } as never,
    )
    const result = await provider.review(transcript, 'ru', ['violence'], events)

    expect(result.complete).toBe(true)
    expect(result.requestCount).toBe(2)
    expect(result.retryCount).toBe(1)
    expect(result.missingBeforeRetry).toBe(1)
    expect(result.missingAfterRetry).toBe(0)
    expect(result.reviewedCandidates).toBe(2)
    expect(result.reviewedEvents).toHaveLength(2)
    expect(result.usage.totalTokens).toBe(220)
    expect(parse).toHaveBeenCalledTimes(2)

    const retryRequest = parse.mock.calls[1]?.[0] as { input?: Array<{ role: string; content: Array<{ text: string }> }> }
    const retryText = retryRequest.input?.find((item) => item.role === 'user')?.content[0]?.text ?? ''
    expect(retryText).toContain('review_1')
    expect(retryText).not.toContain('"reviewItemId":"review_0"')
    expect(retryText).toContain('retry ONLY for reviewItemIds omitted')
  })

  it('retains a first-pass candidate as not reviewed after one targeted retry also omits it', async () => {
    const transcript = normalizeTranscript([
      { text: 'Если не сделаешь это, жителям конец.', startMs: 10_000, endMs: 11_000 },
    ])
    const event = violentThreat('candidate_0_1', 10_000)

    const parse = vi.fn()
      .mockResolvedValueOnce({
        id: 'resp_review_partial',
        status: 'completed',
        output_text: '{"reviews":[]}',
        output_parsed: { reviews: [] },
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      })
      .mockResolvedValueOnce({
        id: 'resp_review_retry_partial',
        status: 'completed',
        output_text: '{"reviews":[]}',
        output_parsed: { reviews: [] },
        usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
      })

    const provider = new OpenAIAnalysisProvider(
      'test-key',
      'gpt-test',
      undefined,
      { responses: { parse } } as never,
    )
    const result = await provider.review(transcript, 'ru', ['violence'], [event])

    expect(result.complete).toBe(false)
    expect(result.requestCount).toBe(2)
    expect(result.retryCount).toBe(1)
    expect(result.missingBeforeRetry).toBe(1)
    expect(result.missingAfterRetry).toBe(1)
    expect(result.reviewedCandidates).toBe(0)
    expect(result.reviewedEvents).toHaveLength(1)
    expect(result.reviewedEvents[0]?.review?.status).toBe('not_reviewed')
    expect(result.reviewedEvents[0]?.review?.rationale).toContain('one targeted retry')
  })

  it('marks duplicate or unknown review ids incomplete instead of silently accepting them', async () => {
    const transcript = normalizeTranscript([
      { text: 'Если не сделаешь это, жителям конец.', startMs: 10_000, endMs: 11_000 },
    ])
    const event = violentThreat('candidate_0_1', 10_000)
    const parse = vi.fn(async () => ({
      id: 'resp_review_bad_ids',
      status: 'completed',
      output_text: '{"reviews":[]}',
      output_parsed: {
        reviews: [
          confirmedReviewItem('review_0'),
          confirmedReviewItem('review_0'),
          confirmedReviewItem('review_unknown'),
        ],
      },
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    }))

    const provider = new OpenAIAnalysisProvider(
      'test-key',
      'gpt-test',
      undefined,
      { responses: { parse } } as never,
    )
    const result = await provider.review(transcript, 'ru', ['violence'], [event])

    expect(result.complete).toBe(false)
    expect(result.requestCount).toBe(1)
    expect(result.retryCount).toBe(0)
    expect(result.missingBeforeRetry).toBe(0)
    expect(result.missingAfterRetry).toBe(0)
    expect(result.reviewedCandidates).toBe(1)
    expect(parse).toHaveBeenCalledTimes(1)
  })

})
