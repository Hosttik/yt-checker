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
const CONTEXT_SEGMENTS_EACH_SIDE = 1
const MAX_CONTEXT_CHARS = 900

/**
 * Server-only intermediate that may contain raw transcript context.
 * Never return, persist, cache, log, or send this type to the client.
 */
export interface TranscriptCandidate {
  id: string
  ruleId: RuleId
  hitCount: number
  startMs: number
  endMs: number
  context: string
}

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

function buildContext(segments: TranscriptSegment[], segmentIndex: number): string {
  const start = Math.max(0, segmentIndex - CONTEXT_SEGMENTS_EACH_SIDE)
  const end = Math.min(segments.length, segmentIndex + CONTEXT_SEGMENTS_EACH_SIDE + 1)

  return segments
    .slice(start, end)
    .map((segment, index) => index === segmentIndex - start
      ? `[CANDIDATE] ${segment.text}`
      : segment.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CONTEXT_CHARS)
}

export function findTranscriptCandidates(
  segments: TranscriptSegment[],
  enabledRuleIds: RuleId[],
): TranscriptCandidate[] {
  const candidates: TranscriptCandidate[] = []
  let candidateIndex = 0

  segments.forEach((segment, segmentIndex) => {
    for (const ruleId of enabledRuleIds) {
      const rule = getRule(ruleId)
      let hitCount = 0

      for (const pattern of rule.patterns) {
        hitCount += Array.from(segment.text.matchAll(pattern)).length
      }

      if (hitCount === 0) continue

      candidates.push({
        id: `c${candidateIndex}`,
        ruleId,
        hitCount,
        startMs: segment.startMs,
        endMs: Math.max(segment.endMs, segment.startMs),
        context: buildContext(segments, segmentIndex),
      })
      candidateIndex += 1
    }
  })

  return candidates
}

export function buildDetections(
  candidates: TranscriptCandidate[],
  enabledRuleIds: RuleId[],
): RuleDetection[] {
  const grouped = new Map<RuleId, { count: number; ranges: TimelineRange[] }>()

  for (const candidate of candidates) {
    const current = grouped.get(candidate.ruleId) ?? { count: 0, ranges: [] }
    current.count += candidate.hitCount
    current.ranges.push({
      startMs: candidate.startMs,
      endMs: candidate.endMs,
    })
    grouped.set(candidate.ruleId, current)
  }

  return enabledRuleIds.flatMap((ruleId) => {
    const detection = grouped.get(ruleId)
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

export function analyzeTranscript(
  segments: TranscriptSegment[],
  enabledRuleIds: RuleId[],
): RuleDetection[] {
  return buildDetections(findTranscriptCandidates(segments, enabledRuleIds), enabledRuleIds)
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
