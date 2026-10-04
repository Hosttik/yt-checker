import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptCandidate } from '../server/domain/analyze-transcript'
import { findTranscriptCandidates } from '../server/domain/analyze-transcript'
import { JevContextFilter, resolveJevAnswer } from '../server/services/jev-context-filter'

afterEach(() => {
  vi.unstubAllGlobals()
})

const candidates: TranscriptCandidate[] = [
  {
    id: 'c0',
    ruleId: 'violence',
    hitCount: 1,
    startMs: 1_000,
    endMs: 2_000,
    segmentText: 'В Minecraft нужно убить зомби и забрать лут.',
    context: 'В Minecraft нужно убить зомби и забрать лут.',
    transcriptLanguage: 'asr-ru',
    transcriptSource: 'asr',
    matchedTerms: ['убить'],
  },
  {
    id: 'c1',
    ruleId: 'insults',
    hitCount: 1,
    startMs: 3_000,
    endMs: 4_000,
    segmentText: 'Ты дебил, заткнись уже.',
    context: 'Ты дебил, заткнись уже.',
    transcriptLanguage: 'ru',
    transcriptSource: 'manual',
    matchedTerms: ['дебил'],
  },
]

describe('JevContextFilter', () => {
  it.each([
    ['Мы запустили космическую ракету на Луну.', 'benign', 'dismissed'],
    ['Он выстрелил в него из пистолета.', 'violation', 'confirmed'],
  ])('resolves the full regex pipeline for %s', async (text, choice, resolution) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      answers: { c0: { choice, confidence: 0.9, probabilities: {
        benign: choice === 'benign' ? 0.9 : 0.05,
        violation: choice === 'violation' ? 0.9 : 0.05, uncertain: 0.05,
      } } },
    }))))
    const extracted = findTranscriptCandidates([{ text, startMs: 0, endMs: 1000 }], ['violence'], 'asr-ru')
    expect(extracted).toHaveLength(1)
    expect((await new JevContextFilter('key').filter(extracted))[0]?.resolution).toBe(resolution)
    expect((await new JevContextFilter('key').filter([]))).toEqual([])
  })
  it('requires complete, valid confidence and probabilities', () => {
    const answer = { choice: 'benign' as const, confidence: 0.9,
      probabilities: { benign: 0.9, violation: 0.05, uncertain: 0.05 } }
    expect(resolveJevAnswer(answer, 0.75, 0.7)).toBe('dismissed')
    for (const confidence of [undefined, NaN, Infinity, -1, 2, '0.9']) {
      expect(resolveJevAnswer({ ...answer, confidence } as never, 0.75, 0.7)).toBe('needs_review')
    }
    expect(resolveJevAnswer({ ...answer, probabilities: { benign: 0.9 } }, 0.75, 0.7)).toBe('needs_review')
    expect(resolveJevAnswer({ ...answer, probabilities: { benign: 0.9, violation: 0.9, uncertain: 0 } }, 0.75, 0.7)).toBe('needs_review')
    expect(() => new JevContextFilter('key', undefined, undefined, 0)).toThrow(/thresholds/)
  })
  it('drops only high-probability benign candidates', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      answers: {
        c0: {
          type: 'choice',
          choice: 'benign',
          confidence: 0.9,
          probabilities: { violation: 0.03, benign: 0.94, uncertain: 0.03 },
        },
        c1: {
          type: 'choice',
          choice: 'violation',
          confidence: 0.95,
          probabilities: { violation: 0.97, benign: 0.01, uncertain: 0.02 },
        },
      },
    }), { status: 200 })))

    const filter = new JevContextFilter('secret', undefined, 'jev-latest', 0.8)
    const result = await filter.filter(candidates)

    expect(result.map((item) => [item.id, item.resolution])).toEqual([
      ['c0', 'dismissed'],
      ['c1', 'confirmed'],
    ])
  })

  it('keeps ambiguous and low-confidence benign candidates conservatively', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      answers: {
        c0: {
          type: 'choice',
          choice: 'benign',
          confidence: 0.2,
          probabilities: { violation: 0.25, benign: 0.55, uncertain: 0.2 },
        },
        c1: {
          type: 'choice',
          choice: 'uncertain',
          confidence: 0.3,
          probabilities: { violation: 0.35, benign: 0.2, uncertain: 0.45 },
        },
      },
    }), { status: 200 })))

    const filter = new JevContextFilter('secret', undefined, 'jev-latest', 0.8)
    const result = await filter.filter(candidates)

    expect(result.map((item) => [item.id, item.resolution])).toEqual([
      ['c0', 'needs_review'],
      ['c1', 'needs_review'],
    ])
  })

  it('sends only bounded candidate contexts, not an entire transcript object', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      answers: {
        c0: {
          type: 'choice',
          choice: 'uncertain',
          probabilities: { violation: 0.3, benign: 0.2, uncertain: 0.5 },
        },
        c1: {
          type: 'choice',
          choice: 'violation',
          probabilities: { violation: 0.9, benign: 0.05, uncertain: 0.05 },
        },
      },
    }), { status: 200 }))

    vi.stubGlobal('fetch', fetchMock)

    const filter = new JevContextFilter('secret')
    await filter.filter(candidates)

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    const body = JSON.parse(String(init.body)) as {
      model: string
      state: string
      questions: Record<string, unknown>
    }
    const state = JSON.parse(body.state) as {
      candidates: Array<{ id: string; context: string; transcript_source: string }>
    }

    expect(body.model).toBe('jev-latest')
    expect(state.candidates).toHaveLength(2)
    expect(state.candidates.map((item) => item.context)).toEqual(candidates.map((item) => item.context))
    expect(state.candidates[0]?.transcript_source).toBe('asr')
    expect(body.questions).toHaveProperty('c0')
    expect(body.questions).toHaveProperty('c1')
  })

  it('dismisses a garbled ASR keyword only when Jev is confidently benign', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      answers: {
        c0: {
          type: 'choice',
          choice: 'benign',
          confidence: 0.86,
          probabilities: { violation: 0.04, benign: 0.9, uncertain: 0.06 },
        },
      },
    }), { status: 200 })))
    const garbled = findTranscriptCandidates([
      { text: 'ты потопная кровь', startMs: 0, endMs: 1_000 },
      { text: 'ты дари подарки', startMs: 1_000, endMs: 2_000 },
    ], ['violence'], 'asr-ru')
    expect(garbled).toHaveLength(1)
    expect(garbled[0]).toMatchObject({ transcriptSource: 'asr' })

    const [result] = await new JevContextFilter('secret').filter(garbled)
    expect(result?.resolution).toBe('dismissed')
  })

  it('keeps a low-confidence benign choice for review', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      answers: {
        c0: {
          type: 'choice',
          choice: 'benign',
          confidence: 0.31,
          probabilities: { violation: 0.07, benign: 0.65, uncertain: 0.28 },
        },
      },
    }), { status: 200 })))

    const [result] = await new JevContextFilter('secret').filter([candidates[0]!])
    expect(result?.resolution).toBe('needs_review')
    expect(result?.jev?.choice).toBe('benign')
  })
})
