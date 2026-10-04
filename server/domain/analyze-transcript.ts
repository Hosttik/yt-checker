import type {
  RuleDetection, RuleId, RuleSeverity, RuleSummary, VideoScanResult, ViolationEvidence,
} from '../../shared/types/check'
import { RULE_LABELS } from './rules'

const severityRank: Record<RuleSeverity, number> = { low: 0, medium: 1, high: 2 }

export function buildDetections(
  violations: ViolationEvidence[],
  enabledRuleIds: RuleId[],
): RuleDetection[] {
  return enabledRuleIds.flatMap((ruleId) => {
    const evidence = violations.filter((item) => item.category === ruleId)
    if (evidence.length === 0) return []
    const severity = evidence.reduce<RuleSeverity>(
      (highest, item) => severityRank[item.severity] > severityRank[highest] ? item.severity : highest,
      'low',
    )
    return [{
      ruleId,
      label: RULE_LABELS[ruleId],
      severity,
      count: evidence.length,
      ranges: evidence.map(({ startMs, endMs }) => ({ startMs, endMs })),
    }]
  })
}

export function buildRuleSummary(
  videos: VideoScanResult[],
  enabledRuleIds: RuleId[],
): RuleSummary[] {
  return enabledRuleIds.map((ruleId) => {
    const detections = videos.flatMap((video) => video.detections)
      .filter((detection) => detection.ruleId === ruleId)
    const severities = detections.map((item) => item.severity)
    return {
      ruleId,
      label: RULE_LABELS[ruleId],
      severity: severities.length > 0
        ? severities.reduce<RuleSeverity>(
          (highest, severity) => severityRank[severity] > severityRank[highest] ? severity : highest,
          severities[0]!,
        )
        : null,
      violationCount: detections.reduce((sum, item) => sum + item.count, 0),
      affectedVideoCount: detections.length,
    }
  })
}
