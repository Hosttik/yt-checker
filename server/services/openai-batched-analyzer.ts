import type { OpenAIUsage } from '../../shared/types/check'
import type { ClassifiedContentEvent, ContentCategory, RejectedContentCandidate } from '../../shared/types/content'
import type { NormalizedTranscript } from '../domain/normalize-transcript'
import { mapWithConcurrency } from '../utils/concurrency'
import type { ProviderScheduler } from '../utils/provider-scheduler'
import {
  OPENAI_PROMPT_VERSION,
  OPENAI_SCHEMA_VERSION,
  type OpenAIAnalysisBatchInput,
  type OpenAIAnalysisBatchResult,
  type OpenAIAnalysisResult,
  type OpenAIProviderMetadata,
  OpenAIAnalysisProvider,
} from './openai-analysis'

export interface BatchedAnalyzerOptions {
  chunkMaxEstimatedTokens?: number
  batchMaxEstimatedTokens?: number
  chunkOverlapMs?: number
  coalesceMs?: number
  batchConcurrency?: number
  estimatedPromptTokens?: number
}

interface TranscriptChunk {
  itemId: string
  transcript: NormalizedTranscript
  transcriptText: string
  language: string
  estimatedTokens: number
  jobId: number
}

interface PendingJob {
  id: number
  transcript: NormalizedTranscript
  language: string
  enabledCategories: ContentCategory[]
  diagnostic: boolean
  resolve: (value: OpenAIAnalysisResult) => void
  reject: (error: unknown) => void
}

interface ChunkResult {
  chunk: TranscriptChunk
  result: OpenAIAnalysisBatchResult['items'][number]
  usage: OpenAIUsage
  requestCount: number
  provider: OpenAIProviderMetadata
}

const ZERO_USAGE: OpenAIUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback
}

/**
 * Conservative tokenizer-free estimate that is intentionally language agnostic.
 * UTF-8 bytes / 3 slightly overestimates many Latin/Cyrillic transcripts and
 * stays much safer for CJK than chars / 4.
 */
export function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 3))
}

export function transcriptChunks(
  transcript: NormalizedTranscript,
  language: string,
  jobId: number,
  chunkMaxEstimatedTokens: number,
  overlapMs: number,
): TranscriptChunk[] {
  const segments = transcript.segments
  if (segments.length === 0) return []

  const chunks: TranscriptChunk[] = []
  let start = 0
  let chunkIndex = 0

  while (start < segments.length) {
    let end = start
    let tokens = 0

    while (end < segments.length) {
      const line = `[${end}] ${segments[end]!.text}\n`
      const lineTokens = estimateTextTokens(line)
      if (end > start && tokens + lineTokens > chunkMaxEstimatedTokens) break
      tokens += lineTokens
      end += 1
      if (tokens >= chunkMaxEstimatedTokens) break
    }

    if (end <= start) end = start + 1
    const transcriptText = segments
      .slice(start, end)
      .map((segment, offset) => `[${start + offset}] ${segment.text}`)
      .join('\n')

    chunks.push({
      itemId: `job_${jobId}_chunk_${chunkIndex}`,
      transcript,
      transcriptText,
      language,
      estimatedTokens: estimateTextTokens(transcriptText),
      jobId,
    })
    chunkIndex += 1

    if (end >= segments.length) break

    const lastEndMs = segments[end - 1]!.endMs
    const overlapFromMs = Math.max(0, lastEndMs - overlapMs)
    let nextStart = end
    for (let index = Math.max(start + 1, 0); index < end; index += 1) {
      if (segments[index]!.endMs >= overlapFromMs) {
        nextStart = index
        break
      }
    }

    // Always make meaningful progress even for extremely dense captions or
    // an overlap window larger than the chunk itself.
    if (nextStart <= start) nextStart = end
    start = nextStart
  }

  return chunks
}

function packChunks(chunks: TranscriptChunk[], batchMaxEstimatedTokens: number): TranscriptChunk[][] {
  const batches: TranscriptChunk[][] = []
  let current: TranscriptChunk[] = []
  let currentTokens = 0

  for (const chunk of chunks) {
    const wouldOverflow = current.length > 0
      && (currentTokens + chunk.estimatedTokens > batchMaxEstimatedTokens || current.length >= 32)
    if (wouldOverflow) {
      batches.push(current)
      current = []
      currentTokens = 0
    }
    current.push(chunk)
    currentTokens += chunk.estimatedTokens
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function distributeInteger(total: number, weights: number[]): number[] {
  if (weights.length === 0) return []
  if (total <= 0) return weights.map(() => 0)
  const weightTotal = weights.reduce((sum, value) => sum + Math.max(1, value), 0)
  const exact = weights.map((weight) => total * Math.max(1, weight) / weightTotal)
  const values = exact.map(Math.floor)
  let remainder = total - values.reduce((sum, value) => sum + value, 0)
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction)
  for (let index = 0; index < remainder; index += 1) {
    values[order[index % order.length]!.index]! += 1
  }
  return values
}

function distributeUsage(usage: OpenAIUsage, weights: number[]): OpenAIUsage[] {
  const fields = {
    inputTokens: distributeInteger(usage.inputTokens, weights),
    outputTokens: distributeInteger(usage.outputTokens, weights),
    reasoningTokens: distributeInteger(usage.reasoningTokens, weights),
    cachedTokens: distributeInteger(usage.cachedTokens, weights),
    cacheWriteTokens: distributeInteger(usage.cacheWriteTokens, weights),
    totalTokens: distributeInteger(usage.totalTokens, weights),
  }

  return weights.map((_, index) => ({
    inputTokens: fields.inputTokens[index]!,
    outputTokens: fields.outputTokens[index]!,
    reasoningTokens: fields.reasoningTokens[index]!,
    cachedTokens: fields.cachedTokens[index]!,
    cacheWriteTokens: fields.cacheWriteTokens[index]!,
    totalTokens: fields.totalTokens[index]!,
  }))
}

function addUsage(target: OpenAIUsage, item: OpenAIUsage): void {
  target.inputTokens += item.inputTokens
  target.outputTokens += item.outputTokens
  target.reasoningTokens += item.reasoningTokens
  target.cachedTokens += item.cachedTokens
  target.cacheWriteTokens += item.cacheWriteTokens
  target.totalTokens += item.totalTokens
}

function rangesOverlap(
  left: { startMs: number; endMs: number },
  right: { startMs: number; endMs: number },
  paddingMs = 2_000,
): boolean {
  return left.startMs <= right.endMs + paddingMs && left.endMs >= right.startMs - paddingMs
}

function duplicateEvent(left: ClassifiedContentEvent, right: ClassifiedContentEvent): boolean {
  if (left.category !== right.category || left.subtype !== right.subtype) return false
  const leftRanges = left.evidenceRanges.length > 0 ? left.evidenceRanges : [left]
  const rightRanges = right.evidenceRanges.length > 0 ? right.evidenceRanges : [right]
  return leftRanges.some((a) => rightRanges.some((b) => rangesOverlap(a, b)))
}

function dedupeEvents(events: ClassifiedContentEvent[]): ClassifiedContentEvent[] {
  const result: ClassifiedContentEvent[] = []
  for (const event of events.sort((a, b) => a.startMs - b.startMs || b.confidence - a.confidence)) {
    const duplicateIndex = result.findIndex((known) => duplicateEvent(known, event))
    if (duplicateIndex < 0) {
      result.push(event)
      continue
    }
    if (event.confidence > result[duplicateIndex]!.confidence) result[duplicateIndex] = event
  }
  return result.sort((a, b) => a.startMs - b.startMs)
}

function dedupeRejected(items: RejectedContentCandidate[]): RejectedContentCandidate[] {
  const result: RejectedContentCandidate[] = []
  for (const item of items.sort((a, b) => a.startMs - b.startMs)) {
    if (result.some((known) =>
      known.suspectedCategory === item.suspectedCategory
      && rangesOverlap(known, item),
    )) continue
    result.push(item)
  }
  return result
}

/**
 * Per-scan coalescer. Concurrent video analyses wait for a very small window,
 * then their transcript chunks are packed into a handful of provider requests.
 * Provider capacity itself is process-wide through ProviderScheduler.
 */
export class BatchedOpenAIAnalyzer {
  private readonly chunkMaxEstimatedTokens: number
  private readonly batchMaxEstimatedTokens: number
  private readonly chunkOverlapMs: number
  private readonly coalesceMs: number
  private readonly batchConcurrency: number
  private readonly estimatedPromptTokens: number
  private readonly pending: PendingJob[] = []
  private timer?: ReturnType<typeof setTimeout>
  private nextJobId = 0

  constructor(
    private readonly provider: OpenAIAnalysisProvider,
    private readonly scheduler: ProviderScheduler,
    options: BatchedAnalyzerOptions = {},
  ) {
    this.chunkMaxEstimatedTokens = positive(options.chunkMaxEstimatedTokens, 30_000)
    this.batchMaxEstimatedTokens = Math.max(
      this.chunkMaxEstimatedTokens,
      positive(options.batchMaxEstimatedTokens, 70_000),
    )
    this.chunkOverlapMs = Math.max(0, Math.floor(options.chunkOverlapMs ?? 90_000))
    this.coalesceMs = Math.max(0, Math.floor(options.coalesceMs ?? 100))
    this.batchConcurrency = positive(options.batchConcurrency, 2)
    this.estimatedPromptTokens = positive(options.estimatedPromptTokens, 12_000)
  }

  analyze(
    transcript: NormalizedTranscript,
    language: string,
    enabledCategories: ContentCategory[],
    diagnostic: boolean,
  ): Promise<OpenAIAnalysisResult> {
    if (!transcript.text.trim()) {
      return this.provider.analyze(transcript, language, enabledCategories, diagnostic)
    }

    return new Promise<OpenAIAnalysisResult>((resolve, reject) => {
      this.pending.push({
        id: this.nextJobId++,
        transcript,
        language,
        enabledCategories,
        diagnostic,
        resolve,
        reject,
      })
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined
          void this.flush()
        }, this.coalesceMs)
      }
    })
  }

  private async flush(): Promise<void> {
    const jobs = this.pending.splice(0, this.pending.length)
    if (jobs.length === 0) return

    const groups = new Map<string, PendingJob[]>()
    for (const job of jobs) {
      const key = JSON.stringify({
        enabledCategories: job.enabledCategories,
        diagnostic: job.diagnostic,
      })
      const group = groups.get(key) ?? []
      group.push(job)
      groups.set(key, group)
    }

    await Promise.all([...groups.values()].map((group) => this.flushGroup(group)))
  }

  private async flushGroup(jobs: PendingJob[]): Promise<void> {
    const categories = jobs[0]!.enabledCategories
    const diagnostic = jobs[0]!.diagnostic
    const chunks = jobs.flatMap((job) => transcriptChunks(
      job.transcript,
      job.language,
      job.id,
      this.chunkMaxEstimatedTokens,
      this.chunkOverlapMs,
    ))
    const batches = packChunks(chunks, this.batchMaxEstimatedTokens)

    try {
      const perBatch = await mapWithConcurrency(
        batches,
        this.batchConcurrency,
        async (batch): Promise<ChunkResult[]> => {
          const estimatedTokens = this.estimatedPromptTokens
            + batch.reduce((sum, chunk) => sum + chunk.estimatedTokens, 0)
          const input: OpenAIAnalysisBatchInput[] = batch.map((chunk) => ({
            itemId: chunk.itemId,
            transcript: chunk.transcript,
            transcriptText: chunk.transcriptText,
            language: chunk.language,
          }))
          let scheduledAttempts = 0
          const response = await this.scheduler.run(
            estimatedTokens,
            async () => {
              scheduledAttempts += 1
              return this.provider.analyzeBatch(input, categories, diagnostic)
            },
          )
          const byId = new Map(response.items.map((item) => [item.itemId, item]))
          const usages = distributeUsage(response.usage, batch.map((chunk) => chunk.estimatedTokens))

          return batch.map((chunk, index) => {
            const result = byId.get(chunk.itemId)
            if (!result) throw new Error(`Missing OpenAI batch result for ${chunk.itemId}.`)
            return {
              chunk,
              result,
              usage: usages[index]!,
              requestCount: index === 0
                ? scheduledAttempts + Math.max(0, response.requestCount - 1)
                : 0,
              provider: response.provider,
            }
          })
        },
      )
      const chunkResults = perBatch.flat()

      for (const job of jobs) {
        const own = chunkResults.filter((item) => item.chunk.jobId === job.id)
        const usage = { ...ZERO_USAGE }
        for (const item of own) addUsage(usage, item.usage)
        const events = dedupeEvents(own.flatMap((item) => item.result.classifiedEvents))
        const rejectedCandidates = diagnostic
          ? dedupeRejected(own.flatMap((item) => item.result.rejectedCandidates ?? []))
          : undefined
        const requestCount = own.reduce((sum, item) => sum + item.requestCount, 0)
        const slowest = own.reduce<ChunkResult | undefined>(
          (current, item) => !current || item.provider.latencyMs > current.provider.latencyMs ? item : current,
          undefined,
        )

        job.resolve({
          classifiedEvents: events,
          rejectedCandidates,
          outputText: own.map((item) => item.result.outputText).filter(Boolean).join('\n--- chunk ---\n') || undefined,
          usage,
          requestCount,
          provider: slowest?.provider ?? { latencyMs: 0 },
          requestMetadata: {
            model: this.providerModel(),
            reasoningEffort: this.providerReasoningEffort(),
            transcriptLanguage: job.language || 'unknown',
            enabledCategories: job.enabledCategories,
            diagnostic: job.diagnostic,
            promptVersion: OPENAI_PROMPT_VERSION,
            schemaVersion: OPENAI_SCHEMA_VERSION,
          },
        })
      }
    } catch (error) {
      for (const job of jobs) job.reject(error)
    }
  }

  private providerModel(): string {
    return (this.provider as unknown as { model?: string }).model ?? 'unknown'
  }

  private providerReasoningEffort(): 'low' | 'medium' | 'high' {
    return (this.provider as unknown as { reasoningEffort?: 'low' | 'medium' | 'high' }).reasoningEffort ?? 'low'
  }
}
