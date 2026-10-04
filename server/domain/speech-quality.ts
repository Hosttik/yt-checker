import type {
  ChannelSpeechQualitySummary,
  SpeechQualityExample,
  SpeechQualityMarkerCount,
  SpeechQualityMetrics,
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
  return {
    method: russian ? 'heuristic_ru_v1' : 'repetition_only_v1',
    language: language || 'unknown',
    totalWords,
    fillerWordCount,
    fillersPer1000Words: totalWords ? round((fillerWordCount / totalWords) * 1000) : 0,
    repeatedWordCount: repeatedWords,
    repeatedWordsPer1000Words: totalWords ? round((repeatedWords / totalWords) * 1000) : 0,
    fillerBreakdown: fillerBreakdown.sort((a, b) => b.count - a.count || a.marker.localeCompare(b.marker)),
    examples,
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

  return {
    totalWords,
    fillerWordCount,
    fillersPer1000Words: totalWords ? round((fillerWordCount / totalWords) * 1000) : 0,
    repeatedWordCount,
    repeatedWordsPer1000Words: totalWords ? round((repeatedWordCount / totalWords) * 1000) : 0,
    fillerBreakdown: [...byMarker.entries()]
      .map(([marker, count]) => ({ marker, count }))
      .sort((a, b) => b.count - a.count || a.marker.localeCompare(b.marker)),
  }
}
