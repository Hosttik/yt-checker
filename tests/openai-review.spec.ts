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

  it('keeps candidate review and missed-event coverage as separate tasks', async () => {
    const transcript = normalizeTranscript([
      { text: 'Если не сделаешь это, жителям конец.', startMs: 10_000, endMs: 11_000 },
    ])
    const firstPass = violentThreat('candidate_existing', 10_000)
    const parse = vi.fn(async () => ({
      id: 'resp_review_only',
      status: 'completed',
      output_text: '{"reviews":[{"reviewItemId":"review_0"}],"missedHighPriorityEvents":[]}',
      output_parsed: {
        reviews: [confirmedReviewItem('review_0')],
        missedHighPriorityEvents: [],
      },
      usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
    }))
    const provider = new OpenAIAnalysisProvider(
      'test-key',
      'gpt-test',
      undefined,
      { responses: { parse } } as never,
    )

    const result = await provider.review(transcript, 'ru', ['violence'], [firstPass])

    const request = parse.mock.calls[0]?.[0] as { input?: Array<{ role: string; content: Array<{ text: string }> }> }
    const developerText = request.input?.find((item) => item.role === 'developer')?.content[0]?.text ?? ''
    const userText = request.input?.find((item) => item.role === 'user')?.content[0]?.text ?? ''
    expect(developerText).toContain('Coverage is handled by a separate dedicated pass')
    expect(userText).toContain('candidate review only')
    expect(result.rescuedCandidates).toBe(0)
    expect(result.rescuedEvents).toHaveLength(0)
  })

  it('rescues a missed sufficiently evidenced high-priority scene in a dedicated coverage request', async () => {
    const transcript = normalizeTranscript([
      { text: 'Герой идёт по дороге.', startMs: 1_000, endMs: 2_000 },
      { text: 'Я отпущу жителей только если ты выполнишь мои задания.', startMs: 10_000, endMs: 11_000 },
      { text: 'Если откажешься, им конец.', startMs: 11_100, endMs: 12_000 },
    ])
    const existing = violentThreat('candidate_existing', 1_000)
    const parse = vi.fn(async () => ({
      id: 'resp_coverage_rescue',
      status: 'completed',
      output_text: '{"missedHighPriorityEvents":[{}]}',
      output_parsed: {
        missedHighPriorityEvents: [{
          event: {
            candidateId: 'coverage_1_1',
            sceneId: 'coverage_scene_1',
            category: 'violence',
            subtype: 'violent_threat',
            severity: 'high',
            context: 'game',
            confidence: 0.98,
            evidenceStrength: 'explicit',
            engagementLevel: 'depiction',
            portrayal: 'discouraged',
            explicitness: 'mild',
            assertionStatus: 'threatened',
            evidenceSegments: [1, 2],
            sceneStartSegment: 1,
            sceneEndSegment: 2,
            reason: 'Персонаж ставит освобождение жителей в зависимость от выполнения требований и угрожает им вредом при отказе.',
            details: {
              harmLevel: 'threatened',
              targetType: 'human_like_character',
              weaponRole: 'none',
              actionPurpose: 'threat',
            },
          },
          parentRelevance: 'moderate',
          evidenceSufficiency: 'sufficient',
          contextSegments: [],
          actor: 'антагонист',
          target: 'жители',
          aggressionDirection: 'actor_to_target',
          intent: 'coercive',
          distress: 'clear',
          consequence: 'threatened_harm',
          duration: 'brief',
          repetition: 'single',
          narrativeFraming: 'discouraged',
          parentSummary: 'Антагонист удерживает жителей и ставит их освобождение в зависимость от выполнения требований.',
          mitigatingContext: null,
          highPriorityReason: 'Безопасность удерживаемых жителей используется для прямого принуждения.',
          rationale: 'Прямые реплики подтверждают условное освобождение и угрозу вреда при отказе.',
        }],
      },
      usage: { input_tokens: 90, output_tokens: 30, total_tokens: 120 },
    }))
    const provider = new OpenAIAnalysisProvider(
      'test-key',
      'gpt-test',
      undefined,
      { responses: { parse } } as never,
    )

    const result = await provider.coverage(transcript, 'ru', ['violence'], [existing])

    const request = parse.mock.calls[0]?.[0] as { input?: Array<{ role: string; content: Array<{ text: string }> }> }
    const developerText = request.input?.find((item) => item.role === 'developer')?.content[0]?.text ?? ''
    const userText = request.input?.find((item) => item.role === 'user')?.content[0]?.text ?? ''
    expect(developerText).toContain('dedicated HIGH-PRIORITY coverage pass')
    expect(userText).toContain('Covered direct-evidence segment indexes: [0]')
    expect(result.requestCount).toBe(1)
    expect(result.rescuedCandidates).toBe(1)
    expect(result.rejectedCandidates).toBe(0)
    expect(result.rescuedEvents[0]).toMatchObject({
      sourceCandidateId: 'coverage_1_1',
      category: 'violence',
      subtype: 'violent_threat',
      review: {
        status: 'confirmed',
        recommendedParentRelevance: 'high',
        evidenceSufficiency: 'sufficient',
        intent: 'coercive',
      },
    })
  })

  it('rejects a borderline coverage candidate that is not structurally serious enough', async () => {
    const transcript = normalizeTranscript([
      { text: 'Герой идёт по дороге.', startMs: 1_000, endMs: 2_000 },
      { text: 'На стене висит меч.', startMs: 10_000, endMs: 11_000 },
    ])
    const existing = violentThreat('candidate_existing', 1_000)
    const parse = vi.fn(async () => ({
      id: 'resp_coverage_weak',
      status: 'completed',
      output_text: '{"missedHighPriorityEvents":[{}]}',
      output_parsed: {
        missedHighPriorityEvents: [{
          event: {
            candidateId: 'coverage_weak',
            sceneId: 'coverage_weak_scene',
            category: 'violence',
            subtype: 'weapon_presence',
            severity: 'medium',
            context: 'game',
            confidence: 0.95,
            evidenceStrength: 'explicit',
            engagementLevel: 'depiction',
            portrayal: 'neutral',
            explicitness: 'none',
            assertionStatus: 'actual',
            evidenceSegments: [1],
            sceneStartSegment: 1,
            sceneEndSegment: 1,
            reason: 'В сцене присутствует меч.',
            details: {
              harmLevel: 'none',
              targetType: 'object',
              weaponRole: 'possessed',
              actionPurpose: 'demonstration',
            },
          },
          parentRelevance: 'moderate',
          evidenceSufficiency: 'sufficient',
          contextSegments: [],
          actor: null,
          target: null,
          aggressionDirection: 'none',
          intent: 'benign',
          distress: 'none',
          consequence: 'threatened_harm',
          duration: 'brief',
          repetition: 'single',
          narrativeFraming: 'neutral',
          parentSummary: 'В сцене присутствует меч.',
          mitigatingContext: null,
          highPriorityReason: 'Проверка серверной валидации coverage.',
          rationale: 'Это не направленная угроза и не непосредственная опасность.',
        }],
      },
      usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
    }))
    const provider = new OpenAIAnalysisProvider(
      'test-key',
      'gpt-test',
      undefined,
      { responses: { parse } } as never,
    )

    const result = await provider.coverage(transcript, 'ru', ['violence'], [existing])

    expect(result.rescuedCandidates).toBe(0)
    expect(result.rejectedCandidates).toBe(1)
    expect(result.rescuedEvents).toHaveLength(0)
  })

  it('rejects a dedicated coverage candidate that duplicates existing direct evidence', async () => {
    const transcript = normalizeTranscript([
      { text: 'Если не сделаешь это, жителям конец.', startMs: 10_000, endMs: 11_000 },
    ])
    const existing = violentThreat('candidate_existing', 10_000)
    const parse = vi.fn(async () => ({
      id: 'resp_coverage_duplicate',
      status: 'completed',
      output_text: '{"missedHighPriorityEvents":[{}]}',
      output_parsed: {
        missedHighPriorityEvents: [{
          event: {
            candidateId: 'coverage_duplicate',
            sceneId: 'coverage_duplicate_scene',
            category: 'violence',
            subtype: 'violent_threat',
            severity: 'high',
            context: 'game',
            confidence: 0.99,
            evidenceStrength: 'explicit',
            engagementLevel: 'depiction',
            portrayal: 'discouraged',
            explicitness: 'mild',
            assertionStatus: 'threatened',
            evidenceSegments: [0],
            sceneStartSegment: 0,
            sceneEndSegment: 0,
            reason: 'Персонаж угрожает жителям вредом.',
            details: {
              harmLevel: 'threatened',
              targetType: 'human_like_character',
              weaponRole: 'none',
              actionPurpose: 'threat',
            },
          },
          parentRelevance: 'high',
          evidenceSufficiency: 'sufficient',
          contextSegments: [],
          actor: 'антагонист',
          target: 'жители',
          aggressionDirection: 'actor_to_target',
          intent: 'coercive',
          distress: 'clear',
          consequence: 'threatened_harm',
          duration: 'brief',
          repetition: 'single',
          narrativeFraming: 'discouraged',
          parentSummary: 'Персонаж угрожает жителям.',
          mitigatingContext: null,
          highPriorityReason: 'Это направленная угроза вредом.',
          rationale: 'Прямое доказательство совпадает с уже существующим candidate.',
        }],
      },
      usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
    }))
    const provider = new OpenAIAnalysisProvider(
      'test-key',
      'gpt-test',
      undefined,
      { responses: { parse } } as never,
    )

    const result = await provider.coverage(transcript, 'ru', ['violence'], [existing])

    expect(result.rescuedCandidates).toBe(0)
    expect(result.rejectedCandidates).toBe(1)
    expect(result.rescuedEvents).toHaveLength(0)
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
    expect(retryText).toContain('missedHighPriorityEvents MUST be an empty array')
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


  it('retains a strongly supported violent threat when reviewer rejects it without a benign contradiction', async () => {
    const transcript = normalizeTranscript([
      { text: 'Если не сделаешь это, жителям конец.', startMs: 10_000, endMs: 11_000 },
    ])
    const event = violentThreat('candidate_guard_reject', 10_000)
    const parse = vi.fn(async () => ({
      id: 'resp_review_guard_reject',
      status: 'completed',
      output_text: '{"reviews":[{"reviewItemId":"review_0"}]}',
      output_parsed: {
        reviews: [{
          ...confirmedReviewItem('review_0'),
          verdict: 'rejected',
          parentRelevance: 'minimal',
          evidenceSufficiency: 'partial',
          aggressionDirection: 'unclear',
          intent: 'unclear',
          consequence: 'unclear',
          parentSummary: 'Сцена отклонена.',
          rationale: 'Reviewer не смог уверенно подтвердить угрозу.',
        }],
      },
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    }))
    const provider = new OpenAIAnalysisProvider(
      'test-key',
      'gpt-test',
      undefined,
      { responses: { parse } } as never,
    )

    const result = await provider.review(transcript, 'ru', ['violence'], [event])

    expect(result.complete).toBe(false)
    expect(result.rejectedCandidates).toBe(0)
    expect(result.reviewedEvents).toHaveLength(1)
    expect(result.reviewedEvents[0]).toMatchObject({
      sourceCandidateId: 'candidate_guard_reject',
      subtype: 'violent_threat',
      review: { status: 'not_reviewed' },
    })
    expect(result.decisions[0]).toMatchObject({
      verdict: 'not_reviewed',
      originalCandidateId: 'candidate_guard_reject',
    })
  })

  it('allows reviewer to reject a serious first-pass hypothesis when sufficient context proves it benign', async () => {
    const transcript = normalizeTranscript([
      { text: 'Если не сделаешь это, жителям конец.', startMs: 10_000, endMs: 11_000 },
      { text: 'Это была репетиция, никто никому не угрожал.', startMs: 11_100, endMs: 12_000 },
    ])
    const event = violentThreat('candidate_guard_benign', 10_000)
    const parse = vi.fn(async () => ({
      id: 'resp_review_guard_benign',
      status: 'completed',
      output_text: '{"reviews":[{"reviewItemId":"review_0"}]}',
      output_parsed: {
        reviews: [{
          ...confirmedReviewItem('review_0'),
          verdict: 'rejected',
          parentRelevance: 'minimal',
          evidenceSufficiency: 'sufficient',
          contextSegments: [1],
          aggressionDirection: 'none',
          intent: 'benign',
          distress: 'none',
          consequence: 'none',
          parentSummary: 'Фраза оказалась частью безобидной репетиции.',
          rationale: 'Полный контекст прямо отрицает реальную угрозу.',
        }],
      },
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    }))
    const provider = new OpenAIAnalysisProvider(
      'test-key',
      'gpt-test',
      undefined,
      { responses: { parse } } as never,
    )

    const result = await provider.review(transcript, 'ru', ['violence'], [event])

    expect(result.complete).toBe(true)
    expect(result.rejectedCandidates).toBe(1)
    expect(result.reviewedEvents).toHaveLength(0)
    expect(result.decisions[0]?.verdict).toBe('rejected')
  })

  it('retains a strongly supported violent threat when reviewer confirms it but recommends low relevance without contradiction', async () => {
    const transcript = normalizeTranscript([
      { text: 'Если не сделаешь это, жителям конец.', startMs: 10_000, endMs: 11_000 },
    ])
    const event = violentThreat('candidate_guard_low', 10_000)
    const parse = vi.fn(async () => ({
      id: 'resp_review_guard_low',
      status: 'completed',
      output_text: '{"reviews":[{"reviewItemId":"review_0"}]}',
      output_parsed: {
        reviews: [{
          ...confirmedReviewItem('review_0'),
          verdict: 'confirmed',
          parentRelevance: 'low',
          evidenceSufficiency: 'sufficient',
          aggressionDirection: 'actor_to_target',
          intent: 'coercive',
          consequence: 'threatened_harm',
          parentSummary: 'Персонаж ставит безопасность жителей в зависимость от выполнения условия.',
          rationale: 'Угроза подтверждена, но reviewer ошибочно занизил relevance.',
        }],
      },
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    }))
    const provider = new OpenAIAnalysisProvider(
      'test-key',
      'gpt-test',
      undefined,
      { responses: { parse } } as never,
    )

    const result = await provider.review(transcript, 'ru', ['violence'], [event])

    expect(result.complete).toBe(false)
    expect(result.reviewedEvents).toHaveLength(1)
    expect(result.reviewedEvents[0]).toMatchObject({
      sourceCandidateId: 'candidate_guard_low',
      review: { status: 'not_reviewed' },
    })
  })

  it('retains a strongly supported scary confinement threat when reviewer suppresses it without benign contradiction', async () => {
    const transcript = normalizeTranscript([
      { text: 'Мы связаны и не можем двигаться, поезд уже едет сюда.', startMs: 10_000, endMs: 11_000 },
    ])
    const event: ClassifiedContentEvent = {
      sourceCandidateId: 'candidate_scary_guard',
      sceneId: 'scene_scary_guard',
      category: 'scary_and_disturbing',
      subtype: 'confinement',
      severity: 'high',
      context: 'game',
      confidence: 0.96,
      startMs: 10_000,
      endMs: 11_000,
      evidenceRanges: [{ startMs: 10_000, endMs: 11_000 }],
      sceneStartMs: 10_000,
      sceneEndMs: 11_000,
      text: 'Мы связаны и не можем двигаться, поезд уже едет сюда.',
      reason: 'Персонажи удерживаются на месте перед приближающейся опасностью.',
      evidenceStrength: 'explicit',
      evidenceSource: 'transcript',
      engagementLevel: 'depiction',
      portrayal: 'discouraged',
      explicitness: 'mild',
      assertionStatus: 'actual',
      details: {
        fearIntensity: 'strong',
        themePresent: true,
        threatPresent: true,
        supernatural: false,
      },
    }

    const parse = vi.fn(async () => ({
      id: 'resp_review_scary_guard',
      status: 'completed',
      output_text: '{"reviews":[{"reviewItemId":"review_0"}]}',
      output_parsed: {
        reviews: [{
          ...confirmedReviewItem('review_0'),
          verdict: 'rejected',
          parentRelevance: 'minimal',
          evidenceSufficiency: 'partial',
          aggressionDirection: 'unclear',
          intent: 'unclear',
          consequence: 'unclear',
          parentSummary: 'Reviewer не подтвердил сцену.',
          rationale: 'Контекст интерпретирован неоднозначно.',
        }],
      },
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    }))

    const provider = new OpenAIAnalysisProvider(
      'test-key',
      'gpt-test',
      undefined,
      { responses: { parse } } as never,
    )
    const result = await provider.review(transcript, 'ru', ['scary_and_disturbing'], [event])

    expect(result.complete).toBe(false)
    expect(result.rejectedCandidates).toBe(0)
    expect(result.reviewedEvents).toHaveLength(1)
    expect(result.reviewedEvents[0]).toMatchObject({
      sourceCandidateId: 'candidate_scary_guard',
      category: 'scary_and_disturbing',
      subtype: 'confinement',
      review: { status: 'not_reviewed' },
    })
  })

  it('retains the first-pass event when a reviewer correction drifts to a disjoint scene', async () => {
    const transcript = normalizeTranscript([
      { text: 'Если не сделаешь это, жителям конец.', startMs: 10_000, endMs: 11_000 },
      { text: 'Потом герои идут дальше.', startMs: 20_000, endMs: 21_000 },
      { text: 'Совсем другая сцена.', startMs: 30_000, endMs: 31_000 },
    ])
    const event = violentThreat('candidate_drift', 10_000)

    const parse = vi.fn(async () => ({
      id: 'resp_review_drift',
      status: 'completed',
      output_text: '{"reviews":[{"reviewItemId":"review_0"}]}',
      output_parsed: {
        reviews: [{
          ...confirmedReviewItem('review_0'),
          verdict: 'corrected',
          event: {
            candidateId: 'candidate_drift',
            sceneId: 'scene_other',
            category: 'violence',
            subtype: 'weapon_presence',
            severity: 'low',
            context: 'game',
            confidence: 0.95,
            evidenceStrength: 'explicit',
            engagementLevel: 'depiction',
            portrayal: 'neutral',
            explicitness: 'none',
            assertionStatus: 'actual',
            evidenceSegments: [2],
            sceneStartSegment: 2,
            sceneEndSegment: 2,
            reason: 'В другой сцене упоминается предмет.',
            details: {
              harmLevel: 'none',
              targetType: 'object',
              weaponRole: 'possessed',
              actionPurpose: 'demonstration',
            },
          },
          parentRelevance: 'minimal',
          evidenceSufficiency: 'sufficient',
          contextSegments: [2],
          aggressionDirection: 'none',
          intent: 'benign',
          distress: 'none',
          consequence: 'none',
          parentSummary: 'Reviewer перенёс candidate в другую сцену.',
          rationale: 'Коррекция ошибочно использует несвязанную сцену.',
        }],
      },
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    }))

    const provider = new OpenAIAnalysisProvider(
      'test-key',
      'gpt-test',
      undefined,
      { responses: { parse } } as never,
    )
    const result = await provider.review(transcript, 'ru', ['violence'], [event])

    expect(result.complete).toBe(false)
    expect(result.reviewedEvents).toHaveLength(1)
    expect(result.reviewedEvents[0]).toMatchObject({
      sourceCandidateId: 'candidate_drift',
      subtype: 'violent_threat',
      startMs: 10_000,
      endMs: 11_000,
      review: { status: 'not_reviewed' },
    })
    expect(result.decisions[0]?.rationale).toContain('drifted outside the original scene')
  })

  it('keeps first-pass scene identity when an overlapping reviewer correction changes sceneId', async () => {
    const transcript = normalizeTranscript([
      { text: 'Если не сделаешь это, жителям конец.', startMs: 10_000, endMs: 11_000 },
    ])
    const event = violentThreat('candidate_scene_id', 10_000)

    const parse = vi.fn(async () => ({
      id: 'resp_review_scene_id',
      status: 'completed',
      output_text: '{"reviews":[{"reviewItemId":"review_0"}]}',
      output_parsed: {
        reviews: [{
          ...confirmedReviewItem('review_0'),
          verdict: 'corrected',
          event: {
            candidateId: 'candidate_scene_id',
            sceneId: 'scene_reassigned_by_reviewer',
            category: 'violence',
            subtype: 'violent_threat',
            severity: 'medium',
            context: 'game',
            confidence: 0.99,
            evidenceStrength: 'explicit',
            engagementLevel: 'depiction',
            portrayal: 'discouraged',
            explicitness: 'mild',
            assertionStatus: 'threatened',
            evidenceSegments: [0],
            sceneStartSegment: 0,
            sceneEndSegment: 0,
            reason: 'Персонаж угрожает жителям вредом.',
            details: {
              harmLevel: 'threatened',
              targetType: 'human_like_character',
              weaponRole: 'none',
              actionPurpose: 'threat',
            },
          },
          parentRelevance: 'high',
          evidenceSufficiency: 'sufficient',
          contextSegments: [],
          aggressionDirection: 'actor_to_target',
          intent: 'coercive',
          distress: 'clear',
          consequence: 'threatened_harm',
          highPriorityReason: 'Направленная угроза используется как давление.',
          parentSummary: 'Персонаж угрожает жителям.',
          rationale: 'Угроза подтверждена.',
        }],
      },
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    }))

    const provider = new OpenAIAnalysisProvider(
      'test-key',
      'gpt-test',
      undefined,
      { responses: { parse } } as never,
    )
    const result = await provider.review(transcript, 'ru', ['violence'], [event])

    expect(result.complete).toBe(true)
    expect(result.reviewedEvents[0]?.sceneId).toBe(event.sceneId)
    expect(result.reviewedEvents[0]?.review?.status).toBe('corrected')
  })

  it('preserves first-pass reported and mention provenance when review tries to upgrade the same candidate', async () => {
    const transcript = normalizeTranscript([
      { text: 'Админ сообщил, что к деревне идут тысячи зомби.', startMs: 10_000, endMs: 11_000 },
    ])
    const event: ClassifiedContentEvent = {
      sourceCandidateId: 'candidate_reported_1',
      sceneId: 'scene_reported_1',
      category: 'scary_and_disturbing',
      subtype: 'intense_peril',
      severity: 'medium',
      context: 'game',
      confidence: 0.98,
      startMs: 10_000,
      endMs: 11_000,
      evidenceRanges: [{ startMs: 10_000, endMs: 11_000 }],
      sceneStartMs: 10_000,
      sceneEndMs: 11_000,
      text: 'Админ сообщил, что к деревне идут тысячи зомби.',
      reason: 'Персонаж пересказывает предупреждение о будущей угрозе.',
      evidenceStrength: 'explicit',
      evidenceSource: 'transcript',
      engagementLevel: 'mention',
      portrayal: 'neutral',
      explicitness: 'mild',
      assertionStatus: 'reported',
      details: {
        fearIntensity: 'moderate',
        themePresent: true,
        threatPresent: true,
        supernatural: true,
      },
    }

    const parse = vi.fn(async () => ({
      id: 'resp_review_epistemic_upgrade',
      status: 'completed',
      output_text: '{"reviews":[{"reviewItemId":"review_0"}]}',
      output_parsed: {
        reviews: [{
          reviewItemId: 'review_0',
          verdict: 'corrected',
          event: {
            candidateId: 'candidate_reported_1',
            sceneId: 'scene_reported_1',
            category: 'scary_and_disturbing',
            subtype: 'intense_peril',
            severity: 'medium',
            context: 'game',
            confidence: 0.99,
            evidenceStrength: 'explicit',
            engagementLevel: 'depiction',
            portrayal: 'neutral',
            explicitness: 'mild',
            assertionStatus: 'actual',
            evidenceSegments: [0],
            sceneStartSegment: 0,
            sceneEndSegment: 0,
            reason: 'Жители обсуждают приближающуюся угрозу.',
            details: {
              fearIntensity: 'moderate',
              themePresent: true,
              threatPresent: true,
              supernatural: true,
            },
          },
          parentRelevance: 'moderate',
          evidenceSufficiency: 'sufficient',
          contextSegments: [],
          actor: null,
          target: 'жители',
          aggressionDirection: 'unclear',
          intent: 'unclear',
          distress: 'clear',
          consequence: 'threatened_harm',
          duration: 'brief',
          repetition: 'single',
          narrativeFraming: 'neutral',
          parentSummary: 'Жителям сообщают о приближении угрозы.',
          mitigatingContext: null,
          highPriorityReason: null,
          rationale: 'Непосредственное нападение в этой реплике не описано.',
        }],
      },
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    }))

    const provider = new OpenAIAnalysisProvider(
      'test-key',
      'gpt-test',
      undefined,
      { responses: { parse } } as never,
    )
    const result = await provider.review(transcript, 'ru', ['scary_and_disturbing'], [event])

    expect(result.complete).toBe(true)
    expect(result.reviewedEvents[0]?.assertionStatus).toBe('reported')
    expect(result.reviewedEvents[0]?.engagementLevel).toBe('mention')
    expect(result.reviewedEvents[0]?.review?.recommendedParentRelevance).toBe('moderate')
  })

})
