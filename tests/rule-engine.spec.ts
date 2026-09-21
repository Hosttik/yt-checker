import { describe, expect, it } from 'vitest'
import { analyzeTranscript, buildRuleSummary } from '../server/domain/analyze-transcript'
import type { VideoScanResult } from '../shared/types/check'

describe('analyzeTranscript', () => {
  it('returns timestamped evidence for profanity and insults', () => {
    const violations = analyzeTranscript(
      [
        {
          text: 'Да ты дебил вообще. Блять, хватит.',
          offsetMs: 12_400,
          durationMs: 2_000,
          lang: 'ru',
        },
      ],
      ['profanity', 'insults'],
    )

    expect(violations).toHaveLength(2)
    expect(violations.map((item) => item.ruleId).sort()).toEqual(['insults', 'profanity'])
    expect(violations.every((item) => item.timestampMs === 12_400)).toBe(true)
  })

  it('does not flag harmless speech', () => {
    expect(
      analyzeTranscript(
        [{ text: 'Сегодня мы построим дом в Minecraft.', offsetMs: 0, durationMs: 1_000 }],
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
        violations: [
          {
            ruleId: 'insults',
            label: 'Оскорбления',
            severity: 'medium',
            timestampMs: 1_000,
            excerpt: 'дебил',
            matches: ['дебил'],
            count: 2,
          },
        ],
      },
      {
        id: 'two',
        title: 'Two',
        publishedAt: '',
        status: 'analyzed',
        violations: [],
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
