import { describe, expect, it } from 'vitest'
import { CONTENT_CATEGORIES } from '../shared/types/content'
import {
  normalizeRequestedCategories,
  ruleMatchesClassification,
} from '../server/domain/content-categories'

describe('content category normalization', () => {
  it('keeps speech quality outside content-safety taxonomy', () => {
    expect(CONTENT_CATEGORIES).not.toContain('speechQuality' as never)
    expect(CONTENT_CATEGORIES).not.toContain('speech_quality' as never)
  })

  it('normalizes both legacy substance rules into one internal category', () => {
    expect(normalizeRequestedCategories(['alcohol_and_drugs'])).toEqual(['substances'])
    expect(normalizeRequestedCategories(['tobacco_and_nicotine'])).toEqual(['substances'])
    expect(normalizeRequestedCategories([
      'alcohol_and_drugs',
      'tobacco_and_nicotine',
      'substances',
    ])).toEqual(['substances'])
  })

  it('preserves old request scope while using normalized internal substances', () => {
    const nicotine = { category: 'substances' as const, subtype: 'nicotine' }
    const alcohol = { category: 'substances' as const, subtype: 'alcohol' }

    expect(ruleMatchesClassification('tobacco_and_nicotine', nicotine)).toBe(true)
    expect(ruleMatchesClassification('tobacco_and_nicotine', alcohol)).toBe(false)
    expect(ruleMatchesClassification('alcohol_and_drugs', nicotine)).toBe(false)
    expect(ruleMatchesClassification('alcohol_and_drugs', alcohol)).toBe(true)
    expect(ruleMatchesClassification('substances', nicotine)).toBe(true)
    expect(ruleMatchesClassification('substances', alcohol)).toBe(true)
  })
})
