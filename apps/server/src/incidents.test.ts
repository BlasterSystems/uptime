import { describe, expect, it } from 'vitest'
import { Database } from '@uptime/db'
import type { CheckResult } from '@uptime/core'
import { IncidentEngine, type MonitorRef, type NotifierLike } from './incidents.js'

class StubNotifier implements NotifierLike {
  calls: { monitorId: number; title: string; status: string }[] = []

  async notifyMonitor(
    monitorId: number,
    payload: { title: string; status: string },
  ): Promise<unknown> {
    this.calls.push({ monitorId, title: payload.title, status: payload.status })
    return []
  }
}

const httpConfig = {
  url: 'https://example.com/',
  method: 'GET',
  timeoutMs: 10000,
  acceptedStatus: [200, 299],
}

function makeMonitor(
  db: Database,
  overrides: Partial<{ retries: number; resend: number; name: string }> = {},
) {
  return db.createMonitor({
    type: 'http',
    name: overrides.name ?? 'A',
    intervalS: 60,
    retries: overrides.retries ?? 2,
    retryIntervalS: 60,
    resendNotificationS: overrides.resend ?? 60,
    config: httpConfig,
  })
}

const ref = (m: {
  id: number
  name: string
  retries: number
  resendNotificationS: number
}): MonitorRef => m

const down: CheckResult = { status: 'down', latencyMs: 50, responseSnippet: 'connect refused' }
const up: CheckResult = { status: 'up', latencyMs: 42 }

describe('IncidentEngine', () => {
  it('opens an incident after `retries` consecutive failures and notifies once', async () => {
    const db = Database.open({ file: ':memory:' })
    const notifier = new StubNotifier()
    const engine = new IncidentEngine({ db, notifier, tags: () => [] })
    const m = makeMonitor(db)

    const t0 = new Date('2026-01-01T00:00:00Z')
    await engine.onResult(ref(m), down, t0)
    expect(notifier.calls).toHaveLength(0)
    expect(db.getOpenIncident(m.id)).toBeNull()

    await engine.onResult(ref(m), down, new Date(t0.getTime() + 60_000))
    expect(notifier.calls).toHaveLength(1)
    expect(notifier.calls[0]).toMatchObject({ monitorId: m.id, status: 'down' })
    const open = db.getOpenIncident(m.id)
    expect(open).not.toBeNull()
    expect(open?.title).toBe('A is DOWN')

    // Third failure: incident already open, resend interval not elapsed → no new notification.
    await engine.onResult(ref(m), down, new Date(t0.getTime() + 90_000))
    expect(notifier.calls).toHaveLength(1)
    expect(db.listIncidents({ active: true })).toHaveLength(1)
    db.close()
  })

  it('resends while down per resendNotificationS and recovers on up', async () => {
    const db = Database.open({ file: ':memory:' })
    const notifier = new StubNotifier()
    const engine = new IncidentEngine({ db, notifier, tags: () => ['prod'] })
    const m = makeMonitor(db, { resend: 60 })

    const t0 = new Date('2026-01-01T00:00:00Z')
    await engine.onResult(ref(m), down, t0)
    await engine.onResult(ref(m), down, new Date(t0.getTime() + 60_000)) // opens
    await engine.onResult(ref(m), down, new Date(t0.getTime() + 180_000)) // resend due
    expect(notifier.calls.map((c) => c.status)).toEqual(['down', 'down'])
    expect(notifier.calls[1]?.title).toBe('A is still DOWN')

    await engine.onResult(ref(m), up, new Date(t0.getTime() + 240_000))
    expect(notifier.calls.map((c) => c.status)).toEqual(['down', 'down', 'up'])
    expect(db.getOpenIncident(m.id)).toBeNull()
    const resolved = db.listIncidents({})
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.resolvedAt).not.toBeNull()
    db.close()
  })

  it('opens push incidents immediately via onPushDown', async () => {
    const db = Database.open({ file: ':memory:' })
    const notifier = new StubNotifier()
    const engine = new IncidentEngine({ db, notifier, tags: () => [] })
    const m = db.createMonitor({
      type: 'push',
      name: 'cron-job',
      intervalS: 60,
      retries: 3,
      retryIntervalS: 60,
      config: { graceSeconds: 60 },
    })

    await engine.onPushDown(ref(m), 'push deadline missed', new Date('2026-01-01T00:05:00Z'))
    expect(notifier.calls).toHaveLength(1)
    expect(db.getOpenIncident(m.id)).not.toBeNull()
    db.close()
  })
})
