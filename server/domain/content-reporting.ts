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

function sceneEventSignalScore(event: ContentEvent): number {
  const severityRank = { low: 1, medium: 2, high: 3 } as const
  const review = event.review
  let score = PARENT_RELEVANCE_RANK[event.parentRelevance] * 100
    + severityRank[event.severity] * 10

  if (review && review.status !== 'not_reviewed') score += 10
  if (review?.evidenceSufficiency === 'sufficient') score += 8
  else if (review?.evidenceSufficiency === 'partial') score += 2

  if (event.assertionStatus === 'actual' || event.assertionStatus === 'threatened') score += 4
  if (event.engagementLevel === 'depiction' || event.engagementLevel === 'participation') score += 3

  if (review?.distress === 'strong') score += 8
  else if (review?.distress === 'clear') score += 4

  if (review?.consequence === 'death') score += 12
  else if (review?.consequence === 'injury_or_severe_harm') score += 10
  else if (review?.consequence === 'threatened_harm') score += 6
  else if (review?.consequence === 'property_only') score += 1

  if (review?.duration === 'sustained') score += 5
  if (review?.repetition === 'pattern') score += 5
  else if (review?.repetition === 'repeated') score += 3

  if (event.category === 'scary_and_disturbing') {
    if (event.details.fearIntensity === 'strong') score += 8
    else if (event.details.fearIntensity === 'moderate') score += 3
    if (event.details.threatPresent) score += 3
    if (event.subtype === 'intense_peril') score += 3
  }

  if (event.category === 'violence') {
    if (event.subtype === 'life_threatening_situation') score += 10
    else if (event.subtype === 'physical_attack' || event.subtype === 'violent_threat') score += 6
    else if (event.subtype === 'dangerous_situation') score += 3
    if (event.details.weaponRole === 'used' || event.details.weaponRole === 'threatened_use') score += 4
    if (event.details.harmLevel === 'actual' || event.details.harmLevel === 'attempted') score += 3
  }

  return score
}

function orderedSceneEvents(events: ContentEvent[]): ContentEvent[] {
  return [...events].sort((a, b) =>
    sceneEventSignalScore(b) - sceneEventSignalScore(a)
    || eventEvidenceStart(a) - eventEvidenceStart(b),
  )
}

function primarySceneEvent(events: ContentEvent[]): ContentEvent | undefined {
  const ordered = orderedSceneEvents(events)
  return ordered.find((event) => event.review?.parentSummary?.trim())
    ?? ordered.find((event) => event.reason.trim())
    ?? ordered[0]
}

function sceneSummary(events: ContentEvent[]): string {
  const primary = primarySceneEvent(events)
  return primary?.review?.parentSummary?.trim()
    || primary?.reason.trim()
    || ''
}

function sceneMitigatingContext(events: ContentEvent[]): string | undefined {
  const primary = primarySceneEvent(events)
  const summary = primary?.review?.parentSummary?.trim() || primary?.reason.trim() || ''
  const primaryContext = primary?.review?.mitigatingContext?.trim()
  if (primaryContext && primaryContext !== summary) return primaryContext

  return orderedSceneEvents(events)
    .filter((event) => event !== primary)
    .map((event) => event.review?.mitigatingContext?.trim())
    .find((value): value is string => Boolean(value && value !== summary))
}

function scenePriorityReason(events: ContentEvent[]): string | undefined {
  const primary = primarySceneEvent(events)
  if (primary?.parentRelevance === 'high' && primary.review?.highPriorityReason?.trim()) {
    return primary.review.highPriorityReason.trim()
  }
  return orderedSceneEvents(events)
    .filter((event) => event.parentRelevance === 'high')
    .map((event) => event.review?.highPriorityReason?.trim())
    .find((value): value is string => Boolean(value))
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

function normalizedReviewValue(value?: string): string | undefined {
  const normalized = value?.trim().toLocaleLowerCase('ru-RU')
  return normalized || undefined
}

function reviewValues(
  scene: DraftScene,
  field: 'actor' | 'target',
): string[] {
  return unique(scene.events
    .map((event) => normalizedReviewValue(event.review?.[field]))
    .filter((value): value is string => Boolean(value)))
}

function scenesShareReviewValue(
  a: DraftScene,
  b: DraftScene,
  field: 'actor' | 'target',
): boolean {
  const left = reviewValues(a, field)
  const right = reviewValues(b, field)
  return left.some((value) => right.includes(value))
}

function sceneHasDirectedCoercion(scene: DraftScene): boolean {
  return scene.events.some((event) =>
    event.review?.intent === 'coercive'
    && event.review.aggressionDirection === 'actor_to_target',
  )
}

function scenesBelongToSameStoryArc(a: DraftScene, b: DraftScene): boolean {
  const STORY_ARC_GAP_MS = 90_000
  const gap = b.contextStartMs - a.contextEndMs
  if (gap < 0 || gap > STORY_ARC_GAP_MS || !scenesAreCompatible(a, b)) return false

  const sameActor = scenesShareReviewValue(a, b, 'actor')
  const sameTarget = scenesShareReviewValue(a, b, 'target')
  const leftActors = reviewValues(a, 'actor')
  const rightActors = reviewValues(b, 'actor')
  const coerciveContinuation = sceneHasDirectedCoercion(a)
    && sceneHasDirectedCoercion(b)
    && (sameActor || leftActors.length === 0 || rightActors.length === 0)

  return (sameActor && sameTarget) || coerciveContinuation
}

function mergeStoryArcScenes(scenes: DraftScene[]): DraftScene[] {
  const merged: DraftScene[] = []

  for (const scene of [...scenes].sort((a, b) => a.contextStartMs - b.contextStartMs)) {
    const previous = merged.at(-1)
    if (!previous || !scenesBelongToSameStoryArc(previous, scene)) {
      merged.push({ ...scene, events: [...scene.events] })
      continue
    }

    previous.events.push(...scene.events)
    previous.originSceneIds = unique([...previous.originSceneIds, ...scene.originSceneIds])
    previous.contextStartMs = Math.min(previous.contextStartMs, scene.contextStartMs)
    previous.contextEndMs = Math.max(previous.contextEndMs, scene.contextEndMs)
    previous.sceneId = `${previous.sceneId}+${scene.sceneId}`
  }

  return merged
}

function unreviewedModerateHasHardRisk(event: ContentEvent): boolean {
  if (event.evidenceStrength === 'weak_context') return false

  if (event.category === 'violence') {
    const directedTarget = event.details.targetType === 'person'
      || event.details.targetType === 'human_like_character'
      || event.details.targetType === 'animal'
      || event.details.targetType === 'fantasy_creature'
    const weaponAggression = directedTarget
      && (event.details.weaponRole === 'used' || event.details.weaponRole === 'threatened_use')
      && (event.subtype === 'physical_attack' || event.subtype === 'violent_threat')
    const lethalPeril = event.subtype === 'life_threatening_situation'
      && (event.assertionStatus === 'actual' || event.assertionStatus === 'threatened')
    const severeHarm = event.severity === 'high'
      && (event.subtype === 'injury' || event.subtype === 'death' || event.subtype === 'graphic_violence')
    return weaponAggression || lethalPeril || severeHarm
  }

  if (event.category === 'scary_and_disturbing') {
    return event.subtype === 'intense_peril'
      && event.severity === 'high'
      && event.assertionStatus === 'actual'
      && event.details.fearIntensity === 'strong'
      && event.details.threatPresent
  }

  return false
}

function moderateEventBelongsOnMain(event: ContentEvent): boolean {
  if (event.parentRelevance !== 'moderate') return false

  const review = event.review
  if (review?.status === 'uncertain' && review.evidenceSufficiency !== 'sufficient') return false
  if (review?.status === 'not_reviewed'
    && (event.category === 'violence' || event.category === 'scary_and_disturbing')) {
    return unreviewedModerateHasHardRisk(event)
  }

  if (event.category !== 'violence' && event.category !== 'scary_and_disturbing') return true

  const fictional = event.context === 'game' || event.context === 'fiction'
  if (!fictional) return true

  if (event.assertionStatus === 'reported'
    || event.assertionStatus === 'hypothetical'
    || event.assertionStatus === 'negated'
    || event.engagementLevel === 'mention') {
    return false
  }

  if (event.category === 'violence') {
    if (event.subtype === 'fantasy_combat') return false

    if (event.subtype === 'destruction'
      && (review?.consequence === 'property_only'
        || event.details.targetType === 'environment'
        || event.details.targetType === 'object')) {
      return false
    }

    if (review?.intent === 'coercive' && review.aggressionDirection === 'actor_to_target') {
      return true
    }

    if (event.subtype === 'violent_threat'
      || event.subtype === 'life_threatening_situation'
      || event.subtype === 'physical_attack') {
      return true
    }

    if (event.subtype === 'dangerous_situation') {
      const meaningfulDistress = review?.distress === 'clear' || review?.distress === 'strong'
      const seriousConsequence = review?.consequence === 'threatened_harm'
        || review?.consequence === 'injury_or_severe_harm'
        || review?.consequence === 'death'
      return Boolean(meaningfulDistress && seriousConsequence)
    }

    return false
  }

  if (review?.intent === 'coercive' && review.aggressionDirection === 'actor_to_target') {
    return true
  }

  if (event.subtype === 'intense_peril') {
    const meaningfulDistress = !review || review.distress === 'clear' || review.distress === 'strong'
    return event.details.threatPresent && meaningfulDistress
  }

  if (event.subtype === 'threatening_character'
    || event.subtype === 'pursuit'
    || event.subtype === 'confinement') {
    const meaningfulDistress = !review || review.distress === 'clear' || review.distress === 'strong'
    return event.details.threatPresent && meaningfulDistress
  }

  return Boolean(
    review
    && (review.distress === 'clear' || review.distress === 'strong')
    && (review.duration === 'sustained'
      || review.repetition === 'repeated'
      || review.repetition === 'pattern'),
  )
}

function eventEvidenceStatus(event: ContentEvent): 'verified' | 'uncertain' | 'unreviewed' {
  const review = event.review
  // Final production events now carry an explicit not_reviewed state on
  // reviewer degradation. Missing review is kept as a backwards-compatible
  // established state for legacy fixtures/one-pass diagnostics.
  if (!review) return 'verified'
  if (review.status === 'not_reviewed') return 'unreviewed'
  if (review.status === 'uncertain' || review.evidenceSufficiency !== 'sufficient') return 'uncertain'
  return 'verified'
}

function sceneEvidenceStatus(events: ContentEvent[]): 'verified' | 'uncertain' | 'unreviewed' {
  const statuses = events.map(eventEvidenceStatus)
  if (statuses.length > 0 && statuses.every((status) => status === 'verified')) return 'verified'
  if (statuses.some((status) => status === 'uncertain')) return 'uncertain'
  return 'unreviewed'
}

function sceneAttention(
  events: ContentEvent[],
  level: ReportLevel,
  evidenceStatus: 'verified' | 'uncertain' | 'unreviewed',
): 'main' | 'details' {
  if (level === 'high') {
    if (evidenceStatus === 'verified') return 'main'
    const strongHardRisk = events.some((event) =>
      event.confidence >= 0.7
      && event.evidenceStrength !== 'weak_context'
      && unreviewedModerateHasHardRisk(event),
    )
    return strongHardRisk ? 'main' : 'details'
  }
  if (level !== 'moderate') return 'details'
  return events.some(moderateEventBelongsOnMain) ? 'main' : 'details'
}

function russianCountForm(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100
  const mod10 = count % 10
  if (mod100 >= 11 && mod100 <= 14) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

function detailCountText(count: number): string {
  if (count === 1) return '1 лёгкая или спорная находка вынесена в подробности'
  const noun = russianCountForm(count, 'находка', 'находки', 'находок')
  const adjective = russianCountForm(count, 'лёгкая или спорная', 'лёгкие или спорные', 'лёгких или спорных')
  const verb = russianCountForm(count, 'вынесена', 'вынесены', 'вынесено')
  return `${count} ${adjective} ${noun} ${verb} в подробности`
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

  return mergeStoryArcScenes(mergeOverlappingScenes(drafts))
    .map((scene) => {
      const compactEvidence = evidenceRanges(scene.events)
      const level = maxReportLevel(scene.events.map(eventLevel))
      const reviewedCount = scene.events.filter((event) =>
        event.review
        && (event.review.status === 'confirmed' || event.review.status === 'corrected'),
      ).length
      const reviewStatus = reviewedCount === 0
        ? 'unreviewed' as const
        : reviewedCount === scene.events.length
          ? 'reviewed' as const
          : 'mixed' as const
      const evidenceStatus = sceneEvidenceStatus(scene.events)
      return {
        sceneId: scene.sceneId,
        startMs: compactEvidence[0]?.startMs ?? scene.contextStartMs,
        endMs: compactEvidence.at(-1)?.endMs ?? scene.contextEndMs,
        level,
        attention: sceneAttention(scene.events, level, evidenceStatus),
        reviewStatus,
        evidenceStatus,
        categories: sceneCategories(scene.events),
        evidenceRanges: compactEvidence,
        label: sceneLabel(scene.events),
        summary: sceneSummary(scene.events),
        mitigatingContext: sceneMitigatingContext(scene.events),
        priorityReason: level === 'high' && evidenceStatus === 'verified'
          ? scenePriorityReason(scene.events)
          : undefined,
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

  const mainNoun = russianCountForm(main.length, 'сцена', 'сцены', 'сцен')
  const mainRelative = main.length === 1 ? 'на которую' : 'на которые'
  const detailSuffix = details.length > 0
    ? ` Ещё ${detailCountText(details.length)}.`
    : ''
  return `В проанализированных субтитрах есть ${main.length} ${mainNoun}, ${mainRelative} стоит обратить внимание.${detailSuffix}`
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
    const perVideo = eventsByVideo.map(({ videoId, events }) => {
      const categoryEvents = events.filter((event) => event.category === category)
      const categoryScenes = buildPresentationScenes(events)
        .filter((scene) => scene.categories.includes(category))
      return { videoId, events: categoryEvents, scenes: categoryScenes }
    })
    const raw = perVideo.flatMap((item) => item.events)
    const displayed = raw.filter((event) => event.displayLevel !== 'hidden')
    const displayedScenes = perVideo.flatMap((item) => item.scenes)
    const verifiedMainScenes = displayedScenes.filter((scene) =>
      scene.attention === 'main' && scene.evidenceStatus === 'verified',
    )

    const rawAffectedVideos = perVideo.filter((item) => item.events.length > 0).length
    const affectedVideos = perVideo.filter((item) => item.scenes.length > 0).length
    const highlightedVideos = perVideo.filter((item) =>
      item.scenes.some((scene) =>
        scene.attention === 'main'
        && scene.evidenceStatus === 'verified'
        && scene.level === 'high',
      ),
    ).length
    const moderatePlusAffectedVideos = perVideo.filter((item) =>
      item.scenes.some((scene) =>
        scene.attention === 'main'
        && scene.evidenceStatus === 'verified'
        && (scene.level === 'moderate' || scene.level === 'high'),
      ),
    ).length

    const peakConcern: ReportLevel = displayedScenes.length > 0
      ? maxReportLevel(displayedScenes.map((scene) => scene.level))
      : 'none'
    const affectedRatio = analyzedVideos > 0 ? affectedVideos / analyzedVideos : 0
    const prevalence = prevalenceLevel(affectedVideos, analyzedVideos)
    const moderatePlusAffectedRatio = analyzedVideos > 0 ? moderatePlusAffectedVideos / analyzedVideos : 0
    const moderatePlusPrevalence = prevalenceLevel(moderatePlusAffectedVideos, analyzedVideos)

    // Parent concern is derived from final, verified main scenes. Frequency of
    // details is reported separately through prevalence and must not promote a
    // low-value pattern into a stronger warning.
    const level: ReportLevel = verifiedMainScenes.length > 0
      ? maxReportLevel(verifiedMainScenes.map((scene) => scene.level))
      : displayedScenes.length > 0
        ? 'low'
        : 'none'

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
