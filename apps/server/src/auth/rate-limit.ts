/**
 * In-memory sliding-window failure limiter for the login endpoint (SPEC §8).
 * `now` is injectable so tests are deterministic.
 */

export interface RateLimitDecision {
  limited: boolean
  /** Milliseconds until the oldest failure leaves the window (0 when not limited). */
  retryAfterMs: number
}

export interface SlidingWindowOptions {
  /** Failures allowed per window before the key is limited. */
  limit: number
  windowMs: number
  now?: () => number
}

export class SlidingWindowRateLimiter {
  readonly #limit: number
  readonly #windowMs: number
  readonly #now: () => number
  readonly #failures = new Map<string, number[]>()
  #lastSweep = Number.NEGATIVE_INFINITY

  constructor(opts: SlidingWindowOptions) {
    this.#limit = opts.limit
    this.#windowMs = opts.windowMs
    this.#now = opts.now ?? Date.now
  }

  /** Decides whether `key` has exhausted its failure budget. */
  check(key: string): RateLimitDecision {
    const now = this.#now()
    const recent = this.#prune(key, now)
    if (recent.length < this.#limit) return { limited: false, retryAfterMs: 0 }
    const oldest = recent[0]!
    return { limited: true, retryAfterMs: Math.max(1, oldest + this.#windowMs - now) }
  }

  /** Records a failed attempt and drops failures that already left the window. */
  recordFailure(key: string): void {
    const now = this.#now()
    const recent = this.#prune(key, now)
    recent.push(now)
    this.#failures.set(key, recent)
    this.#sweep(now)
  }

  /** Clears the budget (call after a successful login). */
  reset(key: string): void {
    this.#failures.delete(key)
  }

  #prune(key: string, now: number): number[] {
    const times = this.#failures.get(key)
    if (times === undefined) return []
    const cutoff = now - this.#windowMs
    const recent = times.filter((time) => time > cutoff)
    if (recent.length === 0) this.#failures.delete(key)
    else this.#failures.set(key, recent)
    return recent
  }

  /** Amortized cleanup so abandoned keys cannot grow the map without bound. */
  #sweep(now: number): void {
    if (now - this.#lastSweep < this.#windowMs) return
    this.#lastSweep = now
    for (const [key, times] of this.#failures) {
      const cutoff = now - this.#windowMs
      const recent = times.filter((time) => time > cutoff)
      if (recent.length === 0) this.#failures.delete(key)
      else this.#failures.set(key, recent)
    }
  }
}
