import type { RuleId } from '../../shared/types/check'
import { RULE_IDS } from '../../shared/types/check'

export { RULE_IDS }

export const RULE_LABELS: Record<RuleId, string> = {
  profanity_and_rude_language: 'Мат и грубая лексика',
  insults: 'Оскорбления',
  toilet_humor: 'Туалетный юмор',
  gambling: 'Азартные игры и ставки',
  sexual_content: 'Сексуальные темы',
  violence: 'Насилие',
  alcohol_and_drugs: 'Алкоголь и наркотики',
  scary_and_disturbing: 'Пугающие и тревожные темы',
  tobacco_and_nicotine: 'Табак и никотин',
  self_harm: 'Самоповреждение',
}
