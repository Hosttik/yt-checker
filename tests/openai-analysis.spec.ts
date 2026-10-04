import OpenAI from 'openai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeTranscript } from '../server/domain/normalize-transcript'
import {
  OPENAI_SYSTEM_PROMPT,
  OpenAIAnalysisProvider,
} from '../server/services/openai-analysis'
import type { RuleId, ViolationEvidence } from '../shared/types/check'

afterEach(() => vi.unstubAllGlobals())

function providerWith(output: { violations: ViolationEvidence[]; rejectedCandidates?: unknown[] }) {
  const parse = vi.fn().mockResolvedValue({
    status: 'completed',
    output_text: JSON.stringify(output),
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 125,
      output_tokens_details: { reasoning_tokens: 5 },
    },
  })
  const client = { responses: { create: parse } } as unknown as OpenAI
  return { provider: new OpenAIAnalysisProvider('secret', 'gpt-6-luna', undefined, client), parse }
}

async function analyze(
  lines: string[],
  violations: ViolationEvidence[],
  categories: RuleId[],
) {
  const transcript = normalizeTranscript(lines.map((text, index) => ({
    text,
    startMs: index * 3_000,
    endMs: index * 3_000 + 2_000,
  })))
  return providerWith({ violations }).provider.analyze(transcript, 'ru', categories, false)
}

describe('OpenAIAnalysisProvider', () => {
  it.each([400, 401, 409, 429, 500])('makes exactly one HTTP request on status %s', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'secret must not leak', code: 'test_error' } }), { status },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAIAnalysisProvider('secret')
    await expect(provider.analyze(normalizeTranscript([
      { text: 'Привет', startMs: 0, endMs: 1000 },
    ]), 'ru', ['insults'], false)).rejects.toMatchObject({ status, code: 'test_error' })
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
    await expect(provider.analyze(normalizeTranscript([
      { text: 'Привет', startMs: 0, endMs: 1000 },
    ]), 'ru', ['insults'], false)).rejects.toMatchObject({ type: 'timeout' })
  })

  it('requests rejectedCandidates only in diagnostic mode', async () => {
    const { provider, parse } = providerWith({ violations: [], rejectedCandidates: [] })
    await provider.analyze(normalizeTranscript([
      { text: 'Привет', startMs: 0, endMs: 1000 },
    ]), 'ru', ['insults'], true)
    expect(parse.mock.calls[0]?.[0].text.format.schema.properties).toHaveProperty('rejectedCandidates')
  })

  it.each(['incomplete', 'completed'])('retains billed usage on %s invalid response', async (status) => {
    const { provider, parse } = providerWith({ violations: [] })
    parse.mockResolvedValueOnce({
      status, output_text: status === 'completed' ? '{broken' : '',
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    })
    await expect(provider.analyze(normalizeTranscript([
      { text: 'Привет', startMs: 0, endMs: 1000 },
    ]), 'ru', ['insults'], false)).rejects.toMatchObject({
      type: 'schema', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: 0 },
    })
  })

  it('rejects real transcript text assigned to a different time', async () => {
    const { provider } = providerWith({ violations: [{
      category: 'insults', severity: 'low', context: 'verbal', type: 'not_applicable',
      startMs: 0, endMs: 1000, text: 'Лёня дурёня.', reason: 'Обзывательство.',
    }] })
    await expect(provider.analyze(normalizeTranscript([
      { text: 'Привет', startMs: 0, endMs: 1000 },
      { text: 'Лёня дурёня.', startMs: 10000, endMs: 11000 },
    ]), 'ru', ['insults'], false)).rejects.toMatchObject({ type: 'schema' })
  })

  it('uses the real SDK strict schema and does not request debug fields in compact mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_test', status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"violations":[]}', annotations: [] }] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const provider = new OpenAIAnalysisProvider('secret', undefined, undefined,
      new OpenAI({ apiKey: 'secret', fetch: fetchMock, maxRetries: 0 }))
    const result = await provider.analyze(normalizeTranscript([
      { text: 'Привет', startMs: 0, endMs: 1000 },
    ]), 'ru', ['insults'], false)
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true })
    expect(body.text.format.schema.properties).not.toHaveProperty('rejectedCandidates')
    expect(result.usage.totalTokens).toBe(0)
  })
  it('sends one Responses API call with low reasoning, no tools, and compact transcript only', async () => {
    const { provider, parse } = providerWith({ violations: [] })
    const transcript = normalizeTranscript([
      { text: 'Мне выпала награда.', startMs: 0, endMs: 1_000 },
      { text: 'Мне повезло.', startMs: 1_500, endMs: 2_500 },
    ])
    const result = await provider.analyze(transcript, 'ru', ['gambling'], false)
    expect(parse).toHaveBeenCalledTimes(1)
    expect(parse).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-6-luna',
      reasoning: { effort: 'low' },
      instructions: OPENAI_SYSTEM_PROMPT,
      tools: [],
      store: false,
      max_output_tokens: 4096,
      input: expect.stringContaining('[00:00:00.000] Мне выпала награда.'),
    }))
    expect(result.usage).toEqual({
      inputTokens: 100, outputTokens: 20, reasoningTokens: 5, totalTokens: 125,
    })
  })

  it('accepts low-severity directed insults', async () => {
    const violation: ViolationEvidence = {
      category: 'insults', severity: 'low', context: 'verbal', type: 'not_applicable',
      startMs: 0, endMs: 2_000, text: 'Лёня дурёня.',
      reason: 'Лёгкое детское обзывательство направлено на персонажа.',
    }
    await expect(analyze(['Лёня дурёня.'], [violation], ['insults']))
      .resolves.toMatchObject({ violations: [violation] })
  })

  it('distinguishes rude language from profanity', async () => {
    const violation: ViolationEvidence = {
      category: 'profanity_and_rude_language', severity: 'low', context: 'verbal',
      type: 'rude_language', startMs: 0, endMs: 2_000, text: 'Ты сдурел?',
      reason: 'Грубое обращение без нецензурной лексики.',
    }
    await expect(analyze(['Ты сдурел?'], [violation], ['profanity_and_rude_language']))
      .resolves.toMatchObject({ violations: [violation] })
  })

  it.each([
    ['idiomatic violence', ['Только через мой труп.'], ['violence'] as RuleId[]],
    ['reward without gambling stake', ['Мне выпала награда.', 'Мне повезло.', 'Я получил игровой сундук.'], ['gambling'] as RuleId[]],
    ['bathroom without toilet humor', ['Пойдём в ванную.', 'Мне нужно помыться.'], ['toilet_humor'] as RuleId[]],
  ])('allows an empty violation set for %s', async (_name, lines, categories) => {
    await expect(analyze(lines, [], categories)).resolves.toMatchObject({ violations: [] })
  })

  it('accepts one grouped fantasy-violence scene', async () => {
    const lines = ['Лунные зомби атакуют.', 'Бежать нужно.', 'Мне пригодится меч.', 'А давно у тебя огнемёт?']
    const violation: ViolationEvidence = {
      category: 'violence', severity: 'low', context: 'fantasy', type: 'not_applicable',
      startMs: 0, endMs: 11_000,
      text: lines.join(' '),
      reason: 'Фантастические существа атакуют персонажей; лёгкое игровое насилие.',
    }
    await expect(analyze(lines, [violation], ['violence']))
      .resolves.toMatchObject({ violations: [violation] })
  })

  it('rejects hallucinated evidence instead of marking a video safe', async () => {
    const fake: ViolationEvidence = {
      category: 'violence', severity: 'high', context: 'realistic', type: 'not_applicable',
      startMs: 0, endMs: 1_000, text: 'Текста в transcript нет.', reason: 'Выдумано.',
    }
    await expect(analyze(['Нейтральный текст.'], [fake], ['violence']))
      .rejects.toMatchObject({ type: 'schema' })
  })
})
