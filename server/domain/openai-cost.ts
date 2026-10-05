import type { OpenAIUsage } from '../../shared/types/check'

export interface OpenAIPricing {
  inputPerMillion: number
  cachedInputPerMillion: number
  cacheWritePerMillion: number
  outputPerMillion: number
}

export const GPT6_LUNA_STANDARD_PRICING: OpenAIPricing = {
  inputPerMillion: 0.10,
  cachedInputPerMillion: 0.01,
  cacheWritePerMillion: 0.125,
  outputPerMillion: 0.50,
}

export function estimateOpenAICostUsd(
  usage: Pick<
    OpenAIUsage,
    'inputTokens' | 'outputTokens' | 'cachedTokens' | 'cacheWriteTokens'
  >,
  pricing: OpenAIPricing = GPT6_LUNA_STANDARD_PRICING,
): number {
  const uncachedInputTokens = Math.max(
    0,
    usage.inputTokens - usage.cachedTokens - usage.cacheWriteTokens,
  )
  return (
    uncachedInputTokens * pricing.inputPerMillion
    + usage.cachedTokens * pricing.cachedInputPerMillion
    + usage.cacheWriteTokens * pricing.cacheWritePerMillion
    + usage.outputTokens * pricing.outputPerMillion
  ) / 1_000_000
}
