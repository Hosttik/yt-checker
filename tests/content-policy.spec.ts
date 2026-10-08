import { notReviewedReview } from '../server/domain/content-review-state'
import { describe, expect, it } from 'vitest'
import type { ClassifiedContentEvent, ContentEvent } from '../shared/types/content'
import { applyContentPolicy } from '../server/domain/content-policy'
import {
  buildChannelCategoryReports,
  buildPresentationScenes,
  buildVideoCategoryReports,
} from '../server/domain/content-reporting'

const base = {
  severity: 'low',
  context: 'game',
  confidence: 0.95,
  startMs: 1_000,
  endMs: 3_000,
  text: 'test',
  reason: 'test',
  evidenceStrength: 'explicit',
  evidenceSource: 'transcript',
  engagementLevel: 'depiction',
  portrayal: 'neutral',
  explicitness: 'mild',
  assertionStatus: 'actual',
} as const

function violence(
  subtype: Extract<ClassifiedContentEvent, { category: 'violence' }>['subtype'],
  details: Omit<Extract<ClassifiedContentEvent, { category: 'violence' }>['details'], 'actionPurpose'> & {
    actionPurpose?: Extract<ClassifiedContentEvent, { category: 'violence' }>['details']['actionPurpose']
  },
  overrides: Partial<Extract<ClassifiedContentEvent, { category: 'violence' }>> = {},
): Extract<ClassifiedContentEvent, { category: 'violence' }> {
  return {
    ...base,
    category: 'violence',
    subtype,
    details: { actionPurpose: 'unknown', ...details },
    ...overrides,
  }
}

function scary(
  subtype: Extract<ClassifiedContentEvent, { category: 'scary_and_disturbing' }>['subtype'],
  overrides: Partial<Extract<ClassifiedContentEvent, { category: 'scary_and_disturbing' }>> = {},
): Extract<ClassifiedContentEvent, { category: 'scary_and_disturbing' }> {
  return {
    ...base,
    category: 'scary_and_disturbing',
    subtype,
    details: { fearIntensity: 'moderate', threatPresent: true, supernatural: true },
    ...overrides,
  }
}

function substances(
  subtype: Extract<ClassifiedContentEvent, { category: 'substances' }>['subtype'],
  action: Extract<ClassifiedContentEvent, { category: 'substances' }>['details']['action'],
  overrides: Partial<Extract<ClassifiedContentEvent, { category: 'substances' }>> = {},
): Extract<ClassifiedContentEvent, { category: 'substances' }> {
  return {
    ...base,
    category: 'substances',
    subtype,
    details: { substance: subtype, action, userType: 'adult' },
    ...overrides,
  }
}

describe('deterministic content policy', () => {
  it('hides a gifted/possessed weapon in normal mode but keeps it as a real event', () => {
    const event = applyContentPolicy(violence('weapon_presence', {
      harmLevel: 'none', targetType: 'object', weaponRole: 'possessed',
    }), 'event_sword', 'normal')

    expect(event.parentRelevance).toBe('minimal')
    expect(event.displayLevel).toBe('hidden')
  })

  it('keeps non-harmful weapon use low rather than treating it like an attack', () => {
    const event = applyContentPolicy(violence('weapon_use', {
      harmLevel: 'none', targetType: 'object', weaponRole: 'used',
    }, {
      context: 'real_world',
      reason: 'Полицейский тренируется стрелять по мишени.',
    }), 'event_training', 'normal')

    expect(event.parentRelevance).toBe('low')
    expect(event.displayLevel).toBe('summary')
  })

  it('keeps environmental destruction distinct from a physical attack', () => {
    const event = applyContentPolicy(violence('destruction', {
      harmLevel: 'implied', targetType: 'environment', weaponRole: 'none',
    }, {
      severity: 'medium',
      reason: 'Чёрная дыра разрушает деревню.',
    }), 'event_black_hole', 'normal')

    expect(event.subtype).toBe('destruction')
    expect(event.details.targetType).toBe('environment')
    expect(event.parentRelevance).toBe('moderate')
  })

  it('treats fantasy combat as moderate relevance without making severity high', () => {
    const event = applyContentPolicy(violence('fantasy_combat', {
      harmLevel: 'implied', targetType: 'fantasy_creature', weaponRole: 'used',
    }), 'event_zombies', 'normal')

    expect(event.severity).toBe('low')
    expect(event.parentRelevance).toBe('moderate')
    expect(event.displayLevel).toBe('summary')
  })

  it('floors sufficiently evidenced directed coercion at high even when reviewer recommends moderate', () => {
    const event = applyContentPolicy(violence('violent_threat', {
      harmLevel: 'threatened',
      targetType: 'human_like_character',
      weaponRole: 'none',
      actionPurpose: 'threat',
    }, {
      severity: 'medium',
      assertionStatus: 'threatened',
      review: {
        status: 'corrected',
        recommendedParentRelevance: 'moderate',
        evidenceSufficiency: 'sufficient',
        contextRanges: [],
        actor: 'читер',
        target: 'жители',
        aggressionDirection: 'actor_to_target',
        intent: 'coercive',
        distress: 'clear',
        consequence: 'threatened_harm',
        duration: 'brief',
        repetition: 'single',
        narrativeFraming: 'unclear',
        parentSummary: 'Читер обещает не трогать жителей, если герой ему поможет.',
        rationale: 'Условное обещание безопасности используется для принуждения.',
      },
    }), 'event_coercion_floor', 'normal')

    expect(event.parentRelevance).toBe('high')
    expect(event.displayLevel).toBe('highlight')
  })

  it('treats a pitchfork threat as more relevant than weapon presence', () => {
    const event = applyContentPolicy(violence('violent_threat', {
      harmLevel: 'threatened', targetType: 'human_like_character', weaponRole: 'threatened_use',
    }), 'event_pitchfork', 'normal')

    expect(event.parentRelevance).toBe('high')
    expect(event.displayLevel).toBe('highlight')
  })
  it('keeps an armed directed threat high when the model marks the weapons as possessed', () => {
    const event = applyContentPolicy(violence('violent_threat', {
      harmLevel: 'threatened',
      targetType: 'human_like_character',
      weaponRole: 'possessed',
      actionPurpose: 'attack',
    }, {
      severity: 'high',
      review: {
        status: 'confirmed',
        recommendedParentRelevance: 'high',
        evidenceSufficiency: 'sufficient',
        contextRanges: [],
        actor: 'жители',
        target: 'Компот',
        aggressionDirection: 'actor_to_target',
        intent: 'aggressive',
        distress: 'clear',
        consequence: 'threatened_harm',
        duration: 'brief',
        repetition: 'single',
        narrativeFraming: 'neutral',
        parentSummary: 'Жители берут вилы и копья и загоняют Компота в тупик.',
        highPriorityReason: 'Несколько жителей вооружаются против загнанного в тупик героя.',
        rationale: 'Прямое вооружённое давление подтверждено.',
      },
    }), 'event_armed_threat', 'normal')

    expect(event.parentRelevance).toBe('high')
    expect(event.displayLevel).toBe('highlight')
  })


  it('preserves one life-threatening scene as high concern without frequency-based demotion', () => {
    const event = applyContentPolicy(violence('life_threatening_situation', {
      harmLevel: 'actual', targetType: 'human_like_character', weaponRole: 'none',
    }, {
      reason: 'Персонажей намеренно привязали к рельсам перед приближающимся поездом.',
    }), 'event_rails', 'normal')

    expect(event.parentRelevance).toBe('high')
    event.review = { ...notReviewedReview('Verified life-threatening scene fixture.'), status: 'confirmed', evidenceSufficiency: 'sufficient' }
    const channel = buildChannelCategoryReports(
      [{ videoId: 'one', events: [event] }],
      ['violence'],
      10,
      'normal',
    )
    expect(channel[0]?.peakConcern).toBe('high')
    expect(channel[0]?.highlightedVideos).toBe(1)
    expect(channel[0]?.level).toBe('high')
  })

  it('distinguishes neutral nicotine mention, use and promotion', () => {
    const mention = applyContentPolicy(substances('nicotine', 'mention'), 'mention', 'normal')
    const use = applyContentPolicy(substances('nicotine', 'use'), 'use', 'normal')
    const promo = applyContentPolicy(substances('nicotine', 'promotion', {
      portrayal: 'glamorized',
    }), 'promo', 'normal')

    expect([mention.parentRelevance, mention.displayLevel]).toEqual(['minimal', 'hidden'])
    expect([use.parentRelevance, use.displayLevel]).toEqual(['low', 'summary'])
    expect([promo.parentRelevance, promo.displayLevel]).toEqual(['high', 'highlight'])
  })

  it('keeps low-confidence high-relevance events visible but not highlighted in normal mode', () => {
    const event = applyContentPolicy(violence('life_threatening_situation', {
      harmLevel: 'actual', targetType: 'human_like_character', weaponRole: 'none',
    }, {
      confidence: 0.4,
      evidenceStrength: 'weak_context',
    }), 'event_uncertain', 'normal')

    expect(event.parentRelevance).toBe('high')
    expect(event.displayLevel).toBe('summary')
  })

  it('strict mode surfaces minimal findings without changing their relevance', () => {
    const event = applyContentPolicy(violence('weapon_presence', {
      harmLevel: 'none', targetType: 'object', weaponRole: 'possessed',
    }), 'event_sword', 'strict')

    expect(event.parentRelevance).toBe('minimal')
    expect(event.displayLevel).toBe('summary')
  })
})

describe('calibration regressions', () => {
  it('hides a low-severity accidental injury in normal mode but keeps it in strict mode', () => {
    const classified = violence('injury', {
      harmLevel: 'actual',
      targetType: 'person',
      weaponRole: 'none',
      actionPurpose: 'accident',
    }, {
      severity: 'low',
      reason: 'Пружина случайно ударила героя в спину.',
    })

    const normal = applyContentPolicy(classified, 'accident-normal', 'normal')
    const strict = applyContentPolicy(classified, 'accident-strict', 'strict')

    expect([normal.parentRelevance, normal.displayLevel]).toEqual(['minimal', 'hidden'])
    expect([strict.parentRelevance, strict.displayLevel]).toEqual(['minimal', 'summary'])
  })

  it('hides harmless weapon demonstrations in normal mode', () => {
    const event = applyContentPolicy(violence('weapon_use', {
      harmLevel: 'none',
      targetType: 'object',
      weaponRole: 'used',
      actionPurpose: 'demonstration',
    }, {
      severity: 'low',
      reason: 'Персонаж показывает, как работает подаренный меч.',
    }), 'event-demo', 'normal')

    expect(event.parentRelevance).toBe('minimal')
    expect(event.displayLevel).toBe('hidden')
  })

  it('hides rescue-oriented weapon use in normal mode', () => {
    const event = applyContentPolicy(violence('weapon_use', {
      harmLevel: 'none', targetType: 'object', weaponRole: 'used', actionPurpose: 'rescue',
    }), 'event_rescue', 'normal')

    expect(event.parentRelevance).toBe('minimal')
    expect(event.displayLevel).toBe('hidden')
  })

  it('does not turn a low-severity degrading statement into high relevance', () => {
    const event = applyContentPolicy({
      ...base,
      category: 'insults',
      subtype: 'degrading_statement',
      details: { targetType: 'character' },
    }, 'event_reproach', 'normal')

    expect(event.parentRelevance).toBe('low')
    expect(event.displayLevel).toBe('summary')
  })

  it('keeps moderate game peril moderate unless fear is strong or severity is high', () => {
    const event = applyContentPolicy(scary('intense_peril', {
      severity: 'medium',
      context: 'game',
      details: { fearIntensity: 'moderate', threatPresent: true, supernatural: true },
    }), 'event_zombie_fear', 'normal')

    expect(event.parentRelevance).toBe('moderate')
    expect(event.displayLevel).toBe('summary')
  })
})
describe('multi-label presentation and aggregation', () => {
  it('groups violence and scary labels from one scene into one user-visible scene', () => {
    const violenceEvent = applyContentPolicy(violence('dangerous_situation', {
      harmLevel: 'threatened', targetType: 'human_like_character', weaponRole: 'none',
    }, {
      sourceCandidateId: 'candidate_10_1',
      sceneId: 'scene_10',
      reason: 'Зомби ломятся в бункер.',
    }), 'v1', 'normal')
    const scaryEvent = applyContentPolicy(scary('threatening_character', {
      sourceCandidateId: 'candidate_10_2',
      sceneId: 'scene_10',
      reason: 'Герой паникует, пока зомби пытаются попасть внутрь.',
    }), 's1', 'normal')

    const scenes = buildPresentationScenes([violenceEvent, scaryEvent])
    expect(scenes).toHaveLength(1)
    expect(scenes[0]?.categories.sort()).toEqual(['scary_and_disturbing', 'violence'])
    expect(scenes[0]?.events).toHaveLength(2)
  })

  it('does not leak hidden minimal findings through the normal report summary', () => {
    const hidden = applyContentPolicy(violence('weapon_presence', {
      harmLevel: 'none', targetType: 'object', weaponRole: 'possessed',
    }), 'hidden_weapon', 'normal')
    const report = buildVideoCategoryReports([hidden], ['violence'])[0]

    expect(report?.displayedEventCount).toBe(0)
    expect(report?.level).toBe('none')
    expect(report?.summary).toBe('Для выбранного профиля значимых элементов не показано.')
  })

  it('does not let hidden findings inflate displayed-video prevalence', () => {
    const displayed = Array.from({ length: 3 }, (_, index) =>
      applyContentPolicy(violence('weapon_use', {
        harmLevel: 'none', targetType: 'object', weaponRole: 'used',
      }, {
        startMs: index * 10_000,
        endMs: index * 10_000 + 1_000,
      }), `displayed_${index}`, 'normal'),
    )
    const hidden = Array.from({ length: 7 }, (_, index) =>
      applyContentPolicy(violence('weapon_presence', {
        harmLevel: 'none', targetType: 'object', weaponRole: 'possessed',
      }, {
        startMs: (index + 3) * 10_000,
        endMs: (index + 3) * 10_000 + 1_000,
      }), `hidden_${index}`, 'normal'),
    )

    const channel = buildChannelCategoryReports(
      [...displayed, ...hidden].map((event, index) => ({ videoId: `v${index}`, events: [event] })),
      ['violence'],
      10,
      'normal',
    )[0]

    expect(channel?.rawAffectedVideos).toBe(10)
    expect(channel?.affectedVideos).toBe(3)
    expect(channel?.level).toBe('none')
    expect(channel?.pendingReviewVideos).toBe(3)
  })

  it('does not escalate many hidden minimal weapon mentions into a worse normal report', () => {
    const events: ContentEvent[] = Array.from({ length: 10 }, (_, index) =>
      applyContentPolicy(violence('weapon_presence', {
        harmLevel: 'none', targetType: 'object', weaponRole: 'possessed',
      }, {
        startMs: index * 10_000,
        endMs: index * 10_000 + 1_000,
      }), `event_${index}`, 'normal'),
    )

    const videoReport = buildVideoCategoryReports(events, ['violence'])
    expect(videoReport[0]).toMatchObject({
      rawEventCount: 10,
      displayedEventCount: 0,
      level: 'none',
    })

    const channel = buildChannelCategoryReports(
      events.map((event, index) => ({ videoId: `v${index}`, events: [event] })),
      ['violence'],
      10,
      'normal',
    )
    expect(channel[0]?.level).toBe('none')
  })
})


it('hides routine demolition without suppressing dangerous destruction', () => {
  const routine = violence('destruction', {
    harmLevel: 'actual', targetType: 'object', weaponRole: 'none', actionPurpose: 'utility',
  }, { text: 'Снести каменный дом и построить новый дом.', severity: 'low' })
  expect(applyContentPolicy(routine, 'demolition', 'normal').displayLevel).toBe('hidden')
  expect(applyContentPolicy({ ...routine, severity: 'high' }, 'danger', 'normal').displayLevel).not.toBe('hidden')
  expect(applyContentPolicy({ ...routine, details: { ...routine.details, actionPurpose: 'destruction' } }, 'attack', 'normal').parentRelevance).toBe('moderate')
})


it('shows an established mild funeral theme without turning it into a high warning', () => {
  const theme = scary('death_related_theme', {
    severity: 'low',
    details: { themePresent: true, fearIntensity: 'mild', threatPresent: false, supernatural: false },
  })
  const event = applyContentPolicy(theme, 'funeral', 'normal')
  expect([event.parentRelevance, event.displayLevel]).toEqual(['low', 'summary'])
  expect(applyContentPolicy({ ...theme, details: { ...theme.details, themePresent: false } }, 'word', 'normal').displayLevel).toBe('hidden')
})


describe('child-safety semantic modifiers', () => {
  it('keeps stylized fantasy behavior below realistic easy-to-copy behavior', () => {
    const fantasy = applyContentPolicy(violence('weapon_use', {
      harmLevel: 'none',
      targetType: 'object',
      weaponRole: 'used',
      actionPurpose: 'sport',
    }, {
      context: 'game',
      realism: 'fantasy',
      imitationRisk: 'low',
      behaviorOutcome: 'neutral',
    }), 'fantasy-training', 'normal')

    const realistic = applyContentPolicy(violence('weapon_use', {
      harmLevel: 'none',
      targetType: 'object',
      weaponRole: 'used',
      actionPurpose: 'sport',
    }, {
      context: 'real_world',
      realism: 'realistic',
      imitationRisk: 'high',
      behaviorOutcome: 'neutral',
    }), 'real-training', 'normal')

    expect(fantasy.parentRelevance).toBe('low')
    expect(realistic.parentRelevance).toBe('moderate')
  })

  it('raises rewarded easy-to-copy harmful behavior without turning reward into severity', () => {
    const event = applyContentPolicy(violence('dangerous_situation', {
      harmLevel: 'threatened',
      targetType: 'person',
      weaponRole: 'none',
      actionPurpose: 'unknown',
    }, {
      severity: 'medium',
      realism: 'realistic',
      imitationRisk: 'high',
      behaviorOutcome: 'rewarded',
      engagementLevel: 'depiction',
      portrayal: 'glamorized',
    }), 'rewarded-danger', 'normal')

    expect(event.severity).toBe('medium')
    expect(event.parentRelevance).toBe('high')
    expect(event.displayLevel).toBe('highlight')
  })

  it('keeps harmful instruction high even in educational context', () => {
    const event = applyContentPolicy(substances('drugs', 'instruction', {
      context: 'educational',
      engagementLevel: 'instruction',
      portrayal: 'educational',
      realism: 'realistic',
      imitationRisk: 'high',
      behaviorOutcome: 'negative_consequences',
    }), 'educational-instruction', 'normal')

    expect(event.parentRelevance).toBe('high')
  })

  it('uses child age only as a deterministic salience modifier, not as a category shortcut', () => {
    const classified = violence('weapon_use', {
      harmLevel: 'none',
      targetType: 'object',
      weaponRole: 'used',
      actionPurpose: 'sport',
    }, {
      context: 'real_world',
      realism: 'realistic',
      imitationRisk: 'medium',
      behaviorOutcome: 'neutral',
    })

    const younger = applyContentPolicy(classified, 'age-7', 'normal', { childAge: 7 })
    const teen = applyContentPolicy(classified, 'age-13', 'normal', { childAge: 13 })

    expect(younger.parentRelevance).toBe('moderate')
    expect(teen.parentRelevance).toBe('low')
  })

  it('does not let reviewer relevance opinion override deterministic event policy', () => {
    const event = applyContentPolicy(violence('fantasy_combat', {
      harmLevel: 'implied',
      targetType: 'fantasy_creature',
      weaponRole: 'used',
      actionPurpose: 'attack',
    }, {
      review: {
        status: 'confirmed',
        recommendedParentRelevance: 'low',
        evidenceSufficiency: 'sufficient',
        contextRanges: [],
        aggressionDirection: 'mutual',
        intent: 'aggressive',
        distress: 'mild',
        consequence: 'none',
        duration: 'brief',
        repetition: 'single',
        narrativeFraming: 'neutral',
        parentSummary: 'Герои сражаются с фантастическими существами.',
        rationale: 'Фантастический игровой бой подтверждён.',
      },
    }), 'review-opinion', 'normal')

    expect(event.parentRelevance).toBe('moderate')
  })

  it('preserves legacy behavior when new semantic fields are absent', () => {
    const event = applyContentPolicy(violence('weapon_use', {
      harmLevel: 'none',
      targetType: 'object',
      weaponRole: 'used',
      actionPurpose: 'sport',
    }), 'legacy-training', 'normal')

    expect([event.parentRelevance, event.displayLevel]).toEqual(['low', 'summary'])
  })
})
