import { describe, expect, it } from 'vitest'
import { SlidingWindowRateLimiter } from './rate-limit.js'

function makeLimiter(limit = 2, windowMs = 1000) {
  let now = 0
  return {
    limiter: new SlidingWindowRateLimiter({ limit, windowMs, now: () => now }),
    advance(ms: number) {
      now += ms
    },
  }
}

describe('SlidingWindowRateLimiter', () => {
  it('allows failures below the limit and trips at the limit', () => {
    const { limiter } = makeLimiter()
    expect(limiter.check('ip').limited).toBe(false)
    limiter.recordFailure('ip')
    expect(limiter.check('ip').limited).toBe(false)
    limiter.recordFailure('ip')
    expect(limiter.check('ip')).toEqual({ limited: true, retryAfterMs: 1000 })
  })

  it('counts down retryAfterMs as time passes', () => {
    const { limiter, advance } = makeLimiter()
    limiter.recordFailure('ip')
    limiter.recordFailure('ip')
    advance(400)
    expect(limiter.check('ip')).toEqual({ limited: true, retryAfterMs: 600 })
  })

  it('slides: failures older than the window stop counting', () => {
    const { limiter, advance } = makeLimiter()
    limiter.recordFailure('ip')
    limiter.recordFailure('ip')
    advance(1001)
    expect(limiter.check('ip')).toEqual({ limited: false, retryAfterMs: 0 })
  })

  it('keeps keys independent and reset clears the budget', () => {
    const { limiter } = makeLimiter()
    limiter.recordFailure('a')
    limiter.recordFailure('a')
    expect(limiter.check('b').limited).toBe(false)
    expect(limiter.check('a').limited).toBe(true)
    limiter.reset('a')
    expect(limiter.check('a')).toEqual({ limited: false, retryAfterMs: 0 })
  })
})
