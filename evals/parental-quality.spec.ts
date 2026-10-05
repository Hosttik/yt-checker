import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AggregateOpenAIUsage } from '../shared/types/check'
import type {
  AnalysisProfile,
  ClassifiedContentEvent,
  ContentCategory,
  ContentEvent,
} from '../shared/types/content'
import { applyContentPolicy } from '../server/domain/content-policy'
import { normalizeClassifiedEvents } from '../server/domain/content-normalization'
import { buildPresentationScenes } from '../server/domain/content-reporting'
import { validateClassifiedEvents } from '../server/domain/content-validation'
import type { NormalizedTranscript } from '../server/domain/normalize-transcript'
import {
  OPENAI_PROMPT_VERSION,
  OPENAI_REVIEW_PROMPT_VERSION,
  OPENAI_REVIEW_SCHEMA_VERSION,
  OPENAI_SCHEMA_VERSION,
  OpenAIAnalysisProvider,
} from '../server/services/openai-analysis'

const RUN = process.env.RUN_PARENTAL_QUALITY_EVAL === '1'
const QUALITY_EVAL_VERSION = '2026-10-05.temporal-anchor-v2'
const ALL_CATEGORIES: ContentCategory[] = [
  'profanity_and_rude_language',
  'insults',
  'toilet_humor',
  'violence',
  'scary_and_disturbing',
  'sexual_content',
  'gambling',
  'substances',
  'self_harm',
]
const DEFAULT_SCAN_DIRS = [
  'scan-results/2026-10-04T17-30-28-729Z_c382e104-a47f-48cf-b223-75b76b2faf86',
  'scan-results/2026-10-04T17-59-39-308Z_6b4f06d4-0322-43e3-8eb0-6c0ce24185c8',
]

type Priority = 'hidden' | 'details' | 'main'
type ConcernLevel = 'hidden' | 'low' | 'moderate' | 'high'

const CONCERN_LEVEL_RANK: Record<ConcernLevel, number> = {
  hidden: 0,
  low: 1,
  moderate: 2,
  high: 3,
}

interface ManualCase {
  id: string
  annotationSource: 'provisional' | 'human_confirmed'
  split: 'tuning' | 'holdout'
  sourceVideo: string
  anchor: string
  categories: ContentCategory[]
  showToParent: boolean
  priority: Priority
  expectedLevel?: ConcernLevel
  why: string
  requiredEvidence: string[]
  forbiddenInterpretations: string[]
  forbiddenFindings: string[]
  /** Runtime-only resolved location of the literal anchor in the saved transcript. */
  anchorStartMs?: number
  anchorEndMs?: number
  anchorMatchScore?: number
}

interface DiagnosticEntry {
  videoId: string
  normalizedTranscript: string
  requestMetadata?: { enabledCategories?: ContentCategory[] }
  provider?: { latencyMs?: number }
  usage?: {
    inputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    cachedTokens?: number
    cacheWriteTokens?: number
    totalTokens?: number
  }
  parsedResult?: {
    normalizedContentEvents?: ContentEvent[]
    classifiedEvents?: ClassifiedContentEvent[]
  }
}

interface ScanResult {
  openaiUsage?: AggregateOpenAIUsage
}

interface ScanRecord {
  scanName: string
  scanDir: string
  videoId: string
  transcript: NormalizedTranscript
  transcriptHash: string
  baselineEvents: ContentEvent[]
  baselineLatencyMs: number
}

interface NewVideoResult {
  videoId: string
  transcriptHash: string
  firstPassEvents: ClassifiedContentEvent[]
  onePassEvents: ContentEvent[]
  events: ContentEvent[]
  onePassSceneCount: number
  sceneCount: number
  detectorTokens: number
  detectorLatencyMs: number
  requests: number
  tokens: number
  latencyMs: number
}

interface MetricSet {
  annotatedCases: number
  shownCases: number
  usefulShownCases: number
  /** Anchor-only precision. Do not interpret this as card-level precision. */
  usefulWarningPrecision: number | null
  substantialMisses: number
  lowValueCards: number
  unsupportedClaims: number
  levelMismatches: number
  mainCases: number
  detailCases: number
  hiddenCases: number
}

interface RunOutput {
  metrics: MetricSet
  onePassMetrics: MetricSet
  cardAudit: CardAudit
  onePassCardAudit: CardAudit
  firstPassSubstantialMisses: number
  requests: number
  tokens: number
  latencyMs: number
  detectorTokens: number
  detectorLatencyMs: number
  onePassSceneCount: number
  sceneCount: number
  priorities: Record<string, Priority>
  levels: Record<string, ConcernLevel>
  sceneSignatures: Record<string, string[]>
}

interface StabilityCheckpoint {
  version: 2
  key: string
  runOutputs: RunOutput[]
}

interface VideoCoverageFile {
  note: string
  videos: Record<string, {
    coverage: 'anchor_only' | 'exhaustive'
    humanConfirmed: boolean
  }>
}

interface CardAudit {
  allDisplayedCards: number
  matchedKnownVisibleAnchors: number
  withoutKnownVisibleAnchor: number
  exhaustiveHumanVideos: number
  exhaustiveDisplayedCards: number
  exhaustiveUsefulCards: number
  cardPrecision: number | null
  exhaustiveVisibleMisses: number
}

function zeroUsage(): AggregateOpenAIUsage {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  }
}

function parseTranscript(text: string): NormalizedTranscript {
  const segments = text
    .split('\n')
    .map((line) => {
      const match = line.match(/^\[(\d+)]\s?(.*)$/)
      return match ? { index: Number(match[1]), text: match[2] } : null
    })
    .filter((item): item is { index: number; text: string } => Boolean(item))
    .sort((a, b) => a.index - b.index)
    .map((item, position) => ({
      text: item.text,
      startMs: position * 3_000,
      endMs: position * 3_000 + 2_500,
    }))

  if (segments.length === 0) throw new Error('Saved diagnostic entry has no indexed transcript lines.')
  return {
    text: segments.map((segment, index) => `[${index}] ${segment.text}`).join('\n'),
    sourceText: segments.map((segment) => segment.text).join(' '),
    segments,
  }
}

function normalizedWords(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
}

function anchorOverlap(anchor: string, value: string): number {
  const expected = normalizedWords(anchor)
  if (expected.size === 0) return 0
  const actual = normalizedWords(value)
  let common = 0
  for (const word of expected) if (actual.has(word)) common += 1
  return common / expected.size
}

function resolveAnnotationAnchor(
  annotation: ManualCase,
  transcript: NormalizedTranscript,
): ManualCase {
  let best:
    | { score: number; startMs: number; endMs: number; span: number }
    | undefined

  for (let start = 0; start < transcript.segments.length; start += 1) {
    let text = ''
    for (let end = start; end < Math.min(transcript.segments.length, start + 6); end += 1) {
      text += ` ${transcript.segments[end]!.text}`
      const score = anchorOverlap(annotation.anchor, text)
      const span = end - start + 1
      if (!best || score > best.score || (score === best.score && span < best.span)) {
        best = {
          score,
          startMs: transcript.segments[start]!.startMs,
          endMs: transcript.segments[end]!.endMs,
          span,
        }
      }
      if (score === 1) break
    }
  }

  if (!best || best.score < 0.6) return annotation
  return {
    ...annotation,
    anchorStartMs: best.startMs,
    anchorEndMs: best.endMs,
    anchorMatchScore: best.score,
  }
}

function eventMatches(
  event: Pick<
    ContentEvent,
    'text' | 'reason' | 'category' | 'startMs' | 'endMs' | 'sceneStartMs' | 'sceneEndMs'
  > | Pick<
    ClassifiedContentEvent,
    'text' | 'reason' | 'category' | 'startMs' | 'endMs' | 'sceneStartMs' | 'sceneEndMs'
  >,
  annotation: ManualCase,
): boolean {
  if (annotation.anchorStartMs !== undefined && annotation.anchorEndMs !== undefined) {
    if (!annotation.categories.includes(event.category)) return false
    const EVENT_MATCH_PADDING_MS = 5_000
    const startMs = event.sceneStartMs ?? event.startMs
    const endMs = event.sceneEndMs ?? event.endMs
    return startMs <= annotation.anchorEndMs + EVENT_MATCH_PADDING_MS
      && endMs >= annotation.anchorStartMs - EVENT_MATCH_PADDING_MS
  }

  return annotation.categories.includes(event.category)
    && anchorOverlap(annotation.anchor, `${event.text} ${event.reason}`) >= 0.6
}

function matchingPresentationScenes(events: ContentEvent[], annotation: ManualCase) {
  return buildPresentationScenes(events).filter((scene) =>
    scene.events.some((event) => eventMatches(event, annotation)),
  )
}

function actualPriority(events: ContentEvent[], annotation: ManualCase): Priority {
  const scenes = matchingPresentationScenes(events, annotation)
  if (scenes.some((scene) => scene.attention === 'main')) return 'main'
  if (scenes.length > 0) return 'details'
  return 'hidden'
}

function actualLevel(events: ContentEvent[], annotation: ManualCase): ConcernLevel {
  return matchingPresentationScenes(events, annotation)
    .reduce<ConcernLevel>((max, scene) => {
      const level = scene.level === 'high'
        ? 'high'
        : scene.level === 'moderate'
          ? 'moderate'
          : 'low'
      return CONCERN_LEVEL_RANK[level] > CONCERN_LEVEL_RANK[max] ? level : max
    }, 'hidden')
}

function findingMatches(event: ContentEvent, pattern: string): boolean {
  const [category, subtype] = pattern.split('.')
  return event.category === category && (subtype === '*' || event.subtype === subtype)
}

function unsupportedCount(events: ContentEvent[], annotation: ManualCase): number {
  return events.filter((event) =>
    eventMatches(event, annotation)
    && annotation.forbiddenFindings.some((pattern) => findingMatches(event, pattern)),
  ).length
}

function metricsFor(
  annotations: ManualCase[],
  eventsByVideo: Map<string, ContentEvent[]>,
): MetricSet {
  let shownCases = 0
  let usefulShownCases = 0
  let substantialMisses = 0
  let lowValueCards = 0
  let unsupportedClaims = 0
  let levelMismatches = 0
  let mainCases = 0
  let detailCases = 0
  let hiddenCases = 0

  for (const annotation of annotations) {
    const events = eventsByVideo.get(annotation.sourceVideo) ?? []
    const actual = actualPriority(events, annotation)
    if (actual === 'main') mainCases += 1
    else if (actual === 'details') detailCases += 1
    else hiddenCases += 1

    if (actual !== 'hidden') {
      shownCases += 1
      if (annotation.showToParent) usefulShownCases += 1
    }
    if (annotation.priority === 'main' && actual !== 'main') substantialMisses += 1
    if ((annotation.priority === 'hidden' && actual !== 'hidden')
      || (annotation.priority === 'details' && actual === 'main')) {
      lowValueCards += 1
    }
    unsupportedClaims += unsupportedCount(events, annotation)
    if (annotation.expectedLevel && actualLevel(events, annotation) !== annotation.expectedLevel) {
      levelMismatches += 1
    }
  }

  return {
    annotatedCases: annotations.length,
    shownCases,
    usefulShownCases,
    usefulWarningPrecision: shownCases === 0 ? null : usefulShownCases / shownCases,
    substantialMisses,
    lowValueCards,
    unsupportedClaims,
    levelMismatches,
    mainCases,
    detailCases,
    hiddenCases,
  }
}

function cardAuditFor(
  annotations: ManualCase[],
  eventsByVideo: Map<string, ContentEvent[]>,
  coverage: VideoCoverageFile,
): CardAudit {
  let allDisplayedCards = 0
  let matchedKnownVisibleAnchors = 0
  let exhaustiveHumanVideos = 0
  let exhaustiveDisplayedCards = 0
  let exhaustiveUsefulCards = 0
  let exhaustiveVisibleMisses = 0

  for (const [videoId, events] of eventsByVideo.entries()) {
    const scenes = buildPresentationScenes(events)
    const visibleAnnotations = annotations.filter((annotation) =>
      annotation.sourceVideo === videoId && annotation.showToParent,
    )
    const matched = scenes.filter((scene) =>
      visibleAnnotations.some((annotation) =>
        scene.events.some((event) => eventMatches(event, annotation)),
      ),
    ).length

    allDisplayedCards += scenes.length
    matchedKnownVisibleAnchors += matched

    const videoCoverage = coverage.videos[videoId]
    const exhaustive = videoCoverage?.coverage === 'exhaustive' && videoCoverage.humanConfirmed
    if (!exhaustive) continue

    exhaustiveHumanVideos += 1
    exhaustiveDisplayedCards += scenes.length
    exhaustiveUsefulCards += matched
    exhaustiveVisibleMisses += visibleAnnotations.filter((annotation) =>
      !scenes.some((scene) => scene.events.some((event) => eventMatches(event, annotation))),
    ).length
  }

  return {
    allDisplayedCards,
    matchedKnownVisibleAnchors,
    withoutKnownVisibleAnchor: allDisplayedCards - matchedKnownVisibleAnchors,
    exhaustiveHumanVideos,
    exhaustiveDisplayedCards,
    exhaustiveUsefulCards,
    cardPrecision: exhaustiveDisplayedCards === 0
      ? null
      : exhaustiveUsefulCards / exhaustiveDisplayedCards,
    exhaustiveVisibleMisses,
  }
}

function displayedSceneSignatures(
  eventsByVideo: Map<string, ContentEvent[]>,
): Record<string, string[]> {
  return Object.fromEntries([...eventsByVideo.entries()].map(([videoId, events]) => [
    videoId,
    buildPresentationScenes(events).map((scene) => [
      scene.attention,
      scene.level,
      [...scene.categories].sort().join('+'),
      Math.round(scene.startMs / 5_000),
      Math.round(scene.endMs / 5_000),
    ].join(':')),
  ]))
}

function firstPassMisses(
  annotations: ManualCase[],
  eventsByVideo: Map<string, ClassifiedContentEvent[]>,
): number {
  return annotations.filter((annotation) =>
    annotation.showToParent
    && !(eventsByVideo.get(annotation.sourceVideo) ?? []).some((event) => eventMatches(event, annotation)),
  ).length
}

async function loadScan(scanDir: string): Promise<{ records: ScanRecord[]; result: ScanResult }> {
  const [diagnosticRaw, resultRaw] = await Promise.all([
    readFile(resolve(scanDir, 'openai-analysis.json'), 'utf8'),
    readFile(resolve(scanDir, 'result.json'), 'utf8'),
  ])
  const diagnostic = JSON.parse(diagnosticRaw) as DiagnosticEntry[]
  const result = JSON.parse(resultRaw) as ScanResult
  const records = diagnostic
    .filter((entry) => entry.normalizedTranscript && entry.parsedResult)
    .map((entry) => {
      const transcript = parseTranscript(entry.normalizedTranscript)
      return {
        scanName: basename(scanDir),
        scanDir,
        videoId: entry.videoId,
        transcript,
        transcriptHash: createHash('sha256').update(entry.normalizedTranscript).digest('hex').slice(0, 16),
        baselineEvents: entry.parsedResult?.normalizedContentEvents ?? [],
        baselineLatencyMs: entry.provider?.latencyMs ?? 0,
      }
    })
  return { records, result }
}

function isRateLimitError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && (
      ('type' in error && error.type === 'rate_limit')
      || ('status' in error && error.status === 429)
    ),
  )
}

async function withRateLimitRetry<T>(
  label: string,
  task: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number,
): Promise<{ value: T; retries: number }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return { value: await task(), retries: attempt }
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= maxRetries) throw error
      const delayMs = Math.min(baseDelayMs * (2 ** attempt), 60_000)
      console.warn(
        `[quality] rate limit on ${label}; retry ${attempt + 1}/${maxRetries} in ${delayMs}ms`,
      )
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs))
    }
  }
}

async function runCurrent(
  record: ScanRecord,
  detector: OpenAIAnalysisProvider,
  reviewer: OpenAIAnalysisProvider,
  profile: AnalysisProfile,
  rateLimitRetries: number,
  retryBaseDelayMs: number,
): Promise<NewVideoResult> {
  const detectionAttempt = await withRateLimitRetry(
    `${record.videoId}:detector`,
    () => detector.analyze(record.transcript, 'ru', ALL_CATEGORIES, false),
    rateLimitRetries,
    retryBaseDelayMs,
  )
  const detection = detectionAttempt.value
  const onePassValidation = validateClassifiedEvents(detection.classifiedEvents)
  const onePassEvents = normalizeClassifiedEvents(onePassValidation.accepted)
    .map((event, index) => applyContentPolicy(
      event,
      `${record.videoId}:one-pass:${index}:${event.category}:${event.subtype}`,
      profile,
    ))
  let reviewed = detection.classifiedEvents
  let requests = 1 + detectionAttempt.retries
  let tokens = detection.usage.totalTokens
  let latencyMs = detection.provider.latencyMs

  if (reviewed.length > 0) {
    const reviewAttempt = await withRateLimitRetry(
      `${record.videoId}:review`,
      () => reviewer.review(record.transcript, 'ru', ALL_CATEGORIES, reviewed),
      rateLimitRetries,
      retryBaseDelayMs,
    )
    const review = reviewAttempt.value
    reviewed = review.reviewedEvents
    requests += review.requestCount + reviewAttempt.retries
    tokens += review.usage.totalTokens
    latencyMs += review.provider.latencyMs
  }

  const validation = validateClassifiedEvents(reviewed)
  const events = normalizeClassifiedEvents(validation.accepted)
    .map((event, index) => applyContentPolicy(
      event,
      `${record.videoId}:eval:${index}:${event.category}:${event.subtype}`,
      profile,
    ))
  return {
    videoId: record.videoId,
    transcriptHash: record.transcriptHash,
    firstPassEvents: detection.classifiedEvents,
    onePassEvents,
    events,
    onePassSceneCount: buildPresentationScenes(onePassEvents).length,
    sceneCount: buildPresentationScenes(events).length,
    detectorTokens: detection.usage.totalTokens,
    detectorLatencyMs: detection.provider.latencyMs,
    requests,
    tokens,
    latencyMs,
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = nextIndex
        nextIndex += 1
        if (index >= items.length) return
        results[index] = await task(items[index]!, index)
      }
    },
  )

  await Promise.all(workers)
  return results
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function priorities(
  annotations: ManualCase[],
  eventsByVideo: Map<string, ContentEvent[]>,
): Record<string, Priority> {
  return Object.fromEntries(annotations.map((annotation) => [
    annotation.id,
    actualPriority(eventsByVideo.get(annotation.sourceVideo) ?? [], annotation),
  ]))
}

function levels(
  annotations: ManualCase[],
  eventsByVideo: Map<string, ContentEvent[]>,
): Record<string, ConcernLevel> {
  return Object.fromEntries(annotations.map((annotation) => [
    annotation.id,
    actualLevel(eventsByVideo.get(annotation.sourceVideo) ?? [], annotation),
  ]))
}

describe.skipIf(!RUN)('parental quality evaluation on saved full transcripts', () => {
  it('compares saved baseline with two-pass contextual review without TranscriptAPI', async () => {
    const apiKey = process.env.OPENAI_API_KEY || process.env.NUXT_OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for paid quality evaluation.')

    const scanDirs = (process.env.QUALITY_SCAN_DIRS
      ? process.env.QUALITY_SCAN_DIRS.split(',').map((item) => item.trim()).filter(Boolean)
      : DEFAULT_SCAN_DIRS)
    const maxVideos = Math.max(1, Math.min(20, Number(process.env.QUALITY_MAX_VIDEOS ?? 20)))
    const runs = Math.max(1, Math.min(5, Number(process.env.QUALITY_RUNS ?? 1)))
    const concurrency = Math.max(1, Math.min(5, Number(process.env.QUALITY_CONCURRENCY ?? 1)))
    const rateLimitRetries = Math.max(0, Math.min(8, Number(process.env.QUALITY_RATE_LIMIT_RETRIES ?? 5)))
    const retryBaseDelayMs = Math.max(1_000, Math.min(60_000, Number(process.env.QUALITY_RETRY_BASE_MS ?? 10_000)))
    const runCooldownMs = Math.max(0, Math.min(120_000, Number(process.env.QUALITY_RUN_COOLDOWN_MS ?? 10_000)))
    const model = process.env.OPENAI_MODEL ?? 'gpt-6-luna'
    const reviewModel = process.env.OPENAI_REVIEW_MODEL ?? model
    const profile: AnalysisProfile = 'normal'

    const [annotations, coverage] = await Promise.all([
      readFile(resolve('evals/parental-quality-manual.json'), 'utf8')
        .then((raw) => JSON.parse(raw) as ManualCase[]),
      readFile(resolve('evals/parental-quality-coverage.json'), 'utf8')
        .then((raw) => JSON.parse(raw) as VideoCoverageFile),
    ])
    const loaded = await Promise.all(scanDirs.map(loadScan))
    const allRecords = loaded.flatMap((item) => item.records)

    const unique = new Map<string, ScanRecord>()
    for (const record of allRecords) {
      const key = `${record.videoId}:${record.transcriptHash}`
      if (!unique.has(key)) unique.set(key, record)
    }
    const selected = [...unique.values()].slice(0, maxVideos)
    const selectedKeys = new Set(selected.map((record) => `${record.videoId}:${record.transcriptHash}`))
    const selectedRecords = allRecords.filter((record) =>
      selectedKeys.has(`${record.videoId}:${record.transcriptHash}`),
    )
    const selectedVideoIds = new Set(selected.map((record) => record.videoId))
    const transcriptByVideo = new Map(selected.map((record) => [record.videoId, record.transcript]))
    const applicableAnnotations = annotations
      .filter((annotation) => selectedVideoIds.has(annotation.sourceVideo))
      .map((annotation) => {
        const transcript = transcriptByVideo.get(annotation.sourceVideo)
        return transcript ? resolveAnnotationAnchor(annotation, transcript) : annotation
      })
    if (applicableAnnotations.length === 0) {
      throw new Error('None of the annotated videos are present in the selected saved scans.')
    }
    const unresolvedAnchors = applicableAnnotations.filter((annotation) =>
      annotation.anchorStartMs === undefined || annotation.anchorEndMs === undefined,
    )
    if (unresolvedAnchors.length > 0) {
      console.warn(
        `[quality] temporal anchor resolution fell back to lexical matching for: ${unresolvedAnchors.map((item) => item.id).join(', ')}`,
      )
    }

    const baselineByScan = loaded.map((item, scanIndex) => {
      const records = item.records.filter((record) =>
        selectedKeys.has(`${record.videoId}:${record.transcriptHash}`),
      )
      const eventsByVideo = new Map(records.map((record) => [record.videoId, record.baselineEvents]))
      const scanAnnotations = applicableAnnotations.filter((annotation) => eventsByVideo.has(annotation.sourceVideo))
      return {
        scan: basename(scanDirs[scanIndex]!),
        metrics: metricsFor(scanAnnotations, eventsByVideo),
        cardAudit: cardAuditFor(scanAnnotations, eventsByVideo, coverage),
        usage: item.result.openaiUsage ?? zeroUsage(),
        latencyMs: records.reduce((sum, record) => sum + record.baselineLatencyMs, 0),
        annotations: scanAnnotations.map((item) => item.id),
      }
    })

    const outDir = resolve('benchmark-results/parental-quality')
    await mkdir(outDir, { recursive: true })
    const checkpointKey = createHash('sha256')
      .update(JSON.stringify({
        qualityEvalVersion: QUALITY_EVAL_VERSION,
        scanDirs,
        selected: selected.map((record) => `${record.videoId}:${record.transcriptHash}`),
        runs,
        model,
        reviewModel,
        profile,
      }))
      .digest('hex')
      .slice(0, 16)
    const checkpointPath = resolve(outDir, `.stability-${checkpointKey}.checkpoint.json`)
    let runOutputs: RunOutput[] = []

    try {
      const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as StabilityCheckpoint
      if (checkpoint.version === 2 && checkpoint.key === checkpointKey) {
        runOutputs = checkpoint.runOutputs.slice(0, runs)
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT') throw error
    }

    console.log(
      `Quality eval: ${runs} run(s), ${selected.length} video(s), concurrency=${concurrency}, rateLimitRetries=${rateLimitRetries}, scans=${scanDirs.join(', ')}`,
    )
    if (runOutputs.length > 0) {
      console.log(`[quality] resumed from checkpoint: ${runOutputs.length}/${runs} completed run(s)`)
    }

    for (let run = runOutputs.length; run < runs; run += 1) {
      const detector = new OpenAIAnalysisProvider(apiKey, model)
      const reviewer = new OpenAIAnalysisProvider(apiKey, reviewModel)
      const newByKey = new Map<string, NewVideoResult>()
      let completedVideos = 0

      console.log(`[quality] run ${run + 1}/${runs} started`)
      const outputsForRun = await mapWithConcurrency(
        selected,
        concurrency,
        async (record, index) => {
          console.log(
            `[quality] run ${run + 1}/${runs} video ${index + 1}/${selected.length} started: ${record.videoId}`,
          )
          try {
            const output = await runCurrent(
              record,
              detector,
              reviewer,
              profile,
              rateLimitRetries,
              retryBaseDelayMs,
            )
            completedVideos += 1
            console.log(
              `[quality] run ${run + 1}/${runs} completed ${completedVideos}/${selected.length}: ${record.videoId} (${output.tokens} tokens, ${output.requests} request(s))`,
            )
            return output
          } catch (error) {
            console.error(
              `[quality] run ${run + 1}/${runs} failed on ${record.videoId}`,
              error,
            )
            throw error
          }
        },
      )

      for (const output of outputsForRun) {
        newByKey.set(`${output.videoId}:${output.transcriptHash}`, output)
      }
      console.log(`[quality] run ${run + 1}/${runs} finished`)

      const currentByVideo = new Map<string, ContentEvent[]>()
      const onePassByVideo = new Map<string, ContentEvent[]>()
      const firstPassByVideo = new Map<string, ClassifiedContentEvent[]>()
      for (const record of selectedRecords) {
        const output = newByKey.get(`${record.videoId}:${record.transcriptHash}`)
        if (!output) continue
        currentByVideo.set(record.videoId, output.events)
        onePassByVideo.set(record.videoId, output.onePassEvents)
        firstPassByVideo.set(record.videoId, output.firstPassEvents)
      }
      const outputs = [...newByKey.values()]
      runOutputs.push({
        metrics: metricsFor(applicableAnnotations, currentByVideo),
        onePassMetrics: metricsFor(applicableAnnotations, onePassByVideo),
        cardAudit: cardAuditFor(applicableAnnotations, currentByVideo, coverage),
        onePassCardAudit: cardAuditFor(applicableAnnotations, onePassByVideo, coverage),
        firstPassSubstantialMisses: firstPassMisses(
          applicableAnnotations.filter((item) => item.priority === 'main'),
          firstPassByVideo,
        ),
        requests: outputs.reduce((sum, item) => sum + item.requests, 0),
        tokens: outputs.reduce((sum, item) => sum + item.tokens, 0),
        latencyMs: outputs.reduce((sum, item) => sum + item.latencyMs, 0),
        detectorTokens: outputs.reduce((sum, item) => sum + item.detectorTokens, 0),
        detectorLatencyMs: outputs.reduce((sum, item) => sum + item.detectorLatencyMs, 0),
        onePassSceneCount: outputs.reduce((sum, item) => sum + item.onePassSceneCount, 0),
        sceneCount: outputs.reduce((sum, item) => sum + item.sceneCount, 0),
        priorities: priorities(applicableAnnotations, currentByVideo),
        levels: levels(applicableAnnotations, currentByVideo),
        sceneSignatures: displayedSceneSignatures(currentByVideo),
      })
      await writeFile(
        checkpointPath,
        JSON.stringify({
          version: 2,
          key: checkpointKey,
          runOutputs,
        } satisfies StabilityCheckpoint, null, 2) + '\n',
        'utf8',
      )
      console.log(`[quality] checkpoint saved: ${runOutputs.length}/${runs} completed run(s)`)
      if (run + 1 < runs && runCooldownMs > 0) {
        console.log(`[quality] cooling down for ${runCooldownMs}ms before next run`)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, runCooldownMs))
      }
    }

    let stability: number | null = null
    let levelStability: number | null = null
    let displayedCardStability: number | null = null
    if (runOutputs.length > 1) {
      let comparisons = 0
      let equal = 0
      let levelEqual = 0
      const first = runOutputs[0]!.priorities
      const firstLevels = runOutputs[0]!.levels
      for (const output of runOutputs.slice(1)) {
        for (const annotation of applicableAnnotations) {
          comparisons += 1
          if (first[annotation.id] === output.priorities[annotation.id]) equal += 1
          if (firstLevels[annotation.id] === output.levels[annotation.id]) levelEqual += 1
        }
      }
      stability = comparisons === 0 ? null : equal / comparisons
      levelStability = comparisons === 0 ? null : levelEqual / comparisons

      let cardComparisons = 0
      let cardSimilarity = 0
      const firstScenes = runOutputs[0]!.sceneSignatures
      for (const output of runOutputs.slice(1)) {
        const videoIds = new Set([...Object.keys(firstScenes), ...Object.keys(output.sceneSignatures)])
        for (const videoId of videoIds) {
          const left = new Set(firstScenes[videoId] ?? [])
          const right = new Set(output.sceneSignatures[videoId] ?? [])
          const union = new Set([...left, ...right])
          const intersection = [...left].filter((signature) => right.has(signature)).length
          cardSimilarity += union.size === 0 ? 1 : intersection / union.size
          cardComparisons += 1
        }
      }
      displayedCardStability = cardComparisons === 0 ? null : cardSimilarity / cardComparisons
    }

    const baselineCombinedEvents = new Map<string, ContentEvent[]>()
    for (const record of selectedRecords) {
      if (!baselineCombinedEvents.has(record.videoId)) {
        baselineCombinedEvents.set(record.videoId, record.baselineEvents)
      }
    }
    const baselineCombined = metricsFor(applicableAnnotations, baselineCombinedEvents)
    const baselineCombinedCardAudit = cardAuditFor(
      applicableAnnotations,
      baselineCombinedEvents,
      coverage,
    )
    const current = runOutputs[0]!

    const report = {
      generatedAt: new Date().toISOString(),
      scope: {
        scanDirs,
        selectedUniqueFullTranscripts: selected.length,
        selectedRecords: selectedRecords.length,
        runs,
        concurrency,
        rateLimitRetries,
        retryBaseDelayMs,
        runCooldownMs,
        annotations: applicableAnnotations.length,
        provisionalAnnotations: applicableAnnotations.filter((item) => item.annotationSource === 'provisional').length,
        humanConfirmedAnnotations: applicableAnnotations.filter((item) => item.annotationSource === 'human_confirmed').length,
        tuningAnnotations: applicableAnnotations.filter((item) => item.split === 'tuning').length,
        holdoutAnnotations: applicableAnnotations.filter((item) => item.split === 'holdout').length,
        exhaustiveHumanVideos: Object.values(coverage.videos).filter((item) =>
          item.coverage === 'exhaustive' && item.humanConfirmed,
        ).length,
        annotationNote: coverage.note,
        resolvedTemporalAnchors: applicableAnnotations.filter((item) =>
          item.anchorStartMs !== undefined && item.anchorEndMs !== undefined,
        ).length,
        anchorResolution: Object.fromEntries(applicableAnnotations.map((item) => [
          item.id,
          {
            mode: item.anchorStartMs !== undefined ? 'temporal' : 'lexical_fallback',
            matchScore: item.anchorMatchScore ?? null,
            startMs: item.anchorStartMs ?? null,
            endMs: item.anchorEndMs ?? null,
          },
        ])),
      },
      versions: {
        qualityEval: QUALITY_EVAL_VERSION,
        detectorModel: model,
        reviewerModel: reviewModel,
        detectorPrompt: OPENAI_PROMPT_VERSION,
        detectorSchema: OPENAI_SCHEMA_VERSION,
        reviewerPrompt: OPENAI_REVIEW_PROMPT_VERSION,
        reviewerSchema: OPENAI_REVIEW_SCHEMA_VERSION,
      },
      baselineByScan,
      baselineCombined,
      baselineCombinedCardAudit,
      currentOnePass: {
        metrics: current.onePassMetrics,
        requests: selected.length,
        tokens: current.detectorTokens,
        latencyMs: current.detectorLatencyMs,
        sceneCount: current.onePassSceneCount,
        cardAudit: current.onePassCardAudit,
      },
      newTwoPass: {
        ...current,
        repeatedRuns: runs,
        stability,
        levelStability,
        displayedCardStability,
        anchorStability: Object.fromEntries(applicableAnnotations.map((annotation) => {
          const priorityCounts: Record<Priority, number> = { hidden: 0, details: 0, main: 0 }
          const levelCounts: Record<ConcernLevel, number> = { hidden: 0, low: 0, moderate: 0, high: 0 }
          for (const output of runOutputs) {
            priorityCounts[output.priorities[annotation.id]!] += 1
            levelCounts[output.levels[annotation.id]!] += 1
          }
          return [annotation.id, {
            expectedPriority: annotation.priority,
            expectedLevel: annotation.expectedLevel ?? null,
            priorityCounts,
            levelCounts,
          }]
        })),
        averageRequests: average(runOutputs.map((item) => item.requests)),
        averageTokens: average(runOutputs.map((item) => item.tokens)),
        averageLatencyMs: average(runOutputs.map((item) => item.latencyMs)),
      },
      interpretation: {
        usefulWarningPrecision: 'Anchor-only metric: share of shown annotated anchors that are expected to be parent-visible. It is not card-level precision.',
        cardAudit: 'Counts every displayed card. Cards without a known visible anchor are diagnostic only until that video has exhaustive human-confirmed labels.',
        cardPrecision: 'Computed only on videos explicitly marked exhaustive and humanConfirmed; null otherwise.',
        substantialMisses: 'Annotated main-priority scenes that were hidden or relegated to details.',
        lowValueCards: 'Annotated hidden cases shown at all, plus annotated details cases promoted to main.',
        unsupportedClaims: 'Machine-checkable forbidden category/subtype interpretations from the annotated set.',
        firstPassSubstantialMisses: 'Annotated main scenes not detected by the full-transcript first pass before review.',
        stability: 'Share of annotated anchors whose final priority is unchanged across repeated full-transcript runs.',
        displayedCardStability: 'Average Jaccard similarity of all displayed scene signatures across repeated runs.',
      },
    }

    const outputPath = resolve(
      outDir,
      `${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    )
    await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
    console.log(JSON.stringify(report, null, 2))
    console.log(`Saved quality report: ${outputPath}`)

    expect(runOutputs).toHaveLength(runs)
    const enforceQualityGates = process.env.QUALITY_ENFORCE_GATES === '1'
    if (enforceQualityGates) {
      expect(current.metrics.shownCases).toBeGreaterThan(0)
      expect(current.metrics.substantialMisses).toBeLessThanOrEqual(current.onePassMetrics.substantialMisses)
      expect(current.metrics.lowValueCards).toBeLessThanOrEqual(current.onePassMetrics.lowValueCards)
      expect(current.metrics.unsupportedClaims).toBeLessThanOrEqual(current.onePassMetrics.unsupportedClaims)
      expect(current.metrics.substantialMisses).toBeLessThanOrEqual(baselineCombined.substantialMisses)
      expect(current.metrics.lowValueCards).toBeLessThanOrEqual(baselineCombined.lowValueCards)
      expect(current.metrics.unsupportedClaims).toBeLessThanOrEqual(baselineCombined.unsupportedClaims)
      if (baselineCombined.usefulWarningPrecision !== null && current.metrics.usefulWarningPrecision !== null) {
        expect(current.metrics.usefulWarningPrecision).toBeGreaterThanOrEqual(baselineCombined.usefulWarningPrecision)
      }
      expect(current.firstPassSubstantialMisses).toBe(0)
    } else {
      console.log('[quality] provisional labels are report-only; set QUALITY_ENFORCE_GATES=1 to enable hard quality assertions')
    }

    await rm(checkpointPath, { force: true })
  }, 1_800_000)
})
