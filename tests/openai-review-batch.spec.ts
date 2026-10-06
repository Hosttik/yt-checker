import OpenAI from 'openai'
import { describe, expect, it, vi } from 'vitest'
import { normalizeTranscript } from '../server/domain/normalize-transcript'
import { OpenAIAnalysisProvider } from '../server/services/openai-analysis'
import type { ClassifiedContentEvent } from '../shared/types/content'

function threat(candidateId: string, startMs: number, text: string): ClassifiedContentEvent {
  return {
    sourceCandidateId: candidateId,
    sceneId: `scene_${candidateId}`,
    category: 'violence',
    subtype: 'violent_threat',
    severity: 'medium',
    context: 'game',
    confidence: 0.96,
    startMs,
    endMs: startMs + 1_000,
    evidenceRanges: [{ startMs, endMs: startMs + 1_000 }],
    sceneStartMs: startMs,
    sceneEndMs: startMs + 1_000,
    text,
    reason: 'Персонаж прямо угрожает другому персонажу.',
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

function confirmed(reviewItemId: string, summary: string) {
  return {
    reviewItemId,
    verdict: 'confirmed' as const,
    event: null,
    parentRelevance: 'moderate' as const,
    evidenceSufficiency: 'sufficient' as const,
    contextSegments: [],
    actor: null,
    target: null,
    aggressionDirection: 'actor_to_target' as const,
    intent: 'aggressive' as const,
    distress: 'clear' as const,
    consequence: 'threatened_harm' as const,
    duration: 'brief' as const,
    repetition: 'single' as const,
    narrativeFraming: 'discouraged' as const,
    parentSummary: summary,
    mitigatingContext: null,
    highPriorityReason: null,
    rationale: 'Сцена подтверждена.',
  }
}

describe('OpenAI cross-video review batch', () => {
  it('keeps review decisions and evidence isolated between transcript items', async () => {
    const parse = vi.fn().mockResolvedValue({
      id: 'resp_review_batch',
      status: 'completed',
      output_text: '{"items":[],"missedHighPriorityEvents":[]}',
      output_parsed: {
        items: [
          { itemId: 'video_a', reviews: [confirmed('video_a_review_0', 'Угроза в первом видео.')] },
          { itemId: 'video_b', reviews: [confirmed('video_b_review_0', 'Угроза во втором видео.')] },
        ],
        missedHighPriorityEvents: [],
      },
      usage: { input_tokens: 200, output_tokens: 40, total_tokens: 240 },
    })
    const provider = new OpenAIAnalysisProvider(
      'secret',
      'gpt-test',
      undefined,
      { responses: { parse } } as unknown as OpenAI,
    )

    const transcriptA = normalizeTranscript([
      { text: 'Если не уйдёшь, тебе конец.', startMs: 10_000, endMs: 11_000 },
    ])
    const transcriptB = normalizeTranscript([
      { text: 'Сейчас я тебя поймаю.', startMs: 90_000, endMs: 91_000 },
    ])
    const result = await provider.reviewBatch([
      {
        itemId: 'video_a',
        transcript: transcriptA,
        language: 'ru',
        enabledCategories: ['violence'],
        events: [threat('a', 10_000, 'Если не уйдёшь, тебе конец.')],
      },
      {
        itemId: 'video_b',
        transcript: transcriptB,
        language: 'ru',
        enabledCategories: ['violence'],
        events: [threat('b', 90_000, 'Сейчас я тебя поймаю.')],
      },
    ])

    expect(result.requestCount).toBe(1)
    expect(result.items[0]?.reviewedEvents[0]).toMatchObject({
      sourceCandidateId: 'a',
      startMs: 10_000,
      text: 'Если не уйдёшь, тебе конец.',
      review: { parentSummary: 'Угроза в первом видео.' },
    })
    expect(result.items[1]?.reviewedEvents[0]).toMatchObject({
      sourceCandidateId: 'b',
      startMs: 90_000,
      text: 'Сейчас я тебя поймаю.',
      review: { parentSummary: 'Угроза во втором видео.' },
    })

    const request = parse.mock.calls[0]?.[0] as { input?: Array<{ role: string; content: Array<{ text: string }> }> }
    const userText = request.input?.find((item) => item.role === 'user')?.content[0]?.text ?? ''
    expect(userText).toContain('ITEM_START video_a')
    expect(userText).toContain('video_a_review_0')
    expect(userText).toContain('ITEM_START video_b')
    expect(userText).toContain('video_b_review_0')
  })
})
