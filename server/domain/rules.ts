import type { RuleId } from '../../shared/types/check'
import { RULE_IDS } from '../../shared/types/check'
import { CONTENT_CATEGORY_LABELS, legacyRuleLabel } from './content-categories'

export { RULE_IDS }

export const RULE_LABELS: Record<RuleId, string> = Object.fromEntries(
  RULE_IDS.map((ruleId) => [
    ruleId,
    ruleId === 'alcohol_and_drugs' || ruleId === 'tobacco_and_nicotine'
      ? legacyRuleLabel(ruleId)
      : CONTENT_CATEGORY_LABELS[ruleId],
  ]),
) as Record<RuleId, string>
