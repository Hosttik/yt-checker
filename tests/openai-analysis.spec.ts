import OpenAI from 'openai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeTranscript } from '../server/domain/normalize-transcript'
import {
  OPENAI_SYSTEM_PROMPT,
  OpenAIAnalysisProvider,
} from '../server/services/openai-analysis'
import type { RuleId } from '../shared/types/check'

afterEach(() => vi.unstubAllGlobals())

interface ModelViolation {
  category: RuleId
  severity: 'low' | 'medium' | 'high'
  context: 'realistic' | 'game' | 'fantasy' | 'cartoon' | 'verbal' | 'educational' | 'idiom' | 'other'
  type: 'profanity' | 'rude_language' | 'not_applicable'
  startSegment: number
  endSegment: number
  reason: string
}

function providerWith(output: {
  violations: ModelViolation[]
  rejectedCandidates?: Array<{
    category: RuleId
    startSegment: number
    endSegment: number
    reason: string
  }>
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

async function analyze(lines: string[], violations: ModelViolation[], categories: RuleId[]) {
  return providerWith({ violations }).provider.analyze(transcript(lines), 'ru', categories, false)
}

describe('OpenAIAnalysisProvider', () => {
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
    const { provider, parse } = providerWith({ violations: [] })
    await expect(provider.analyze(normalizeTranscript([
      { text: '[музыка]', startMs: 0, endMs: 1000 },
    ]), 'ru', ['insults'], false)).rejects.toMatchObject({ type: 'schema' })
    expect(parse).not.toHaveBeenCalled()
  })

  it('classifies SDK timeout before the generic APIError branch', async () => {
    const { provider, parse } = providerWith({ violations: [] })
    parse.mockRejectedValueOnce(new OpenAI.APIConnectionTimeoutError())
    await expect(provider.analyze(transcript(['Привет']), 'ru', ['insults'], false))
      .rejects.toMatchObject({ type: 'timeout' })
  })

  it('requests rejectedCandidates only in diagnostic mode', async () => {
    const { provider, parse } = providerWith({ violations: [], rejectedCandidates: [] })
    await provider.analyze(transcript(['Привет']), 'ru', ['insults'], true)
    expect(parse.mock.calls[0]?.[0].text.format.schema.properties).toHaveProperty('rejectedCandidates')
  })

  it('retains billed cache usage on an incomplete response', async () => {
    const { provider, parse } = providerWith({ violations: [] })
    parse.mockResolvedValueOnce({
      id: 'resp_incomplete',
      status: 'incomplete',
      output_parsed: null,
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 20, cache_write_tokens: 50 },
        output_tokens: 20,
        total_tokens: 120,
      },
    })
    await expect(provider.analyze(transcript(['Привет']), 'ru', ['insults'], false))
      .rejects.toMatchObject({
        type: 'schema',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          reasoningTokens: 0,
          cachedTokens: 20,
          cacheWriteTokens: 50,
        },
      })
  })

  it('rejects out-of-range segment indexes', async () => {
    const { provider } = providerWith({ violations: [{
      category: 'insults', severity: 'low', context: 'verbal', type: 'not_applicable',
      startSegment: 99, endSegment: 99, reason: 'Обзывательство.',
    }] })
    await expect(provider.analyze(transcript(['Привет']), 'ru', ['insults'], false))
      .rejects.toMatchObject({ type: 'schema' })
  })

  it('uses strict schema and explicit caching only for the stable developer prompt', async () => {
    const { provider, parse } = providerWith({ violations: [] })
    await provider.analyze(transcript(['Мне выпала награда.']), 'ru', ['gambling'], false)
    const request = parse.mock.calls[0]?.[0]
    expect(request).toMatchObject({
      model: 'gpt-6-luna',
      reasoning: { effort: 'low' },
      prompt_cache_options: { mode: 'explicit', ttl: '30m' },
      tools: [],
      store: false,
      max_output_tokens: 4096,
      text: { verbosity: 'low' },
    })
    expect(request).not.toHaveProperty('instructions')
    expect(request.input[0]).toEqual({
      role: 'developer',
      content: [{
        type: 'input_text',
        text: OPENAI_SYSTEM_PROMPT,
        prompt_cache_breakpoint: { mode: 'explicit' },
      }],
    })
    expect(request.input[1].content[0].text).toContain('[0] Мне выпала награда.')
    expect(request.input[1].content[0].text).not.toMatch(/00:00:/)
  })

  it('reports request metadata and cache usage', async () => {
    const { provider } = providerWith({ violations: [] })
    const result = await provider.analyze(transcript(['Привет']), 'ru', ['insults'], false)
    expect(result.provider).toMatchObject({ requestId: 'resp_test', status: 'completed' })
    expect(result.provider.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cachedTokens: 64,
      cacheWriteTokens: 0,
      totalTokens: 125,
    })
  })

  it('materializes exact evidence from selected segments', async () => {
    const result = await analyze(['Лёня дурёня.'], [{
      category: 'insults', severity: 'low', context: 'verbal', type: 'not_applicable',
      startSegment: 0, endSegment: 0,
      reason: 'Лёгкое детское обзывательство направлено на персонажа.',
    }], ['insults'])
    expect(result.violations[0]).toMatchObject({
      startMs: 0, endMs: 2_000, text: 'Лёня дурёня.',
    })
  })

  it.each([
    ['idiomatic violence', ['Только через мой труп.'], ['violence'] as RuleId[]],
    ['reward without gambling stake', ['Мне выпала награда.', 'Мне повезло.'], ['gambling'] as RuleId[]],
    ['bathroom without toilet humor', ['Пойдём в ванную.', 'Мне нужно помыться.'], ['toilet_humor'] as RuleId[]],
    ['self-identification nickname', ['Я Учёный Нуб в Майнкрафте.'], ['insults'] as RuleId[]],
    ['self-reference with negation', ['Я мыслю как человек, который не сбежал из психушки.'], ['insults'] as RuleId[]],
  ])('allows an empty violation set for %s', async (_name, lines, categories) => {
    await expect(analyze(lines, [], categories)).resolves.toMatchObject({ violations: [] })
  })

  it('documents minimal evidence and ASR ambiguity rules in the classifier prompt', () => {
    expect(OPENAI_SYSTEM_PROMPT).toContain('smallest contiguous segment range')
    expect(OPENAI_SYSTEM_PROMPT).toContain('Normally use 1-6 segments')
    expect(OPENAI_SYSTEM_PROMPT).toContain('self-identification/name')
    expect(OPENAI_SYSTEM_PROMPT).toContain('Preserve negation exactly')
    expect(OPENAI_SYSTEM_PROMPT).toContain('ASR errors')
  })

  it('supports the added child-safety categories in the structured schema', async () => {
    for (const category of ['scary_and_disturbing', 'tobacco_and_nicotine', 'self_harm'] as RuleId[]) {
      const { provider } = providerWith({ violations: [] })
      await expect(provider.analyze(transcript(['Тест']), 'ru', [category], false))
        .resolves.toMatchObject({ violations: [] })
    }
  })
})
