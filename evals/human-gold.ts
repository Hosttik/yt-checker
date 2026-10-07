import { createHash } from 'node:crypto'
import { z } from 'zod'
import tuningExposure from './tuning-exposure.json'
import { CONTENT_CATEGORIES, type PresentationScene } from '../shared/types/content'
import type { NormalizedTranscript } from '../server/domain/normalize-transcript'

const labelSchema = z.object({
  id: z.string().min(1),
  categories: z.array(z.enum(CONTENT_CATEGORIES)).min(1),
  evidence: z.array(z.object({ firstSegment: z.number().int().nonnegative(), lastSegment: z.number().int().nonnegative() })).min(1),
  priority: z.enum(['hidden', 'details', 'main']),
  level: z.enum(['hidden', 'low', 'moderate', 'high']),
  rationale: z.string().trim().min(1),
}).strict().superRefine((label, ctx) => {
  if ((label.priority === 'hidden') !== (label.level === 'hidden')
    || (label.priority === 'main' && label.level === 'low')) ctx.addIssue({ code: 'custom', message: 'Inconsistent priority and level.' })
})
export const humanGoldSchema = z.object({
  version: z.literal(1),
  videos: z.array(z.object({
    videoId: z.string().min(1), channelId: z.string().min(1),
    transcriptHash: z.string().regex(/^[a-f0-9]{64}$/),
    split: z.enum(['tuning', 'holdout']),
    previouslyUsedForTuning: z.boolean(),
    complete: z.boolean(),
    reviewerId: z.string().nullable(), reviewedAt: z.string().datetime().nullable(),
    blindedToModelOutput: z.boolean().nullable(),
    reviewedEntireTranscript: z.boolean().nullable(),
    labels: z.array(labelSchema),
  }).strict()),
}).strict()
export type HumanGold = z.infer<typeof humanGoldSchema>
export function transcriptFingerprint(transcript: NormalizedTranscript): string {
  return createHash('sha256').update(JSON.stringify(transcript.segments)).digest('hex')
}

export function validateHumanGold(raw: unknown, sources: Map<string, NormalizedTranscript>): HumanGold {
  const gold = humanGoldSchema.parse(raw)
  const ids = new Set<string>()
  for (const video of gold.videos) {
    if (ids.has(video.videoId)) throw new Error(`Duplicate gold video: ${video.videoId}`)
    ids.add(video.videoId)
    const transcript = sources.get(video.videoId)
    if (!transcript || transcriptFingerprint(transcript) !== video.transcriptHash) throw new Error(`Gold transcript/timeline mismatch: ${video.videoId}`)
    if (video.split === 'holdout' && (video.previouslyUsedForTuning
      || tuningExposure.videoIds.includes(video.videoId) || tuningExposure.channelIds.includes(video.channelId))) throw new Error(`Tuning video cannot be holdout: ${video.videoId}`)
    if (video.complete && (!video.reviewerId?.trim() || !video.reviewedAt
      || video.blindedToModelOutput !== true || video.reviewedEntireTranscript !== true)) {
      throw new Error(`Complete gold requires named human review of the entire transcript, blind to model output: ${video.videoId}`)
    }
    const labelIds = new Set<string>()
    for (const label of video.labels) {
      if (labelIds.has(label.id)) throw new Error(`Duplicate label: ${label.id}`)
      labelIds.add(label.id)
      for (const range of label.evidence) {
        if (range.firstSegment > range.lastSegment || range.lastSegment >= transcript.segments.length) {
          throw new Error(`Invalid gold evidence range: ${video.videoId}/${label.id}`)
        }
      }
    }
  }
  return gold
}

// Maximum one-to-one matching: duplicated cards must not all earn credit for one scene.
function matchCards(cards: PresentationScene[], labels: HumanGold['videos'][number]['labels'], transcript: NormalizedTranscript) {
  const matches = new Map<number, number>()
  const eligible = (card: PresentationScene, label: typeof labels[number]) => card.events.some(event =>
    label.categories.includes(event.category) && label.evidence.some(range => {
      const start = transcript.segments[range.firstSegment]!.startMs
      const end = transcript.segments[range.lastSegment]!.endMs
      return (event.evidenceRanges?.length ? event.evidenceRanges : [event]).some(evidence =>
        Math.min(end, evidence.endMs) - Math.max(start, evidence.startMs) > 0)
    }))
  function assign(cardIndex: number, seen: Set<number>): boolean {
    for (let labelIndex = 0; labelIndex < labels.length; labelIndex++) {
      if (seen.has(labelIndex) || !eligible(cards[cardIndex]!, labels[labelIndex]!)) continue
      seen.add(labelIndex)
      const previous = matches.get(labelIndex)
      if (previous === undefined || assign(previous, seen)) {
        matches.set(labelIndex, cardIndex)
        return true
      }
    }
    return false
  }
  cards.forEach((_, index) => assign(index, new Set()))
  return matches
}

export function auditHumanGold(
  raw: unknown, sources: Map<string, NormalizedTranscript>, scenesByVideo: Map<string, PresentationScene[]>,
  split: 'tuning' | 'holdout',
) {
  const gold = validateHumanGold(raw, sources)
  const videos = gold.videos.filter(video => video.complete && video.split === split && scenesByVideo.has(video.videoId))
  let mainCards = 0, expectedMainScenes = 0, matchedMainCards = 0, excessiveHighCards = 0
  let visibleCards = 0, matchedVisibleCards = 0
  const perVideo = videos.map(video => {
    const transcript = sources.get(video.videoId)!
    const cards = scenesByVideo.get(video.videoId)!
    const main = cards.filter(card => card.attention === 'main')
    const mainLabels = video.labels.filter(label => label.priority === 'main')
    const matches = matchCards(main, mainLabels, transcript)
    const visibleMatches = matchCards(cards, video.labels.filter(label => label.priority !== 'hidden'), transcript)
    const excessive = [...matches].filter(([label, card]) => main[card]!.level === 'high' && mainLabels[label]!.level !== 'high').length
    mainCards += main.length; expectedMainScenes += mainLabels.length; matchedMainCards += matches.size
    visibleCards += cards.length; matchedVisibleCards += visibleMatches.size; excessiveHighCards += excessive
    return { videoId: video.videoId, mainCards: main.length, expectedMainScenes: mainLabels.length,
      matchedMainCards: matches.size, unmatchedMainCards: main.length - matches.size, missedMainScenes: mainLabels.length - matches.size,
      excessiveHighCards: excessive }
  })
  return {
    split, evaluatedVideos: videos.length, channels: new Set(videos.map(v => v.channelId)).size,
    pendingVideos: gold.videos.filter(v => !v.complete && v.split === split).length,
    mainCards, expectedMainScenes, matchedMainCards,
    unmatchedMainCards: mainCards - matchedMainCards, missedMainScenes: expectedMainScenes - matchedMainCards,
    candidateMainPrecision: mainCards ? matchedMainCards / mainCards : null,
    candidateMainRecall: expectedMainScenes ? matchedMainCards / expectedMainScenes : null,
    candidateVisiblePrecision: visibleCards ? matchedVisibleCards / visibleCards : null,
    excessiveHighCards, perVideo,
    matchingMethod: 'One-to-one category and direct-evidence time overlap. Semantic correctness of summaries requires separate human card adjudication.',
  }
}
