import { describe, expect, it } from 'vitest'
import type {
  ClassifiedContentEvent,
  ContentEventReview,
} from '../shared/types/content'
import { applyContentPolicy } from '../server/domain/content-policy'
import { buildPresentationScenes, buildVideoContentSummary } from '../server/domain/content-reporting'

function review(overrides: Partial<ContentEventReview> = {}): ContentEventReview {
  return {
    status: 'confirmed',
    recommendedParentRelevance: 'high',
    evidenceSufficiency: 'sufficient',
    contextRanges: [],
    actor: 'Персонаж',
    target: 'Другой персонаж',
    aggressionDirection: 'actor_to_target',
    intent: 'aggressive',
    distress: 'clear',
    consequence: 'threatened_harm',
    duration: 'brief',
    repetition: 'single',
    narrativeFraming: 'neutral',
    parentSummary: 'Персонажу прямо угрожают причинить вред.',
    highPriorityReason: 'Угроза направлена на конкретного персонажа и может привести к серьёзному вреду.',
    rationale: 'Проверено по полному контексту сцены.',
    ...overrides,
  }
}

function scary(
  subtype: Extract<ClassifiedContentEvent, { category: 'scary_and_disturbing' }>['subtype'],
  overrides: Partial<Extract<ClassifiedContentEvent, { category: 'scary_and_disturbing' }>> = {},
): Extract<ClassifiedContentEvent, { category: 'scary_and_disturbing' }> {
  return {
    sourceCandidateId: 'scary-candidate',
    sceneId: 'scary-scene',
    category: 'scary_and_disturbing',
    subtype,
    severity: 'high',
    context: 'game',
    confidence: 0.99,
    startMs: 1_000,
    endMs: 5_000,
    text: 'Персонаж пугается и убегает.',
    reason: 'Персонаж пугается и убегает от игровой угрозы.',
    evidenceStrength: 'explicit',
    evidenceSource: 'transcript',
    engagementLevel: 'depiction',
    portrayal: 'neutral',
    explicitness: 'mild',
    assertionStatus: 'actual',
    details: {
      fearIntensity: 'strong',
      themePresent: true,
      threatPresent: true,
      supernatural: false,
    },
    review: review(),
    ...overrides,
  }
}

function violence(
  subtype: Extract<ClassifiedContentEvent, { category: 'violence' }>['subtype'],
  overrides: Partial<Extract<ClassifiedContentEvent, { category: 'violence' }>> = {},
): Extract<ClassifiedContentEvent, { category: 'violence' }> {
  return {
    sourceCandidateId: 'violence-candidate',
    sceneId: 'violence-scene',
    category: 'violence',
    subtype,
    severity: 'high',
    context: 'game',
    confidence: 0.99,
    startMs: 1_000,
    endMs: 5_000,
    text: 'Персонажу угрожают.',
    reason: 'Персонажу угрожают причинить вред.',
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
    review: review(),
    ...overrides,
  }
}

describe('parent relevance calibration', () => {
  it('caps an ordinary game pursuit at main/moderate even when review asks for high', () => {
    const event = applyContentPolicy(scary('pursuit', {
      review: review({
        intent: 'aggressive',
        consequence: 'threatened_harm',
        duration: 'brief',
        parentSummary: 'Герой убегает от преследующего его игрового противника.',
        highPriorityReason: 'Погоня выглядит напряжённо.',
      }),
    }), 'pursuit', 'normal')

    expect(event.parentRelevance).toBe('moderate')
    expect(event.displayLevel).toBe('summary')
  })

  it('caps reported monster danger at moderate without immediate peril or coercion', () => {
    const event = applyContentPolicy(scary('threatening_character', {
      assertionStatus: 'reported',
      text: 'Сообщили, что к деревне идут монстры.',
      reason: 'Персонажи получают известие о приближении монстров.',
      details: {
        fearIntensity: 'moderate',
        themePresent: true,
        threatPresent: true,
        supernatural: true,
      },
      review: review({
        intent: 'unclear',
        aggressionDirection: 'unclear',
        distress: 'mild',
        consequence: 'threatened_harm',
        duration: 'brief',
        parentSummary: 'Персонажи узнают, что к игровой деревне приближаются монстры.',
        highPriorityReason: 'Монстры могут представлять опасность.',
      }),
    }), 'monster-news', 'normal')

    expect(event.parentRelevance).toBe('moderate')
    expect(buildPresentationScenes([event])[0]?.attention).toBe('details')
  })

  it('keeps an active fictional threat on the main screen at moderate relevance', () => {
    const event = applyContentPolicy(scary('threatening_character', {
      severity: 'medium',
      assertionStatus: 'actual',
      engagementLevel: 'depiction',
      text: 'Зомби скребутся снаружи, быстрее закрываем дверь.',
      reason: 'Персонаж прячется за дверью, пока зомби находятся прямо снаружи.',
      details: {
        fearIntensity: 'moderate',
        themePresent: true,
        threatPresent: true,
        supernatural: true,
      },
      review: review({
        recommendedParentRelevance: 'moderate',
        intent: 'unclear',
        aggressionDirection: 'actor_to_target',
        distress: 'clear',
        consequence: 'threatened_harm',
        duration: 'brief',
        highPriorityReason: undefined,
        parentSummary: 'Зомби находятся у двери, пока герой пытается укрыться внутри.',
      }),
    }), 'active-zombie-threat', 'normal')

    expect(event.parentRelevance).toBe('moderate')
    expect(buildPresentationScenes([event])[0]?.attention).toBe('main')
  })

  it('keeps uncertain partial-evidence moderate scenes in details', () => {
    const event = applyContentPolicy(scary('threatening_character', {
      severity: 'medium',
      assertionStatus: 'actual',
      text: 'О нет, зомби тут. [стон]',
      reason: 'Герой говорит, что зомби рядом; дальше слышен звук.',
      details: {
        fearIntensity: 'moderate',
        themePresent: true,
        threatPresent: true,
        supernatural: true,
      },
      review: review({
        status: 'uncertain',
        recommendedParentRelevance: 'moderate',
        evidenceSufficiency: 'partial',
        intent: 'unclear',
        aggressionDirection: 'unclear',
        distress: 'clear',
        consequence: 'unclear',
        duration: 'momentary',
        highPriorityReason: undefined,
        parentSummary: 'Герой говорит, что зомби рядом, но дальнейшее действие неясно.',
      }),
    }), 'uncertain-zombie', 'normal')

    expect(event.parentRelevance).toBe('moderate')
    expect(buildPresentationScenes([event])[0]?.attention).toBe('details')
  })

  it('keeps routine fictional fantasy combat in details', () => {
    const event = applyContentPolicy(violence('fantasy_combat', {
      severity: 'medium',
      context: 'game',
      assertionStatus: 'actual',
      engagementLevel: 'participation',
      text: 'Я раскидал зомби по одному и всех вынес.',
      reason: 'Герой участвует в обычной игровой драке с зомби.',
      details: {
        harmLevel: 'actual',
        targetType: 'fantasy_creature',
        weaponRole: 'none',
        actionPurpose: 'attack',
      },
      review: review({
        recommendedParentRelevance: 'moderate',
        distress: 'none',
        consequence: 'unclear',
        duration: 'brief',
        repetition: 'repeated',
        highPriorityReason: undefined,
        parentSummary: 'Герой дерётся с зомби и говорит, что победил их.',
      }),
    }), 'routine-fantasy-combat', 'normal')

    expect(buildPresentationScenes([event])[0]?.attention).toBe('details')
  })

  it('keeps property-only fictional destruction in details', () => {
    const event = applyContentPolicy(violence('destruction', {
      severity: 'high',
      context: 'game',
      assertionStatus: 'actual',
      text: 'Чёрная дыра разрушила половину деревни и засасывает дом.',
      reason: 'Игровая чёрная дыра разрушает здания.',
      details: {
        harmLevel: 'actual',
        targetType: 'environment',
        weaponRole: 'none',
        actionPurpose: 'destruction',
      },
      review: review({
        recommendedParentRelevance: 'moderate',
        intent: 'accidental',
        aggressionDirection: 'none',
        distress: 'clear',
        consequence: 'property_only',
        duration: 'sustained',
        repetition: 'repeated',
        highPriorityReason: undefined,
        parentSummary: 'Чёрная дыра разрушает часть деревни и затягивает дом.',
      }),
    }), 'property-destruction', 'normal')

    expect(event.parentRelevance).toBe('moderate')
    expect(buildPresentationScenes([event])[0]?.attention).toBe('details')
  })

  it('keeps sustained coercive confinement high', () => {
    const event = applyContentPolicy(scary('confinement', {
      severity: 'medium',
      text: 'Выход из деревни вам запрещён, будете делать только то, что я скажу.',
      reason: 'Персонаж запрещает группе покидать деревню и требует подчинения.',
      details: {
        fearIntensity: 'moderate',
        themePresent: true,
        threatPresent: true,
        supernatural: false,
      },
      review: review({
        intent: 'coercive',
        distress: 'clear',
        consequence: 'none',
        duration: 'sustained',
        parentSummary: 'Персонаж запрещает группе покидать деревню и требует выполнять его приказы.',
        highPriorityReason: 'У группы отнимают возможность уйти и принуждают подчиняться.',
      }),
    }), 'coercion', 'normal')

    expect(event.parentRelevance).toBe('high')
    expect(event.displayLevel).toBe('highlight')
  })

  it('keeps a directed weapon threat high', () => {
    const event = applyContentPolicy(violence('violent_threat', {
      details: {
        harmLevel: 'threatened',
        targetType: 'human_like_character',
        weaponRole: 'threatened_use',
        actionPurpose: 'threat',
      },
      review: review({
        intent: 'aggressive',
        parentSummary: 'Жители загоняют героя в тупик и угрожают ему вилами и копьями.',
        highPriorityReason: 'Оружие направлено против конкретного персонажа, который просит остановиться.',
      }),
    }), 'weapon-threat', 'normal')

    expect(event.parentRelevance).toBe('high')
  })

  it('keeps immediate railway peril high', () => {
    const event = applyContentPolicy(violence('life_threatening_situation', {
      assertionStatus: 'actual',
      text: 'Мы привязаны. Поезд ведь едет.',
      reason: 'Связанные персонажи лежат на рельсах, к ним приближается поезд.',
      details: {
        harmLevel: 'threatened',
        targetType: 'human_like_character',
        weaponRole: 'none',
        actionPurpose: 'threat',
      },
      review: review({
        intent: 'coercive',
        distress: 'strong',
        consequence: 'threatened_harm',
        duration: 'sustained',
        parentSummary: 'Связанные персонажи лежат на рельсах, пока к ним приближается поезд.',
        mitigatingContext: 'Позже их успевают освободить до прохода поезда.',
        highPriorityReason: 'Персонажи обездвижены перед непосредственно приближающимся поездом.',
      }),
    }), 'railway', 'normal')

    expect(event.parentRelevance).toBe('high')
  })

  it('uses one reviewed parent summary and keeps mitigation and high rationale separate', () => {
    const primary = applyContentPolicy(violence('violent_threat', {
      sceneId: 'shared-scene',
      review: review({
        parentSummary: 'Жители загоняют героя в тупик и угрожают ему вилами и копьями.',
        mitigatingContext: 'Сцена происходит в Minecraft и заканчивается без описанной травмы.',
        highPriorityReason: 'Это направленная угроза оружием конкретному персонажу.',
      }),
      details: {
        harmLevel: 'threatened',
        targetType: 'human_like_character',
        weaponRole: 'threatened_use',
        actionPurpose: 'threat',
      },
    }), 'primary', 'normal')
    const duplicate = applyContentPolicy(violence('dangerous_situation', {
      sceneId: 'shared-scene',
      severity: 'medium',
      reason: 'Повторное внутреннее описание той же угрозы.',
      review: review({
        recommendedParentRelevance: 'moderate',
        parentSummary: 'Повторное описание той же сцены.',
        mitigatingContext: 'Сцена происходит в Minecraft и заканчивается без описанной травмы.',
        highPriorityReason: undefined,
      }),
    }), 'duplicate', 'normal')

    const scene = buildPresentationScenes([primary, duplicate])[0]!
    expect(scene.summary).toBe('Жители загоняют героя в тупик и угрожают ему вилами и копьями.')
    expect(scene.summary).not.toContain('Повторное')
    expect(scene.mitigatingContext).toBe('Сцена происходит в Minecraft и заканчивается без описанной травмы.')
    expect(scene.priorityReason).toBe('Это направленная угроза оружием конкретному персонажу.')
  })
  it('merges nearby coercive scenes from one story arc into one card', () => {
    const first = applyContentPolicy(violence('dangerous_situation', {
      sceneId: 'arc-1',
      severity: 'medium',
      context: 'fiction',
      startMs: 10_000,
      endMs: 20_000,
      sceneStartMs: 10_000,
      sceneEndMs: 20_000,
      review: review({
        recommendedParentRelevance: 'moderate',
        actor: 'клон мэра',
        target: 'мэр',
        intent: 'coercive',
        consequence: 'threatened_harm',
        duration: 'brief',
        highPriorityReason: undefined,
        parentSummary: 'Клон удерживает мэра, который просит выпустить его.',
      }),
    }), 'arc-first', 'normal')
    const second = applyContentPolicy(violence('dangerous_situation', {
      sceneId: 'arc-2',
      severity: 'medium',
      context: 'fiction',
      startMs: 45_000,
      endMs: 55_000,
      sceneStartMs: 45_000,
      sceneEndMs: 55_000,
      review: review({
        recommendedParentRelevance: 'moderate',
        actor: undefined,
        target: 'жители деревни',
        intent: 'coercive',
        consequence: 'threatened_harm',
        duration: 'brief',
        highPriorityReason: undefined,
        parentSummary: 'Говорящий угрожает не выпускать жителей из деревни.',
      }),
    }), 'arc-second', 'normal')
    const third = applyContentPolicy(violence('dangerous_situation', {
      sceneId: 'arc-3',
      severity: 'high',
      context: 'fiction',
      startMs: 85_000,
      endMs: 95_000,
      sceneStartMs: 85_000,
      sceneEndMs: 95_000,
      review: review({
        recommendedParentRelevance: 'high',
        actor: 'клон мэра',
        target: 'жители деревни',
        intent: 'coercive',
        consequence: 'threatened_harm',
        duration: 'sustained',
        parentSummary: 'Клон запрещает жителям уходить и требует полного подчинения.',
        highPriorityReason: 'Жителей принуждают оставаться и выполнять приказы.',
      }),
    }), 'arc-third', 'normal')

    const scenes = buildPresentationScenes([first, second, third])
    expect(scenes).toHaveLength(1)
    expect(scenes[0]?.level).toBe('high')
    expect(scenes[0]?.attention).toBe('main')
    expect(scenes[0]?.events).toHaveLength(3)
    expect(scenes[0]?.summary).toBe('Клон запрещает жителям уходить и требует полного подчинения.')
  })

  it('uses correct Russian singular forms in the video summary', () => {
    const mainEvent = applyContentPolicy(violence('life_threatening_situation', {
      sceneId: 'summary-main',
      assertionStatus: 'actual',
      details: {
        harmLevel: 'threatened',
        targetType: 'human_like_character',
        weaponRole: 'none',
        actionPurpose: 'threat',
      },
      review: review({
        intent: 'coercive',
        distress: 'strong',
        duration: 'sustained',
        parentSummary: 'Связанные персонажи находятся перед приближающимся поездом.',
        highPriorityReason: 'Персонажи не могут уйти от непосредственно приближающегося поезда.',
      }),
    }), 'summary-main', 'normal')
    const detailEvent = applyContentPolicy(violence('fantasy_combat', {
      sceneId: 'summary-detail',
      severity: 'medium',
      startMs: 200_000,
      endMs: 205_000,
      sceneStartMs: 200_000,
      sceneEndMs: 205_000,
      details: {
        harmLevel: 'actual',
        targetType: 'fantasy_creature',
        weaponRole: 'none',
        actionPurpose: 'attack',
      },
      review: review({
        recommendedParentRelevance: 'moderate',
        actor: 'герой',
        target: 'зомби',
        distress: 'none',
        consequence: 'unclear',
        highPriorityReason: undefined,
        parentSummary: 'Герой участвует в обычной игровой драке с зомби.',
      }),
    }), 'summary-detail', 'normal')

    const summary = buildVideoContentSummary(buildPresentationScenes([mainEvent, detailEvent]))
    expect(summary).toBe(
      'В проанализированных субтитрах есть 1 сцена, на которую стоит обратить внимание. Ещё 1 лёгкая или спорная находка вынесена в подробности.',
    )
  })

  it('prefers the stronger reviewed summary inside one merged moderate scene', () => {
    const nearbyDanger = applyContentPolicy(violence('dangerous_situation', {
      sceneId: 'bunker-scene',
      severity: 'medium',
      context: 'game',
      assertionStatus: 'actual',
      startMs: 458_000,
      endMs: 482_000,
      sceneStartMs: 458_000,
      sceneEndMs: 508_000,
      details: {
        harmLevel: 'threatened',
        targetType: 'human_like_character',
        weaponRole: 'none',
        actionPurpose: 'unknown',
      },
      review: review({
        recommendedParentRelevance: 'moderate',
        actor: 'зомби',
        target: 'рассказчик',
        intent: 'unclear',
        distress: 'clear',
        consequence: 'threatened_harm',
        duration: 'brief',
        repetition: 'single',
        highPriorityReason: undefined,
        parentSummary: 'Рассказчик слышит рядом зомби и закрывает дверь бункера.',
        mitigatingContext: 'Рассказчик находится за закрытой дверью бункера.',
      }),
    }), 'bunker-danger', 'normal')

    const strongerPeril = applyContentPolicy(scary('intense_peril', {
      sceneId: 'bunker-scene',
      severity: 'medium',
      context: 'game',
      assertionStatus: 'actual',
      startMs: 492_000,
      endMs: 508_000,
      sceneStartMs: 458_000,
      sceneEndMs: 508_000,
      details: {
        fearIntensity: 'strong',
        themePresent: true,
        threatPresent: true,
        supernatural: true,
      },
      review: review({
        recommendedParentRelevance: 'moderate',
        actor: 'зомби',
        target: 'рассказчик',
        intent: 'aggressive',
        distress: 'clear',
        consequence: 'threatened_harm',
        duration: 'brief',
        repetition: 'repeated',
        highPriorityReason: undefined,
        parentSummary: 'Рассказчик слышит, как зомби скребутся и стучат по двери бункера.',
        mitigatingContext: 'Позже рассказчик говорит, что дверь выдержала.',
      }),
    }), 'bunker-peril', 'normal')

    const scene = buildPresentationScenes([nearbyDanger, strongerPeril])[0]!
    expect(scene.summary).toBe('Рассказчик слышит, как зомби скребутся и стучат по двери бункера.')
    expect(scene.mitigatingContext).toBe('Позже рассказчик говорит, что дверь выдержала.')
  })

  it('keeps unreviewed fictional moderate threats in details unless direct facts are hard-risk', () => {
    const unreviewedCloneThreat = applyContentPolicy(violence('violent_threat', {
      sceneId: 'clone-threat',
      severity: 'medium',
      context: 'game',
      assertionStatus: 'actual',
      text: 'Вы больше никогда не покинете деревню.',
      reason: 'Клон говорит, что жители больше никогда не покинут деревню.',
      details: {
        harmLevel: 'threatened',
        targetType: 'human_like_character',
        weaponRole: 'none',
        actionPurpose: 'threat',
      },
      review: review({
        status: 'not_reviewed',
        recommendedParentRelevance: 'low',
        evidenceSufficiency: 'insufficient',
        contextRanges: [],
        actor: undefined,
        target: undefined,
        aggressionDirection: 'unclear',
        intent: 'unclear',
        distress: 'unclear',
        consequence: 'unclear',
        duration: 'unclear',
        repetition: 'unclear',
        narrativeFraming: 'unclear',
        parentSummary: undefined,
        mitigatingContext: undefined,
        highPriorityReason: undefined,
        rationale: 'Contextual review omitted this candidate.',
      }),
    }), 'clone-unreviewed', 'normal')

    const unreviewedWeaponAttack = applyContentPolicy(violence('physical_attack', {
      sceneId: 'weapon-attack',
      severity: 'medium',
      context: 'game',
      assertionStatus: 'actual',
      startMs: 200_000,
      endMs: 205_000,
      sceneStartMs: 200_000,
      sceneEndMs: 205_000,
      details: {
        harmLevel: 'attempted',
        targetType: 'human_like_character',
        weaponRole: 'threatened_use',
        actionPurpose: 'attack',
      },
      review: review({
        status: 'not_reviewed',
        recommendedParentRelevance: 'low',
        evidenceSufficiency: 'insufficient',
        contextRanges: [],
        actor: undefined,
        target: undefined,
        aggressionDirection: 'unclear',
        intent: 'unclear',
        distress: 'unclear',
        consequence: 'unclear',
        duration: 'unclear',
        repetition: 'unclear',
        narrativeFraming: 'unclear',
        parentSummary: undefined,
        mitigatingContext: undefined,
        highPriorityReason: undefined,
        rationale: 'Contextual review omitted this candidate.',
      }),
    }), 'weapon-unreviewed', 'normal')

    expect(unreviewedCloneThreat.parentRelevance).toBe('moderate')
    expect(buildPresentationScenes([unreviewedCloneThreat])[0]?.attention).toBe('details')
    expect(buildPresentationScenes([unreviewedWeaponAttack])[0]?.attention).toBe('main')
  })

})
