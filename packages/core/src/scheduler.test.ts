import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Scheduler } from './scheduler.js'
import type { CheckResult, HttpMonitorConfig, ScheduledMonitor } from './types.js'

const UP: CheckResult = { status: 'up', latencyMs: 1 }
const DOWN: CheckResult = { status: 'down', latencyMs: 1, responseSnippet: 'boom' }

const BASE_CONFIG: HttpMonitorConfig = {
  method: 'GET',
  url: 'http://example.test/healthz',
  timeoutMs: 1000,
  acceptedStatus: 'any',
}

function monitor(overrides: Partial<ScheduledMonitor> = {}): ScheduledMonitor {
  return {
    id: 1,
    type: 'http',
    name: 'test monitor',
    active: true,
    intervalS: 60,
    retries: 3,
    retryIntervalS: 5,
    config: BASE_CONFIG,
    ...overrides,
  }
}

/** Scheduler wired to a stubbed check; `times` are result timestamps relative to creation. */
function createHarness(
  check: (monitor: ScheduledMonitor) => Promise<CheckResult>,
  limits: { globalConcurrency?: number; perHostConcurrency?: number } = {},
) {
  const onResult = vi.fn(
    (_monitor: ScheduledMonitor, _result: CheckResult, _time: Date): void => {},
  )
  const scheduler = new Scheduler({ ...limits, check, onResult })
  const startedAt = Date.now()
  return {
    scheduler,
    onResult,
    check,
    times: () => onResult.mock.calls.map(([, , time]) => time.getTime() - startedAt),
  }
}

/** Promise resolved manually from the test (check stubs that must stay in flight). */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Let queued microtasks settle without moving the fake clock. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve()
}

/** Stub check that resolves immediately with `UP` (a mock, so call counts are assertable). */
function stubCheck() {
  return vi.fn(async (_monitor: ScheduledMonitor): Promise<CheckResult> => UP)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Scheduler', () => {
  it('probes immediately and then on the drift-corrected grid', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // zero jitter
    const { scheduler, check, times } = createHarness(stubCheck())

    scheduler.upsert(monitor({ intervalS: 60 }))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(check).toHaveBeenCalledTimes(6)
    expect(times()).toEqual([0, 60_000, 120_000, 180_000, 240_000, 300_000])
  })

  it('keeps the grid when a check takes longer than one interval', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { scheduler, times } = createHarness(async (_monitor: ScheduledMonitor) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30_000))
      return UP
    })

    scheduler.upsert(monitor({ intervalS: 60 }))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    // Results lag their grid slot by the check duration; the spacing itself never drifts.
    expect(times()).toEqual([30_000, 90_000, 150_000, 210_000, 270_000])
  })

  it('probes at retryIntervalS while down and returns to the grid after recovery', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const results: CheckResult[] = [DOWN, DOWN, UP, UP]
    const { scheduler, times } = createHarness(
      async (_monitor: ScheduledMonitor) => results.shift() ?? UP,
    )

    scheduler.upsert(monitor({ intervalS: 60, retryIntervalS: 5 }))
    scheduler.start()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(times()).toEqual([0, 5_000, 10_000])

    // Recovery re-anchors onto the interval grid: 10 s + 60 s.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(times()).toEqual([0, 5_000, 10_000, 70_000])
  })

  it('offsets each slot by ±10 % of the current spacing', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.25) // (0.25 × 2 − 1) × 10 % = −5 %
    const { scheduler, times } = createHarness(stubCheck())

    scheduler.upsert(monitor({ intervalS: 60 }))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(3 * 60_000)

    expect(times()).toEqual([0, 57_000, 117_000, 177_000])
  })

  it('keeps jitter within ±10 % of the grid', async () => {
    const { scheduler, times } = createHarness(stubCheck())

    scheduler.upsert(monitor({ intervalS: 60 }))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    const observed = times()
    expect(observed[0]).toBe(0)
    observed.slice(1).forEach((time, index) => {
      expect(Math.abs(time - (index + 1) * 60_000)).toBeLessThanOrEqual(6_000)
    })
  })

  it('serializes checks at the global concurrency cap', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const gate = deferred<CheckResult>()
    const check = vi.fn((): Promise<CheckResult> => gate.promise)
    const { scheduler, onResult } = createHarness(check, { globalConcurrency: 1 })

    scheduler.upsert(monitor({ id: 1 }))
    scheduler.upsert(monitor({ id: 2 }))
    scheduler.start()

    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    expect(check).toHaveBeenCalledTimes(1)
    expect(onResult).not.toHaveBeenCalled()

    gate.resolve(UP)
    await flushMicrotasks()
    expect(check).toHaveBeenCalledTimes(2)
    expect(onResult).toHaveBeenCalledTimes(2)
  })

  it('serializes checks per hostname and runs different hosts in parallel', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const gate = deferred<CheckResult>()
    const check = vi.fn((): Promise<CheckResult> => gate.promise)
    const { scheduler } = createHarness(check, { globalConcurrency: 10, perHostConcurrency: 1 })

    scheduler.upsert(monitor({ id: 1, config: { ...BASE_CONFIG, url: 'http://same.test/a' } }))
    scheduler.upsert(monitor({ id: 2, config: { ...BASE_CONFIG, url: 'http://same.test/b' } }))
    scheduler.upsert(monitor({ id: 3, config: { ...BASE_CONFIG, url: 'http://other.test/c' } }))
    scheduler.start()

    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('stops firing after remove()', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { scheduler, check, onResult } = createHarness(stubCheck())

    scheduler.upsert(monitor({ intervalS: 60 }))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onResult).toHaveBeenCalledTimes(2)

    scheduler.remove(1)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(check).toHaveBeenCalledTimes(2)
    expect(onResult).toHaveBeenCalledTimes(2)
  })

  it('applies a new interval on upsert without stacking timers', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { scheduler, check, times } = createHarness(stubCheck())

    scheduler.upsert(monitor({ intervalS: 60 }))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(check).toHaveBeenCalledTimes(1)

    scheduler.upsert(monitor({ intervalS: 20 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(check).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(times()).toEqual([0, 0, 20_000, 40_000, 60_000])
  })

  it('never schedules inactive monitors', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { scheduler, check } = createHarness(stubCheck())

    scheduler.upsert(monitor({ active: false }))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(check).not.toHaveBeenCalled()

    scheduler.upsert(monitor({ active: true }))
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('skips a tick while the previous check is still running', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const gate = deferred<CheckResult>()
    const check = vi.fn((): Promise<CheckResult> => gate.promise)
    const { scheduler, onResult } = createHarness(check)

    scheduler.upsert(monitor({ intervalS: 60 }))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(check).toHaveBeenCalledTimes(1)
    expect(onResult).not.toHaveBeenCalled()

    gate.resolve(UP)
    await flushMicrotasks()
    expect(onResult).toHaveBeenCalledTimes(1)
  })

  it('clears every timer on stop()', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { scheduler, check, onResult } = createHarness(stubCheck())

    scheduler.upsert(monitor({ intervalS: 60 }))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onResult).toHaveBeenCalledTimes(2)

    scheduler.stop()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(check).toHaveBeenCalledTimes(2)
    expect(onResult).toHaveBeenCalledTimes(2)
  })

  it('reports a throwing check as a down result', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { scheduler, onResult } = createHarness(async (_monitor: ScheduledMonitor) => {
      throw new Error('socket exploded')
    })

    scheduler.upsert(monitor())
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()

    expect(onResult).toHaveBeenCalledTimes(1)
    const [, result] = onResult.mock.calls[0] ?? []
    expect(result).toEqual({ status: 'down', latencyMs: 0, responseSnippet: 'socket exploded' })
  })

  it('never schedules push monitors', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { scheduler, check, onResult } = createHarness(stubCheck())

    // `config` is inert here: push monitors are heartbeat-receiver-driven and never executed.
    scheduler.upsert(monitor({ type: 'push' }))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(check).not.toHaveBeenCalled()
    expect(onResult).not.toHaveBeenCalled()

    scheduler.remove(1) // safe: nothing was ever scheduled
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(check).not.toHaveBeenCalled()
  })

  it('drops a running schedule when a monitor becomes push', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { scheduler, check } = createHarness(stubCheck())

    scheduler.upsert(monitor({ intervalS: 60 }))
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    expect(check).toHaveBeenCalledTimes(1)

    scheduler.upsert(monitor({ type: 'push' }))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(check).toHaveBeenCalledTimes(1)
  })
})
