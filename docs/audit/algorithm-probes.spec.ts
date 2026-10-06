// Audit observations, not desired product behavior. No network requests.
// Run: npx vitest run docs/audit/algorithm-probes.spec.ts
import { describe, expect, it } from 'vitest'
import { applyContentPolicy } from '../../server/domain/content-policy'
import { buildChannelCategoryReports, buildPresentationScenes } from '../../server/domain/content-reporting'
import { markEventsNotReviewed } from '../../server/domain/content-review-state'
import { validateClassifiedEvents } from '../../server/domain/content-validation'
import { normalizeTranscript } from '../../server/domain/normalize-transcript'
import { OpenAIAnalysisProvider } from '../../server/services/openai-analysis'
import type { ClassifiedContentEvent, ContentEventReview } from '../../shared/types/content'

function review(overrides: Partial<ContentEventReview> = {}): ContentEventReview {
  return {
    status: 'confirmed', recommendedParentRelevance: 'low', evidenceSufficiency: 'sufficient',
    contextRanges: [], aggressionDirection: 'none', intent: 'benign', distress: 'none',
    consequence: 'none', duration: 'brief', repetition: 'single', narrativeFraming: 'humorous',
    rationale: 'Audit fixture', ...overrides,
  }
}

function scary(): ClassifiedContentEvent {
  return {
    sourceCandidateId: 'candidate', sceneId: 'scene', category: 'scary_and_disturbing',
    subtype: 'threatening_character', severity: 'medium', context: 'game', confidence: 0.95,
    startMs: 0, endMs: 2000, text: 'Зомби у двери, я прячусь.', reason: 'Персонаж прячется от зомби.',
    evidenceStrength: 'explicit', evidenceSource: 'transcript', assertionStatus: 'actual',
    engagementLevel: 'depiction', portrayal: 'neutral', explicitness: 'mild',
    details: { fearIntensity: 'moderate', threatPresent: true, supernatural: true },
  }
}

describe('Audit: regression acceptance criteria', () => {
  it('three isolated low-value teases stay low at channel level', () => {
    const event = { ...scary(), category: 'insults', subtype: 'mockery', severity: 'low',
      text: 'Ну ты и чудак.', reason: 'Мягкая насмешка.', details: { targetType: 'character' },
      review: review(),
    } as ClassifiedContentEvent
    const videos = [0, 1, 2].map(id => ({ videoId: String(id), events: [applyContentPolicy(event, String(id), 'normal')] }))
    const report = buildChannelCategoryReports(videos, ['insults'], 3, 'normal')[0]!
    expect(report.peakConcern).toBe('low')
    expect(report.level).toBe('low')
    expect(videos.flatMap(v => buildPresentationScenes(v.events)).every(s => s.attention === 'details')).toBe(true)
  })

  it('a routine combat scene in details does not count as moderate-plus channel concern', () => {
    const event = { ...scary(), category: 'violence', subtype: 'fantasy_combat', severity: 'low',
      details: { harmLevel: 'implied', targetType: 'fantasy_creature', weaponRole: 'used', actionPurpose: 'attack' },
      review: review({ recommendedParentRelevance: 'moderate' }),
    } as ClassifiedContentEvent
    const events = [applyContentPolicy(event, 'combat', 'normal')]
    expect(buildPresentationScenes(events)[0]!.attention).toBe('details')
    expect(buildChannelCategoryReports([{ videoId: 'v', events }], ['violence'], 1, 'normal')[0]!.moderatePlusAffectedVideos).toBe(0)
  })

  it('review failure is represented explicitly and cannot bypass not_reviewed handling', () => {
    const failed = markEventsNotReviewed([scary()], 'Reviewer failed.')[0]!
    const output = applyContentPolicy(failed, 'failed', 'normal')
    expect(output.review?.status).toBe('not_reviewed')
    expect(buildPresentationScenes([output])[0]).toMatchObject({
      attention: 'details',
      evidenceStatus: 'unreviewed',
      reviewStatus: 'unreviewed',
    })
  })

  it('weak uncertain evidence remains a potential high but is moved out of established main attention', () => {
    const event = { ...scary(), confidence: 0.4, evidenceStrength: 'weak_context',
      details: { fearIntensity: 'strong', threatPresent: true, supernatural: true },
      review: review({ status: 'uncertain', evidenceSufficiency: 'insufficient', recommendedParentRelevance: 'low' }),
    } as ClassifiedContentEvent
    const output = applyContentPolicy(event, 'uncertain', 'normal')
    expect(output.displayLevel).toBe('summary')
    expect(output.parentRelevance).toBe('high')
    expect(buildPresentationScenes([output])[0]).toMatchObject({ level: 'high', attention: 'details', reviewStatus: 'unreviewed', evidenceStatus: 'uncertain' })
  })

  it('strict minimal signals do not elevate channel concern without main scenes', () => {
    const event = { ...scary(), category: 'violence', subtype: 'weapon_presence', severity: 'low',
      details: { harmLevel: 'none', targetType: 'object', weaponRole: 'possessed', actionPurpose: 'unknown' },
    } as ClassifiedContentEvent
    const videos = [0, 1, 2].map(id => ({ videoId: String(id), events: [applyContentPolicy(event, String(id), 'strict')] }))
    expect(videos.every(v => v.events[0]!.parentRelevance === 'minimal')).toBe(true)
    expect(buildChannelCategoryReports(videos, ['violence'], 3, 'strict')[0]!.level).toBe('none')
  })

  it('reviewer can correct a mistaken hypothetical assertion into an actual attack', async () => {
    const transcript = normalizeTranscript([{ text: 'Он ударил меня.', startMs: 0, endMs: 2000 }])
    const original = { ...scary(), category: 'violence', subtype: 'physical_attack', assertionStatus: 'hypothetical',
      text: 'Он ударил меня.', reason: 'Персонаж сообщает об ударе.',
      details: { harmLevel: 'actual', targetType: 'human_like_character', weaponRole: 'none', actionPurpose: 'attack' },
    } as ClassifiedContentEvent
    const corrected = {
      candidateId: 'candidate', sceneId: 'scene', category: 'violence', subtype: 'physical_attack',
      severity: 'medium', context: 'game', confidence: 0.99, evidenceStrength: 'explicit',
      engagementLevel: 'depiction', portrayal: 'neutral', explicitness: 'mild', assertionStatus: 'actual',
      evidenceSegments: [0], sceneStartSegment: 0, sceneEndSegment: 0,
      reason: original.reason, details: original.details,
    }
    const item = {
      reviewItemId: 'review_0', verdict: 'corrected', event: corrected, parentRelevance: 'moderate',
      evidenceSufficiency: 'sufficient', contextSegments: [], actor: null, target: null,
      aggressionDirection: 'actor_to_target', intent: 'aggressive', distress: 'clear',
      consequence: 'injury_or_severe_harm', duration: 'brief', repetition: 'single', narrativeFraming: 'neutral',
      parentSummary: 'Персонаж сообщает об ударе.', mitigatingContext: null, highPriorityReason: null,
      rationale: 'Прямое свидетельство удара, а не гипотеза.',
    }
    const client = { responses: { parse: async () => ({ status: 'completed', output_parsed: { reviews: [item], missedHighPriorityEvents: [] } }) } }
    const provider = new OpenAIAnalysisProvider('offline-fixture', 'fixture', undefined, client as never)
    const output = await provider.review(transcript, 'ru', ['violence'], [original])
    expect(output.reviewedEvents[0]!.review!.status).toBe('corrected')
    expect(output.reviewedEvents[0]!.assertionStatus).toBe('actual')
    expect(validateClassifiedEvents(output.reviewedEvents).accepted).toHaveLength(1)
  })
})
