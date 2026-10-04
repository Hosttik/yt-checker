import { describe, expect, it } from 'vitest'
import type {
  ClassifiedContentEvent,
  ContentEventReview,
} from '../shared/types/content'
import { applyContentPolicy } from '../server/domain/content-policy'
import { buildPresentationScenes } from '../server/domain/content-reporting'

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
})
