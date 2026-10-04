import { describe, expect, it } from 'vitest'
import type { ClassifiedContentEvent } from '../shared/types/content'
import { validateClassifiedEvents } from '../server/domain/content-validation'

function violence(
  overrides: Partial<Extract<ClassifiedContentEvent, { category: 'violence' }>> = {},
): Extract<ClassifiedContentEvent, { category: 'violence' }> {
  return {
    category: 'violence',
    subtype: 'life_threatening_situation',
    severity: 'medium',
    context: 'game',
    confidence: 0.99,
    startMs: 1_000,
    endMs: 2_000,
    text: 'Вы что, меня в лаву хотите скинуть? Да какую лаву.',
    reason: 'Опасение тут же отрицается.',
    evidenceStrength: 'explicit',
    evidenceSource: 'transcript',
    engagementLevel: 'mention',
    portrayal: 'neutral',
    explicitness: 'mild',
    assertionStatus: 'negated',
    details: {
      harmLevel: 'threatened',
      targetType: 'human_like_character',
      weaponRole: 'none',
      actionPurpose: 'unknown',
    },
    ...overrides,
  }
}

describe('content semantic validation', () => {
  it('drops an explicitly negated life-threatening interpretation', () => {
    const result = validateClassifiedEvents([violence()])
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected[0]?.reason).toContain('negated')
  })

  it('drops merely hypothetical danger', () => {
    const result = validateClassifiedEvents([violence({ assertionStatus: 'hypothetical' })])
    expect(result.accepted).toHaveLength(0)
  })

  it('keeps a real threatened lethal situation', () => {
    const result = validateClassifiedEvents([violence({
      assertionStatus: 'threatened',
      text: 'Мы привязаны к рельсам. Поезд едет.',
      reason: 'Персонажи привязаны к рельсам перед поездом.',
    })])
    expect(result.accepted).toHaveLength(1)
    expect(result.rejected).toHaveLength(0)
  })

  it('rejects dangerous_situation with no danger semantics', () => {
    const result = validateClassifiedEvents([violence({
      subtype: 'dangerous_situation',
      assertionStatus: 'actual',
      details: {
        harmLevel: 'none',
        targetType: 'human_like_character',
        weaponRole: 'none',
        actionPurpose: 'unknown',
      },
    })])
    expect(result.accepted).toHaveLength(0)
  })
  it('normalizes a conditional coercive threat instead of dropping it as hypothetical', () => {
    const result = validateClassifiedEvents([violence({
      subtype: 'violent_threat',
      assertionStatus: 'hypothetical',
      details: {
        harmLevel: 'threatened',
        targetType: 'human_like_character',
        weaponRole: 'none',
        actionPurpose: 'threat',
      },
      text: 'Сделай это, иначе жителям конец.',
      reason: 'Персонаж ставит условие и угрожает жителям.',
    })])

    expect(result.rejected).toHaveLength(0)
    expect(result.accepted[0]?.assertionStatus).toBe('threatened')
    expect(result.adjustments).toHaveLength(1)
  })

  it('rejects an implied physical attack when transcript evidence is not explicit', () => {
    const result = validateClassifiedEvents([violence({
      subtype: 'physical_attack',
      assertionStatus: 'actual',
      evidenceStrength: 'strong_context',
      details: {
        harmLevel: 'implied',
        targetType: 'human_like_character',
        weaponRole: 'none',
        actionPurpose: 'attack',
      },
      text: 'О нет, зомби тут. [стон]',
      reason: 'Стоны могут указывать на нападение.',
    })])

    expect(result.accepted).toHaveLength(0)
    expect(result.rejected[0]?.reason).toContain('requires explicit transcript evidence')
  })

})
