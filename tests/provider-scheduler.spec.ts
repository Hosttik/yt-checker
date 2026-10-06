import { describe, expect, it } from 'vitest'
import { ProviderScheduler } from '../server/utils/provider-scheduler'

describe('ProviderScheduler', () => {
  it('bounds process-wide concurrency under a 100-task burst', async () => {
    const scheduler = new ProviderScheduler({ concurrency: 3, maxRetries: 0 })
    let active = 0
    let maxActive = 0

    await Promise.all(Array.from({ length: 100 }, async (_, index) =>
      scheduler.run(10, async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 1 + (index % 2)))
        active -= 1
        return index
      }),
    ))

    expect(maxActive).toBe(3)
  })

  it('retries a transient 429 instead of failing the scan immediately', async () => {
    const scheduler = new ProviderScheduler({
      concurrency: 1,
      maxRetries: 1,
      retryBaseMs: 50,
      retryMaxMs: 50,
      jitterMs: 0,
    })
    let attempts = 0

    const result = await scheduler.run(10, async () => {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 1 })
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(attempts).toBe(2)
  })
})
