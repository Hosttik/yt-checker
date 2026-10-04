import { describe, expect, it } from 'vitest'
import { normalizeTranscript } from '../server/domain/normalize-transcript'

describe('normalizeTranscript', () => {
  it('preserves repeated speech without temporal overlap and literal music words', () => {
    const result = normalizeTranscript([
      { text: 'Нет', startMs: 0, endMs: 1000 },
      { text: 'Нет', startMs: 1000, endMs: 2000 },
      { text: 'музыка', startMs: 3000, endMs: 4000 },
    ])
    expect(result.sourceText).toBe('Нет Нет музыка')
  })

  it('does not remove a word merely contained inside another word', () => {
    expect(normalizeTranscript([
      { text: 'автомат', startMs: 0, endMs: 2000 },
      { text: 'мат', startMs: 1000, endMs: 3000 },
    ]).sourceText).toBe('автомат мат')
  })
  it('uses compact segment ids, removes music/empty captions, and deduplicates overlaps', () => {
    const result = normalizeTranscript([
      { text: '  [музыка] ', startMs: 0, endMs: 100 },
      { text: 'Меня и моего друга заточили внутри', startMs: 199, endMs: 2_700 },
      { text: 'друга заточили внутри красного круга', startMs: 2_000, endMs: 4_000 },
      { text: 'красного круга посреди луны.', startMs: 3_500, endMs: 6_000 },
      { text: 'красного круга посреди луны.', startMs: 3_600, endMs: 6_100 },
      { text: ' ', startMs: 7_000, endMs: 8_000 },
    ])
    expect(result.text).toBe([
      '[0] Меня и моего друга заточили внутри',
      '[1] красного круга',
      '[2] посреди луны.',
    ].join('\n'))
    expect(result.sourceText).toBe('Меня и моего друга заточили внутри красного круга посреди луны.')
  })

  it('keeps laughter and does not rewrite meaning', () => {
    expect(normalizeTranscript([
      { text: '[смех] Ты сдурел?', startMs: 122_000, endMs: 124_000 },
    ]).text).toContain('[смех] Ты сдурел?')
  })
})
