import type { ClassifiedContentEvent } from '../../shared/types/content'

export interface ContentValidationRejection {
  event: ClassifiedContentEvent
  reason: string
}

export interface ContentValidationAdjustment {
  originalEvent: ClassifiedContentEvent
  event: ClassifiedContentEvent
  reason: string
}

export interface ContentValidationResult {
  accepted: ClassifiedContentEvent[]
  rejected: ContentValidationRejection[]
  adjustments: ContentValidationAdjustment[]
}

function looksLikeCurrentReportedThreat(text: string): boolean {
  const normalized = text.toLocaleLowerCase()
  return [
    /прямо сейчас/,
    /уже (?:ид[её]т|идут|приближа)/,
    /(?:ид[её]т|идут).{0,40}(?:сюда|к нам|к деревне|на деревню)/,
    /сообщил.{0,60}(?:ид[её]т|идут|приближа)/,
    /right now/,
    /currently/,
    /(?:is|are) (?:coming|approaching)/,
  ].some((pattern) => pattern.test(normalized))
}

function normalizeEvent(
  event: ClassifiedContentEvent,
): { event: ClassifiedContentEvent; reason?: string } {
  if (event.category === 'violence'
    && event.subtype === 'dangerous_situation'
    && event.assertionStatus === 'hypothetical'
    && event.details.harmLevel === 'threatened'
    && event.evidenceStrength === 'explicit'
    && event.confidence >= 0.9
    && event.engagementLevel === 'depiction'
    && looksLikeCurrentReportedThreat(event.text)) {
    return {
      event: { ...event, assertionStatus: 'reported' },
      reason: 'current reported danger normalized from hypothetical to reported',
    }
  }

  if (event.category === 'violence'
    && event.subtype === 'violent_threat'
    && event.assertionStatus === 'hypothetical'
    && event.details.harmLevel === 'threatened'
    && event.details.actionPurpose === 'threat') {
    return {
      event: { ...event, assertionStatus: 'threatened' },
      reason: 'conditional coercive threat normalized from hypothetical to threatened',
    }
  }

  return { event }
}

function validationReason(event: ClassifiedContentEvent): string | undefined {
  if (event.category === 'insults' && event.details.targetType === 'self') {
    return 'self-directed criticism is not an insult against another target'
  }

  if (event.category === 'profanity_and_rude_language' && event.details.expression) {
    const expression = event.details.expression.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const evidence = event.text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    if (!expression || !(` ${evidence} `).includes(` ${expression} `)) {
      return 'offending expression is not present in transcript evidence'
    }
    if (/^(?:о )?(?:господи|боже(?: мой)?|господи боже мой)$/.test(expression)) {
      return 'ordinary religious exclamation is not profanity or rude language'
    }
  }

  // These subtypes describe themes in speech, not the truth of the feared event.
  const theme = event.category === 'scary_and_disturbing'
    && event.details.themePresent === true
    && ['death_related_theme', 'horror_theme', 'disturbing_theme'].includes(event.subtype)

  if (event.assertionStatus === 'negated' && !theme) {
    return 'event is explicitly negated by surrounding context'
  }

  if (event.assertionStatus === 'hypothetical' && !theme) {
    return 'event is only hypothetical and is not an actual or threatened event'
  }

  if (event.category === 'scary_and_disturbing') {
    if (event.subtype === 'intense_peril'
      && (!event.details.threatPresent || event.details.fearIntensity === 'mild')) {
      return 'intense_peril requires a present threat and at least moderate fear intensity'
    }
    return undefined
  }

  if (event.category !== 'violence') return undefined

  const details = event.details

  if (event.subtype === 'dangerous_situation' && details.harmLevel === 'none') {
    return 'dangerous_situation requires meaningful harm or danger semantics'
  }

  if (event.subtype === 'life_threatening_situation' && details.harmLevel === 'none') {
    return 'life_threatening_situation cannot have harmLevel=none'
  }

  if (event.subtype === 'violent_threat'
    && details.harmLevel !== 'threatened'
    && details.harmLevel !== 'attempted'
    && details.harmLevel !== 'actual'
    && details.weaponRole !== 'threatened_use') {
    return 'violent_threat requires threatened harm or threatened weapon use'
  }

  if (event.subtype === 'violent_threat'
    && event.evidenceStrength !== 'explicit'
    && (event.evidenceStrength === 'weak_context'
      || (event.confidence < 0.85
        && !(event.assertionStatus === 'threatened' && details.actionPurpose === 'threat'))
      || (event.assertionStatus === 'actual' && details.actionPurpose !== 'threat'))) {
    return 'violent_threat requires stronger corroboration when transcript evidence is ambiguous'
  }

  if (event.subtype === 'physical_attack'
    && details.harmLevel === 'implied'
    && event.evidenceStrength !== 'explicit') {
    return 'physical_attack with implied harm requires explicit transcript evidence'
  }

  if (event.subtype === 'weapon_presence'
    && (details.weaponRole === 'used' || details.weaponRole === 'threatened_use')) {
    return 'weapon_presence conflicts with active/threatened weapon use'
  }

  if (event.subtype === 'weapon_use' && details.weaponRole !== 'used') {
    return 'weapon_use requires weaponRole=used'
  }

  if ((event.subtype === 'physical_attack' || event.subtype === 'fantasy_combat')
    && details.harmLevel === 'none') {
    return event.subtype + ' cannot have harmLevel=none'
  }

  return undefined
}

export function validateClassifiedEvents(
  events: ClassifiedContentEvent[],
): ContentValidationResult {
  const accepted: ClassifiedContentEvent[] = []
  const rejected: ContentValidationRejection[] = []
  const adjustments: ContentValidationAdjustment[] = []

  for (const originalEvent of events) {
    const normalized = normalizeEvent(originalEvent)
    const event = normalized.event
    if (normalized.reason) {
      adjustments.push({ originalEvent, event, reason: normalized.reason })
    }

    const reason = validationReason(event)
    if (reason) rejected.push({ event, reason })
    else accepted.push(event)
  }

  return { accepted, rejected, adjustments }
}
