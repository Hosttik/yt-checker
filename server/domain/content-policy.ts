import type {
  AnalysisProfile,
  ClassifiedContentEvent,
  ContentCategory,
  ContentEvent,
  DisplayLevel,
  ParentRelevance,
} from '../../shared/types/content'

const relevanceRank: Record<ParentRelevance, number> = {
  minimal: 0,
  low: 1,
  moderate: 2,
  high: 3,
}

export const PARENT_RELEVANCE_RANK = relevanceRank

export interface CategoryPolicy<TEvent extends ClassifiedContentEvent = ClassifiedContentEvent> {
  getParentRelevance(event: TEvent): ParentRelevance
  getDisplayLevel(event: TEvent, relevance: ParentRelevance, profile: AnalysisProfile): DisplayLevel
}

function defaultDisplayLevel(
  _event: ClassifiedContentEvent,
  relevance: ParentRelevance,
  profile: AnalysisProfile,
): DisplayLevel {
  if (profile === 'diagnostic') return relevance === 'high' ? 'highlight' : 'summary'
  if (profile === 'strict') {
    if (relevance === 'high' || relevance === 'moderate') return 'highlight'
    return 'summary'
  }
  if (relevance === 'minimal') return 'hidden'
  if (relevance === 'high') return 'highlight'
  return 'summary'
}

function severityFloor(event: ClassifiedContentEvent): ParentRelevance {
  if (event.severity === 'high') return 'high'
  if (event.severity === 'medium') return 'moderate'
  return 'low'
}

const profanityPolicy: CategoryPolicy<Extract<ClassifiedContentEvent, { category: 'profanity_and_rude_language' }>> = {
  getParentRelevance(event) {
    if (event.subtype === 'slur') return event.severity === 'low' ? 'moderate' : 'high'
    if (event.subtype === 'profanity' || event.subtype === 'obscene_expression') {
      return event.severity === 'high' ? 'high' : 'moderate'
    }
    return event.severity === 'medium' ? 'moderate' : 'low'
  },
  getDisplayLevel: defaultDisplayLevel,
}

const insultsPolicy: CategoryPolicy<Extract<ClassifiedContentEvent, { category: 'insults' }>> = {
  getParentRelevance(event) {
    if (event.subtype === 'degrading_statement' || event.severity === 'high') return 'high'
    if (event.subtype === 'direct_insult' && event.severity === 'medium') return 'moderate'
    return event.severity === 'low' ? 'low' : 'moderate'
  },
  getDisplayLevel: defaultDisplayLevel,
}

const toiletPolicy: CategoryPolicy<Extract<ClassifiedContentEvent, { category: 'toilet_humor' }>> = {
  getParentRelevance(event) {
    if (event.subtype === 'toilet_reference') return 'minimal'
    if (event.subtype === 'gross_out_humor' || event.severity === 'medium') return 'moderate'
    return 'low'
  },
  getDisplayLevel: defaultDisplayLevel,
}

const violencePolicy: CategoryPolicy<Extract<ClassifiedContentEvent, { category: 'violence' }>> = {
  getParentRelevance(event) {
    const details = event.details
    if (event.subtype === 'graphic_violence') return 'high'
    if (event.subtype === 'life_threatening_situation') return 'high'
    if (event.subtype === 'violent_threat') {
      return event.severity === 'high' || details.weaponRole === 'threatened_use' ? 'high' : 'moderate'
    }
    if (event.subtype === 'weapon_presence' && details.harmLevel === 'none') return 'minimal'
    if (event.subtype === 'weapon_use' && details.harmLevel === 'none') return 'low'
    if (event.subtype === 'fantasy_combat') return event.severity === 'high' ? 'high' : 'moderate'
    if (event.subtype === 'dangerous_situation' || event.subtype === 'destruction') {
      return event.severity === 'low' && details.harmLevel === 'none' ? 'low' : 'moderate'
    }
    if (event.subtype === 'physical_attack' || event.subtype === 'injury' || event.subtype === 'death') {
      return severityFloor(event)
    }
    return severityFloor(event)
  },
  getDisplayLevel: defaultDisplayLevel,
}

const scaryPolicy: CategoryPolicy<Extract<ClassifiedContentEvent, { category: 'scary_and_disturbing' }>> = {
  getParentRelevance(event) {
    if (event.details.fearIntensity === 'strong' || event.subtype === 'intense_peril') return 'high'
    if (event.details.fearIntensity === 'moderate' || event.details.threatPresent) return 'moderate'
    if (event.subtype === 'death_related_theme' && event.severity !== 'low') return 'moderate'
    return 'minimal'
  },
  getDisplayLevel: defaultDisplayLevel,
}

const sexualPolicy: CategoryPolicy<Extract<ClassifiedContentEvent, { category: 'sexual_content' }>> = {
  getParentRelevance(event) {
    if (event.subtype === 'romantic_reference') return 'minimal'
    if (event.subtype === 'suggestive_reference') return 'low'
    if (event.subtype === 'sexual_joke') return event.severity === 'low' ? 'low' : 'moderate'
    if (event.subtype === 'explicit_sexual_content' || event.details.sexualExplicitness === 'explicit') return 'high'
    if (event.subtype === 'sexual_behavior') return event.severity === 'high' ? 'high' : 'moderate'
    return 'moderate'
  },
  getDisplayLevel: defaultDisplayLevel,
}

const gamblingPolicy: CategoryPolicy<Extract<ClassifiedContentEvent, { category: 'gambling' }>> = {
  getParentRelevance(event) {
    if (event.subtype === 'mention') return 'minimal'
    if (event.subtype === 'simulated_gambling') return 'low'
    if (event.subtype === 'promotion') return event.portrayal === 'glamorized' ? 'high' : 'moderate'
    if (event.subtype === 'instruction') return 'high'
    if (event.subtype === 'real_money_gambling' || event.subtype === 'betting') return 'moderate'
    return severityFloor(event)
  },
  getDisplayLevel: defaultDisplayLevel,
}

const substancesPolicy: CategoryPolicy<Extract<ClassifiedContentEvent, { category: 'substances' }>> = {
  getParentRelevance(event) {
    const { action, userType } = event.details
    if (action === 'mention' || action === 'presence') return 'minimal'
    if (action === 'instruction') return 'high'
    if (action === 'promotion' || action === 'encouragement') {
      return event.portrayal === 'glamorized' ? 'high' : 'moderate'
    }
    if (userType === 'minor') return 'high'
    if (action === 'use' || action === 'purchase') {
      if (event.portrayal === 'glamorized' || event.portrayal === 'normalized') return 'moderate'
      return 'low'
    }
    return severityFloor(event)
  },
  getDisplayLevel: defaultDisplayLevel,
}

const selfHarmPolicy: CategoryPolicy<Extract<ClassifiedContentEvent, { category: 'self_harm' }>> = {
  getParentRelevance(event) {
    if (event.subtype === 'joke_or_casual_reference' && event.details.intentionality === 'unclear') return 'minimal'
    if (event.subtype === 'instruction' || event.subtype === 'encouragement') return 'high'
    if (event.details.intentionality === 'explicit') return 'high'
    if (event.details.actionStatus === 'attempt' || event.details.actionStatus === 'actual') return 'high'
    if (event.details.actionStatus === 'threat') return 'high'
    return event.details.intentionality === 'implied' ? 'moderate' : 'low'
  },
  getDisplayLevel(event, relevance, profile) {
    if (profile === 'normal' && relevance === 'low') return 'summary'
    if (profile === 'normal' && relevance === 'minimal') return 'hidden'
    return defaultDisplayLevel(event, relevance, profile)
  },
}

export const categoryPolicies: {
  [C in ContentCategory]: CategoryPolicy<Extract<ClassifiedContentEvent, { category: C }>>
} = {
  profanity_and_rude_language: profanityPolicy,
  insults: insultsPolicy,
  toilet_humor: toiletPolicy,
  violence: violencePolicy,
  scary_and_disturbing: scaryPolicy,
  sexual_content: sexualPolicy,
  gambling: gamblingPolicy,
  substances: substancesPolicy,
  self_harm: selfHarmPolicy,
}

export function applyContentPolicy(
  event: ClassifiedContentEvent,
  id: string,
  profile: AnalysisProfile,
): ContentEvent {
  const policy = categoryPolicies[event.category] as CategoryPolicy
  const parentRelevance = policy.getParentRelevance(event)
  const displayLevel = policy.getDisplayLevel(event, parentRelevance, profile)
  return {
    ...event,
    id,
    parentRelevance,
    displayLevel,
  } as ContentEvent
}
