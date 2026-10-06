import OpenAI from 'openai'
import { describe, expect, it, vi } from 'vitest'
import { normalizeTranscript } from '../server/domain/normalize-transcript'
import { OpenAIAnalysisProvider } from '../server/services/openai-analysis'
import type { ClassifiedContentEvent } from '../shared/types/content'

function baseViolence(candidateId: string, sceneId: string): ClassifiedContentEvent {
  return {
    sourceCandidateId: candidateId,
    sceneId,
    category: 'violence',
    subtype: 'weapon_use',
    severity: 'medium',
    context: 'game',
    confidence: 0.97,
    startMs: 1_000,
    endMs: 2_000,
    evidenceRanges: [{ startMs: 1_000, endMs: 2_000 }],
    sceneStartMs: 1_000,
    sceneEndMs: 2_000,
    text: 'Scene signal.',
    reason: 'First-pass signal.',
    evidenceStrength: 'explicit',
    evidenceSource: 'transcript',
    engagementLevel: 'depiction',
    portrayal: 'neutral',
    explicitness: 'mild',
    assertionStatus: 'actual',
    details: {
      harmLevel: 'attempted',
      targetType: 'human_like_character',
      weaponRole: 'used',
      actionPurpose: 'attack',
    },
  }
}

function sceneOutput(decisions: Array<Record<string, unknown>>) {
  return {
    sceneReviewId: 'video_scene_0',
    candidateDecisions: decisions,
    contextSegments: [],
    actor: null,
    target: null,
    aggressionDirection: 'unclear',
    intent: 'unclear',
    distress: 'mild',
    consequence: 'none',
    duration: 'momentary',
    repetition: 'single',
    narrativeFraming: 'neutral',
    parentSummary: 'One shared scene summary.',
    mitigatingContext: 'Game context.',
    highPriorityReason: null,
  }
}

describe('OpenAI scene-level batch review', () => {
  it('groups two category candidates with the same sceneId into one scene request', async () => {
    const parse = vi.fn().mockResolvedValue({
      id: 'resp_scene',
      status: 'completed',
      output_text: '{}',
      output_parsed: {
        items: [{
          itemId: 'video',
          scenes: [sceneOutput([
            {
              reviewItemId: 'video_review_0',
              verdict: 'confirmed',
              event: null,
              parentRelevance: 'moderate',
              evidenceSufficiency: 'sufficient',
              rationale: 'Confirmed first label.',
            },
            {
              reviewItemId: 'video_review_1',
              verdict: 'confirmed',
              event: null,
              parentRelevance: 'low',
              evidenceSufficiency: 'sufficient',
              rationale: 'Confirmed second label.',
            },
          ])],
        }],
        missedHighPriorityEvents: [],
      },
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    })
    const provider = new OpenAIAnalysisProvider(
      'secret',
      'gpt-test',
      undefined,
      { responses: { parse } } as unknown as OpenAI,
    )
    const transcript = normalizeTranscript([
      { text: 'Scene signal.', startMs: 1_000, endMs: 2_000 },
    ])
    const first = baseViolence('candidate_a', 'shared_scene')
    const second: ClassifiedContentEvent = {
      ...first,
      sourceCandidateId: 'candidate_b',
      category: 'scary_and_disturbing',
      subtype: 'intense_peril',
      details: {
        fearIntensity: 'moderate',
        themePresent: true,
        threatPresent: true,
        supernatural: false,
      },
    }

    const result = await provider.reviewBatch([{
      itemId: 'video',
      transcript,
      language: 'ru',
      enabledCategories: ['violence', 'scary_and_disturbing'],
      events: [first, second],
    }])

    expect(result.items[0]?.complete).toBe(true)
    expect(result.items[0]?.reviewedEvents).toHaveLength(2)
    expect(result.items[0]?.reviewedEvents.map((event) => event.review?.parentSummary))
      .toEqual(['One shared scene summary.', 'One shared scene summary.'])

    const request = parse.mock.calls[0]?.[0] as {
      input?: Array<{ role: string; content: Array<{ text: string }> }>
    }
    const userText = request.input?.find((item) => item.role === 'user')?.content[0]?.text ?? ''
    expect(userText.match(/shared_scene/g)?.length).toBe(1)
    expect(userText).toContain('video_review_0')
    expect(userText).toContain('video_review_1')
  })

  it('accepts a low-relevance rejection when review finds no directed aggression or harm', async () => {
    const parse = vi.fn().mockResolvedValue({
      id: 'resp_downgrade',
      status: 'completed',
      output_text: '{}',
      output_parsed: {
        items: [{
          itemId: 'video',
          scenes: [sceneOutput([{
            reviewItemId: 'video_review_0',
            verdict: 'rejected',
            event: null,
            parentRelevance: 'low',
            evidenceSufficiency: 'sufficient',
            rationale: 'No directed aggression or harmful consequence is established.',
          }])],
        }],
        missedHighPriorityEvents: [],
      },
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    })
    const provider = new OpenAIAnalysisProvider(
      'secret',
      'gpt-test',
      undefined,
      { responses: { parse } } as unknown as OpenAI,
    )
    const transcript = normalizeTranscript([
      { text: 'Scene signal.', startMs: 1_000, endMs: 2_000 },
    ])

    const result = await provider.reviewBatch([{
      itemId: 'video',
      transcript,
      language: 'ru',
      enabledCategories: ['violence'],
      events: [baseViolence('candidate_a', 'scene_a')],
    }])

    expect(result.items[0]?.complete).toBe(true)
    expect(result.items[0]?.reviewedEvents).toHaveLength(0)
    expect(result.items[0]?.rejectedCandidates).toBe(1)
    expect(result.items[0]?.decisions[0]?.verdict).toBe('rejected')
  })
})
