import OpenAI from 'openai'
import { describe, expect, it, vi } from 'vitest'
import { normalizeTranscript } from '../server/domain/normalize-transcript'
import { OpenAIAnalysisProvider } from '../server/services/openai-analysis'

function transcript(text: string, startMs: number) {
  return normalizeTranscript([{ text, startMs, endMs: startMs + 1_000 }])
}

function event(candidateId: string) {
  return {
    candidateId,
    sceneId: 'scene_0',
    category: 'violence' as const,
    subtype: 'weapon_presence' as const,
    severity: 'low' as const,
    context: 'game' as const,
    confidence: 0.9,
    evidenceStrength: 'explicit' as const,
    engagementLevel: 'depiction' as const,
    portrayal: 'neutral' as const,
    explicitness: 'mild' as const,
    assertionStatus: 'actual' as const,
    evidenceSegments: [0],
    sceneStartSegment: 0,
    sceneEndSegment: 0,
    reason: 'В сцене присутствует игровой меч.',
    details: {
      harmLevel: 'none' as const,
      targetType: 'object' as const,
      weaponRole: 'possessed' as const,
      actionPurpose: 'demonstration' as const,
    },
  }
}

describe('OpenAI batched content-event classifier', () => {
  it('materializes each batch item against its own original transcript', async () => {
    const parse = vi.fn().mockResolvedValue({
      id: 'resp_batch',
      status: 'completed',
      output_parsed: {
        items: [
          { itemId: 'video_a_chunk_0', events: [event('candidate_0')] },
          { itemId: 'video_b_chunk_0', events: [event('candidate_0')] },
        ],
      },
      output_text: '{"items":[]}',
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    })
    const provider = new OpenAIAnalysisProvider(
      'secret',
      'gpt-test',
      undefined,
      { responses: { parse } } as unknown as OpenAI,
    )
    const first = transcript('Первый меч.', 10_000)
    const second = transcript('Second sword.', 50_000)

    const result = await provider.analyzeBatch([
      { itemId: 'video_a_chunk_0', transcript: first, transcriptText: first.text, language: 'ru' },
      { itemId: 'video_b_chunk_0', transcript: second, transcriptText: second.text, language: 'en' },
    ], ['violence'], false)

    expect(result.requestCount).toBe(1)
    expect(result.items).toHaveLength(2)
    expect(result.items[0]?.classifiedEvents[0]).toMatchObject({
      sourceCandidateId: 'video_a_chunk_0:candidate_0',
      sceneId: 'video_a_chunk_0:scene_0',
      startMs: 10_000,
      text: 'Первый меч.',
    })
    expect(result.items[1]?.classifiedEvents[0]).toMatchObject({
      sourceCandidateId: 'video_b_chunk_0:candidate_0',
      sceneId: 'video_b_chunk_0:scene_0',
      startMs: 50_000,
      text: 'Second sword.',
    })

    const request = parse.mock.calls[0]?.[0] as { input?: Array<{ role: string; content: Array<{ text: string }> }> }
    const userText = request.input?.find((item) => item.role === 'user')?.content[0]?.text ?? ''
    expect(userText).toContain('ITEM_START video_a_chunk_0')
    expect(userText).toContain('Transcript language: ru')
    expect(userText).toContain('ITEM_START video_b_chunk_0')
    expect(userText).toContain('Transcript language: en')
  })

  it('rejects an incomplete set of returned batch item ids', async () => {
    const parse = vi.fn().mockResolvedValue({
      id: 'resp_batch_bad',
      status: 'completed',
      output_parsed: {
        items: [{ itemId: 'video_a_chunk_0', events: [] }],
      },
      output_text: '{"items":[]}',
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    })
    const provider = new OpenAIAnalysisProvider(
      'secret',
      'gpt-test',
      undefined,
      { responses: { parse } } as unknown as OpenAI,
    )
    const first = transcript('A', 0)
    const second = transcript('B', 1_000)

    await expect(provider.analyzeBatch([
      { itemId: 'video_a_chunk_0', transcript: first, transcriptText: first.text, language: 'en' },
      { itemId: 'video_b_chunk_0', transcript: second, transcriptText: second.text, language: 'en' },
    ], ['violence'], false)).rejects.toMatchObject({ type: 'schema' })
  })
})
