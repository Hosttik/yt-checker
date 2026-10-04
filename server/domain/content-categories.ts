import type {
  ContentCategory,
  ContentEvent,
  LegacyRuleId,
} from '../../shared/types/content'
import type { RuleId } from '../../shared/types/check'
import { CONTENT_CATEGORIES } from '../../shared/types/content'

export const CONTENT_CATEGORY_LABELS: Record<ContentCategory, string> = {
  profanity_and_rude_language: 'Мат и грубая лексика',
  insults: 'Оскорбления',
  toilet_humor: 'Туалетный юмор',
  violence: 'Насилие',
  scary_and_disturbing: 'Пугающие и тревожные темы',
  sexual_content: 'Сексуальные темы',
  gambling: 'Азартные игры и ставки',
  substances: 'Алкоголь, никотин и другие вещества',
  self_harm: 'Самоповреждение',
}

export function normalizeRequestedCategories(ruleIds: RuleId[]): ContentCategory[] {
  const normalized = new Set<ContentCategory>()
  for (const ruleId of ruleIds) {
    if (ruleId === 'alcohol_and_drugs' || ruleId === 'tobacco_and_nicotine') {
      normalized.add('substances')
    } else if ((CONTENT_CATEGORIES as readonly string[]).includes(ruleId)) {
      normalized.add(ruleId as ContentCategory)
    }
  }
  return [...normalized]
}

export function ruleMatchesEvent(ruleId: RuleId, event: ContentEvent): boolean {
  if (ruleId === 'alcohol_and_drugs') {
    return event.category === 'substances' && event.subtype !== 'nicotine'
  }
  if (ruleId === 'tobacco_and_nicotine') {
    return event.category === 'substances' && event.subtype === 'nicotine'
  }
  return event.category === ruleId
}

export function legacyRuleLabel(ruleId: RuleId): string {
  if (ruleId === 'alcohol_and_drugs') return 'Алкоголь и наркотики'
  if (ruleId === 'tobacco_and_nicotine') return 'Табак и никотин'
  return CONTENT_CATEGORY_LABELS[ruleId]
}

export function legacyRuleForSubstance(subtype: string): LegacyRuleId {
  return subtype === 'nicotine' ? 'tobacco_and_nicotine' : 'alcohol_and_drugs'
}
