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
    status: 'completed',
    output_parsed: output,
    output_text: JSON.stringify(output),
    usage: {
      input_tokens: 100,
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

async function analyze(
  lines: string[],
  violations: ModelViolation[],
  categories: RuleId[],
) {
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

  it('retains billed usage on an incomplete response', async () => {
    const { provider, parse } = providerWith({ violations: [] })
    parse.mockResolvedValueOnce({
      status: 'incomplete',
      output_parsed: null,
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    })
    await expect(provider.analyze(transcript(['Привет']), 'ru', ['insults'], false))
      .rejects.toMatchObject({
        type: 'schema',
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: 0 },
      })
  })

  it('rejects out-of-range segment indexes', async () => {
    const { provider } = providerWith({ violations: [{
      category: 'insults',
      severity: 'low',
      context: 'verbal',
      type: 'not_applicable',
      startSegment: 99,
      endSegment: 99,
      reason: 'Обзывательство.',
    }] })
    await expect(provider.analyze(transcript(['Привет']), 'ru', ['insults'], false))
      .rejects.toMatchObject({ type: 'schema' })
  })

  it('uses the official Responses parse helper with a strict segment-index schema', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_test',
      status: 'completed',
      output: [{
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{
          type: 'output_text',
          text: '{"violations":[]}',
          annotations: [],
        }],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const provider = new OpenAIAnalysisProvider(
      'secret',
      undefined,
      undefined,
      new OpenAI({ apiKey: 'secret', fetch: fetchMock, maxRetries: 0 }),
    )
    const result = await provider.analyze(transcript(['Привет']), 'ru', ['insults'], false)
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    const item = body.text.format.schema.properties.violations.items.properties
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true })
    expect(item).toHaveProperty('startSegment')
    expect(item).toHaveProperty('endSegment')
    expect(item).not.toHaveProperty('startMs')
    expect(item).not.toHaveProperty('text')
    expect(result.usage.totalTokens).toBe(0)
  })

  it('sends one low-reasoning request with segment ids and bounded output', async () => {
    const { provider, parse } = providerWith({ violations: [] })
    const result = await provider.analyze(
      transcript(['Мне выпала награда.', 'Мне повезло.']),
      'ru',
      ['gambling'],
      false,
    )
    expect(parse).toHaveBeenCalledTimes(1)
    expect(parse).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-6-luna',
      reasoning: { effort: 'low' },
      instructions: OPENAI_SYSTEM_PROMPT,
      tools: [],
      store: false,
      max_output_tokens: 4096,
      input: expect.stringContaining('[0|00:00:00.000] Мне выпала награда.'),
    }))
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      totalTokens: 125,
    })
  })

  it('materializes exact insult evidence from the selected segment', async () => {
    const result = await analyze(['Лёня дурёня.'], [{
      category: 'insults',
      severity: 'low',
      context: 'verbal',
      type: 'not_applicable',
      startSegment: 0,
      endSegment: 0,
      reason: 'Лёгкое детское обзывательство направлено на персонажа.',
    }], ['insults'])

    expect(result.violations).toEqual([{
      category: 'insults',
      severity: 'low',
      context: 'verbal',
      type: 'not_applicable',
      startMs: 0,
      endMs: 2_000,
      text: 'Лёня дурёня.',
      reason: 'Лёгкое детское обзывательство направлено на персонажа.',
    }])
  })

  it('distinguishes rude language from profanity', async () => {
    const result = await analyze(['Ты сдурел?'], [{
      category: 'profanity_and_rude_language',
      severity: 'low',
      context: 'verbal',
      type: 'rude_language',
      startSegment: 0,
      endSegment: 0,
      reason: 'Грубое обращение без нецензурной лексики.',
    }], ['profanity_and_rude_language'])

    expect(result.violations[0]).toMatchObject({
      category: 'profanity_and_rude_language',
      type: 'rude_language',
      text: 'Ты сдурел?',
    })
  })

  it.each([
    ['idiomatic violence', ['Только через мой труп.'], ['violence'] as RuleId[]],
    ['reward without gambling stake', ['Мне выпала награда.', 'Мне повезло.', 'Я получил игровой сундук.'], ['gambling'] as RuleId[]],
    ['bathroom without toilet humor', ['Пойдём в ванную.', 'Мне нужно помыться.'], ['toilet_humor'] as RuleId[]],
  ])('allows an empty violation set for %s', async (_name, lines, categories) => {
    await expect(analyze(lines, [], categories)).resolves.toMatchObject({ violations: [] })
  })

  it('materializes one grouped fantasy-violence scene without model timestamp arithmetic', async () => {
    const lines = ['Лунные зомби атакуют.', 'Бежать нужно.', 'Мне пригодится меч.', 'А давно у тебя огнемёт?']
    const result = await analyze(lines, [{
      category: 'violence',
      severity: 'low',
      context: 'fantasy',
      type: 'not_applicable',
      startSegment: 0,
      endSegment: 3,
      reason: 'Фантастические существа атакуют персонажей; лёгкое игровое насилие.',
    }], ['violence'])

    expect(result.violations[0]).toMatchObject({
      startMs: 0,
      endMs: 11_000,
      text: lines.join(' '),
    })
  })

  it('filters disabled categories from both accepted and rejected diagnostic output', async () => {
    const { provider } = providerWith({
      violations: [{
        category: 'violence',
        severity: 'low',
        context: 'fantasy',
        type: 'not_applicable',
        startSegment: 0,
        endSegment: 0,
        reason: 'Фэнтезийное насилие.',
      }],
      rejectedCandidates: [{
        category: 'violence',
        startSegment: 0,
        endSegment: 0,
        reason: 'Отклонено.',
      }],
    })
    const result = await provider.analyze(transcript(['Зомби']), 'ru', ['insults'], true)
    expect(result.violations).toEqual([])
    expect(result.rejectedCandidates).toEqual([])
  })
})
