import { describe, expect, it } from 'vitest'
import type { ContentEvent } from '../shared/types/content'
import {
  buildChannelCategoryReports,
  buildPresentationScenes,
  buildVideoCategoryReports,
} from '../server/domain/content-reporting'

type ViolenceEvent = Extract<ContentEvent, { category: 'violence' }>

function violenceEvent(overrides: Partial<ViolenceEvent> = {}): ViolenceEvent {
  return {
    id: 'event-visible',
    sourceCandidateId: 'candidate-visible',
    sceneId: 'scene-visible',
    category: 'violence',
    subtype: 'weapon_use',
    severity: 'low',
    context: 'game',
    confidence: 0.98,
    startMs: 1_000,
    endMs: 2_000,
    text: 'Стреляю по мишени.',
    reason: 'Персонаж использует оружие без причинения вреда цели.',
    evidenceStrength: 'explicit',
    evidenceSource: 'transcript',
    engagementLevel: 'participation',
    portrayal: 'neutral',
    explicitness: 'mild',
    assertionStatus: 'actual',
    details: {
      harmLevel: 'none',
      targetType: 'object',
      weaponRole: 'used',
      actionPurpose: 'sport',
    },
    parentRelevance: 'low',
    displayLevel: 'summary',
    ...overrides,
  }
}

describe('content reporting', () => {
  it('does not let a hidden finding raise or leak into the visible category report', () => {
    const visible = violenceEvent()
    const hidden = violenceEvent({
      id: 'event-hidden',
      sourceCandidateId: 'candidate-hidden',
      sceneId: 'scene-hidden',
      subtype: 'dangerous_situation',
      context: 'real_world',
      confidence: 0.4,
      startMs: 3_000,
      endMs: 4_000,
      text: 'Опасная ситуация.',
      reason: 'Слабый контекст возможной опасности.',
      evidenceStrength: 'weak_context',
      details: {
        harmLevel: 'implied',
        targetType: 'person',
        weaponRole: 'none',
        actionPurpose: 'unknown',
      },
      parentRelevance: 'moderate',
      displayLevel: 'hidden',
    })

    const videoReport = buildVideoCategoryReports([visible, hidden], ['violence'])[0]!
    expect(videoReport.level).toBe('low')
    expect(videoReport.label).toBe('Игровое насилие и опасные сцены')
    expect(videoReport.summary).toContain('использование оружия')
    expect(videoReport.summary).not.toContain('опасные ситуации')

    const channelReport = buildChannelCategoryReports(
      [{ videoId: 'video-1', events: [visible, hidden] }],
      ['violence'],
      1,
      'normal',
    )[0]!

    expect(channelReport.level).toBe('low')
    expect(channelReport.label).toBe('Игровое насилие и опасные сцены')
    expect(channelReport.summary).toContain('использование оружия')
    expect(channelReport.summary).not.toContain('опасные ситуации')
  })

  it('splits reused scene ids when events are far apart in time', () => {
    const early = violenceEvent({
      id: 'early',
      sceneId: 'thread-1',
      startMs: 75_000,
      endMs: 90_000,
    })
    const late = violenceEvent({
      id: 'late',
      sceneId: 'thread-1',
      startMs: 535_000,
      endMs: 579_000,
    })

    const scenes = buildPresentationScenes([early, late])
    expect(scenes).toHaveLength(2)
    expect(scenes[0]?.endMs).toBe(90_000)
    expect(scenes[1]?.startMs).toBe(535_000)
  })

  it('reports peak concern separately from prevalence', () => {
    const high = violenceEvent({
      parentRelevance: 'high',
      displayLevel: 'highlight',
      severity: 'high',
    })
    const report = buildChannelCategoryReports(
      [{ videoId: 'v1', events: [high] }, ...Array.from({ length: 9 }, (_, i) => ({ videoId: `v${i + 2}`, events: [] }))],
      ['violence'],
      10,
      'normal',
    )[0]!

    expect(report.peakConcern).toBe('high')
    expect(report.prevalence).toBe('rare')
    expect(report.affectedRatio).toBe(0.1)
  })
  it('merges overlapping narrative scenes even when the model used different scene ids', () => {
    const first = violenceEvent({
      id: 'scene-a-event',
      sceneId: 'scene-a',
      startMs: 400_000,
      endMs: 405_000,
      sceneStartMs: 357_000,
      sceneEndMs: 453_000,
    })
    const second = violenceEvent({
      id: 'scene-b-event',
      sceneId: 'scene-b',
      startMs: 500_000,
      endMs: 505_000,
      sceneStartMs: 403_000,
      sceneEndMs: 561_000,
    })

    const scenes = buildPresentationScenes([first, second])
    expect(scenes).toHaveLength(1)
    expect(scenes[0]?.events).toHaveLength(2)
    expect(scenes[0]?.evidenceRanges).toEqual([
      { startMs: 400_000, endMs: 405_000 },
      { startMs: 500_000, endMs: 505_000 },
    ])
  })

  it('keeps presentation timestamps focused on compact evidence rather than the whole scene', () => {
    const event = violenceEvent({
      startMs: 200_000,
      endMs: 205_000,
      sceneStartMs: 180_000,
      sceneEndMs: 360_000,
    })

    const scene = buildPresentationScenes([event])[0]!
    expect(scene.startMs).toBe(200_000)
    expect(scene.endMs).toBe(205_000)
    expect(scene.evidenceRanges).toEqual([{ startMs: 200_000, endMs: 205_000 }])
  })

  it('preserves sparse evidence ranges instead of expanding them to the whole envelope', () => {
    const event = violenceEvent({
      startMs: 10_000,
      endMs: 80_000,
      evidenceRanges: [
        { startMs: 10_000, endMs: 12_000 },
        { startMs: 30_000, endMs: 34_000 },
        { startMs: 78_000, endMs: 80_000 },
      ],
    })

    const scene = buildPresentationScenes([event])[0]!
    expect(scene.evidenceRanges).toEqual([
      { startMs: 10_000, endMs: 12_000 },
      { startMs: 30_000, endMs: 34_000 },
      { startMs: 78_000, endMs: 80_000 },
    ])
  })

  it('splits one oversized model scene when displayed evidence is far apart', () => {
    const early = violenceEvent({
      id: 'train-early',
      sceneId: 'train-thread',
      startMs: 75_000,
      endMs: 127_000,
      evidenceRanges: [{ startMs: 75_000, endMs: 127_000 }],
      sceneStartMs: 75_000,
      sceneEndMs: 579_000,
    })
    const late = violenceEvent({
      id: 'train-late',
      sceneId: 'train-thread',
      startMs: 290_000,
      endMs: 306_000,
      evidenceRanges: [{ startMs: 290_000, endMs: 306_000 }],
      sceneStartMs: 75_000,
      sceneEndMs: 579_000,
    })

    const scenes = buildPresentationScenes([early, late])
    expect(scenes).toHaveLength(2)
    expect(scenes[0]?.evidenceRanges).toEqual([{ startMs: 75_000, endMs: 127_000 }])
    expect(scenes[1]?.evidenceRanges).toEqual([{ startMs: 290_000, endMs: 306_000 }])
  })

  it('limits a scene summary to the strongest non-duplicate reasons', () => {
    const first = violenceEvent({
      id: 'summary-1',
      parentRelevance: 'high',
      displayLevel: 'highlight',
      reason: 'Чёрная дыра затягивает персонажей; они пытаются спастись.',
    })
    const second = violenceEvent({
      id: 'summary-2',
      reason: 'Чёрная дыра затягивает персонажей и создаёт непосредственную опасность.',
    })
    const third = violenceEvent({
      id: 'summary-3',
      subtype: 'destruction',
      reason: 'Чёрная дыра разрушает дома и поглощает деревню.',
    })

    const scene = buildPresentationScenes([first, second, third])[0]!
    expect(scene.summary.split('.').filter(Boolean).length).toBeLessThanOrEqual(2)
  })

})
