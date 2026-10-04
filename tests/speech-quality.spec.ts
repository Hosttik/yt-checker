import { describe, expect, it } from 'vitest'
import { normalizeTranscript } from '../server/domain/normalize-transcript'
import { analyzeSpeechQuality, summarizeSpeechQuality } from '../server/domain/speech-quality'

function transcript(lines: string[]) {
  return normalizeTranscript(lines.map((text, index) => ({
    text,
    startMs: index * 1000,
    endMs: index * 1000 + 900,
  })))
}

describe('speech quality metrics', () => {
  it('counts Russian filler markers and immediate repetitions locally', () => {
    const result = analyzeSpeechQuality(transcript([
      'Ну ну, короче, это типа тест.',
      'Эээ, как бы, значит, продолжаем.',
    ]), 'asr-ru')

    expect(result.method).toBe('heuristic_ru_v1')
    expect(result.fillerWordCount).toBeGreaterThanOrEqual(7)
    expect(result.repeatedWordCount).toBe(1)
    expect(result.fillerBreakdown).toEqual(expect.arrayContaining([
      { marker: 'ну', count: 2 },
      { marker: 'короче', count: 1 },
      { marker: 'типа', count: 1 },
      { marker: 'как бы', count: 1 },
      { marker: 'значит', count: 1 },
      { marker: 'э/ээ', count: 1 },
    ]))
    expect(result.examples.length).toBeGreaterThan(0)
  })

  it('does not classify Russian-specific fillers for unsupported languages', () => {
    const result = analyzeSpeechQuality(transcript(['ну ну test test']), 'en')
    expect(result.method).toBe('repetition_only_v1')
    expect(result.fillerWordCount).toBe(0)
    expect(result.repeatedWordCount).toBe(2)
  })

  it('aggregates channel-level rates from video metrics', () => {
    const one = analyzeSpeechQuality(transcript(['Ну ну тест']), 'ru')
    const two = analyzeSpeechQuality(transcript(['Короче тест тест']), 'ru')
    const result = summarizeSpeechQuality([one, two])
    expect(result.totalWords).toBe(6)
    expect(result.fillerWordCount).toBe(3)
    expect(result.repeatedWordCount).toBe(2)
    expect(result.fillersPer1000Words).toBe(500)
  })
})
