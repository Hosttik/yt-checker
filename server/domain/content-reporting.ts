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

function sceneSummary(events: ContentEvent[]): string {
  const reasons = unique(events.map((event) => event.reason.trim()).filter(Boolean))
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

function evidenceRanges(events: ContentEvent[]): Array<{ startMs: number; endMs: number }> {
  const ranges = events
    .map((event) => ({ startMs: event.startMs, endMs: event.endMs }))
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
  events: ContentEvent[]
  contextStartMs: number
  contextEndMs: number
}

function draftScene(sceneId: string, events: ContentEvent[]): DraftScene {
  return {
    sceneId,
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
      scenesAreCompatible(candidate, scene) && overlapRatio(candidate, scene) >= 0.4,
    )

    if (!match) {
      merged.push({ ...scene, events: [...scene.events] })
      continue
    }

    match.events.push(...scene.events)
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

  const MAX_SCENE_GAP_MS = 45_000
  const drafts: DraftScene[] = []

  for (const [baseSceneId, groupedEvents] of groups.entries()) {
    const sorted = [...groupedEvents].sort((a, b) =>
      eventSceneStart(a) - eventSceneStart(b) || eventSceneEnd(a) - eventSceneEnd(b),
    )
    const clusters: ContentEvent[][] = []

    for (const event of sorted) {
      const current = clusters.at(-1)
      if (!current) {
        clusters.push([event])
        continue
      }
      const currentEnd = Math.max(...current.map(eventSceneEnd))
      if (eventSceneStart(event) <= currentEnd + MAX_SCENE_GAP_MS) current.push(event)
      else clusters.push([event])
    }

    clusters.forEach((sceneEvents, index) => {
      drafts.push(draftScene(
        clusters.length === 1 ? baseSceneId : `${baseSceneId}:${index + 1}`,
        sceneEvents,
      ))
    })
  }

  return mergeOverlappingScenes(drafts)
    .map((scene) => {
      const compactEvidence = evidenceRanges(scene.events)
      return {
        sceneId: scene.sceneId,
        startMs: compactEvidence[0]?.startMs ?? scene.contextStartMs,
        endMs: compactEvidence.at(-1)?.endMs ?? scene.contextEndMs,
        level: maxReportLevel(scene.events.map(eventLevel)),
        categories: sceneCategories(scene.events),
        evidenceRanges: compactEvidence,
        label: sceneLabel(scene.events),
        summary: sceneSummary(scene.events),
        events: scene.events,
      }
    })
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
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
