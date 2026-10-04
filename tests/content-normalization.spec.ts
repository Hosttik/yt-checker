import { describe, expect, it } from 'vitest'
import type { ClassifiedContentEvent } from '../shared/types/content'
import { normalizeClassifiedEvents } from '../server/domain/content-normalization'

const base: Extract<ClassifiedContentEvent, { category: 'violence' }> = {
  sourceCandidateId: 'candidate_1',
  sceneId: 'scene_1',
  category: 'violence',
  subtype: 'weapon_presence',
  severity: 'low',
  context: 'game',
  confidence: 0.7,
  startMs: 1_000,
  endMs: 2_000,
  text: 'Мне подарили меч.',
  reason: 'Персонажу подарили меч.',
  evidenceStrength: 'explicit',
  evidenceSource: 'transcript',
  engagementLevel: 'depiction',
  portrayal: 'neutral',
  explicitness: 'mild',
  assertionStatus: 'actual',
  details: {
    harmLevel: 'none',
    targetType: 'object',
    weaponRole: 'possessed',
    actionPurpose: 'unknown',
  },
}

describe('content classification normalization', () => {
  it('deduplicates identical classifications and keeps the higher-confidence version', () => {
    const result = normalizeClassifiedEvents([
      base,
      { ...base, confidence: 0.93, reason: 'Более уверенная классификация.' },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.confidence).toBe(0.93)
    expect(result[0]?.reason).toBe('Более уверенная классификация.')
  })

  it('keeps distinct subtypes from the same scene as separate semantic events', () => {
    const result = normalizeClassifiedEvents([
      base,
      {
        ...base,
        sourceCandidateId: 'candidate_2',
        subtype: 'dangerous_situation',
        details: {
          harmLevel: 'threatened',
          targetType: 'human_like_character',
          weaponRole: 'none',
          actionPurpose: 'threat',
        },
      },
    ])

    expect(result).toHaveLength(2)
  })
})
