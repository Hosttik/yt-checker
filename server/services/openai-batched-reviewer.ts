import type { OpenAIUsage } from '../../shared/types/check'
import type { ClassifiedContentEvent, ContentCategory } from '../../shared/types/content'
import type { NormalizedTranscript } from '../domain/normalize-transcript'
import { mapWithConcurrency } from '../utils/concurrency'
import type { ProviderScheduler, ProviderSchedulerTiming } from '../utils/provider-scheduler'
import {
  OPENAI_REVIEW_PROMPT_VERSION,
  OPENAI_REVIEW_SCHEMA_VERSION,
  buildReviewContextText,
  type OpenAIProviderMetadata,
  type OpenAIReviewBatchInput,
  type OpenAIReviewResult,
  OpenAIAnalysisError,
  OpenAIAnalysisProvider,
} from './openai-analysis'
import { estimateTextTokens } from './openai-batched-analyzer'

export interface BatchedReviewerOptions {
  batchMaxEstimatedTokens?: number
  coalesceMs?: number
  batchConcurrency?: number
  batchMaxItems?: number
  batchMaxCandidates?: number
  batchMaxScenes?: number
  estimatedPromptTokens?: number
  onSchedulerTiming?: (timing: ProviderSchedulerTiming) => void
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
  fallbackRequestCount: number
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

function sceneCount(events: ClassifiedContentEvent[]): number {
  return new Set(events.map((event, index) =>
    event.sceneId ?? event.sourceCandidateId ?? `candidate_${index}`,
  )).size
}

function packJobs(
  jobs: PendingReview[],
  maxTokens: number,
  maxItems: number,
  maxCandidates: number,
  maxScenes: number,
): PendingReview[][] {
  const batches: PendingReview[][] = []
  let current: PendingReview[] = []
  let currentTokens = 0
  let currentCandidates = 0
  let currentScenes = 0

  for (const job of jobs) {
    const jobScenes = sceneCount(job.events)
    const overflow = current.length > 0
      && (
        currentTokens + job.estimatedTokens > maxTokens
        || current.length >= maxItems
        || currentCandidates + job.events.length > maxCandidates
        || currentScenes + jobScenes > maxScenes
      )
    if (overflow) {
      batches.push(current)
      current = []
      currentTokens = 0
      currentCandidates = 0
      currentScenes = 0
    }
    current.push(job)
    currentTokens += job.estimatedTokens
    currentCandidates += job.events.length
    currentScenes += jobScenes
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function mergedUsage(left: OpenAIUsage, right?: OpenAIUsage): OpenAIUsage {
  return {
    inputTokens: left.inputTokens + (right?.inputTokens ?? 0),
    outputTokens: left.outputTokens + (right?.outputTokens ?? 0),
    reasoningTokens: left.reasoningTokens + (right?.reasoningTokens ?? 0),
    cachedTokens: left.cachedTokens + (right?.cachedTokens ?? 0),
    cacheWriteTokens: left.cacheWriteTokens + (right?.cacheWriteTokens ?? 0),
    totalTokens: left.totalTokens + (right?.totalTokens ?? 0),
  }
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
  private readonly batchMaxItems: number
  private readonly batchMaxCandidates: number
  private readonly batchMaxScenes: number
  private readonly estimatedPromptTokens: number
  private readonly pending: PendingReview[] = []
  private timer?: ReturnType<typeof setTimeout>
  private nextId = 0

  constructor(
    private readonly provider: OpenAIAnalysisProvider,
    private readonly scheduler: ProviderScheduler,
    private readonly options: BatchedReviewerOptions = {},
  ) {
    this.batchMaxEstimatedTokens = positive(this.options.batchMaxEstimatedTokens, 70_000)
    this.coalesceMs = Math.max(0, Math.floor(this.options.coalesceMs ?? 100))
    this.batchConcurrency = positive(this.options.batchConcurrency, 2)
    this.batchMaxItems = positive(this.options.batchMaxItems, 4)
    this.batchMaxCandidates = positive(this.options.batchMaxCandidates, 24)
    this.batchMaxScenes = positive(this.options.batchMaxScenes, 8)
    this.estimatedPromptTokens = positive(this.options.estimatedPromptTokens, 20_000)
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
    const batches = packJobs(
      jobs,
      this.batchMaxEstimatedTokens,
      this.batchMaxItems,
      this.batchMaxCandidates,
      this.batchMaxScenes,
    )

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
          const response = await this.scheduler.run(
            estimatedTokens,
            async () => {
              scheduledAttempts += 1
              return this.provider.reviewBatch(input)
            },
            this.options.onSchedulerTiming,
          )
          const byId = new Map(response.items.map((item) => [item.itemId, item]))
          const usages = distributeUsage(response.usage, batch.map((job) => job.estimatedTokens))

          const base = batch.map((job, index) => {
            const result = byId.get(`review_job_${job.id}`)
            if (!result) throw new Error(`Missing OpenAI review batch result for review_job_${job.id}.`)
            return {
              job,
              result,
              usage: usages[index]!,
              requestCount: index === 0
                ? scheduledAttempts + Math.max(0, response.requestCount - 1)
                : 0,
              fallbackRequestCount: 0,
              provider: response.provider,
            }
          })

          const recovered: ResolvedReview[] = []
          for (const item of base) {
            if (item.result.complete) {
              recovered.push(item)
              continue
            }

            let fallbackAttempts = 0
            try {
              const fallback = await this.scheduler.run(
                this.estimatedPromptTokens + item.job.estimatedTokens,
                async () => {
                  fallbackAttempts += 1
                  return this.provider.review(
                    item.job.transcript,
                    item.job.language,
                    item.job.enabledCategories,
                    item.job.events,
                  )
                },
                this.options.onSchedulerTiming,
              )
              recovered.push({
                job: item.job,
                result: {
                  itemId: `review_job_${item.job.id}`,
                  reviewedEvents: fallback.reviewedEvents,
                  decisions: fallback.decisions,
                  totalCandidates: fallback.totalCandidates,
                  reviewedCandidates: fallback.reviewedCandidates,
                  rejectedCandidates: fallback.rejectedCandidates,
                  uncertainCandidates: fallback.uncertainCandidates,
                  complete: fallback.complete,
                },
                usage: mergedUsage(item.usage, fallback.usage),
                requestCount: item.requestCount
                  + fallbackAttempts
                  + Math.max(0, fallback.requestCount - 1),
                fallbackRequestCount: fallbackAttempts + Math.max(0, fallback.requestCount - 1),
                provider: {
                  ...fallback.provider,
                  latencyMs: item.provider.latencyMs + fallback.provider.latencyMs,
                },
              })
            } catch (error) {
              const fallbackError = error as { usage?: OpenAIUsage; provider?: OpenAIProviderMetadata }
              recovered.push({
                ...item,
                usage: mergedUsage(item.usage, fallbackError.usage),
                requestCount: item.requestCount + fallbackAttempts,
                fallbackRequestCount: fallbackAttempts,
                provider: fallbackError.provider
                  ? {
                      ...fallbackError.provider,
                      latencyMs: item.provider.latencyMs + fallbackError.provider.latencyMs,
                    }
                  : item.provider,
              })
            }
          }

          return recovered
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
          fallbackRequestCount: item.fallbackRequestCount,
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
      const shared = error as {
        usage?: OpenAIUsage
        provider?: OpenAIProviderMetadata
        requestCount?: number
        message?: string
        status?: number
        code?: string
        type?: string
      }
      const usages = distributeUsage(
        shared.usage ?? {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
        },
        jobs.map((job) => job.estimatedTokens),
      )
      for (let index = 0; index < jobs.length; index += 1) {
        const cloned = new OpenAIAnalysisError(
          shared.type === 'rate_limit'
            || shared.type === 'authentication'
            || shared.type === 'timeout'
            || shared.type === 'schema'
            || shared.type === 'provider'
            || shared.type === 'server'
            ? shared.type
            : 'provider',
          shared.message ?? 'Batched contextual review failed.',
          shared.status,
          shared.code,
        )
        cloned.usage = usages[index]
        cloned.provider = shared.provider
        cloned.requestCount = index === 0 ? (shared.requestCount ?? 1) : 0
        jobs[index]!.reject(cloned)
      }
    }
  }

  private providerModel(): string {
    return (this.provider as unknown as { model?: string }).model ?? 'unknown'
  }

  private providerReasoningEffort(): 'low' | 'medium' | 'high' {
    return (this.provider as unknown as { reasoningEffort?: 'low' | 'medium' | 'high' }).reasoningEffort ?? 'low'
  }
}
