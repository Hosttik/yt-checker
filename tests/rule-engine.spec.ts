import { describe, expect, it } from 'vitest'
import { analyzeTranscript, buildRuleSummary } from '../server/domain/analyze-transcript'
import type { VideoScanResult } from '../shared/types/check'

describe('analyzeTranscript', () => {
  it('returns derived detections and timeline ranges without raw transcript text', () => {
    const rawText = 'Да ты дебил вообще. Блять, хватит.'
    const detections = analyzeTranscript(
      [
        {
          text: rawText,
          startMs: 12_400,
          endMs: 14_400,
        },
      ],
      ['profanity', 'insults'],
    )

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
    expect(serialized).not.toContain('excerpt')
    expect(serialized).not.toContain('matches')
  })

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
