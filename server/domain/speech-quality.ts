import type {
  ChannelSpeechQualitySummary,
  SpeechQualityExample,
  SpeechQualityMarkerCount,
  SpeechQualityMetrics,
  SpeechPatternFrequency,
  SpeechQualityInterpretation,
} from '../../shared/types/check'
import type { NormalizedTranscript } from './normalize-transcript'

const RU_FILLERS = [
  { marker: 'ну', regex: /(^|[^\p{L}\p{N}])ну(?=$|[^\p{L}\p{N}])/giu },
  { marker: 'короче', regex: /(^|[^\p{L}\p{N}])короче(?=$|[^\p{L}\p{N}])/giu },
  { marker: 'типа', regex: /(^|[^\p{L}\p{N}])типа(?=$|[^\p{L}\p{N}])/giu },
  { marker: 'как бы', regex: /(^|[^\p{L}\p{N}])как\s+бы(?=$|[^\p{L}\p{N}])/giu },
  { marker: 'значит', regex: /(^|[^\p{L}\p{N}])значит(?=$|[^\p{L}\p{N}])/giu },
  { marker: 'э/ээ', regex: /(^|[^\p{L}\p{N}])э+(?=$|[^\p{L}\p{N}])/giu },
  { marker: 'эм', regex: /(^|[^\p{L}\p{N}])эм(?=$|[^\p{L}\p{N}])/giu },
] as const

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function frequencyBand(ratePer1000: number): SpeechPatternFrequency {
  if (ratePer1000 <= 0) return 'none'
  if (ratePer1000 < 5) return 'occasional'
  if (ratePer1000 < 15) return 'noticeable'
  return 'frequent'
}

function frequencyText(level: SpeechPatternFrequency): string {
  if (level === 'frequent') return 'часто'
  if (level === 'noticeable') return 'заметно'
  if (level === 'occasional') return 'редко'
  return 'не обнаружены'
}

function everyWords(totalWords: number, count: number): number | undefined {
  if (!totalWords || !count) return undefined
  return Math.max(1, Math.round(totalWords / count))
}

function interpretation(
  totalWords: number,
  fillerWordCount: number,
  fillersPer1000Words: number,
  repeatedWordCount: number,
  repeatedWordsPer1000Words: number,
  options: { fillersSupported: boolean; asrVideos: number; analyzedVideos: number },
): SpeechQualityInterpretation {
  const fillerFrequency = options.fillersSupported ? frequencyBand(fillersPer1000Words) : 'none'
  const repetitionFrequency = frequencyBand(repeatedWordsPer1000Words)
  const fillerEveryWords = options.fillersSupported ? everyWords(totalWords, fillerWordCount) : undefined
  const repetitionEveryWords = everyWords(totalWords, repeatedWordCount)

  const fillerSummary = options.fillersSupported
    ? fillerWordCount > 0
      ? `Речевые маркеры вроде «ну», «короче», «э/ээ» встречаются ${frequencyText(fillerFrequency)} — примерно 1 раз на ${fillerEveryWords} слов.`
      : 'Речевые маркеры из поддерживаемого списка не обнаружены.'
    : 'Для этого языка речевые маркеры пока не оцениваются.'

  const repetitionPrefix = options.asrVideos > 0 && options.asrVideos === options.analyzedVideos
    ? 'В автоматических субтитрах повторы слов подряд встречаются'
    : 'Повторы слов подряд встречаются'
  const repetitionSummary = repeatedWordCount > 0
    ? `${repetitionPrefix} ${frequencyText(repetitionFrequency)} — примерно 1 раз на ${repetitionEveryWords} слов.`
    : 'Повторы слов подряд не обнаружены.'

  const asrNote = options.asrVideos > 0
    ? ` ${options.asrVideos === options.analyzedVideos ? 'Все' : `${options.asrVideos} из ${options.analyzedVideos}`} анализируемые субтитры auto-generated, поэтому ASR может добавлять ложные повторы или искажать отдельные слова.`
    : ''

  return {
    fillerFrequency,
    repetitionFrequency,
    fillerEveryWords,
    repetitionEveryWords,
    summary: `${fillerSummary} ${repetitionSummary}`,
    note: `Это эвристика речевых особенностей, а не оценка безопасности или «качества» автора. Градации «редко / заметно / часто» — внутренние ориентиры интерфейса, а не языковая норма. Маркеры считаются по форме слова: например, «ну» не в каждом контексте является словом-паразитом.${asrNote}`,
  }
}

function baseLanguage(language: string): string {
  return language.toLowerCase().replace(/^asr-/, '').split(/[-_]/)[0] ?? ''
}

function words(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

function countMatches(text: string, regex: RegExp): number {
  regex.lastIndex = 0
  return Array.from(text.matchAll(regex)).length
}

function repeatedWordCount(text: string): number {
  const tokens = words(text)
  let count = 0
  for (let index = 1; index < tokens.length; index += 1) {
    if (tokens[index] === tokens[index - 1]) count += 1
  }
  return count
}

export function analyzeSpeechQuality(
  transcript: NormalizedTranscript,
  language: string,
): SpeechQualityMetrics {
  const totalWords = words(transcript.sourceText).length
  const russian = baseLanguage(language) === 'ru'
  const fillerBreakdown: SpeechQualityMarkerCount[] = []
  const examples: SpeechQualityExample[] = []
  let fillerWordCount = 0

  if (russian) {
    for (const filler of RU_FILLERS) {
      const count = countMatches(transcript.sourceText, filler.regex)
      if (count > 0) fillerBreakdown.push({ marker: filler.marker, count })
      fillerWordCount += count
    }

    for (const segment of transcript.segments) {
      if (examples.length >= 8) break
      for (const filler of RU_FILLERS) {
        if (countMatches(segment.text, filler.regex) === 0) continue
        examples.push({
          marker: filler.marker,
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
        })
        if (examples.length >= 8) break
      }
    }
  }

  const repeatedWords = repeatedWordCount(transcript.sourceText)
  const fillersPer1000Words = totalWords ? round((fillerWordCount / totalWords) * 1000) : 0
  const repeatedWordsPer1000Words = totalWords ? round((repeatedWords / totalWords) * 1000) : 0
  return {
    method: russian ? 'heuristic_ru_v1' : 'repetition_only_v1',
    language: language || 'unknown',
    totalWords,
    fillerWordCount,
    fillersPer1000Words,
    repeatedWordCount: repeatedWords,
    repeatedWordsPer1000Words,
    fillerBreakdown: fillerBreakdown.sort((a, b) => b.count - a.count || a.marker.localeCompare(b.marker)),
    examples,
    interpretation: interpretation(
      totalWords,
      fillerWordCount,
      fillersPer1000Words,
      repeatedWords,
      repeatedWordsPer1000Words,
      {
        fillersSupported: russian,
        asrVideos: language.toLowerCase().startsWith('asr-') ? 1 : 0,
        analyzedVideos: 1,
      },
    ),
  }
}

export function summarizeSpeechQuality(items: SpeechQualityMetrics[]): ChannelSpeechQualitySummary {
  const totalWords = items.reduce((sum, item) => sum + item.totalWords, 0)
  const fillerWordCount = items.reduce((sum, item) => sum + item.fillerWordCount, 0)
  const repeatedWordCount = items.reduce((sum, item) => sum + item.repeatedWordCount, 0)
  const byMarker = new Map<string, number>()

  for (const item of items) {
    for (const entry of item.fillerBreakdown) {
      byMarker.set(entry.marker, (byMarker.get(entry.marker) ?? 0) + entry.count)
    }
  }

  const fillersPer1000Words = totalWords ? round((fillerWordCount / totalWords) * 1000) : 0
  const repeatedWordsPer1000Words = totalWords ? round((repeatedWordCount / totalWords) * 1000) : 0
  const analyzedVideos = items.length
  const asrVideos = items.filter((item) => item.language.toLowerCase().startsWith('asr-')).length
  const fillersSupported = items.some((item) => item.method === 'heuristic_ru_v1')

  return {
    totalWords,
    fillerWordCount,
    fillersPer1000Words,
    repeatedWordCount,
    repeatedWordsPer1000Words,
    fillerBreakdown: [...byMarker.entries()]
      .map(([marker, count]) => ({ marker, count }))
      .sort((a, b) => b.count - a.count || a.marker.localeCompare(b.marker)),
    analyzedVideos,
    asrVideos,
    interpretation: interpretation(
      totalWords,
      fillerWordCount,
      fillersPer1000Words,
      repeatedWordCount,
      repeatedWordsPer1000Words,
      { fillersSupported, asrVideos, analyzedVideos },
    ),
  }
}
