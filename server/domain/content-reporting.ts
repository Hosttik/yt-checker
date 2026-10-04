import type {
  AnalysisProfile,
  ChannelCategoryReport,
  ContentCategory,
  ContentEvent,
  ParentRelevance,
  PresentationScene,
  ReportLevel,
  VideoCategoryReport,
} from '../../shared/types/content'
import { CONTENT_CATEGORY_LABELS } from './content-categories'
import { PARENT_RELEVANCE_RANK } from './content-policy'

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

function dynamicLabel(category: ContentCategory, events: ContentEvent[]): string {
  if (category === 'violence' && events.length > 0) {
    const fictional = events.every((event) => event.context === 'game' || event.context === 'fiction')
    if (fictional) return 'Игровое насилие и опасные сцены'
  }
  if (category === 'substances') {
    const subtypes = new Set(events.map((event) => event.subtype))
    if (subtypes.size === 1 && subtypes.has('nicotine')) return 'Табак и никотин'
    if (subtypes.size === 1 && subtypes.has('alcohol')) return 'Алкоголь'
  }
  return CONTENT_CATEGORY_LABELS[category]
}

function categorySummary(category: ContentCategory, events: ContentEvent[], displayed: ContentEvent[]): string {
  if (events.length === 0) return 'В проанализированных субтитрах релевантных элементов не обнаружено.'

  const subtypes = unique(events.map((event) => event.subtype))
  const contextText = events.every((event) => event.context === 'game' || event.context === 'fiction')
    ? ' Большинство найденных элементов относятся к игровому или вымышленному контексту.'
    : ''

  if (displayed.length === 0) {
    return 'Найдены только минимально значимые элементы, скрытые в обычном родительском отчёте.' + contextText
  }

  if (category === 'violence') {
    return `Обнаружены: ${subtypes.join(', ')}.${contextText}`
  }
  if (category === 'scary_and_disturbing') {
    return `Обнаружены пугающие или тревожные элементы: ${subtypes.join(', ')}.${contextText}`
  }
  if (category === 'substances') {
    return `Обнаружены упоминания или действия, связанные с веществами: ${subtypes.join(', ')}.`
  }
  return `Обнаружены элементы: ${subtypes.join(', ')}.${contextText}`
}

function sceneSummary(events: ContentEvent[]): string {
  const reasons = unique(events.map((event) => event.reason.trim()).filter(Boolean))
  return reasons.join(' ')
}

function sceneLabel(events: ContentEvent[]): string {
  if (events.some((event) => event.category === 'violence')
    && events.some((event) => event.category === 'scary_and_disturbing')) {
    return 'Напряжённая сцена'
  }
  const categories = unique(events.map((event) => event.category))
  return categories.length === 1
    ? dynamicLabel(categories[0]!, events)
    : categories.map((category) => CONTENT_CATEGORY_LABELS[category]).join(' · ')
}

export function buildPresentationScenes(events: ContentEvent[]): PresentationScene[] {
  const groups = new Map<string, ContentEvent[]>()
  for (const event of events.filter((item) => item.displayLevel !== 'hidden')) {
    const key = event.sceneId || event.id
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }

  return [...groups.entries()]
    .map(([sceneId, sceneEvents]) => ({
      sceneId,
      startMs: Math.min(...sceneEvents.map((event) => event.startMs)),
      endMs: Math.max(...sceneEvents.map((event) => event.endMs)),
      level: maxReportLevel(sceneEvents.map(eventLevel)),
      categories: unique(sceneEvents.map((event) => event.category)),
      label: sceneLabel(sceneEvents),
      summary: sceneSummary(sceneEvents),
      events: sceneEvents,
    }))
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
    return {
      category,
      label: dynamicLabel(category, raw),
      level: maxReportLevel(displayed.map(eventLevel)),
      rawEventCount: raw.length,
      displayedEventCount: displayed.length,
      subtypes: unique(raw.map((event) => event.subtype)),
      summary: categorySummary(category, raw, displayed),
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
    const affectedVideos = perVideo.filter((item) => item.events.length > 0).length
    const highlightedVideos = perVideo.filter((item) =>
      item.events.some((event) => event.displayLevel === 'highlight'),
    ).length
    const maxRelevance = raw.reduce<ParentRelevance>(
      (max, event) => PARENT_RELEVANCE_RANK[event.parentRelevance] > PARENT_RELEVANCE_RANK[max]
        ? event.parentRelevance
        : max,
      'minimal',
    )

    let level: ReportLevel = displayed.length === 0 ? 'none' : relevanceToReportLevel(maxRelevance)
    const affectedRatio = analyzedVideos > 0 ? affectedVideos / analyzedVideos : 0
    if (level === 'low' && affectedRatio >= 0.6 && displayed.length >= 3) level = 'moderate'
    else if (level === 'moderate' && affectedRatio >= 0.8 && displayed.length >= 5) level = 'high'
    if (raw.some((event) => event.parentRelevance === 'high')) level = 'high'

    const subtypeMap = new Map<string, { eventCount: number; videoIds: Set<string> }>()
    for (const item of perVideo) {
      for (const event of item.events) {
        const current = subtypeMap.get(event.subtype) ?? { eventCount: 0, videoIds: new Set<string>() }
        current.eventCount += 1
        current.videoIds.add(item.videoId)
        subtypeMap.set(event.subtype, current)
      }
    }

    return {
      category,
      label: dynamicLabel(category, raw),
      level,
      analyzedVideos,
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
      summary: categorySummary(category, raw, displayed),
    }
  })
}
