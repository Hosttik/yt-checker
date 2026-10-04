import type {
  AnalysisProfile,
  ChannelCategoryReport,
  ContentCategory,
  ContentEvent,
  ParentRelevance,
  PresentationScene,
  PrevalenceLevel,
  ReportLevel,
  VideoCategoryReport,
} from '../../shared/types/content'
import { CONTENT_CATEGORY_LABELS } from './content-categories'
import {
  categoryPolicies,
  PARENT_RELEVANCE_RANK,
  type CategoryPolicy,
} from './content-policy'

const reportRank: Record<ReportLevel, number> = { none: 0, low: 1, moderate: 2, high: 3 }

function relevanceToReportLevel(relevance: ParentRelevance): ReportLevel {
  if (relevance === 'high') return 'high'
  if (relevance === 'moderate') return 'moderate'
  return 'low'
}

function maxReportLevel(levels: ReportLevel[]): ReportLevel {
  return levels.reduce<ReportLevel>(
    (max, level) => reportRank[level] > reportRank[max] ? level : max,
    'none',
  )
}

function eventLevel(event: ContentEvent): ReportLevel {
  return event.displayLevel === 'hidden' ? 'none' : relevanceToReportLevel(event.parentRelevance)
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function policyFor(category: ContentCategory): CategoryPolicy {
  return categoryPolicies[category] as CategoryPolicy
}

function reasonWords(reason: string): Set<string> {
  return new Set(reason.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
}

function reasonsOverlap(a: string, b: string): boolean {
  const left = reasonWords(a)
  const right = reasonWords(b)
  if (left.size === 0 || right.size === 0) return false
  let common = 0
  for (const word of left) if (right.has(word)) common += 1
  return common / Math.min(left.size, right.size) >= 0.6
}

function sceneSummary(events: ContentEvent[]): string {
  const severityRank = { low: 1, medium: 2, high: 3 } as const
  const ordered = [...events].sort((a, b) => {
    const relevanceDelta = PARENT_RELEVANCE_RANK[b.parentRelevance] - PARENT_RELEVANCE_RANK[a.parentRelevance]
    if (relevanceDelta !== 0) return relevanceDelta
    return severityRank[b.severity] - severityRank[a.severity]
  })

  const reasons: string[] = []
  for (const event of ordered) {
    const reason = event.reason.trim()
    if (!reason || reasons.some((existing) => existing === reason || reasonsOverlap(existing, reason))) continue
    reasons.push(reason)
    if (reasons.length >= 2) break
  }
  return reasons.join(' ')
}

function prevalenceLevel(affectedVideos: number, analyzedVideos: number): PrevalenceLevel {
  if (affectedVideos === 0 || analyzedVideos === 0) return 'none'
  const ratio = affectedVideos / analyzedVideos
  if (ratio <= 0.2) return 'rare'
  if (ratio <= 0.5) return 'occasional'
  if (ratio <= 0.8) return 'common'
  return 'pervasive'
}

function sceneLabel(events: ContentEvent[]): string {
  if (events.some((event) => event.category === 'violence')
    && events.some((event) => event.category === 'scary_and_disturbing')) {
    return 'Напряжённая сцена'
  }
  const categories = unique(events.map((event) => event.category))
  return categories.length === 1
    ? policyFor(categories[0]!).getLabel(events)
    : categories.map((category) => CONTENT_CATEGORY_LABELS[category]).join(' · ')
}

function eventSceneStart(event: ContentEvent): number {
  return event.sceneStartMs ?? event.startMs
}

function eventSceneEnd(event: ContentEvent): number {
  return event.sceneEndMs ?? event.endMs
}

function eventEvidenceRanges(event: ContentEvent): Array<{ startMs: number; endMs: number }> {
  return event.evidenceRanges && event.evidenceRanges.length > 0
    ? event.evidenceRanges
    : [{ startMs: event.startMs, endMs: event.endMs }]
}

function eventEvidenceStart(event: ContentEvent): number {
  return Math.min(...eventEvidenceRanges(event).map((range) => range.startMs))
}

function eventEvidenceEnd(event: ContentEvent): number {
  return Math.max(...eventEvidenceRanges(event).map((range) => range.endMs))
}

function evidenceRanges(events: ContentEvent[]): Array<{ startMs: number; endMs: number }> {
  const ranges = events
    .flatMap(eventEvidenceRanges)
    .map((range) => ({ ...range }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)

  const merged: Array<{ startMs: number; endMs: number }> = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last && range.startMs <= last.endMs + 5_000) {
      last.endMs = Math.max(last.endMs, range.endMs)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

interface DraftScene {
  sceneId: string
  originSceneIds: string[]
  events: ContentEvent[]
  contextStartMs: number
  contextEndMs: number
}

function draftScene(sceneId: string, events: ContentEvent[], originSceneId: string): DraftScene {
  return {
    sceneId,
    originSceneIds: [originSceneId],
    events,
    contextStartMs: Math.min(...events.map(eventSceneStart)),
    contextEndMs: Math.max(...events.map(eventSceneEnd)),
  }
}

function sceneCategories(events: ContentEvent[]): ContentCategory[] {
  return unique(events.map((event) => event.category))
}

function scenesAreCompatible(a: DraftScene, b: DraftScene): boolean {
  const aCategories = sceneCategories(a.events)
  const bCategories = sceneCategories(b.events)
  if (aCategories.some((category) => bCategories.includes(category))) return true

  const complementary = (left: ContentCategory[], right: ContentCategory[]) =>
    left.includes('violence') && right.includes('scary_and_disturbing')

  return complementary(aCategories, bCategories) || complementary(bCategories, aCategories)
}

function overlapRatio(a: DraftScene, b: DraftScene): number {
  const overlap = Math.max(0, Math.min(a.contextEndMs, b.contextEndMs) - Math.max(a.contextStartMs, b.contextStartMs))
  const shorter = Math.min(
    Math.max(1, a.contextEndMs - a.contextStartMs),
    Math.max(1, b.contextEndMs - b.contextStartMs),
  )
  return overlap / shorter
}

function mergeOverlappingScenes(scenes: DraftScene[]): DraftScene[] {
  const merged: DraftScene[] = []

  for (const scene of [...scenes].sort((a, b) => a.contextStartMs - b.contextStartMs)) {
    const match = merged.find((candidate) =>
      !candidate.originSceneIds.some((origin) => scene.originSceneIds.includes(origin))
      && scenesAreCompatible(candidate, scene)
      && overlapRatio(candidate, scene) >= 0.4,
    )

    if (!match) {
      merged.push({ ...scene, events: [...scene.events] })
      continue
    }

    match.events.push(...scene.events)
    match.originSceneIds = unique([...match.originSceneIds, ...scene.originSceneIds])
    match.contextStartMs = Math.min(match.contextStartMs, scene.contextStartMs)
    match.contextEndMs = Math.max(match.contextEndMs, scene.contextEndMs)
    match.sceneId = `${match.sceneId}+${scene.sceneId}`
  }

  return merged
}

export function buildPresentationScenes(events: ContentEvent[]): PresentationScene[] {
  const groups = new Map<string, ContentEvent[]>()
  for (const event of events.filter((item) => item.displayLevel !== 'hidden')) {
    const key = event.sceneId || event.id
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }

  const MAX_SCENE_GAP_MS = 75_000
  const drafts: DraftScene[] = []

  for (const [baseSceneId, groupedEvents] of groups.entries()) {
    const sorted = [...groupedEvents].sort((a, b) =>
      eventEvidenceStart(a) - eventEvidenceStart(b) || eventEvidenceEnd(a) - eventEvidenceEnd(b),
    )
    const clusters: ContentEvent[][] = []

    for (const event of sorted) {
      const current = clusters.at(-1)
      if (!current) {
        clusters.push([event])
        continue
      }
      const currentEnd = Math.max(...current.map(eventEvidenceEnd))
      if (eventEvidenceStart(event) <= currentEnd + MAX_SCENE_GAP_MS) current.push(event)
      else clusters.push([event])
    }

    clusters.forEach((sceneEvents, index) => {
      drafts.push(draftScene(
        clusters.length === 1 ? baseSceneId : `${baseSceneId}:${index + 1}`,
        sceneEvents,
        baseSceneId,
      ))
    })
  }

  return mergeOverlappingScenes(drafts)
    .map((scene) => {
      const compactEvidence = evidenceRanges(scene.events)
      const level = maxReportLevel(scene.events.map(eventLevel))
      const reviewedCount = scene.events.filter((event) =>
        event.review && event.review.status !== 'not_reviewed',
      ).length
      const reviewStatus = reviewedCount === 0
        ? 'unreviewed' as const
        : reviewedCount === scene.events.length
          ? 'reviewed' as const
          : 'mixed' as const
      return {
        sceneId: scene.sceneId,
        startMs: compactEvidence[0]?.startMs ?? scene.contextStartMs,
        endMs: compactEvidence.at(-1)?.endMs ?? scene.contextEndMs,
        level,
        attention: (level === 'moderate' || level === 'high' ? 'main' : 'details') as 'main' | 'details',
        reviewStatus,
        categories: sceneCategories(scene.events),
        evidenceRanges: compactEvidence,
        label: sceneLabel(scene.events),
        summary: sceneSummary(scene.events),
        events: scene.events,
      }
    })
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
}

export function buildVideoContentSummary(scenes: PresentationScene[]): string {
  const main = scenes.filter((scene) => scene.attention === 'main')
  const details = scenes.filter((scene) => scene.attention === 'details')

  if (main.length === 0 && details.length === 0) {
    return 'В проанализированных субтитрах значимых сцен для выбранных критериев не обнаружено.'
  }
  if (main.length === 0) {
    return `Существенных сцен в проанализированных субтитрах не обнаружено; лёгких или спорных находок: ${details.length}.`
  }
  const detailSuffix = details.length > 0
    ? ` Ещё ${details.length} лёгких или спорных находок вынесено в подробности.`
    : ''
  return `В проанализированных субтитрах есть ${main.length} сцен, на которые стоит обратить внимание.${detailSuffix}`
}

export function buildVideoCategoryReports(
  events: ContentEvent[],
  enabledCategories: ContentCategory[],
): VideoCategoryReport[] {
  return enabledCategories.map((category) => {
    const raw = events.filter((event) => event.category === category)
    const displayed = raw.filter((event) => event.displayLevel !== 'hidden')
    const highlights = displayed.filter((event) => event.displayLevel === 'highlight')
    const policy = policyFor(category)
    const presentationEvents = displayed.length > 0 ? displayed : raw
    return {
      category,
      label: policy.getLabel(presentationEvents),
      level: maxReportLevel(displayed.map(eventLevel)),
      rawEventCount: raw.length,
      displayedEventCount: displayed.length,
      subtypes: unique(raw.map((event) => event.subtype)),
      summary: policy.summarize(raw, displayed),
      highlights,
      details: displayed,
    }
  })
}

export function buildChannelCategoryReports(
  eventsByVideo: Array<{ videoId: string; events: ContentEvent[] }>,
  enabledCategories: ContentCategory[],
  analyzedVideos: number,
  _profile: AnalysisProfile,
): ChannelCategoryReport[] {
  return enabledCategories.map((category) => {
    const perVideo = eventsByVideo.map(({ videoId, events }) => ({
      videoId,
      events: events.filter((event) => event.category === category),
    }))
    const raw = perVideo.flatMap((item) => item.events)
    const displayed = raw.filter((event) => event.displayLevel !== 'hidden')
    const rawAffectedVideos = perVideo.filter((item) => item.events.length > 0).length
    const affectedVideos = perVideo.filter((item) =>
      item.events.some((event) => event.displayLevel !== 'hidden'),
    ).length
    const highlightedVideos = perVideo.filter((item) =>
      item.events.some((event) => event.displayLevel === 'highlight'),
    ).length
    const moderatePlusAffectedVideos = perVideo.filter((item) =>
      item.events.some((event) =>
        event.displayLevel !== 'hidden'
        && (event.parentRelevance === 'moderate' || event.parentRelevance === 'high'),
      ),
    ).length
    const maxDisplayedRelevance = displayed.reduce<ParentRelevance>(
      (max, event) => PARENT_RELEVANCE_RANK[event.parentRelevance] > PARENT_RELEVANCE_RANK[max]
        ? event.parentRelevance
        : max,
      'minimal',
    )

    const peakConcern: ReportLevel = displayed.length === 0
      ? 'none'
      : relevanceToReportLevel(maxDisplayedRelevance)
    let level: ReportLevel = peakConcern
    const affectedRatio = analyzedVideos > 0 ? affectedVideos / analyzedVideos : 0
    if (level === 'low' && affectedRatio >= 0.6 && displayed.length >= 3) level = 'moderate'
    else if (level === 'moderate' && affectedRatio >= 0.8 && displayed.length >= 5) level = 'high'
    if (displayed.some((event) => event.parentRelevance === 'high')) level = 'high'
    const prevalence = prevalenceLevel(affectedVideos, analyzedVideos)
    const moderatePlusAffectedRatio = analyzedVideos > 0 ? moderatePlusAffectedVideos / analyzedVideos : 0
    const moderatePlusPrevalence = prevalenceLevel(moderatePlusAffectedVideos, analyzedVideos)

    const subtypeMap = new Map<string, { eventCount: number; videoIds: Set<string> }>()
    for (const item of perVideo) {
      for (const event of item.events) {
        const current = subtypeMap.get(event.subtype) ?? { eventCount: 0, videoIds: new Set<string>() }
        current.eventCount += 1
        current.videoIds.add(item.videoId)
        subtypeMap.set(event.subtype, current)
      }
    }

    const policy = policyFor(category)
    const presentationEvents = displayed.length > 0 ? displayed : raw
    return {
      category,
      label: policy.getLabel(presentationEvents),
      level,
      peakConcern,
      prevalence,
      affectedRatio,
      moderatePlusPrevalence,
      moderatePlusAffectedRatio,
      moderatePlusAffectedVideos,
      analyzedVideos,
      rawAffectedVideos,
      affectedVideos,
      highlightedVideos,
      rawEventCount: raw.length,
      displayedEventCount: displayed.length,
      subtypeStats: [...subtypeMap.entries()]
        .map(([subtype, value]) => ({
          subtype,
          eventCount: value.eventCount,
          videoCount: value.videoIds.size,
        }))
        .sort((a, b) => b.eventCount - a.eventCount || a.subtype.localeCompare(b.subtype)),
      summary: policy.summarize(raw, displayed),
    }
  })
}
