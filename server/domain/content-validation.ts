import type { ClassifiedContentEvent } from '../../shared/types/content'

export interface ContentValidationRejection {
  event: ClassifiedContentEvent
  reason: string
}

export interface ContentValidationResult {
  accepted: ClassifiedContentEvent[]
  rejected: ContentValidationRejection[]
}

function validationReason(event: ClassifiedContentEvent): string | undefined {
  if (event.assertionStatus === 'negated') {
    return 'event is explicitly negated by surrounding context'
  }

  if (event.assertionStatus === 'hypothetical') {
    return 'event is only hypothetical and is not an actual or threatened event'
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

  for (const event of events) {
    const reason = validationReason(event)
    if (reason) rejected.push({ event, reason })
    else accepted.push(event)
  }

  return { accepted, rejected }
}
