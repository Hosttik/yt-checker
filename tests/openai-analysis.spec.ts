import OpenAI from 'openai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeTranscript } from '../server/domain/normalize-transcript'
import {
  OPENAI_SYSTEM_PROMPT,
  OpenAIAnalysisProvider,
} from '../server/services/openai-analysis'
import type { ContentCategory } from '../shared/types/content'

afterEach(() => vi.unstubAllGlobals())

const violenceEvent = {
  candidateId: 'candidate_0_1',
  sceneId: 'scene_0',
  category: 'violence' as const,
  subtype: 'weapon_presence' as const,
  severity: 'low' as const,
  context: 'game' as const,
  confidence: 0.98,
  evidenceStrength: 'explicit' as const,
  engagementLevel: 'depiction' as const,
  portrayal: 'neutral' as const,
  explicitness: 'mild' as const,
  startSegment: 0,
  endSegment: 0,
  reason: 'Персонажу подарили меч.',
  details: {
    harmLevel: 'none' as const,
    targetType: 'object' as const,
    weaponRole: 'possessed' as const,
  },
}

function providerWith(output: {
  events: unknown[]
  rejectedCandidates?: unknown[]
}) {
  const parse = vi.fn().mockResolvedValue({
    id: 'resp_test',
    status: 'completed',
    output_parsed: output,
    output_text: JSON.stringify(output),
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 64, cache_write_tokens: 0 },
      output_tokens: 20,
      total_tokens: 125,
      output_tokens_details: { reasoning_tokens: 5 },
    },
  })
  const client = { responses: { parse } } as unknown as OpenAI
  return { provider: new OpenAIAnalysisProvider('secret', 'gpt-6-luna', undefined, client), parse }
}

function transcript(lines: string[]) {
  return normalizeTranscript(lines.map((text, index) => ({
    text,
    startMs: index * 3_000,
    endMs: index * 3_000 + 2_000,
  })))
}

describe('OpenAI content-event classifier', () => {
  it.each([400, 401, 409, 429, 500])('makes exactly one HTTP request on status %s', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'secret must not leak', code: 'test_error' } }), { status },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAIAnalysisProvider('secret')
    await expect(provider.analyze(transcript(['Привет']), 'ru', ['insults'], false))
      .rejects.toMatchObject({ status, code: 'test_error' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not call OpenAI for captions containing only music', async () => {
    const { provider, parse } = providerWith({ events: [] })
    await expect(provider.analyze(normalizeTranscript([
      { text: '[музыка]', startMs: 0, endMs: 1000 },
    ]), 'ru', ['insults'], false)).rejects.toMatchObject({ type: 'schema' })
    expect(parse).not.toHaveBeenCalled()
  })

  it('requests rejected candidates only for diagnostic analysis', async () => {
    const { provider, parse } = providerWith({ events: [], rejectedCandidates: [] })
    await provider.analyze(transcript(['Привет']), 'ru', ['insults'], true)
    const schema = JSON.stringify(parse.mock.calls[0]?.[0].text.format.schema)
    expect(schema).toContain('rejectedCandidates')
  })

  it('keeps UX decisions out of the LLM structured schema', async () => {
    const { provider, parse } = providerWith({ events: [] })
    await provider.analyze(transcript(['Мне подарили меч.']), 'ru', ['violence'], false)
    const request = parse.mock.calls[0]?.[0]
    const schema = JSON.stringify(request.text.format.schema)

    expect(schema).toContain('sceneId')
    expect(schema).toContain('confidence')
    expect(schema).toContain('harmLevel')
    expect(schema).toContain('fearIntensity')
    expect(schema).toContain('intentionality')
    expect(schema).not.toContain('parentRelevance')
    expect(schema).not.toContain('displayLevel')
    expect(request.input[1].content[0].text).toContain('[0] Мне подарили меч.')
    expect(request.input[1].content[0].text).not.toMatch(/00:00:/)
  })

  it('materializes exact transcript evidence without asking the model for timestamps or text', async () => {
    const { provider } = providerWith({ events: [violenceEvent] })
    const result = await provider.analyze(
      transcript(['Мне подарили меч.', 'Пойдём дальше.']),
      'ru',
      ['violence'],
      false,
    )

    expect(result.classifiedEvents).toEqual([expect.objectContaining({
      sourceCandidateId: 'candidate_0_1',
      sceneId: 'scene_0',
      category: 'violence',
      subtype: 'weapon_presence',
      startMs: 0,
      endMs: 2_000,
      text: 'Мне подарили меч.',
      confidence: 0.98,
      details: {
        harmLevel: 'none',
        targetType: 'object',
        weaponRole: 'possessed',
      },
    })])
  })

  it('rejects out-of-range segment indexes', async () => {
    const { provider } = providerWith({
      events: [{ ...violenceEvent, startSegment: 99, endSegment: 99 }],
    })
    await expect(provider.analyze(transcript(['Привет']), 'ru', ['violence'], false))
      .rejects.toMatchObject({ type: 'schema' })
  })

  it('filters classifications outside enabled categories', async () => {
    const { provider } = providerWith({ events: [violenceEvent] })
    const result = await provider.analyze(transcript(['Мне подарили меч.']), 'ru', ['insults'], false)
    expect(result.classifiedEvents).toEqual([])
  })

  it('reports request metadata and cache usage', async () => {
    const { provider } = providerWith({ events: [] })
    const result = await provider.analyze(transcript(['Привет']), 'ru', ['insults'], false)
    expect(result.provider).toMatchObject({ requestId: 'resp_test', status: 'completed' })
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cachedTokens: 64,
      cacheWriteTokens: 0,
      totalTokens: 125,
    })
  })

  it.each([
    'scary_and_disturbing',
    'substances',
    'self_harm',
  ] as ContentCategory[])('supports normalized category %s', async (category) => {
    const { provider } = providerWith({ events: [] })
    await expect(provider.analyze(transcript(['Тест']), 'ru', [category], false))
      .resolves.toMatchObject({ classifiedEvents: [] })
  })

  it('explicitly separates classification from presentation and transcript-only claims', () => {
    expect(OPENAI_SYSTEM_PROMPT).toContain('Do not produce show/hide decisions')
    expect(OPENAI_SYSTEM_PROMPT).toContain('confidence: 0..1 confidence')
    expect(OPENAI_SYSTEM_PROMPT).toContain('Ten low-intensity mentions do not become high severity')
    expect(OPENAI_SYSTEM_PROMPT).toContain('do not infer visual facts')
    expect(OPENAI_SYSTEM_PROMPT).toContain('Reuse the exact same sceneId')
  })

  it('contains regression guidance for self-harm and weak violence candidates', () => {
    expect(OPENAI_SYSTEM_PROMPT).toContain('weapon_presence')
    expect(OPENAI_SYSTEM_PROMPT).toContain('Accidents, ordinary game deaths, falls')
    expect(OPENAI_SYSTEM_PROMPT).toContain('"я сейчас умру"')
    expect(OPENAI_SYSTEM_PROMPT).toContain('stakePresent')
  })
})
