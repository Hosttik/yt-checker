import { describe, expect, it } from 'vitest'
import type { ClassifiedContentEvent, ContentEventReview } from '../shared/types/content'
import { applyContentPolicy } from '../server/domain/content-policy'
import { buildPresentationScenes } from '../server/domain/content-reporting'
import { groundEventCopy, copyGroundingIssue } from '../server/domain/content-evidence'

function review(overrides: Partial<ContentEventReview> = {}): ContentEventReview {
  return {
    status: 'confirmed', recommendedParentRelevance: 'high',
    evidenceSufficiency: 'sufficient', contextRanges: [],
    aggressionDirection: 'actor_to_target', intent: 'coercive',
    distress: 'clear', consequence: 'threatened_harm',
    duration: 'brief', repetition: 'single', narrativeFraming: 'humorous',
    highPriorityReason: 'Персонаж ограничивает другого.', rationale: '2026-10-11 scan',
    ...overrides,
  }
}

function gameConfinement(extra: Partial<ClassifiedContentEvent> = {}): ClassifiedContentEvent {
  return {
    category: 'scary_and_disturbing', subtype: 'confinement',
    severity: 'medium', context: 'game', confidence: 0.96,
    startMs: 434000, endMs: 442520,
    text: 'Компот, отпусти меня, пожалуйста. Нет, ты никуда не уйдёшь.',
    reason: 'Один персонаж просит отпустить его, другой отказывает.',
    evidenceStrength: 'explicit', evidenceSource: 'transcript',
    engagementLevel: 'depiction', portrayal: 'humorous', explicitness: 'mild',
    realism: 'stylized', imitationRisk: 'low',
    assertionStatus: 'actual',
    details: { fearIntensity: 'moderate', themePresent: true, threatPresent: true, supernatural: false },
    review: review(),
    ...extra,
  }
}

describe('Compot 2026-10-11 evidence-based controls', () => {
  it('tKmnOpeiIg0 07:14: brief gameplay refusal is not exceptional high priority', () => {
    const event = applyContentPolicy(gameConfinement(), 'brief', 'normal')
    expect([event.parentRelevance, event.displayLevel]).toEqual(['moderate', 'summary'])
    expect(buildPresentationScenes([event])[0]?.attention).toBe('details')
  })

  it('sustained confinement remains high with the same taxonomy', () => {
    const event = applyContentPolicy(gameConfinement({
      review: review({ duration: 'sustained', repetition: 'repeated' }),
    }), 'sustained', 'normal')
    expect(event.parentRelevance).toBe('high')
    expect(buildPresentationScenes([event])[0]?.attention).toBe('main')
  })

  it('MmdIhSW5B7Q 02:49: reviewer may not reverse an explicit negation', () => {
    const evidence = 'Я мыслю как человек, который не сбежал из психушки.'
    const mistaken = 'Он мыслит как человек, сбежавший из лечебницы.'
    expect(copyGroundingIssue(evidence, mistaken)).toBe('negation_reversed')
    const event = groundEventCopy(gameConfinement({
      text: evidence, reason: 'Персонаж рассказывает о себе.',
      review: review({ parentSummary: mistaken }),
    }))
    expect(event.review?.parentSummary).toContain('не сбежал')
    expect(event.review?.copyGroundingFallback).toBe('negation_reversed')
  })

  it('edgRlTMnF0o 08:00: reviewer may not add unsupported future consequences', () => {
    const evidence = 'Пожалуйста, в меня не целиться? Быстро говори, ты кто такой?'
    const mistaken = 'Полицейский угрожает пожизненным заключением после экспертизы пластилиновой головы.'
    const event = groundEventCopy(gameConfinement({
      text: evidence, reason: 'Персонаж просит в него не целиться.',
      review: review({ parentSummary: mistaken }),
    }))
    expect(event.review?.copyGroundingFallback).toBe('unsupported_clause')
    expect(event.review?.parentSummary).not.toContain('пожизненным')
  })

  it('wiuuBaYC8B8 06:15: fantastic accidental peril does not become high automatically', () => {
    const event = applyContentPolicy(gameConfinement({
      subtype: 'intense_peril', severity: 'high', realism: 'fantasy', imitationRisk: 'none',
      details: { fearIntensity: 'strong', themePresent: true, threatPresent: true, supernatural: true },
      review: review({ intent: 'accidental', aggressionDirection: 'none', distress: 'strong',
        duration: 'sustained', repetition: 'repeated' }),
    }), 'blackhole', 'normal')
    expect(event.parentRelevance).toBe('moderate')
  })
})
