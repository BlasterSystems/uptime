import { Cron } from 'croner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Database } from '@uptime/db'
import { PushEngine, type PushDownTarget } from './push.js'

const KEY_CASES = {
  interval: { intervalS: 60, graceSeconds: 30 },
  cron: { intervalS: 3600, graceSeconds: 30, cron: '* * * * *' },
}

function makeDb() {
  return Database.open({ file: ':memory:' })
}

function createPush(db: Database, config: Record<string, unknown>, intervalS = 60) {
  return db.createMonitor({
    type: 'push',
    name: 'job',
    intervalS,
    retries: 2,
    retryIntervalS: 60,
    config,
  })
}

describe('PushEngine', () => {
  let db: Database
  let downs: PushDownTarget[]

  beforeEach(() => {
    db = makeDb()
    downs = []
  })

  function makeEngine() {
    return new PushEngine({
      db,
      onDown: async (m) => {
        downs.push(m)
      },
    })
  }

  it('marks a push monitor down after interval + grace', async () => {
    const m = createPush(db, KEY_CASES.interval)
    const t0 = new Date('2026-01-01T00:00:00Z')
    db.insertHeartbeat({ monitorId: m.id, status: 'up', time: t0 })

    const engine = makeEngine()
    await engine.sweep(new Date(t0.getTime() + 89_000))
    expect(downs).toHaveLength(0)

    await engine.sweep(new Date(t0.getTime() + 91_000))
    expect(downs).toHaveLength(1)
    expect(downs[0]?.id).toBe(m.id)
    const [beat] = db.listHeartbeats(m.id, { limit: 1 })
    expect(beat?.status).toBe('down')

    // Idempotent: already recorded as down → no duplicate heartbeat or onDown.
    await engine.sweep(new Date(t0.getTime() + 200_000))
    expect(downs).toHaveLength(1)
  })

  it('uses cron schedule + grace when configured', async () => {
    const m = createPush(db, KEY_CASES.cron, 3600)
    const t0 = new Date('2026-01-01T00:00:00Z')
    db.insertHeartbeat({ monitorId: m.id, status: 'up', time: t0 })
    const engine = makeEngine()

    // Next cron run after t0 is 00:01:00; deadline 00:01:30.
    await engine.sweep(new Date(t0.getTime() + 89_000))
    expect(downs).toHaveLength(0)
    await engine.sweep(new Date(t0.getTime() + 91_000))
    expect(downs).toHaveLength(1)

    const cronNext = new Cron(KEY_CASES.cron.cron).nextRun(t0)
    expect(cronNext?.getTime()).toBe(t0.getTime() + 60_000)
  })

  it('ignores monitors that never pushed and inactive monitors', async () => {
    createPush(db, KEY_CASES.interval)
    const inactive = createPush(db, KEY_CASES.interval)
    db.updateMonitor(inactive.id, { active: false })
    const engine = makeEngine()
    await engine.sweep(new Date('2026-01-02T00:00:00Z'))
    expect(downs).toHaveLength(0)
    expect(db.listIncidents({ active: true })).toHaveLength(0)
  })

  it('start/stop manage the sweep timer', () => {
    vi.useFakeTimers()
    const engine = makeEngine()
    const spy = vi.spyOn(engine, 'sweep').mockResolvedValue()
    engine.start(10)
    vi.advanceTimersByTime(35)
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3)
    engine.stop()
    vi.advanceTimersByTime(100)
    expect(spy.mock.calls.length).toBeLessThanOrEqual(4)
    vi.useRealTimers()
  })
})
