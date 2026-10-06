import type {
  ClassifiedContentEvent,
  ContentEventReview,
} from '../../shared/types/content'

export function notReviewedReview(rationale: string): ContentEventReview {
  return {
    status: 'not_reviewed',
    recommendedParentRelevance: 'minimal',
    evidenceSufficiency: 'insufficient',
    contextRanges: [],
    aggressionDirection: 'unclear',
    intent: 'unclear',
    distress: 'unclear',
    consequence: 'unclear',
    duration: 'unclear',
    repetition: 'unclear',
    narrativeFraming: 'unclear',
    rationale,
  }
}

export function markEventsNotReviewed(
  events: ClassifiedContentEvent[],
  rationale: string,
): ClassifiedContentEvent[] {
  return events.map((event) => ({
    ...event,
    review: notReviewedReview(rationale),
  }))
}
