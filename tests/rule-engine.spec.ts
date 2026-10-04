import { describe, expect, it } from 'vitest'
import { buildDetections, buildRuleSummary } from '../server/domain/analyze-transcript'
import type { VideoScanResult, ViolationEvidence } from '../shared/types/check'

const insult: ViolationEvidence = {
  category: 'insults',
  severity: 'low',
  context: 'verbal',
  type: 'not_applicable',
  startMs: 109_000,
  endMs: 111_000,
  text: 'Лёня дурёня.',
  reason: 'Лёгкое детское обзывательство направлено на персонажа.',
}

describe('OpenAI-derived detections', () => {
  it('keeps complete evidence in the public result', () => {
    expect(buildDetections([insult], ['insults'])).toEqual([{
      ruleId: 'insults',
      label: 'Оскорбления',
      severity: 'low',
      count: 1,
      confirmedCount: 1,
      reviewCount: 0,
      ranges: [{ startMs: 109_000, endMs: 111_000 }],
      evidence: [insult],
    }])
  })

  it('aggregates the highest severity and affected video count', () => {
    const videos: VideoScanResult[] = [{
      id: 'video-one11', title: 'One', publishedAt: '',
      url: 'https://www.youtube.com/watch?v=video-one11',
      status: 'analyzed', violations: [insult],
      detections: buildDetections([insult], ['insults']),
    }]
    expect(buildRuleSummary(videos, ['insults'])).toEqual([{
      ruleId: 'insults',
      label: 'Оскорбления',
      severity: 'low',
      hitCount: 1,
      confirmedCount: 1,
      reviewCount: 0,
      videoCount: 1,
    }])
  })
})
