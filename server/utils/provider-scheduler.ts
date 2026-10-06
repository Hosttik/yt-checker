import { Semaphore } from './semaphore'

export interface ProviderSchedulerTiming {
  waitMs: number
  providerMs: number
  attempts: number
}

export interface ProviderSchedulerOptions {
  concurrency: number
  requestsPerMinute?: number
  tokensPerMinute?: number
  maxRetries?: number
  retryBaseMs?: number
  retryMaxMs?: number
  jitterMs?: number
}

interface Reservation {
  at: number
  tokens: number
}

function positive(value: number | undefined): number | undefined {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : undefined
}

function retryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const direct = Number((error as { retryAfterMs?: unknown }).retryAfterMs)
  if (Number.isFinite(direct) && direct >= 0) return direct

  const headers = (error as { headers?: unknown }).headers
  if (headers && typeof (headers as { get?: unknown }).get === 'function') {
    const raw = (headers as { get(name: string): string | null }).get('retry-after')
    if (raw) {
      const seconds = Number(raw)
      if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
      const at = Date.parse(raw)
      if (Number.isFinite(at)) return Math.max(0, at - Date.now())
    }
  }
  return undefined
}

function retryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const status = Number((error as { status?: unknown }).status)
  return status === 429 || status === 503
}

/**
 * Process-wide provider scheduler.
 *
 * It protects the provider in three layers:
 * - bounded simultaneous requests;
 * - optional rolling RPM/TPM reservations;
 * - one shared cooldown after 429/503 so a burst from many scans does not
 *   immediately retry in parallel.
 *
 * The rolling budgets are deliberately optional because real OpenAI limits are
 * account/model specific. When unset, adaptive cooldown still protects bursts.
 */
export class ProviderScheduler {
  private readonly semaphore: Semaphore
  private readonly requestsPerMinute?: number
  private readonly tokensPerMinute?: number
  private readonly maxRetries: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private readonly jitterMs: number
  private readonly reservations: Reservation[] = []
  private cooldownUntil = 0

  constructor(options: ProviderSchedulerOptions) {
    this.semaphore = new Semaphore(options.concurrency)
    this.requestsPerMinute = positive(options.requestsPerMinute)
    this.tokensPerMinute = positive(options.tokensPerMinute)
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 2))
    this.retryBaseMs = Math.max(50, Math.floor(options.retryBaseMs ?? 1_000))
    this.retryMaxMs = Math.max(this.retryBaseMs, Math.floor(options.retryMaxMs ?? 30_000))
    this.jitterMs = Math.max(0, Math.floor(options.jitterMs ?? 250))
  }

  async run<T>(
    estimatedInputTokens: number,
    task: () => Promise<T>,
    onTiming?: (timing: ProviderSchedulerTiming) => void,
  ): Promise<T> {
    const tokens = Math.max(1, Math.floor(estimatedInputTokens || 1))
    const scheduledAt = performance.now()
    let providerMs = 0
    let attempts = 0
    let attempt = 0

    while (true) {
      try {
        const result = await this.semaphore.run(async () => {
          await this.waitForBudget(tokens)
          const providerStartedAt = performance.now()
          attempts += 1
          try {
            return await task()
          } finally {
            providerMs += performance.now() - providerStartedAt
          }
        })
        const elapsedMs = performance.now() - scheduledAt
        onTiming?.({
          waitMs: Math.max(0, elapsedMs - providerMs),
          providerMs,
          attempts,
        })
        return result
      } catch (error) {
        if (!retryable(error) || attempt >= this.maxRetries) {
          const elapsedMs = performance.now() - scheduledAt
          onTiming?.({
            waitMs: Math.max(0, elapsedMs - providerMs),
            providerMs,
            attempts,
          })
          throw error
        }

        const hinted = retryAfterMs(error)
        const exponential = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** attempt))
        const jitter = this.jitterMs > 0 ? Math.floor(Math.random() * (this.jitterMs + 1)) : 0
        const delay = Math.max(hinted ?? 0, exponential) + jitter
        this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delay)
        attempt += 1
        await this.sleepUntil(this.cooldownUntil)
      }
    }
  }

  private async waitForBudget(tokens: number): Promise<void> {
    while (true) {
      const now = Date.now()
      if (now < this.cooldownUntil) {
        await this.sleepUntil(this.cooldownUntil)
        continue
      }

      this.prune(now)
      const requestBlocked = this.requestsPerMinute !== undefined
        && this.reservations.length >= this.requestsPerMinute
      const reservedTokens = this.reservations.reduce((sum, item) => sum + item.tokens, 0)
      const tokenBlocked = this.tokensPerMinute !== undefined
        && this.reservations.length > 0
        && reservedTokens + tokens > this.tokensPerMinute

      if (!requestBlocked && !tokenBlocked) {
        this.reservations.push({ at: now, tokens })
        return
      }

      const oldestExpiry = this.reservations.length > 0
        ? this.reservations[0]!.at + 60_000
        : now + 50
      await this.sleepUntil(Math.max(now + 10, oldestExpiry))
    }
  }

  private prune(now: number): void {
    const cutoff = now - 60_000
    while (this.reservations.length > 0 && this.reservations[0]!.at <= cutoff) {
      this.reservations.shift()
    }
  }

  private async sleepUntil(timestamp: number): Promise<void> {
    const delay = Math.max(0, timestamp - Date.now())
    if (delay <= 0) return
    await new Promise<void>((resolve) => setTimeout(resolve, delay))
  }
}

export function optionalPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
