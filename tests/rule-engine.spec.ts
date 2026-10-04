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
  it('keeps evidence canonical in violations instead of duplicating it in detections', () => {
    expect(buildDetections([insult], ['insults'])).toEqual([{
      ruleId: 'insults',
      label: 'Оскорбления',
      severity: 'low',
      count: 1,
      ranges: [{ startMs: 109_000, endMs: 111_000 }],
    }])
  })

  it('aggregates violation count, affected videos and highest severity', () => {
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
      violationCount: 1,
      affectedVideoCount: 1,
    }])
  })

  it('uses null severity when a rule has zero violations', () => {
    expect(buildRuleSummary([], ['gambling'])).toEqual([{
      ruleId: 'gambling',
      label: 'Азартные игры и ставки',
      severity: null,
      violationCount: 0,
      affectedVideoCount: 0,
    }])
  })
})
