import { describe, expect, it } from 'vitest'
import {
  analyzeTranscript,
  buildDetections,
  buildRuleSummary,
  findTranscriptCandidates,
} from '../server/domain/analyze-transcript'
import type { VideoScanResult } from '../shared/types/check'

describe('transcript candidate extraction', () => {
  it.each(['пулю', 'взорвать', 'ядерный реактор', 'стрельба'])('covers %s', (text) => {
    expect(findTranscriptCandidates([{ text, startMs: 0, endMs: 1000 }], ['violence'])).toHaveLength(1)
  })

  it('does not treat a clock hand or a pulsing light as a weapon', () => {
    expect(findTranscriptCandidates([{ text: 'стрелка часов пульсирует', startMs: 0, endMs: 1000 }], ['violence'])).toEqual([])
  })

  it('keeps candidate text when previous context is long', () => {
    const result = findTranscriptCandidates([
      { text: 'нейтрально '.repeat(150), startMs: 0, endMs: 1000 },
      { text: 'пистолет', startMs: 1000, endMs: 2000 },
    ], ['violence'])
    expect(result[0]?.context).toContain('пистолет')
  })

  it('bounds incident duration and never merges evidence beyond context capacity', () => {
    const result = findTranscriptCandidates(Array.from({ length: 20 }, (_, i) => ({
      text: 'стрелять ' + 'контекст '.repeat(40), startMs: i * 4000, endMs: i * 4000 + 1000,
    })), ['violence'])
    expect(result.length).toBeGreaterThan(1)
    expect(result.every((item) => item.endMs - item.startMs <= 25000)).toBe(true)
    expect(result.reduce((sum, item) => sum + item.hitCount, 0)).toBe(20)
  })

  it('does not connect a train and a threat separated by minutes', () => {
    expect(findTranscriptCandidates([
      { text: 'поезд', startMs: 0, endMs: 1000 },
      { text: 'задавит', startMs: 120000, endMs: 121000 },
    ], ['violence'])).toEqual([])
  })

  it('finds consecutive railway threats once each', () => {
    const result = findTranscriptCandidates([
      { text: 'привязали к рельсам', startMs: 0, endMs: 1000 },
      { text: 'привязали к рельсам', startMs: 2000, endMs: 3000 },
    ], ['violence'])
    expect(result.reduce((sum, item) => sum + item.hitCount, 0)).toBe(2)
  })
  it('keeps raw text only in server-side candidates and final detections are derived-only', () => {
    const rawText = 'Да ты дебил вообще. Блять, хватит.'
    const segments = [
      { text: 'До этого мы спокойно разговаривали.', startMs: 10_000, endMs: 12_000 },
      { text: rawText, startMs: 12_400, endMs: 14_400 },
      { text: 'А потом продолжили игру.', startMs: 14_500, endMs: 16_000 },
    ]

    const candidates = findTranscriptCandidates(segments, ['profanity', 'insults'])
    expect(candidates).toHaveLength(2)
    expect(candidates.every((item) => item.context.includes(rawText))).toBe(true)
    expect(candidates.every((item) => item.segmentText === rawText)).toBe(true)
    expect(candidates.find((item) => item.ruleId === 'profanity')?.matchedTerms).toContain('Блять')
    expect(candidates.find((item) => item.ruleId === 'insults')?.matchedTerms).toContain('дебил')

    const detections = buildDetections(candidates, ['profanity', 'insults'])

    expect(detections).toEqual([
      {
        ruleId: 'profanity',
        label: 'Мат и грубая лексика',
        severity: 'high',
        count: 1,
        confirmedCount: 0,
        reviewCount: 1,
        ranges: [{ startMs: 12_400, endMs: 14_400 }],
      },
      {
        ruleId: 'insults',
        label: 'Оскорбления',
        severity: 'medium',
        count: 1,
        confirmedCount: 0,
        reviewCount: 1,
        ranges: [{ startMs: 12_400, endMs: 14_400 }],
      },
    ])

    const serialized = JSON.stringify(detections)
    expect(serialized).not.toContain(rawText)
    expect(serialized).not.toContain('дебил')
    expect(serialized).not.toContain('Блять')
    expect(serialized).not.toContain('context')
  })

  it('limits contextual text to the candidate segment and two neighboring segments each side', () => {
    const segments = [
      { text: 'DISTANT_SECRET_SHOULD_NOT_LEAVE', startMs: 0, endMs: 500 },
      { text: 'ещё одна предыдущая фраза', startMs: 500, endMs: 1_000 },
      { text: 'предыдущий контекст', startMs: 1_000, endMs: 1_500 },
      { text: 'этот дебил опять пришёл', startMs: 1_500, endMs: 2_000 },
      { text: 'следующий контекст', startMs: 2_000, endMs: 2_500 },
      { text: 'ещё одна следующая фраза', startMs: 2_500, endMs: 3_000 },
      { text: 'ANOTHER_DISTANT_SECRET', startMs: 3_000, endMs: 4_000 },
    ]

    const [candidate] = findTranscriptCandidates(segments, ['insults'])

    expect(candidate?.context).toContain('предыдущий контекст')
    expect(candidate?.context).toContain('этот дебил опять пришёл')
    expect(candidate?.context).toContain('следующий контекст')
    expect(candidate?.context).not.toContain('DISTANT_SECRET_SHOULD_NOT_LEAVE')
    expect(candidate?.context).not.toContain('ANOTHER_DISTANT_SECRET')
  })

  it.each([
    ['пушки + патроны', [
      'Так, жители, держите пушки.',
      'Сейчас мы попробуем открыть дверь. Прицеливаемся.',
      'У меня закончились патроны.',
    ]],
    ['ядерная ракета', [
      'А это ядерный реактор.',
      'Не нужно никакую ядерную ракету сюда ставить.',
    ]],
    ['привязаны к рельсам', [
      'Жители привязаны прямо к рельсам.',
      'Поезд приближается.',
    ]],
    ['explicit violence', ['Он выстрелил в него из пистолета.']],
  ])('creates a violence candidate for %s', (_name, texts) => {
    const candidates = findTranscriptCandidates(
      texts.map((text, index) => ({
        text,
        startMs: index * 2_000,
        endMs: index * 2_000 + 1_500,
      })),
      ['violence'],
      'ru',
    )
    expect(candidates.some((candidate) => candidate.ruleId === 'violence')).toBe(true)
  })

  it('generates a candidate for a harmless rocket so Jev can dismiss it', () => {
    const candidates = findTranscriptCandidates([
      { text: 'Мы запустили космическую ракету на Луну.', startMs: 0, endMs: 2_000 },
    ], ['violence'], 'asr-ru')
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ transcriptSource: 'asr' })
  })

  it('merges nearby repeated weapon hits into one semantic incident', () => {
    const candidates = findTranscriptCandidates([
      { text: 'стрелять', startMs: 632_000, endMs: 633_000 },
      { text: 'стрелять', startMs: 635_000, endMs: 636_000 },
      { text: 'стрелять', startMs: 639_000, endMs: 640_000 },
    ], ['violence'])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ hitCount: 3, startMs: 632_000, endMs: 640_000 })
  })
})

describe('analyzeTranscript', () => {
  it('merges adjacent hit segments into one timeline range', () => {
    const detections = analyzeTranscript(
      [
        { text: 'дебил', startMs: 1_000, endMs: 2_000 },
        { text: 'идиот', startMs: 2_700, endMs: 3_500 },
      ],
      ['insults'],
    )

    expect(detections[0]?.count).toBe(2)
    expect(detections[0]?.ranges).toEqual([{ startMs: 1_000, endMs: 3_500 }])
  })

  it('does not flag harmless speech', () => {
    expect(
      analyzeTranscript(
        [{ text: 'Сегодня мы построим дом в Minecraft.', startMs: 0, endMs: 1_000 }],
        ['profanity', 'insults', 'toilet_humor'],
      ),
    ).toEqual([])
  })
})

describe('buildRuleSummary', () => {
  it('counts hits and affected videos independently', () => {
    const videos: VideoScanResult[] = [
      {
        id: 'one',
        title: 'One',
        publishedAt: '',
        status: 'analyzed',
        detections: [
          {
            ruleId: 'insults',
            label: 'Оскорбления',
            severity: 'medium',
            count: 2,
            confirmedCount: 1,
            reviewCount: 1,
            ranges: [{ startMs: 1_000, endMs: 2_000 }],
          },
        ],
      },
      {
        id: 'two',
        title: 'Two',
        publishedAt: '',
        status: 'analyzed',
        detections: [],
      },
    ]

    expect(buildRuleSummary(videos, ['insults'])).toEqual([
      {
        ruleId: 'insults',
        label: 'Оскорбления',
        severity: 'medium',
        hitCount: 2,
        confirmedCount: 1,
        reviewCount: 1,
        videoCount: 1,
      },
    ])
  })
})
