import { describe, expect, it } from 'vitest'
import type { ContentEvent } from '../shared/types/content'
import {
  buildChannelCategoryReports,
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
})
