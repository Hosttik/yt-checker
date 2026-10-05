import type {
  RuleDetection,
  RuleId,
  RuleSeverity,
  RuleSummary,
  VideoScanResult,
  ViolationEvidence,
} from '../../shared/types/check'
import type { ContentEvent } from '../../shared/types/content'
import { ruleMatchesEvent } from './content-categories'
import { RULE_LABELS } from './rules'

const severityRank: Record<RuleSeverity, number> = { low: 0, medium: 1, high: 2 }

function legacyContext(event: ContentEvent): ViolationEvidence['context'] {
  if (event.context === 'real_world') return 'realistic'
  if (event.context === 'fiction') return 'fantasy'
  if (event.context === 'educational') return 'educational'
  if (event.context === 'game') return 'game'
  return 'other'
}

function legacyType(event: ContentEvent): ViolationEvidence['type'] {
  if (event.category !== 'profanity_and_rude_language') return 'not_applicable'
  return event.subtype === 'rude_language' ? 'rude_language' : 'profanity'
}

function preferredLegacyCategory(event: ContentEvent, requestedRuleIds: RuleId[]): RuleId {
  if (event.category !== 'substances') return event.category
  if (event.subtype === 'nicotine' && requestedRuleIds.includes('tobacco_and_nicotine')) {
    return 'tobacco_and_nicotine'
  }
  if (event.subtype !== 'nicotine' && requestedRuleIds.includes('alcohol_and_drugs')) {
    return 'alcohol_and_drugs'
  }
  return 'substances'
}

export function buildLegacyViolations(
  events: ContentEvent[],
  requestedRuleIds: RuleId[],
): ViolationEvidence[] {
  return events
    .filter((event) => event.displayLevel !== 'hidden')
    .filter((event) => requestedRuleIds.some((ruleId) => ruleMatchesEvent(ruleId, event)))
    .map((event) => ({
      category: preferredLegacyCategory(event, requestedRuleIds),
      severity: event.severity,
      context: legacyContext(event),
      type: legacyType(event),
      startMs: event.startMs,
      endMs: event.endMs,
      text: event.text,
      reason: event.reason,
    }))
}

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
