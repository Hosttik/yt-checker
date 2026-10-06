import type { OpenAIUsage } from '../../shared/types/check'
import type { ClassifiedContentEvent, ContentCategory } from '../../shared/types/content'
import type { NormalizedTranscript } from '../domain/normalize-transcript'
import { mapWithConcurrency } from '../utils/concurrency'
import type { ProviderScheduler } from '../utils/provider-scheduler'
import {
  OPENAI_REVIEW_PROMPT_VERSION,
  OPENAI_REVIEW_SCHEMA_VERSION,
  buildReviewContextText,
  type OpenAIProviderMetadata,
  type OpenAIReviewBatchInput,
  type OpenAIReviewResult,
  OpenAIAnalysisProvider,
} from './openai-analysis'
import { estimateTextTokens } from './openai-batched-analyzer'

export interface BatchedReviewerOptions {
  batchMaxEstimatedTokens?: number
  coalesceMs?: number
  batchConcurrency?: number
  estimatedPromptTokens?: number
}

interface PendingReview {
  id: number
  transcript: NormalizedTranscript
  language: string
  enabledCategories: ContentCategory[]
  events: ClassifiedContentEvent[]
  estimatedTokens: number
  resolve: (value: OpenAIReviewResult) => void
  reject: (error: unknown) => void
}

interface ResolvedReview {
  job: PendingReview
  result: Awaited<ReturnType<OpenAIAnalysisProvider['reviewBatch']>>['items'][number]
  usage: OpenAIUsage
  requestCount: number
  provider: OpenAIProviderMetadata
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback
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
  while (remainder > 0) {
    const target = order[(total - remainder) % order.length]!
    values[target.index]! += 1
    remainder -= 1
  }
  return values
}

function distributeUsage(usage: OpenAIUsage, weights: number[]): OpenAIUsage[] {
  const inputTokens = distributeInteger(usage.inputTokens, weights)
  const outputTokens = distributeInteger(usage.outputTokens, weights)
  const reasoningTokens = distributeInteger(usage.reasoningTokens, weights)
  const cachedTokens = distributeInteger(usage.cachedTokens, weights)
  const cacheWriteTokens = distributeInteger(usage.cacheWriteTokens, weights)
  const totalTokens = distributeInteger(usage.totalTokens, weights)

  return weights.map((_, index) => ({
    inputTokens: inputTokens[index]!,
    outputTokens: outputTokens[index]!,
    reasoningTokens: reasoningTokens[index]!,
    cachedTokens: cachedTokens[index]!,
    cacheWriteTokens: cacheWriteTokens[index]!,
    totalTokens: totalTokens[index]!,
  }))
}

function packJobs(jobs: PendingReview[], maxTokens: number): PendingReview[][] {
  const batches: PendingReview[][] = []
  let current: PendingReview[] = []
  let currentTokens = 0

  for (const job of jobs) {
    const overflow = current.length > 0
      && (currentTokens + job.estimatedTokens > maxTokens || current.length >= 32)
    if (overflow) {
      batches.push(current)
      current = []
      currentTokens = 0
    }
    current.push(job)
    currentTokens += job.estimatedTokens
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * Per-scan review coalescer. Detector results for concurrent videos arrive
 * together, so their candidate scene windows can usually be reviewed in one
 * provider request instead of one request per video.
 */
export class BatchedOpenAIReviewer {
  private readonly batchMaxEstimatedTokens: number
  private readonly coalesceMs: number
  private readonly batchConcurrency: number
  private readonly estimatedPromptTokens: number
  private readonly pending: PendingReview[] = []
  private timer?: ReturnType<typeof setTimeout>
  private nextId = 0

  constructor(
    private readonly provider: OpenAIAnalysisProvider,
    private readonly scheduler: ProviderScheduler,
    options: BatchedReviewerOptions = {},
  ) {
    this.batchMaxEstimatedTokens = positive(options.batchMaxEstimatedTokens, 70_000)
    this.coalesceMs = Math.max(0, Math.floor(options.coalesceMs ?? 100))
    this.batchConcurrency = positive(options.batchConcurrency, 1)
    this.estimatedPromptTokens = positive(options.estimatedPromptTokens, 20_000)
  }

  review(
    transcript: NormalizedTranscript,
    language: string,
    enabledCategories: ContentCategory[],
    events: ClassifiedContentEvent[],
  ): Promise<OpenAIReviewResult> {
    if (events.length === 0) {
      return this.provider.review(transcript, language, enabledCategories, events)
    }

    const context = buildReviewContextText(transcript, events)
    const estimatedTokens = estimateTextTokens(context)
      + estimateTextTokens(JSON.stringify(events))

    return new Promise<OpenAIReviewResult>((resolve, reject) => {
      this.pending.push({
        id: this.nextId++,
        transcript,
        language,
        enabledCategories,
        events,
        estimatedTokens,
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
    const batches = packJobs(jobs, this.batchMaxEstimatedTokens)

    try {
      const resolvedBatches = await mapWithConcurrency(
        batches,
        this.batchConcurrency,
        async (batch): Promise<ResolvedReview[]> => {
          const input: OpenAIReviewBatchInput[] = batch.map((job) => ({
            itemId: `review_job_${job.id}`,
            transcript: job.transcript,
            language: job.language,
            enabledCategories: job.enabledCategories,
            events: job.events,
          }))
          const estimatedTokens = this.estimatedPromptTokens
            + batch.reduce((sum, job) => sum + job.estimatedTokens, 0)
          let scheduledAttempts = 0
          const response = await this.scheduler.run(estimatedTokens, async () => {
            scheduledAttempts += 1
            return this.provider.reviewBatch(input)
          })
          const byId = new Map(response.items.map((item) => [item.itemId, item]))
          const usages = distributeUsage(response.usage, batch.map((job) => job.estimatedTokens))

          return batch.map((job, index) => {
            const result = byId.get(`review_job_${job.id}`)
            if (!result) throw new Error(`Missing OpenAI review batch result for review_job_${job.id}.`)
            return {
              job,
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

      for (const item of resolvedBatches.flat()) {
        const { job, result } = item
        item.job.resolve({
          reviewedEvents: result.reviewedEvents,
          decisions: result.decisions,
          totalCandidates: result.totalCandidates,
          reviewedCandidates: result.reviewedCandidates,
          rejectedCandidates: result.rejectedCandidates,
          uncertainCandidates: result.uncertainCandidates,
          complete: result.complete,
          requestCount: item.requestCount,
          retryCount: 0,
          missingBeforeRetry: result.totalCandidates - result.reviewedCandidates,
          missingAfterRetry: result.totalCandidates - result.reviewedCandidates,
          rescuedCandidates: 0,
          rescueRejectedCandidates: 0,
          rescuedEvents: [],
          outputText: JSON.stringify({
            itemId: `review_job_${job.id}`,
            decisions: result.decisions,
          }),
          usage: item.usage,
          provider: item.provider,
          requestMetadata: {
            model: this.providerModel(),
            reasoningEffort: this.providerReasoningEffort(),
            transcriptLanguage: job.language || 'unknown',
            enabledCategories: job.enabledCategories,
            promptVersion: OPENAI_REVIEW_PROMPT_VERSION,
            schemaVersion: OPENAI_REVIEW_SCHEMA_VERSION,
            stage: 'review',
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
