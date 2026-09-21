import { describe, expect, it } from 'vitest'
import { resolveChannelRef } from '../server/domain/channel-ref'

describe('resolveChannelRef', () => {
  it('resolves a handle', () => {
    expect(resolveChannelRef('@GoogleDevelopers')).toEqual({
      kind: 'handle',
      value: '@GoogleDevelopers',
    })
  })

  it('resolves a handle URL', () => {
    expect(resolveChannelRef('https://www.youtube.com/@GoogleDevelopers/videos')).toEqual({
      kind: 'handle',
      value: '@GoogleDevelopers',
    })
  })

  it('resolves a channel ID URL', () => {
    expect(resolveChannelRef('https://youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw')).toEqual({
      kind: 'id',
      value: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
    })
  })

  it('rejects non-YouTube URLs', () => {
    expect(() => resolveChannelRef('https://example.com/@test')).toThrow(/youtube\.com/i)
  })
})
