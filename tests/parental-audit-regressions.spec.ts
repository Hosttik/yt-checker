import { describe, expect, it, vi } from 'vitest'
import type { ClassifiedContentEvent, ContentEvent, ContentEventReview } from '../shared/types/content'
import { applyContentPolicy } from '../server/domain/content-policy'
import { buildChannelCategoryReports, buildPresentationScenes } from '../server/domain/content-reporting'
import { markEventsNotReviewed } from '../server/domain/content-review-state'
import { normalizeTranscript } from '../server/domain/normalize-transcript'
import { OpenAIAnalysisProvider } from '../server/services/openai-analysis'

function verifiedReview(overrides: Partial<ContentEventReview> = {}): ContentEventReview {
  return {
    status: 'confirmed',
    recommendedParentRelevance: 'low',
    evidenceSufficiency: 'sufficient',
    contextRanges: [],
    aggressionDirection: 'none',
    intent: 'benign',
    distress: 'none',
    consequence: 'none',
    duration: 'brief',
    repetition: 'single',
    narrativeFraming: 'neutral',
    rationale: 'Verified fixture.',
    ...overrides,
  }
}

function scaryEvent(review?: ContentEventReview): ClassifiedContentEvent {
  return {
    sourceCandidateId: 'scary_candidate',
    sceneId: 'scary_scene',
    category: 'scary_and_disturbing',
    subtype: 'intense_peril',
    severity: 'high',
    context: 'game',
    confidence: 0.4,
    startMs: 1_000,
    endMs: 2_000,
    evidenceRanges: [{ startMs: 1_000, endMs: 2_000 }],
    sceneStartMs: 1_000,
    sceneEndMs: 2_000,
    text: 'Кажется, сейчас будет очень опасно.',
    reason: 'Detector предполагает сильную опасность.',
    evidenceStrength: 'weak_context',
    evidenceSource: 'transcript',
    engagementLevel: 'depiction',
    portrayal: 'neutral',
    explicitness: 'mild',
    assertionStatus: 'actual',
    review,
    details: {
      fearIntensity: 'strong',
      themePresent: true,
      threatPresent: true,
      supernatural: false,
    },
  }
}

function reviewedInsult(id: string): ContentEvent {
  return {
    id,
    sourceCandidateId: id,
    sceneId: id,
    category: 'insults',
    subtype: 'mockery',
    severity: 'low',
    context: 'game',
    confidence: 0.95,
    startMs: 1_000,
    endMs: 2_000,
    evidenceRanges: [{ startMs: 1_000, endMs: 2_000 }],
    sceneStartMs: 1_000,
    sceneEndMs: 2_000,
    text: 'Ну ты смешной.',
    reason: 'Одиночная мягкая насмешка.',
    evidenceStrength: 'explicit',
    evidenceSource: 'transcript',
    engagementLevel: 'participation',
    portrayal: 'humorous',
    explicitness: 'none',
    assertionStatus: 'actual',
    review: verifiedReview({ recommendedParentRelevance: 'low' }),
    parentRelevance: 'low',
    displayLevel: 'summary',
    details: { targetType: 'character' },
  }
}

function reviewedFantasyCombat(id: string): ContentEvent {
  return {
    id,
    sourceCandidateId: id,
    sceneId: id,
    category: 'violence',
    subtype: 'fantasy_combat',
    severity: 'medium',
    context: 'game',
    confidence: 0.98,
    startMs: 1_000,
    endMs: 2_000,
    evidenceRanges: [{ startMs: 1_000, endMs: 2_000 }],
    sceneStartMs: 1_000,
    sceneEndMs: 2_000,
    text: 'Сражаемся с мобами.',
    reason: 'Обычная игровая битва с мобами.',
    evidenceStrength: 'explicit',
    evidenceSource: 'transcript',
    engagementLevel: 'participation',
    portrayal: 'neutral',
    explicitness: 'mild',
    assertionStatus: 'actual',
    review: verifiedReview({
      recommendedParentRelevance: 'moderate',
      intent: 'aggressive',
      aggressionDirection: 'mutual',
      consequence: 'none',
    }),
    parentRelevance: 'moderate',
    displayLevel: 'summary',
    details: {
      harmLevel: 'implied',
      targetType: 'fantasy_creature',
      weaponRole: 'used',
      actionPurpose: 'attack',
    },
  }
}

describe('parental audit regressions', () => {
  it('keeps reviewer failures explicit instead of dropping review state', () => {
    const [event] = markEventsNotReviewed(
      [scaryEvent()],
      'Reviewer provider failed.',
    )

    expect(event?.review).toMatchObject({
      status: 'not_reviewed',
      evidenceSufficiency: 'insufficient',
      rationale: 'Reviewer provider failed.',
    })

    const policyEvent = applyContentPolicy(event!, 'event_1', 'normal')
    const [scene] = buildPresentationScenes([policyEvent])
    expect(scene?.evidenceStatus).toBe('unreviewed')
  })

  it('does not present an uncertain weak high baseline as established high concern', () => {
    const event = scaryEvent(verifiedReview({
      status: 'uncertain',
      recommendedParentRelevance: 'high',
      evidenceSufficiency: 'insufficient',
      intent: 'unclear',
      aggressionDirection: 'unclear',
      distress: 'unclear',
      consequence: 'unclear',
    }))

    const result = applyContentPolicy(event, 'event_uncertain', 'normal')

    expect(result.parentRelevance).toBe('high')
    expect(result.displayLevel).toBe('summary')
    expect(buildPresentationScenes([result])[0]).toMatchObject({
      attention: 'details',
      evidenceStatus: 'uncertain',
      reviewStatus: 'unreviewed',
    })
    const channel = buildChannelCategoryReports(
      [{ videoId: 'v1', events: [result] }],
      ['scary_and_disturbing'],
      1,
      'normal',
    )[0]!
    expect(channel.level).toBe('none')
    expect(channel.pendingReviewVideos).toBe(1)
    expect(channel.pendingReviewPeakConcern).toBe('high')
  })

  it('does not promote repeated low details into moderate channel concern', () => {
    const report = buildChannelCategoryReports([
      { videoId: 'v1', events: [reviewedInsult('i1')] },
      { videoId: 'v2', events: [reviewedInsult('i2')] },
      { videoId: 'v3', events: [reviewedInsult('i3')] },
    ], ['insults'], 3, 'normal')[0]!

    expect(report.level).toBe('low')
    expect(report.peakConcern).toBe('low')
    expect(report.affectedVideos).toBe(3)
    expect(report.moderatePlusAffectedVideos).toBe(0)
  })

  it('does not count moderate details as main moderate-plus prevalence', () => {
    const report = buildChannelCategoryReports([
      { videoId: 'v1', events: [reviewedFantasyCombat('f1')] },
      { videoId: 'v2', events: [reviewedFantasyCombat('f2')] },
      { videoId: 'v3', events: [reviewedFantasyCombat('f3')] },
    ], ['violence'], 3, 'normal')[0]!

    expect(buildPresentationScenes([reviewedFantasyCombat('preview')])[0]?.attention).toBe('details')
    expect(report.level).toBe('low')
    expect(report.moderatePlusAffectedVideos).toBe(0)
  })

  it('allows a sufficient corrected review to repair detector assertion and engagement', async () => {
    const transcript = normalizeTranscript([
      { text: 'Он ударил жителя и тот упал.', startMs: 1_000, endMs: 2_000 },
    ])
    const detectorEvent: ClassifiedContentEvent = {
      sourceCandidateId: 'candidate_modality',
      sceneId: 'scene_modality',
      category: 'violence',
      subtype: 'physical_attack',
      severity: 'medium',
      context: 'game',
      confidence: 0.8,
      startMs: 1_000,
      endMs: 2_000,
      evidenceRanges: [{ startMs: 1_000, endMs: 2_000 }],
      sceneStartMs: 1_000,
      sceneEndMs: 2_000,
      text: 'Он ударил жителя и тот упал.',
      reason: 'Detector ошибочно посчитал действие предположением.',
      evidenceStrength: 'explicit',
      evidenceSource: 'transcript',
      engagementLevel: 'mention',
      portrayal: 'discouraged',
      explicitness: 'mild',
      assertionStatus: 'hypothetical',
      details: {
        harmLevel: 'actual',
        targetType: 'human_like_character',
        weaponRole: 'none',
        actionPurpose: 'attack',
      },
    }

    const parse = vi.fn(async () => ({
      id: 'resp_modality',
      status: 'completed',
      output_text: '{}',
      output_parsed: {
        reviews: [{
          reviewItemId: 'review_0',
          verdict: 'corrected',
          event: {
            candidateId: 'candidate_modality',
            sceneId: 'scene_modality',
            category: 'violence',
            subtype: 'physical_attack',
            severity: 'medium',
            context: 'game',
            confidence: 0.99,
            evidenceStrength: 'explicit',
            engagementLevel: 'depiction',
            portrayal: 'discouraged',
            explicitness: 'mild',
            assertionStatus: 'actual',
            evidenceSegments: [0],
            sceneStartSegment: 0,
            sceneEndSegment: 0,
            reason: 'Персонаж действительно ударил жителя.',
            details: {
              harmLevel: 'actual',
              targetType: 'human_like_character',
              weaponRole: 'none',
              actionPurpose: 'attack',
            },
          },
          parentRelevance: 'moderate',
          evidenceSufficiency: 'sufficient',
          contextSegments: [0],
          actor: 'персонаж',
          target: 'житель',
          aggressionDirection: 'actor_to_target',
          intent: 'aggressive',
          distress: 'clear',
          consequence: 'injury_or_severe_harm',
          duration: 'brief',
          repetition: 'single',
          narrativeFraming: 'discouraged',
          parentSummary: 'Персонаж ударяет жителя.',
          mitigatingContext: null,
          highPriorityReason: null,
          rationale: 'Прямая реплика описывает произошедшее действие.',
        }],
        missedHighPriorityEvents: [],
      },
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    }))

    const provider = new OpenAIAnalysisProvider(
      'test-key',
      'gpt-test',
      undefined,
      { responses: { parse } } as never,
    )
    const result = await provider.review(transcript, 'ru', ['violence'], [detectorEvent])

    expect(result.reviewedEvents[0]).toMatchObject({
      assertionStatus: 'actual',
      engagementLevel: 'depiction',
      review: {
        status: 'corrected',
        evidenceSufficiency: 'sufficient',
      },
    })
  })
})
