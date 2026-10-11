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
const DIRECTED_DANGER = /(?:набр[ао]с[\p{L}]*|напад[\p{L}]*|цел[\p{L}]*|стреля[\p{L}]*|стрельб[\p{L}]*|загнал[\p{L}]*|преслед[\p{L}]*|кида[\p{L}]*|броса[\p{L}]*|бей\b|уби[\p{L}]*|помогит[\p{L}]*|спасит[\p{L}]*|остановит[\p{L}]*|тупик[\p{L}]*|aim\w*|shoot\w*|attack\w*|chase\w*|kill\w*)/iu
const IMMEDIATE_DISTRESS = /(?:помогит\w*|спасит\w*|загнал\w*|в\s+тупик|в\s+меня\s+не\s+цел|остановит\w*|сейчас\s+убь\w*|help\s+me|stop\s+(?:shooting|aiming))/iu
const RESTRAINT = /(?:привяз[\p{L}]*|связал[\p{L}]*|прикован[\p{L}]*|приковал[\p{L}]*|tied|bound|chained)/iu
// The transcript may say "please stop aiming at me" without naming a gun.
// Require BOTH a specific directed request and nearby coercive speech;
// words such as "aim" or "gun" on their own are not safety findings.
const DIRECTED_AIM_REQUEST = /(?:в\s+меня\s+(?:не\s+)?цел[\p{L}]*|(?:не\s+)?цел[\p{L}]*\s+в\s+меня|(?:don't|stop|please\s+don't)\s+(?:aim|point)\s+(?:it\s+)?at\s+me)/iu
const COERCIVE_SPEECH = /(?:встал[,\s]+я\s+сказал|я\s+сказал[:\s]+вставай|вставай[,;\s]+кто\s+ты|быстро\s+говори|на\s+кого\s+ты\s+работаешь|кто\s+твоя\s+жертва|руки\s+вверх|подними\s+руки|hands\s+up|tell\s+me\s+now|who\s+are\s+you)/iu
const TRAIN = /(?:поезд\w*|рельс\w*|train|tracks)/iu

interface CueMatch {
  index: number
  score: number
  cue: UncoveredRiskWindow['cue']
}

const MAX_COHERENT_SCENE_MS = 150_000
const EVIDENCE_PADDING_MS = 20_000

/**
 * A direct high-risk event may have sparse evidence across a continuous scene.
 * Using evidenceRanges alone incorrectly triggers recall on the closing line
 * of that *same* armed pursuit. Conversely, a generic death/fear event cannot
 * certify that an unrelated weapon threat has been examined.
 */
function relevantSafetyEvent(
  event: ClassifiedContentEvent,
  cue: UncoveredRiskWindow['cue'],
): boolean {
  if (cue === 'helpless_rail_danger') {
    return (event.category === 'violence' && (
      event.subtype === 'life_threatening_situation'
      || event.subtype === 'violent_threat'
      || event.subtype === 'dangerous_situation'
    )) || (event.category === 'scary_and_disturbing'
      && (event.subtype === 'confinement' || event.subtype === 'intense_peril'))
  }
  return event.category === 'violence'
    && (event.subtype === 'violent_threat'
      || event.subtype === 'physical_attack'
      || event.subtype === 'weapon_use'
      || event.subtype === 'dangerous_situation')
    && (event.details.weaponRole === 'used'
      || event.details.weaponRole === 'threatened_use'
      || (event.subtype === 'violent_threat' && event.details.actionPurpose === 'threat'))
}

export function riskAlreadyRepresented(
  atMs: number,
  events: ClassifiedContentEvent[],
  cue: UncoveredRiskWindow['cue'],
): boolean {
  return events.some(event => {
    if (!relevantSafetyEvent(event, cue)) return false
    const startMs = event.sceneStartMs ?? event.startMs
    const endMs = event.sceneEndMs ?? event.endMs
    if (endMs >= startMs && endMs - startMs <= MAX_COHERENT_SCENE_MS
      && atMs >= startMs - EVIDENCE_PADDING_MS
      && atMs <= endMs + EVIDENCE_PADDING_MS) return true
    const ranges = event.evidenceRanges?.length ? event.evidenceRanges : [event]
    return ranges.some(range =>
      atMs >= range.startMs - EVIDENCE_PADDING_MS
      && atMs <= range.endMs + EVIDENCE_PADDING_MS)
  })
}

/** Suppress follow-up mentions of an already classified danger story, but
 * preserve independently evidenced *actual* attacks or injuries. */
export function isDuplicateRiskRecall(
  event: ClassifiedContentEvent,
  primaryEvents: ClassifiedContentEvent[],
  cue: UncoveredRiskWindow['cue'],
): boolean {
  if (event.assertionStatus === 'actual'
    && event.category === 'violence'
    && (event.subtype === 'physical_attack' || event.subtype === 'injury')) {
    return false
  }
  const ranges = event.evidenceRanges?.length ? event.evidenceRanges : [event]
  return ranges.every(range => riskAlreadyRepresented(range.startMs, primaryEvents, cue))
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
    const impliedAimedThreat = DIRECTED_AIM_REQUEST.test(excerpt) && COERCIVE_SPEECH.test(excerpt)
    if (!railDanger && !impliedAimedThreat && !(hasWeapon && hasDirectedDanger)) continue
    const cue: UncoveredRiskWindow['cue'] = railDanger ? 'helpless_rail_danger' : 'directed_weapon_danger'
    if (riskAlreadyRepresented(segments[i]!.startMs, events, cue)) continue

    const distress = IMMEDIATE_DISTRESS.test(excerpt)
    matches.push({
      index: i,
      score: (impliedAimedThreat ? 9 : railDanger ? 5 : 2) + (distress ? 3 : 0),
      cue,
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
