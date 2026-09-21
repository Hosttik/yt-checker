import type {
  RuleDetection,
  RuleId,
  RuleSummary,
  TimelineRange,
  VideoScanResult,
} from '../../shared/types/check'
import type { TranscriptSegment } from './transcript'
import { getRule } from './rules'

const RANGE_MERGE_GAP_MS = 1_000

function mergeRanges(ranges: TimelineRange[]): TimelineRange[] {
  if (ranges.length <= 1) return ranges

  const sorted = [...ranges].sort((a, b) => a.startMs - b.startMs)
  const merged: TimelineRange[] = []

  for (const range of sorted) {
    const previous = merged.at(-1)

    if (previous && range.startMs <= previous.endMs + RANGE_MERGE_GAP_MS) {
      previous.endMs = Math.max(previous.endMs, range.endMs)
      continue
    }

    merged.push({ ...range })
  }

  return merged
}

export function analyzeTranscript(
  segments: TranscriptSegment[],
  enabledRuleIds: RuleId[],
): RuleDetection[] {
  const detections = new Map<RuleId, { count: number; ranges: TimelineRange[] }>()

  for (const segment of segments) {
    for (const ruleId of enabledRuleIds) {
      const rule = getRule(ruleId)
      let segmentHitCount = 0

      for (const pattern of rule.patterns) {
        segmentHitCount += Array.from(segment.text.matchAll(pattern)).length
      }

      if (segmentHitCount === 0) continue

      const current = detections.get(ruleId) ?? { count: 0, ranges: [] }
      current.count += segmentHitCount
      current.ranges.push({
        startMs: segment.startMs,
        endMs: Math.max(segment.endMs, segment.startMs),
      })
      detections.set(ruleId, current)
    }
  }

  return enabledRuleIds.flatMap((ruleId) => {
    const detection = detections.get(ruleId)
    if (!detection) return []

    const rule = getRule(ruleId)

    return [{
      ruleId,
      label: rule.label,
      severity: rule.severity,
      count: detection.count,
      ranges: mergeRanges(detection.ranges),
    }]
  })
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
      const detection = video.detections.find((item) => item.ruleId === ruleId)
      if (!detection) continue

      videoCount += 1
      hitCount += detection.count
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
