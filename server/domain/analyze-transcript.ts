import type {
  CandidateResolution,
  RuleDetection,
  RuleId,
  RuleSummary,
  TimelineRange,
  VideoScanResult,
} from '../../shared/types/check'
import type { TranscriptSegment } from './transcript'
import { getRule } from './rules'

const RANGE_MERGE_GAP_MS = 1_000
export const CANDIDATE_MERGE_GAP_MS = 5_000
const CONTEXT_SEGMENTS_EACH_SIDE = 2
const MAX_CONTEXT_CHARS = 900
const MAX_INCIDENT_MS = 25_000

/**
 * Server-only intermediate that may contain raw transcript context.
 * Never return this type to the public API/client.
 * Raw fields may only be persisted/logged in explicitly enabled diagnostic mode.
 */
export interface TranscriptCandidate {
  id: string
  ruleId: RuleId
  hitCount: number
  startMs: number
  endMs: number
  segmentText: string
  matchedTerms: string[]
  context: string
  contextTruncated?: boolean
  transcriptLanguage?: string
  transcriptSource: 'manual' | 'asr' | 'unknown'
  resolution?: CandidateResolution
  jev?: {
    choice?: 'violation' | 'benign' | 'uncertain'
    confidence?: number
    probabilities?: Partial<Record<'violation' | 'benign' | 'uncertain', number>>
  }
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

  const candidateText = `[CANDIDATE] ${segments[segmentIndex]!.text}`
  const nearby = (items: TranscriptSegment[]) => items
    .filter((segment) => Math.abs(segment.startMs - segments[segmentIndex]!.startMs) <= 10_000)
    .map((segment) => segment.text).join(' ')
  const budget = Math.max(0, MAX_CONTEXT_CHARS - candidateText.length - 2)
  const beforeBudget = Math.floor(budget / 2)
  const before = beforeBudget ? nearby(segments.slice(start, segmentIndex)).slice(-beforeBudget) : ''
  const after = nearby(segments.slice(segmentIndex + 1, end)).slice(0, budget - before.length)
  return `${before} ${candidateText} ${after}`.replace(/\s+/g, ' ').trim().slice(0, MAX_CONTEXT_CHARS)
}

function transcriptSource(language?: string): TranscriptCandidate['transcriptSource'] {
  if (!language) return 'unknown'
  return language.toLowerCase().startsWith('asr') ? 'asr' : 'manual'
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function mergeCandidates(candidates: TranscriptCandidate[]): TranscriptCandidate[] {
  const sorted = [...candidates].sort((a, b) => a.startMs - b.startMs)
  const merged: TranscriptCandidate[] = []
  const lastByRule = new Map<RuleId, TranscriptCandidate>()

  for (const candidate of sorted) {
    const previous = lastByRule.get(candidate.ruleId)
    if (
      previous
      && previous.ruleId === candidate.ruleId
      && candidate.startMs <= previous.endMs + CANDIDATE_MERGE_GAP_MS
      && candidate.endMs - previous.startMs <= MAX_INCIDENT_MS
      && unique([previous.context, candidate.context]).join(' ').length <= MAX_CONTEXT_CHARS
    ) {
      previous.hitCount += candidate.hitCount
      previous.endMs = Math.max(previous.endMs, candidate.endMs)
      previous.matchedTerms = unique([...previous.matchedTerms, ...candidate.matchedTerms])
      previous.segmentText = unique([previous.segmentText, candidate.segmentText]).join(' ')
      previous.context = unique([previous.context, candidate.context]).join(' ').slice(0, MAX_CONTEXT_CHARS)
      continue
    }
    const next = { ...candidate }
    merged.push(next)
    lastByRule.set(candidate.ruleId, next)
  }

  return merged
    .sort((a, b) => a.startMs - b.startMs)
    .map((candidate, index) => ({ ...candidate, id: `c${index}` }))
}

export function findTranscriptCandidates(
  segments: TranscriptSegment[],
  enabledRuleIds: RuleId[],
  transcriptLanguage?: string,
): TranscriptCandidate[] {
  const candidates: TranscriptCandidate[] = []
  const source = transcriptSource(transcriptLanguage)

  segments.forEach((segment, segmentIndex) => {
    for (const ruleId of enabledRuleIds) {
      const rule = getRule(ruleId)
      const matchedTerms: string[] = []

      for (const pattern of rule.patterns) {
        for (const match of segment.text.matchAll(pattern)) {
          matchedTerms.push((match[1] ?? match[0]).trim())
        }
      }

      if (matchedTerms.length === 0) continue

      candidates.push({
        id: '',
        ruleId,
        hitCount: matchedTerms.length,
        startMs: segment.startMs,
        endMs: Math.max(segment.endMs, segment.startMs),
        segmentText: segment.text,
        matchedTerms,
        context: buildContext(segments, segmentIndex),
        contextTruncated: segment.text.length + 12 > MAX_CONTEXT_CHARS,
        transcriptLanguage,
        transcriptSource: source,
      })
    }
  })

  for (const ruleId of enabledRuleIds) {
    const rule = getRule(ruleId)
    if (!rule.contextPatterns?.length) continue
    const seenMatches = new Set<string>()

    for (let startIndex = 0; startIndex < segments.length; startIndex += 1) {
      const window = segments.slice(startIndex, startIndex + 3).filter(
        (segment) => segment.endMs - segments[startIndex]!.startMs <= 10_000,
      )
      if (window.length === 0) continue
      const windowText = window.map((segment) => segment.text).join(' ')
      for (const pattern of rule.contextPatterns) {
        for (const match of windowText.matchAll(pattern)) {
          const matchStart = match.index!
          const matchEnd = matchStart + match[0].length
          let offset = 0
          const affected = window.filter((segment) => {
            const overlaps = offset < matchEnd && offset + segment.text.length > matchStart
            offset += segment.text.length + 1
            return overlaps
          })
          const key = `${affected[0]!.startMs}:${match[0]}`
          if (seenMatches.has(key)) continue
          seenMatches.add(key)
          candidates.push({
            id: '',
            ruleId,
            hitCount: 1,
            startMs: affected[0]!.startMs,
            endMs: affected.at(-1)!.endMs,
            segmentText: affected.map((segment) => segment.text).join(' '),
            matchedTerms: [match[0]],
            context: `[CANDIDATE] ${match[0]} ${windowText}`.slice(0, MAX_CONTEXT_CHARS),
            transcriptLanguage,
            transcriptSource: source,
          })
        }
      }
    }
  }

  return mergeCandidates(candidates)
}

export function buildDetections(
  candidates: TranscriptCandidate[],
  enabledRuleIds: RuleId[],
): RuleDetection[] {
  const grouped = new Map<RuleId, {
    count: number
    confirmedCount: number
    reviewCount: number
    ranges: TimelineRange[]
  }>()

  for (const candidate of candidates) {
    if (candidate.resolution === 'dismissed') continue
    const current = grouped.get(candidate.ruleId) ?? {
      count: 0,
      confirmedCount: 0,
      reviewCount: 0,
      ranges: [],
    }
    current.count += candidate.hitCount
    if (candidate.resolution === 'confirmed') current.confirmedCount += candidate.hitCount
    else current.reviewCount += candidate.hitCount
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
      confirmedCount: detection.confirmedCount,
      reviewCount: detection.reviewCount,
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
    let confirmedCount = 0
    let reviewCount = 0
    let videoCount = 0

    for (const video of videos) {
      const detection = video.detections.find((item) => item.ruleId === ruleId)
      if (!detection) continue

      videoCount += 1
      hitCount += detection.count
      confirmedCount += detection.confirmedCount
      reviewCount += detection.reviewCount
    }

    return {
      ruleId,
      label: rule.label,
      severity: rule.severity,
      hitCount,
      confirmedCount,
      reviewCount,
      videoCount,
    }
  })
}
