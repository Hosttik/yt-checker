import type { ClassifiedContentEvent } from '../../shared/types/content'

function eventKey(event: ClassifiedContentEvent): string {
  return [
    event.sceneId ?? '',
    event.category,
    event.subtype,
    event.startMs,
    event.endMs,
  ].join('|')
}

export function normalizeClassifiedEvents(
  events: ClassifiedContentEvent[],
): ClassifiedContentEvent[] {
  const byKey = new Map<string, ClassifiedContentEvent>()

  for (const event of events) {
    const key = eventKey(event)
    const existing = byKey.get(key)
    if (!existing || event.confidence > existing.confidence) {
      byKey.set(key, event)
    }
  }

  return [...byKey.values()]
    .sort((a, b) =>
      a.startMs - b.startMs
      || a.endMs - b.endMs
      || a.category.localeCompare(b.category)
      || a.subtype.localeCompare(b.subtype),
    )
}
