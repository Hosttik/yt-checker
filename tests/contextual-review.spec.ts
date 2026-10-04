import { describe, expect, it } from 'vitest'
import type {
  ClassifiedContentEvent,
  ContentEventReview,
} from '../shared/types/content'
import { applyContentPolicy } from '../server/domain/content-policy'
import { buildPresentationScenes, buildVideoContentSummary } from '../server/domain/content-reporting'

function review(
  recommendedParentRelevance: ContentEventReview['recommendedParentRelevance'],
  status: ContentEventReview['status'] = 'confirmed',
): ContentEventReview {
  return {
    status,
    recommendedParentRelevance,
    evidenceSufficiency: status === 'uncertain' ? 'partial' : 'sufficient',
    contextRanges: [],
    aggressionDirection: 'actor_to_target',
    intent: 'aggressive',
    distress: 'none',
    consequence: 'none',
    duration: 'momentary',
    repetition: 'single',
    narrativeFraming: 'neutral',
    rationale: 'Manual test review.',
  }
}

function insult(overrides: Partial<ClassifiedContentEvent> = {}): ClassifiedContentEvent {
  return {
    sourceCandidateId: 'candidate_1',
    sceneId: 'scene_1',
    category: 'insults',
    subtype: 'degrading_statement',
    severity: 'high',
    context: 'game',
    confidence: 0.99,
    startMs: 1_000,
    endMs: 2_000,
    evidenceRanges: [{ startMs: 1_000, endMs: 2_000 }],
    sceneStartMs: 500,
    sceneEndMs: 3_000,
    text: 'Как же вы глупые и наивные.',
    reason: 'Персонаж называет группу глупой и наивной.',
    evidenceStrength: 'explicit',
    evidenceSource: 'transcript',
    engagementLevel: 'participation',
    portrayal: 'neutral',
    explicitness: 'none',
    assertionStatus: 'actual',
    details: { targetType: 'group' },
    ...overrides,
  } as ClassifiedContentEvent
}

function violentThreat(overrides: Partial<ClassifiedContentEvent> = {}): ClassifiedContentEvent {
  return {
    sourceCandidateId: 'candidate_2',
    sceneId: 'scene_2',
    category: 'violence',
    subtype: 'violent_threat',
    severity: 'high',
    context: 'game',
    confidence: 0.98,
    startMs: 10_000,
    endMs: 13_000,
    evidenceRanges: [{ startMs: 10_000, endMs: 13_000 }],
    sceneStartMs: 9_000,
    sceneEndMs: 15_000,
    text: 'Если не сделаешь это, жителям конец.',
    reason: 'Персонаж угрожает жителям вредом, чтобы заставить другого выполнить задание.',
    evidenceStrength: 'explicit',
    evidenceSource: 'transcript',
    engagementLevel: 'depiction',
    portrayal: 'discouraged',
    explicitness: 'mild',
    assertionStatus: 'threatened',
    details: {
      harmLevel: 'threatened',
      targetType: 'human_like_character',
      weaponRole: 'none',
      actionPurpose: 'threat',
    },
    ...overrides,
  } as ClassifiedContentEvent
}

describe('contextual parent relevance', () => {
  it('can demote a factually real one-off insult without deleting the detection', () => {
    const event = applyContentPolicy(
      insult({ review: review('low') }),
      'event-1',
      'normal',
    )

    expect(event.category).toBe('insults')
    expect(event.parentRelevance).toBe('low')
    expect(event.displayLevel).toBe('summary')

    const scenes = buildPresentationScenes([event])
    expect(scenes).toHaveLength(1)
    expect(scenes[0]?.attention).toBe('details')
  })

  it('does not let an uncertain review erase a serious explicit threat', () => {
    const event = applyContentPolicy(
      violentThreat({ review: review('low', 'uncertain') }),
      'event-2',
      'normal',
    )

    expect(event.parentRelevance).toBe('high')
    expect(event.displayLevel).toBe('highlight')
    expect(buildPresentationScenes([event])[0]?.attention).toBe('main')
  })

  it('keeps sensitivity preferences as a deterministic display-layer concern', () => {
    const event = applyContentPolicy(
      insult({ severity: 'low' }),
      'event-3',
      'normal',
      { sensitivities: { insults: 'sensitive' } },
    )

    expect(event.parentRelevance).toBe('moderate')
  })

  it('groups a mild insult into a serious scene instead of creating a separate main warning', () => {
    const mild = applyContentPolicy(
      insult({
        sceneId: 'shared-scene',
        severity: 'low',
        review: review('low'),
      }),
      'mild',
      'normal',
    )
    const coercion = applyContentPolicy(
      violentThreat({
        sceneId: 'shared-scene',
        review: {
          ...review('high'),
          intent: 'coercive',
          distress: 'clear',
          consequence: 'threatened_harm',
        },
      }),
      'coercion',
      'normal',
    )

    const scenes = buildPresentationScenes([mild, coercion])
    expect(scenes).toHaveLength(1)
    expect(scenes[0]?.attention).toBe('main')
    expect(scenes[0]?.events).toHaveLength(2)
  })

  it('uses scope-limited calm wording when only light findings remain', () => {
    const mild = applyContentPolicy(
      insult({ severity: 'low', review: review('low') }),
      'mild',
      'normal',
    )
    const scenes = buildPresentationScenes([mild])
    const summary = buildVideoContentSummary(scenes)

    expect(summary).toContain('Существенных сцен в проанализированных субтитрах не обнаружено')
    expect(summary).toContain('лёгких или спорных находок: 1')
  })
})
