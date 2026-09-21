import type {
  RuleId,
  RuleSummary,
  RuleViolation,
  TranscriptSegment,
  VideoScanResult,
} from '../../shared/types/check'
import { getRule } from './rules'

function excerpt(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= 220 ? compact : `${compact.slice(0, 217)}...`
}

export function analyzeTranscript(
  segments: TranscriptSegment[],
  enabledRuleIds: RuleId[],
): RuleViolation[] {
  const violations: RuleViolation[] = []

  for (const segment of segments) {
    for (const ruleId of enabledRuleIds) {
      const rule = getRule(ruleId)
      const matches: string[] = []
      let count = 0

      for (const pattern of rule.patterns) {
        for (const match of segment.text.matchAll(pattern)) {
          const matchedText = (match[1] ?? match[0]).trim()
          if (!matchedText) continue
          matches.push(matchedText)
          count += 1
        }
      }

      if (count > 0) {
        violations.push({
          ruleId,
          label: rule.label,
          severity: rule.severity,
          timestampMs: segment.offsetMs,
          excerpt: excerpt(segment.text),
          matches: [...new Set(matches)],
          count,
        })
      }
    }
  }

  return violations
}

export function buildRuleSummary(
  videos: VideoScanResult[],
  enabledRuleIds: RuleId[],
): RuleSummary[] {
  return enabledRuleIds.map((ruleId) => {
    const rule = getRule(ruleId)
    let hitCount = 0
    let videoCount = 0

    for (const video of videos) {
      const hits = video.violations.filter((violation) => violation.ruleId === ruleId)
      if (hits.length > 0) {
        videoCount += 1
        hitCount += hits.reduce((sum, violation) => sum + violation.count, 0)
      }
    }

    return {
      ruleId,
      label: rule.label,
      severity: rule.severity,
      hitCount,
      videoCount,
    }
  })
}
