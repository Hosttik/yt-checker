import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptCandidate } from '../server/domain/analyze-transcript'
import { JevContextFilter } from '../server/services/jev-context-filter'

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
    context: 'В Minecraft нужно убить зомби и забрать лут.',
  },
  {
    id: 'c1',
    ruleId: 'insults',
    hitCount: 1,
    startMs: 3_000,
    endMs: 4_000,
    context: 'Ты дебил, заткнись уже.',
  },
]

describe('JevContextFilter', () => {
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

    expect(result.map((item) => item.id)).toEqual(['c1'])
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

    expect(result.map((item) => item.id)).toEqual(['c0', 'c1'])
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
      candidates: Array<{ id: string; context: string }>
    }

    expect(body.model).toBe('jev-latest')
    expect(state.candidates).toHaveLength(2)
    expect(state.candidates.map((item) => item.context)).toEqual(candidates.map((item) => item.context))
    expect(body.questions).toHaveProperty('c0')
    expect(body.questions).toHaveProperty('c1')
  })
})
