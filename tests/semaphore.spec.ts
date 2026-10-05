import { describe, expect, it } from 'vitest'
import { Semaphore } from '../server/utils/semaphore'

describe('Semaphore', () => {
  it('caps concurrent work at the configured limit', async () => {
    const semaphore = new Semaphore(2)
    let active = 0
    let peak = 0

    await Promise.all(Array.from({ length: 6 }, (_, index) => semaphore.run(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return index
    })))

    expect(peak).toBe(2)
    expect(active).toBe(0)
  })

  it('releases a slot when a task fails', async () => {
    const semaphore = new Semaphore(1)

    await expect(semaphore.run(async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')

    await expect(semaphore.run(async () => 'ok')).resolves.toBe('ok')
  })
})
