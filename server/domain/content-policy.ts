import type {
  AnalysisProfile,
  ClassifiedContentEvent,
  ContentCategory,
  ContentEvent,
  DisplayLevel,
  ParentPolicyPreferences,
  ParentRelevance,
} from '../../shared/types/content'
import { CONTENT_CATEGORY_LABELS } from './content-categories'
import { contentSubtypeLabel } from './content-labels'

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
  getLabel(events: ContentEvent[]): string
  summarize(events: ContentEvent[], displayed: ContentEvent[]): string
}

function defaultDisplayLevel(
  event: ClassifiedContentEvent,
  relevance: ParentRelevance,
  profile: AnalysisProfile,
): DisplayLevel {
  const weakEvidence = event.confidence < 0.55 || event.evidenceStrength === 'weak_context'
  const reviewDegraded = event.review?.status === 'uncertain'
    || event.review?.status === 'not_reviewed'

  if (profile === 'diagnostic') {
    return relevance === 'high' && !weakEvidence && !reviewDegraded ? 'highlight' : 'summary'
  }

  if (profile === 'strict') {
    if (weakEvidence || reviewDegraded) return 'summary'
    if (relevance === 'high' || relevance === 'moderate') return 'highlight'
    return 'summary'
  }

  if (relevance === 'minimal') return 'hidden'
  if (weakEvidence) return relevance === 'high' ? 'summary' : 'hidden'
  if (reviewDegraded) return relevance === 'high' || relevance === 'moderate' ? 'summary' : 'hidden'
  if (relevance === 'high') return 'highlight'
  return 'summary'
}

function severityFloor(event: ClassifiedContentEvent): ParentRelevance {
  if (event.severity === 'high') return 'high'
  if (event.severity === 'medium') return 'moderate'
  return 'low'
}

function maxRelevance(left: ParentRelevance, right: ParentRelevance): ParentRelevance {
  return relevanceRank[left] >= relevanceRank[right] ? left : right
}

function bumpRelevance(relevance: ParentRelevance): ParentRelevance {
  const levels: ParentRelevance[] = ['minimal', 'low', 'moderate', 'high']
  return levels[Math.min(levels.length - 1, levels.indexOf(relevance) + 1)]!
}

function isPromotionMode(event: ClassifiedContentEvent): boolean {
  return event.engagementLevel === 'endorsement'
    || event.engagementLevel === 'encouragement'
    || event.engagementLevel === 'instruction'
}

function semanticRelevanceFloor(event: ClassifiedContentEvent): ParentRelevance {
  const promotional = isPromotionMode(event)

  if (event.category === 'self_harm' && promotional) return 'high'
  if ((event.category === 'substances' || event.category === 'gambling') && promotional) return 'high'

  if (event.category === 'violence') {
    const rewardedOrGlamorized = event.behaviorOutcome === 'rewarded'
      || event.portrayal === 'glamorized'
    if (event.imitationRisk === 'high' && (promotional || rewardedOrGlamorized)) return 'high'
    if (event.imitationRisk === 'high' && event.realism === 'realistic') return 'moderate'
    if (event.imitationRisk === 'medium' && promotional) return 'moderate'
  }

  return 'minimal'
}

function ageAdjustedRelevance(
  event: ClassifiedContentEvent,
  relevance: ParentRelevance,
  preferences?: ParentPolicyPreferences,
): ParentRelevance {
  const childAge = preferences?.childAge
  if (childAge === undefined || relevance === 'minimal') return relevance

  const behaviorallySalient = event.imitationRisk === 'high'
    || event.behaviorOutcome === 'rewarded'
    || event.portrayal === 'glamorized'
    || event.portrayal === 'normalized'
  const realisticThreat = event.realism === 'realistic'
    && (event.category === 'violence' || event.category === 'scary_and_disturbing')

  if (childAge <= 7) {
    const youngChildSalience = realisticThreat
      || event.imitationRisk === 'medium'
      || behaviorallySalient
    if (youngChildSalience
      && (event.category === 'violence'
        || event.category === 'scary_and_disturbing'
        || event.category === 'substances'
        || event.category === 'gambling')) {
      return bumpRelevance(relevance)
    }
  } else if (childAge <= 9) {
    if (behaviorallySalient
      && (event.category === 'violence'
        || event.category === 'scary_and_disturbing'
        || event.category === 'substances'
        || event.category === 'gambling')) {
      return bumpRelevance(relevance)
    }
  }

  return relevance
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function defaultLabel(category: ContentCategory): (events: ContentEvent[]) => string {
  return () => CONTENT_CATEGORY_LABELS[category]
}

function defaultSummary(category: ContentCategory): (events: ContentEvent[], displayed: ContentEvent[]) => string {
  return (events, displayed) => {
    if (events.length === 0) {
      return 'В проанализированных субтитрах релевантных элементов не обнаружено.'
    }
    if (displayed.length === 0) {
      return 'Для выбранного профиля значимых элементов не показано.'
    }
    const contextText = displayed.every((event) => event.context === 'game' || event.context === 'fiction')
      ? ' Большинство показанных элементов относятся к игровому или вымышленному контексту.'
      : ''
    return `Обнаружены элементы ${CONTENT_CATEGORY_LABELS[category]}: ${unique(displayed.map(contentSubtypeLabel)).join(', ')}.${contextText}`
  }
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
  getLabel: defaultLabel('profanity_and_rude_language'),
  summarize: defaultSummary('profanity_and_rude_language'),
}

const insultsPolicy: CategoryPolicy<Extract<ClassifiedContentEvent, { category: 'insults' }>> = {
  getParentRelevance(event) {
    if (event.severity === 'high') return 'high'
    if (event.subtype === 'degrading_statement') {
      return event.severity === 'medium' ? 'moderate' : 'low'
    }
    if (event.subtype === 'direct_insult' && event.severity === 'medium') return 'moderate'
    return event.severity === 'low' ? 'low' : 'moderate'
  },
  getDisplayLevel: defaultDisplayLevel,
  getLabel: defaultLabel('insults'),
  summarize: defaultSummary('insults'),
}

const toiletPolicy: CategoryPolicy<Extract<ClassifiedContentEvent, { category: 'toilet_humor' }>> = {
  getParentRelevance(event) {
    if (event.subtype === 'toilet_reference') return 'minimal'
    if (event.subtype === 'gross_out_humor' || event.severity === 'medium') return 'moderate'
    return 'low'
  },
  getDisplayLevel: defaultDisplayLevel,
  getLabel: defaultLabel('toilet_humor'),
  summarize: defaultSummary('toilet_humor'),
}

const violencePolicy: CategoryPolicy<Extract<ClassifiedContentEvent, { category: 'violence' }>> = {
  getParentRelevance(event) {
    const details = event.details
    if (event.subtype === 'destruction'
      && details.actionPurpose === 'utility'
      && event.severity === 'low'
      && (details.targetType === 'object' || details.targetType === 'environment')) return 'minimal'
    if (event.subtype === 'graphic_violence') return 'high'
    if (event.subtype === 'life_threatening_situation') {
      return event.assertionStatus === 'reported' && event.severity !== 'high' ? 'moderate' : 'high'
    }
    if (event.subtype === 'violent_threat') {
      return event.severity === 'high' || details.weaponRole === 'threatened_use' ? 'high' : 'moderate'
    }
    if (event.subtype === 'weapon_presence' && details.harmLevel === 'none') return 'minimal'
    if (event.subtype === 'weapon_use') {
      if (details.actionPurpose === 'rescue'
        || details.actionPurpose === 'utility'
        || details.actionPurpose === 'demonstration') return 'minimal'
      if (details.actionPurpose === 'sport' && details.harmLevel === 'none') return 'low'
      if (details.harmLevel === 'none') return 'low'
    }
    if (event.subtype === 'injury'
      && details.actionPurpose === 'accident'
      && event.severity === 'low') return 'minimal'
    if (event.subtype === 'fantasy_combat') return event.severity === 'high' ? 'high' : 'moderate'
    if (event.subtype === 'dangerous_situation') {
      if (details.weaponRole === 'threatened_use'
        || (details.actionPurpose === 'threat' && details.harmLevel === 'threatened')) {
        return event.severity === 'low' ? 'moderate' : 'high'
      }
      return event.severity === 'low' && details.harmLevel === 'none' ? 'low' : 'moderate'
    }
    if (event.subtype === 'destruction') {
      return event.severity === 'low' && details.harmLevel === 'none' ? 'low' : 'moderate'
    }
    return severityFloor(event)
  },
  getDisplayLevel: defaultDisplayLevel,
  getLabel(events) {
    return events.length > 0 && events.every((event) => event.context === 'game' || event.context === 'fiction')
      ? 'Игровое насилие и опасные сцены'
      : CONTENT_CATEGORY_LABELS.violence
  },
  summarize(events, displayed) {
    if (events.length === 0 || displayed.length === 0) return defaultSummary('violence')(events, displayed)
    const contextText = displayed.every((event) => event.context === 'game' || event.context === 'fiction')
      ? ' Большинство показанных элементов относятся к игровому или вымышленному контексту.'
      : ''
    return `Обнаружены: ${unique(displayed.map(contentSubtypeLabel)).join(', ')}.${contextText}`
  },
}

const scaryPolicy: CategoryPolicy<Extract<ClassifiedContentEvent, { category: 'scary_and_disturbing' }>> = {
  getParentRelevance(event) {
    if (event.details.fearIntensity === 'strong') return 'high'
    if (event.subtype === 'intense_peril') {
      if (event.severity === 'high' && event.details.threatPresent) return 'high'
      return event.details.threatPresent ? 'moderate' : 'low'
    }
    if (event.details.fearIntensity === 'moderate' || event.details.threatPresent) return 'moderate'
    if (event.subtype === 'death_related_theme') {
      if (event.severity !== 'low') return 'moderate'
      if (event.details.themePresent) return 'low'
    }
    return 'minimal'
  },
  getDisplayLevel: defaultDisplayLevel,
  getLabel: defaultLabel('scary_and_disturbing'),
  summarize(events, displayed) {
    if (events.length === 0 || displayed.length === 0) {
      return defaultSummary('scary_and_disturbing')(events, displayed)
    }
    const contextText = displayed.every((event) => event.context === 'game' || event.context === 'fiction')
      ? ' Большинство показанных элементов относятся к игровому или вымышленному контексту.'
      : ''
    return `Обнаружены пугающие или тревожные элементы: ${unique(displayed.map(contentSubtypeLabel)).join(', ')}.${contextText}`
  },
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
  getLabel: defaultLabel('sexual_content'),
  summarize: defaultSummary('sexual_content'),
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
  getLabel: defaultLabel('gambling'),
  summarize: defaultSummary('gambling'),
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
  getLabel(events) {
    const subtypes = new Set(events.map((event) => event.subtype))
    if (subtypes.size === 1 && subtypes.has('nicotine')) return 'Табак и никотин'
    if (subtypes.size === 1 && subtypes.has('alcohol')) return 'Алкоголь'
    return CONTENT_CATEGORY_LABELS.substances
  },
  summarize(events, displayed) {
    if (events.length === 0 || displayed.length === 0) {
      return defaultSummary('substances')(events, displayed)
    }
    return `Обнаружены упоминания или действия, связанные с веществами: ${unique(displayed.map(contentSubtypeLabel)).join(', ')}.`
  },
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
  getLabel: defaultLabel('self_harm'),
  summarize: defaultSummary('self_harm'),
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

function reviewedHighPriorityIsSupported(event: ClassifiedContentEvent): boolean {
  const review = event.review
  if (!review || review.status === 'not_reviewed') return true
  if (!review.highPriorityReason?.trim()) return false

  const hasSeriousConsequence = review.consequence === 'threatened_harm'
    || review.consequence === 'injury_or_severe_harm'
    || review.consequence === 'death'
  const directedCoercion = review.intent === 'coercive'
    && review.aggressionDirection === 'actor_to_target'
    && (review.duration === 'sustained'
      || review.repetition === 'repeated'
      || review.repetition === 'pattern'
      || hasSeriousConsequence)

  if (event.category === 'violence') {
    const details = event.details
    const directedTarget = details.targetType === 'person'
      || details.targetType === 'human_like_character'
      || details.targetType === 'animal'
      || details.targetType === 'fantasy_creature'
    const explicitWeaponAggression = details.weaponRole === 'threatened_use'
      || details.weaponRole === 'used'
    const armedDirectedThreat = event.subtype === 'violent_threat'
      && details.weaponRole === 'possessed'
      && details.actionPurpose === 'attack'
      && review.aggressionDirection === 'actor_to_target'
      && review.consequence === 'threatened_harm'
    const directedWeaponAggression = directedTarget
      && (explicitWeaponAggression || armedDirectedThreat)
      && details.harmLevel !== 'none'
      && (review.intent === 'aggressive' || review.intent === 'coercive')
    const immediateLethalPeril = event.subtype === 'life_threatening_situation'
      && event.assertionStatus !== 'hypothetical'
      && event.assertionStatus !== 'negated'
      && details.harmLevel !== 'none'
      && (hasSeriousConsequence
        || review.distress === 'clear'
        || review.distress === 'strong'
        || review.duration === 'sustained')
    const severeAttack = event.subtype === 'physical_attack'
      && review.intent === 'aggressive'
      && (details.harmLevel === 'actual'
        || details.harmLevel === 'attempted'
        || review.consequence === 'injury_or_severe_harm'
        || review.consequence === 'death')

    return event.subtype === 'graphic_violence'
      || directedCoercion
      || directedWeaponAggression
      || immediateLethalPeril
      || severeAttack
  }

  if (event.category === 'scary_and_disturbing') {
    const fictional = event.context === 'game' || event.context === 'fiction'
    const accidentalFictionalThreatOnly = fictional
      && review.intent === 'accidental'
      && review.aggressionDirection === 'none'
      && review.consequence === 'threatened_harm'

    const immediatePeril = event.subtype === 'intense_peril'
      && event.details.threatPresent
      && event.details.fearIntensity === 'strong'
      && event.assertionStatus !== 'hypothetical'
      && event.assertionStatus !== 'negated'
      && !accidentalFictionalThreatOnly
      && (hasSeriousConsequence
        || review.distress === 'strong'
        || review.duration === 'sustained')

    return directedCoercion || immediatePeril
  }

  return true
}

function reviewEstablishesHighPriorityCoercion(event: ClassifiedContentEvent): boolean {
  const review = event.review
  if (!review || (review.status !== 'confirmed' && review.status !== 'corrected')) return false
  if (review.evidenceSufficiency !== 'sufficient') return false
  if (review.intent !== 'coercive' || review.aggressionDirection !== 'actor_to_target') return false
  if (review.consequence !== 'threatened_harm'
    && review.consequence !== 'injury_or_severe_harm'
    && review.consequence !== 'death') {
    return false
  }
  if (event.assertionStatus === 'reported'
    || event.assertionStatus === 'hypothetical'
    || event.assertionStatus === 'negated') {
    return false
  }

  if (event.category === 'violence') {
    const seriousSubtype = event.subtype === 'violent_threat'
      || event.subtype === 'dangerous_situation'
      || event.subtype === 'life_threatening_situation'
      || event.subtype === 'physical_attack'
    const seriousHarm = event.details.harmLevel === 'threatened'
      || event.details.harmLevel === 'attempted'
      || event.details.harmLevel === 'actual'
    return seriousSubtype && seriousHarm
  }

  if (event.category === 'scary_and_disturbing') {
    return event.details.threatPresent
      && (event.subtype === 'confinement'
        || event.subtype === 'intense_peril'
        || event.subtype === 'threatening_character'
        || event.subtype === 'pursuit')
  }

  return false
}

function reviewAdjustedRelevance(
  event: ClassifiedContentEvent,
  baseline: ParentRelevance,
): ParentRelevance {
  const review = event.review
  if (!review || review.status === 'not_reviewed' || review.status === 'uncertain') return baseline

  if (reviewEstablishesHighPriorityCoercion(event)) return 'high'

  // Reviewer output supplies factual context and may correct the normalized event,
  // but final parent relevance is a deterministic product-policy decision.
  // Keep recommendedParentRelevance only as diagnostic/backward-compatible data.
  if (baseline === 'high'
    && (event.category === 'violence' || event.category === 'scary_and_disturbing')
    && !reviewedHighPriorityIsSupported(event)) {
    return 'moderate'
  }
  return baseline
}

function preferenceAdjustedRelevance(
  category: ContentCategory,
  relevance: ParentRelevance,
  preferences?: ParentPolicyPreferences,
): ParentRelevance {
  const sensitivity = preferences?.sensitivities?.[category]
  if (!sensitivity || sensitivity === 'default') return relevance
  const levels: ParentRelevance[] = ['minimal', 'low', 'moderate', 'high']
  const current = levels.indexOf(relevance)
  if (sensitivity === 'sensitive') return levels[Math.min(levels.length - 1, current + 1)]!
  return levels[Math.max(0, current - 1)]!
}

export function applyContentPolicy(
  event: ClassifiedContentEvent,
  id: string,
  profile: AnalysisProfile,
  preferences?: ParentPolicyPreferences,
): ContentEvent {
  const policy = categoryPolicies[event.category] as CategoryPolicy
  const baselineRelevance = policy.getParentRelevance(event)
  const reviewedRelevance = reviewAdjustedRelevance(event, baselineRelevance)
  const semanticRelevance = maxRelevance(reviewedRelevance, semanticRelevanceFloor(event))
  const ageRelevance = ageAdjustedRelevance(event, semanticRelevance, preferences)
  const parentRelevance = preferenceAdjustedRelevance(event.category, ageRelevance, preferences)
  const displayLevel = policy.getDisplayLevel(event, parentRelevance, profile)
  return {
    ...event,
    id,
    parentRelevance,
    displayLevel,
  } as ContentEvent
}
