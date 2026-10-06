import type { ContentCategory } from '../../shared/types/content'
import type { ProviderScheduler, ProviderSchedulerTiming } from '../utils/provider-scheduler'
import { positiveIntegerEnv } from '../utils/semaphore'
import {
  OpenAIAnalysisProvider,
  type OpenAIReasoningEffort,
} from './openai-analysis'
import { BatchedOpenAIAnalyzer } from './openai-batched-analyzer'
import { BatchedOpenAIReviewer } from './openai-batched-reviewer'

export interface OpenAIAnalysisStackOptions {
  apiKey: string
  detectorModel: string
  reviewerModel: string
  scheduler: ProviderScheduler
  batchingEnabled?: boolean
  reasoningEffort?: OpenAIReasoningEffort
  requestTimeoutMs?: number
  onSchedulerTiming?: (timing: ProviderSchedulerTiming) => void
}

export interface OpenAIBatchingManifest {
  enabled: boolean
  detector: {
    chunkMaxEstimatedTokens: number
    batchMaxEstimatedTokens: number
    batchMaxItems: number
    chunkOverlapMs: number
    coalesceMs: number
    batchConcurrency: number
  }
  reviewer: {
    batchMaxEstimatedTokens: number
    batchMaxItems: number
    batchMaxCandidates: number
    batchMaxScenes: number
    coalesceMs: number
    batchConcurrency: number
  }
}

export function openAIBatchingManifestFromEnv(
  enabled = process.env.OPENAI_BATCHING_ENABLED !== 'false',
): OpenAIBatchingManifest {
  return {
    enabled,
    detector: {
      chunkMaxEstimatedTokens: positiveIntegerEnv('OPENAI_DETECTOR_CHUNK_MAX_ESTIMATED_TOKENS', 30_000),
      batchMaxEstimatedTokens: positiveIntegerEnv('OPENAI_DETECTOR_BATCH_MAX_ESTIMATED_TOKENS', 70_000),
      batchMaxItems: positiveIntegerEnv('OPENAI_DETECTOR_BATCH_MAX_ITEMS', 5),
      chunkOverlapMs: positiveIntegerEnv('OPENAI_DETECTOR_CHUNK_OVERLAP_MS', 90_000),
      coalesceMs: positiveIntegerEnv('OPENAI_DETECTOR_COALESCE_MS', 100),
      batchConcurrency: positiveIntegerEnv('OPENAI_SCAN_BATCH_CONCURRENCY', 2),
    },
    reviewer: {
      batchMaxEstimatedTokens: positiveIntegerEnv('OPENAI_REVIEW_BATCH_MAX_ESTIMATED_TOKENS', 70_000),
      batchMaxItems: positiveIntegerEnv('OPENAI_REVIEW_BATCH_MAX_ITEMS', 4),
      batchMaxCandidates: positiveIntegerEnv('OPENAI_REVIEW_BATCH_MAX_CANDIDATES', 24),
      batchMaxScenes: positiveIntegerEnv('OPENAI_REVIEW_BATCH_MAX_SCENES', 8),
      coalesceMs: positiveIntegerEnv('OPENAI_REVIEW_COALESCE_MS', 100),
      batchConcurrency: positiveIntegerEnv('OPENAI_SCAN_REVIEW_BATCH_CONCURRENCY', 2),
    },
  }
}

export function createOpenAIAnalysisStack(options: OpenAIAnalysisStackOptions) {
  const manifest = openAIBatchingManifestFromEnv(options.batchingEnabled)
  const reasoningEffort = options.reasoningEffort ?? 'low'
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000
  const detectorProvider = new OpenAIAnalysisProvider(
    options.apiKey,
    options.detectorModel,
    undefined,
    undefined,
    reasoningEffort,
    requestTimeoutMs,
  )
  const reviewerProvider = new OpenAIAnalysisProvider(
    options.apiKey,
    options.reviewerModel,
    undefined,
    undefined,
    reasoningEffort,
    requestTimeoutMs,
  )

  const batchedAnalyzer = new BatchedOpenAIAnalyzer(detectorProvider, options.scheduler, {
    ...manifest.detector,
    onSchedulerTiming: options.onSchedulerTiming,
  })
  const batchedReviewer = new BatchedOpenAIReviewer(reviewerProvider, options.scheduler, {
    ...manifest.reviewer,
    onSchedulerTiming: options.onSchedulerTiming,
  })

  return {
    manifest,
    detectorProvider,
    reviewerProvider,
    analyzer: manifest.enabled ? batchedAnalyzer : detectorProvider,
    reviewer: manifest.enabled ? batchedReviewer : reviewerProvider,
  }
}

export type ContentAnalyzer = {
  analyze(
    transcript: Parameters<OpenAIAnalysisProvider['analyze']>[0],
    language: string,
    enabledCategories: ContentCategory[],
    diagnostic: boolean,
  ): ReturnType<OpenAIAnalysisProvider['analyze']>
}

export type ContentReviewer = {
  review(
    transcript: Parameters<OpenAIAnalysisProvider['review']>[0],
    language: string,
    enabledCategories: ContentCategory[],
    events: Parameters<OpenAIAnalysisProvider['review']>[3],
  ): ReturnType<OpenAIAnalysisProvider['review']>
}

/** Normal-profile rollout is opt-in until recall and false warnings are measured. */
export function coverageEnabledForProfile(profile: string): boolean {
  return profile === 'diagnostic' || process.env.OPENAI_COVERAGE_ENABLED === 'true'
}
