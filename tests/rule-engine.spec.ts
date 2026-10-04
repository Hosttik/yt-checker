import { describe, expect, it } from 'vitest'
import {
  buildDetections,
  buildLegacyViolations,
  buildRuleSummary,
} from '../server/domain/analyze-transcript'
import type { ContentEvent } from '../shared/types/content'
import type { VideoScanResult } from '../shared/types/check'

const insult: ContentEvent = {
  id: 'event_insult',
  sourceCandidateId: 'candidate_1',
  sceneId: 'scene_1',
  category: 'insults',
  subtype: 'direct_insult',
  severity: 'low',
  context: 'real_world',
  confidence: 0.99,
  startMs: 109_000,
  endMs: 111_000,
  text: 'Лёня дурёня.',
  reason: 'Лёгкое детское обзывательство направлено на персонажа.',
  evidenceStrength: 'explicit',
  evidenceSource: 'transcript',
  engagementLevel: 'participation',
  portrayal: 'humorous',
  explicitness: 'mild',
  details: { targetType: 'character' },
  parentRelevance: 'low',
  displayLevel: 'summary',
}

const nicotine: ContentEvent = {
  id: 'event_smoke',
  category: 'substances',
  subtype: 'nicotine',
  severity: 'low',
  context: 'real_world',
  confidence: 0.98,
  startMs: 10_000,
  endMs: 12_000,
  text: 'Он закурил сигарету.',
  reason: 'Персонаж курит сигарету.',
  evidenceStrength: 'explicit',
  evidenceSource: 'transcript',
  engagementLevel: 'participation',
  portrayal: 'neutral',
  explicitness: 'mild',
  details: { substance: 'nicotine', action: 'use', userType: 'adult' },
  parentRelevance: 'low',
  displayLevel: 'summary',
}

describe('legacy compatibility projection', () => {
  it('derives legacy violations from canonical content events', () => {
    const violations = buildLegacyViolations([insult], ['insults'])
    expect(violations).toEqual([{
      category: 'insults',
      severity: 'low',
      context: 'realistic',
      type: 'not_applicable',
      startMs: 109_000,
      endMs: 111_000,
      text: 'Лёня дурёня.',
      reason: 'Лёгкое детское обзывательство направлено на персонажа.',
    }])

    expect(buildDetections(violations, ['insults'])).toEqual([{
      ruleId: 'insults',
      label: 'Оскорбления',
      severity: 'low',
      count: 1,
      ranges: [{ startMs: 109_000, endMs: 111_000 }],
    }])
  })

  it('maps normalized nicotine back to old tobacco alias when requested by an old client', () => {
    const violations = buildLegacyViolations([nicotine], ['tobacco_and_nicotine'])
    expect(violations[0]?.category).toBe('tobacco_and_nicotine')
  })

  it('keeps normalized substances for new clients', () => {
    const violations = buildLegacyViolations([nicotine], ['substances'])
    expect(violations[0]?.category).toBe('substances')
  })

  it('still aggregates the legacy summary independently from new channel reports', () => {
    const violations = buildLegacyViolations([insult], ['insults'])
    const videos: VideoScanResult[] = [{
      id: 'video-one11',
      title: 'One',
      publishedAt: '',
      url: 'https://www.youtube.com/watch?v=video-one11',
      status: 'analyzed',
      violations,
      detections: buildDetections(violations, ['insults']),
    }]

    expect(buildRuleSummary(videos, ['insults'])).toEqual([{
      ruleId: 'insults',
      label: 'Оскорбления',
      severity: 'low',
      violationCount: 1,
      affectedVideoCount: 1,
    }])
  })
})
