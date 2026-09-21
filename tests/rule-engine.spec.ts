import { describe, expect, it } from 'vitest'
import {
  analyzeTranscript,
  buildDetections,
  buildRuleSummary,
  findTranscriptCandidates,
} from '../server/domain/analyze-transcript'
import type { VideoScanResult } from '../shared/types/check'

describe('transcript candidate extraction', () => {
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

    const detections = buildDetections(candidates, ['profanity', 'insults'])

    expect(detections).toEqual([
      {
        ruleId: 'profanity',
        label: 'Мат и грубая лексика',
        severity: 'high',
        count: 1,
        ranges: [{ startMs: 12_400, endMs: 14_400 }],
      },
      {
        ruleId: 'insults',
        label: 'Оскорбления',
        severity: 'medium',
        count: 1,
        ranges: [{ startMs: 12_400, endMs: 14_400 }],
      },
    ])

    const serialized = JSON.stringify(detections)
    expect(serialized).not.toContain(rawText)
    expect(serialized).not.toContain('дебил')
    expect(serialized).not.toContain('Блять')
    expect(serialized).not.toContain('context')
  })

  it('limits contextual text to the candidate segment and one neighboring segment each side', () => {
    const segments = [
      { text: 'DISTANT_SECRET_SHOULD_NOT_LEAVE', startMs: 0, endMs: 500 },
      { text: 'предыдущий контекст', startMs: 500, endMs: 1_000 },
      { text: 'этот дебил опять пришёл', startMs: 1_000, endMs: 2_000 },
      { text: 'следующий контекст', startMs: 2_000, endMs: 3_000 },
      { text: 'ANOTHER_DISTANT_SECRET', startMs: 3_000, endMs: 4_000 },
    ]

    const [candidate] = findTranscriptCandidates(segments, ['insults'])

    expect(candidate?.context).toContain('предыдущий контекст')
    expect(candidate?.context).toContain('этот дебил опять пришёл')
    expect(candidate?.context).toContain('следующий контекст')
    expect(candidate?.context).not.toContain('DISTANT_SECRET_SHOULD_NOT_LEAVE')
    expect(candidate?.context).not.toContain('ANOTHER_DISTANT_SECRET')
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
        videoCount: 1,
      },
    ])
  })
})
