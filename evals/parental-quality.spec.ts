import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

interface ManualCase {
  id: string
  annotationSource: 'manual'
  split: 'tuning' | 'holdout'
  sourceVideo: string
  anchor: string
  categories: ContentCategory[]
  showToParent: boolean
  priority: Priority
  why: string
  requiredEvidence: string[]
  forbiddenInterpretations: string[]
  forbiddenFindings: string[]
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
  events: ContentEvent[]
  sceneCount: number
  requests: number
  tokens: number
  latencyMs: number
}

interface MetricSet {
  annotatedCases: number
  shownCases: number
  usefulShownCases: number
  usefulWarningPrecision: number | null
  substantialMisses: number
  lowValueCards: number
  unsupportedClaims: number
  mainCases: number
  detailCases: number
  hiddenCases: number
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

function eventMatches(event: Pick<ContentEvent, 'text' | 'reason'> | Pick<ClassifiedContentEvent, 'text' | 'reason'>, annotation: ManualCase): boolean {
  return anchorOverlap(annotation.anchor, `${event.text} ${event.reason}`) >= 0.6
}

function actualPriority(events: ContentEvent[], annotation: ManualCase): Priority {
  const matching = events.filter((event) => eventMatches(event, annotation))
  const displayed = matching.filter((event) => event.displayLevel !== 'hidden')
  if (displayed.some((event) => event.parentRelevance === 'moderate' || event.parentRelevance === 'high')) return 'main'
  if (displayed.length > 0) return 'details'
  return 'hidden'
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
  }

  return {
    annotatedCases: annotations.length,
    shownCases,
    usefulShownCases,
    usefulWarningPrecision: shownCases === 0 ? null : usefulShownCases / shownCases,
    substantialMisses,
    lowValueCards,
    unsupportedClaims,
    mainCases,
    detailCases,
    hiddenCases,
  }
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

async function runCurrent(
  record: ScanRecord,
  detector: OpenAIAnalysisProvider,
  reviewer: OpenAIAnalysisProvider,
  profile: AnalysisProfile,
): Promise<NewVideoResult> {
  const detection = await detector.analyze(record.transcript, 'ru', ALL_CATEGORIES, false)
  let reviewed = detection.classifiedEvents
  let requests = 1
  let tokens = detection.usage.totalTokens
  let latencyMs = detection.provider.latencyMs

  if (reviewed.length > 0) {
    const review = await reviewer.review(record.transcript, 'ru', ALL_CATEGORIES, reviewed)
    reviewed = review.reviewedEvents
    requests += 1
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
    events,
    sceneCount: buildPresentationScenes(events).length,
    requests,
    tokens,
    latencyMs,
  }
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

describe.skipIf(!RUN)('parental quality evaluation on saved full transcripts', () => {
  it('compares saved baseline with two-pass contextual review without TranscriptAPI', async () => {
    const apiKey = process.env.OPENAI_API_KEY || process.env.NUXT_OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for paid quality evaluation.')

    const scanDirs = (process.env.QUALITY_SCAN_DIRS
      ? process.env.QUALITY_SCAN_DIRS.split(',').map((item) => item.trim()).filter(Boolean)
      : DEFAULT_SCAN_DIRS)
    const maxVideos = Math.max(1, Math.min(20, Number(process.env.QUALITY_MAX_VIDEOS ?? 20)))
    const runs = Math.max(1, Math.min(3, Number(process.env.QUALITY_RUNS ?? 1)))
    const model = process.env.OPENAI_MODEL ?? 'gpt-6-luna'
    const reviewModel = process.env.OPENAI_REVIEW_MODEL ?? model
    const profile: AnalysisProfile = 'normal'

    const annotations = JSON.parse(
      await readFile(resolve('evals/parental-quality-manual.json'), 'utf8'),
    ) as ManualCase[]
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
    const applicableAnnotations = annotations.filter((annotation) => selectedVideoIds.has(annotation.sourceVideo))
    if (applicableAnnotations.length === 0) {
      throw new Error('None of the manually annotated videos are present in the selected saved scans.')
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
        usage: item.result.openaiUsage ?? zeroUsage(),
        latencyMs: records.reduce((sum, record) => sum + record.baselineLatencyMs, 0),
        annotations: scanAnnotations.map((item) => item.id),
      }
    })

    const runOutputs: Array<{
      metrics: MetricSet
      firstPassSubstantialMisses: number
      requests: number
      tokens: number
      latencyMs: number
      sceneCount: number
      priorities: Record<string, Priority>
    }> = []

    for (let run = 0; run < runs; run += 1) {
      const detector = new OpenAIAnalysisProvider(apiKey, model)
      const reviewer = new OpenAIAnalysisProvider(apiKey, reviewModel)
      const newByKey = new Map<string, NewVideoResult>()
      for (const record of selected) {
        const output = await runCurrent(record, detector, reviewer, profile)
        newByKey.set(`${record.videoId}:${record.transcriptHash}`, output)
      }

      const currentByVideo = new Map<string, ContentEvent[]>()
      const firstPassByVideo = new Map<string, ClassifiedContentEvent[]>()
      for (const record of selectedRecords) {
        const output = newByKey.get(`${record.videoId}:${record.transcriptHash}`)
        if (!output) continue
        currentByVideo.set(record.videoId, output.events)
        firstPassByVideo.set(record.videoId, output.firstPassEvents)
      }
      const outputs = [...newByKey.values()]
      runOutputs.push({
        metrics: metricsFor(applicableAnnotations, currentByVideo),
        firstPassSubstantialMisses: firstPassMisses(
          applicableAnnotations.filter((item) => item.priority === 'main'),
          firstPassByVideo,
        ),
        requests: outputs.reduce((sum, item) => sum + item.requests, 0),
        tokens: outputs.reduce((sum, item) => sum + item.tokens, 0),
        latencyMs: outputs.reduce((sum, item) => sum + item.latencyMs, 0),
        sceneCount: outputs.reduce((sum, item) => sum + item.sceneCount, 0),
        priorities: priorities(applicableAnnotations, currentByVideo),
      })
    }

    let stability: number | null = null
    if (runOutputs.length > 1) {
      let comparisons = 0
      let equal = 0
      const first = runOutputs[0]!.priorities
      for (const output of runOutputs.slice(1)) {
        for (const annotation of applicableAnnotations) {
          comparisons += 1
          if (first[annotation.id] === output.priorities[annotation.id]) equal += 1
        }
      }
      stability = comparisons === 0 ? null : equal / comparisons
    }

    const baselineCombinedEvents = new Map<string, ContentEvent[]>()
    for (const record of selectedRecords) {
      if (!baselineCombinedEvents.has(record.videoId)) {
        baselineCombinedEvents.set(record.videoId, record.baselineEvents)
      }
    }
    const baselineCombined = metricsFor(applicableAnnotations, baselineCombinedEvents)
    const current = runOutputs[0]!

    const report = {
      generatedAt: new Date().toISOString(),
      scope: {
        scanDirs,
        selectedUniqueFullTranscripts: selected.length,
        selectedRecords: selectedRecords.length,
        manualAnnotations: applicableAnnotations.length,
        tuningAnnotations: applicableAnnotations.filter((item) => item.split === 'tuning').length,
        holdoutAnnotations: applicableAnnotations.filter((item) => item.split === 'holdout').length,
        annotationNote: 'Small manually engineered validation set; not evidence of general model accuracy.',
      },
      versions: {
        detectorModel: model,
        reviewerModel: reviewModel,
        detectorPrompt: OPENAI_PROMPT_VERSION,
        detectorSchema: OPENAI_SCHEMA_VERSION,
        reviewerPrompt: OPENAI_REVIEW_PROMPT_VERSION,
        reviewerSchema: OPENAI_REVIEW_SCHEMA_VERSION,
      },
      baselineByScan,
      baselineCombined,
      newTwoPass: {
        ...current,
        repeatedRuns: runs,
        stability,
        averageRequests: average(runOutputs.map((item) => item.requests)),
        averageTokens: average(runOutputs.map((item) => item.tokens)),
        averageLatencyMs: average(runOutputs.map((item) => item.latencyMs)),
      },
      interpretation: {
        usefulWarningPrecision: 'Share of shown manually labelled cases that the gold set says should be parent-visible.',
        substantialMisses: 'Gold main-priority scenes that were hidden or relegated to details.',
        lowValueCards: 'Gold hidden cases shown at all, plus gold details cases promoted to main.',
        unsupportedClaims: 'Machine-checkable forbidden category/subtype interpretations from the manual gold set.',
        firstPassSubstantialMisses: 'Gold main scenes not detected by the full-transcript first pass before review.',
        stability: 'Share of manual cases whose final priority is unchanged across repeated full-transcript runs.',
      },
    }

    const outDir = resolve('benchmark-results/parental-quality')
    await mkdir(outDir, { recursive: true })
    const outputPath = resolve(
      outDir,
      `${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    )
    await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
    console.log(JSON.stringify(report, null, 2))
    console.log(`Saved quality report: ${outputPath}`)

    expect(current.metrics.shownCases).toBeGreaterThan(0)
    expect(current.metrics.substantialMisses).toBeLessThanOrEqual(baselineCombined.substantialMisses)
    expect(current.metrics.lowValueCards).toBeLessThanOrEqual(baselineCombined.lowValueCards)
    expect(current.metrics.unsupportedClaims).toBeLessThanOrEqual(baselineCombined.unsupportedClaims)
    if (baselineCombined.usefulWarningPrecision !== null && current.metrics.usefulWarningPrecision !== null) {
      expect(current.metrics.usefulWarningPrecision).toBeGreaterThanOrEqual(baselineCombined.usefulWarningPrecision)
    }
    expect(current.firstPassSubstantialMisses).toBe(0)
  }, 600_000)
})
