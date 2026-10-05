import { describe, expect, it } from 'vitest'
import {
  estimateOpenAICostUsd,
  GPT6_LUNA_STANDARD_PRICING,
} from '../server/domain/openai-cost'

describe('OpenAI cost estimation', () => {
  it('prices uncached input, cached input, cache writes and output separately', () => {
    const cost = estimateOpenAICostUsd({
      inputTokens: 100_000,
      cachedTokens: 60_000,
      cacheWriteTokens: 10_000,
      outputTokens: 20_000,
    })

    expect(GPT6_LUNA_STANDARD_PRICING).toEqual({
      inputPerMillion: 0.10,
      cachedInputPerMillion: 0.01,
      cacheWritePerMillion: 0.125,
      outputPerMillion: 0.50,
    })
    expect(cost).toBeCloseTo(0.01485, 8)
  })
})
