import type { ClassifiedContentEvent } from '../../shared/types/content'
import type { NormalizedTranscript } from './normalize-transcript'

export interface UncoveredRiskWindow {
  startMs: number
  endMs: number
  transcriptText: string
  /** Why the deterministic first-pass recall gate was activated. */
  cue: 'directed_weapon_danger' | 'helpless_rail_danger'
  priority: number
}

// Intentionally narrow and cheap. A match is NOT a content finding: it only
// routes a short excerpt through the existing classifier and reviewer.
// JavaScript \b/\w word-boundaries are ASCII-oriented: for Cyrillic use Unicode letters.
const WEAPON = /(?:^|[^\p{L}])(?:вил[аыи]|вилами|копь(?:я|ё|е|ями)|пистолет[\p{L}]*|ружь[\p{L}]*|нож[\p{L}]*|оружи[\p{L}]*|автомат[\p{L}]*|gun|knife|rifle|weapon)(?![\p{L}])/iu
const DIRECTED_DANGER = /(?:набр[ао]с\w*|напад\w*|цел\w*|стреля\w*|стрельб\w*|загнал\w*|преслед\w*|кида\w*|броса\w*|бей\b|уби\w*|помогит\w*|спасит\w*|остановит\w*|тупик\w*|aim\w*|shoot\w*|attack\w*|chase\w*|kill\w*)/iu
const IMMEDIATE_DISTRESS = /(?:помогит\w*|спасит\w*|загнал\w*|в\s+тупик|в\s+меня\s+не\s+цел|остановит\w*|сейчас\s+убь\w*|help\s+me|stop\s+(?:shooting|aiming))/iu
const RESTRAINT = /(?:привяз\w*|связал\w*|прикован\w*|приковал\w*|tied|bound|chained)/iu
const TRAIN = /(?:поезд\w*|рельс\w*|train|tracks)/iu

interface CueMatch {
  index: number
  score: number
  cue: UncoveredRiskWindow['cue']
}

function riskCovered(
  atMs: number,
  events: ClassifiedContentEvent[],
): boolean {
  return events.some((event) => {
    if (event.category !== 'violence' && event.category !== 'scary_and_disturbing') return false
    const ranges = event.evidenceRanges?.length ? event.evidenceRanges : [event]
    return ranges.some((range) => atMs >= range.startMs - 20_000
      && atMs <= range.endMs + 20_000)
  })
}

/**
 * Detects short, concrete danger cues left outside all first-pass safety
 * evidence. Never creates a reportable event itself. Bound the number of
 * windows to limit provider cost on channels with repeated gameplay threats.
 */
export function uncoveredRiskWindows(
  transcript: NormalizedTranscript,
  events: ClassifiedContentEvent[],
  maxWindows = 1,
): UncoveredRiskWindow[] {
  if (maxWindows <= 0) return []
  const segments = transcript.segments
  const matches: CueMatch[] = []
  for (let i = 0; i < segments.length; i++) {
    const excerpt = segments.slice(Math.max(0, i - 2), Math.min(segments.length, i + 3))
      .map(segment => segment.text).join(' ')
    const hasWeapon = WEAPON.test(excerpt)
    const hasDirectedDanger = DIRECTED_DANGER.test(excerpt)
    const railDanger = RESTRAINT.test(excerpt) && TRAIN.test(excerpt)
    if (!railDanger && !(hasWeapon && hasDirectedDanger)) continue
    if (riskCovered(segments[i]!.startMs, events)) continue

    const distress = IMMEDIATE_DISTRESS.test(excerpt)
    matches.push({
      index: i,
      score: (railDanger ? 5 : 2) + (distress ? 3 : 0),
      cue: railDanger ? 'helpless_rail_danger' : 'directed_weapon_danger',
    })
  }

  // If a clip contains "get weapons" then "help, they cornered me", inspect
  // the direct danger rather than spending the only slot on early exposition.
  matches.sort((a, b) => b.score - a.score || b.index - a.index)
  const selected: UncoveredRiskWindow[] = []
  for (const candidate of matches) {
    const index = candidate.index
    const begin = Math.max(0, index - 9)
    const end = Math.min(segments.length, index + 14)
    const startMs = segments[begin]!.startMs
    const endMs = segments[end - 1]!.endMs
    if (selected.some(window =>
      startMs <= window.endMs + 20_000 && endMs >= window.startMs - 20_000)) continue
    selected.push({
      startMs,
      endMs,
      transcriptText: segments.slice(begin, end)
        .map((segment, offset) => `[${begin + offset}] ${segment.text}`)
        .join('\n'),
      cue: candidate.cue,
      priority: candidate.score,
    })
    if (selected.length >= maxWindows) break
  }
  return selected.sort((a, b) => a.startMs - b.startMs)
}
