import { describe, expect, it } from 'vitest'
import { Database } from '@uptime/db'
import type { CheckResult } from '@uptime/core'
import { GroupEngine } from './groups.js'
import { IncidentEngine } from './incidents.js'

interface RecordedResult {
  id: number
  status: string
  snippet?: string
}

function makeRecordingEngine(db: Database) {
  const rec = {
    results: [] as RecordedResult[],
    broadcasts: [] as { monitorId: number; status: string }[],
  }
  return {
    rec,
    onResult: async (m: { id: number }, result: CheckResult): Promise<void> => {
      rec.results.push({ id: m.id, status: result.status, snippet: result.responseSnippet })
      db.insertHeartbeat({
        monitorId: m.id,
        status: result.status,
        latencyMs: result.latencyMs,
        responseSnippet: result.responseSnippet,
      })
    },
    broadcast: (event: { monitorId: number; status: string }): void => {
      rec.broadcasts.push({ monitorId: event.monitorId, status: event.status })
    },
  }
}

function makeDb() {
  return Database.open({ file: ':memory:' })
}

function httpMonitor(db: Database, name: string) {
  return db.createMonitor({ type: 'http', name, intervalS: 60, retries: 1, retryIntervalS: 60, config: { url: `https://${name}.io` } })
}

function makeGroup(db: Database, memberIds: number[], strategy: string, percentage?: number) {
  return db.createMonitor({
    type: 'group',
    name: 'grp',
    intervalS: 20,
    retries: 1,
    retryIntervalS: 60,
    config: percentage === undefined ? { memberIds, strategy } : { memberIds, strategy, percentage },
  })
}

describe('GroupEngine', () => {
  it('evaluates any-up, all-up and percentage strategies', async () => {
    const db = makeDb()
    const { rec, onResult, broadcast } = makeRecordingEngine(db)
    const engine = new GroupEngine({ db, onResult, broadcast })

    const a = httpMonitor(db, 'a')
    const b = httpMonitor(db, 'b')
    db.insertHeartbeat({ monitorId: a.id, status: 'up' })
    db.insertHeartbeat({ monitorId: b.id, status: 'down' })

    const anyUp = makeGroup(db, [a.id, b.id], 'any-up')
    const allUp = makeGroup(db, [a.id, b.id], 'all-up')
    const pct = makeGroup(db, [a.id, b.id], 'percentage', 50)

    await engine.sweep(new Date('2026-01-01T00:00:00Z'))
    const statuses = Object.fromEntries(rec.results.map((r) => [r.id, r.status]))
    expect(statuses[anyUp.id]).toBe('up') // one member up
    expect(statuses[allUp.id]).toBe('down') // one member down
    expect(statuses[pct.id]).toBe('up') // 50% >= 50%
    db.close()
  })

  it('skips unchanged status and invalid configs', async () => {
    const db = makeDb()
    const { rec, onResult, broadcast } = makeRecordingEngine(db)
    const engine = new GroupEngine({ db, onResult, broadcast })
    const a = httpMonitor(db, 'a')
    db.insertHeartbeat({ monitorId: a.id, status: 'up' })
    makeGroup(db, [a.id], 'all-up')
    db.createMonitor({ type: 'group', name: 'bad', intervalS: 20, retries: 1, retryIntervalS: 60, config: { strategy: 'percentage' } })

    await engine.sweep(new Date('2026-01-01T00:00:00Z'))
    await engine.sweep(new Date('2026-01-01T00:00:25Z'))
    expect(rec.results).toHaveLength(1) // second sweep: unchanged
    db.close()
  })
})

describe('group-down notification suppression', () => {
  it('suppresses member notifications while the containing group is down', async () => {
    const db = makeDb()
    const member = httpMonitor(db, 'member')
    const group = db.createMonitor({
      type: 'group',
      name: 'grp',
      intervalS: 20,
      retries: 1,
      retryIntervalS: 60,
      config: { memberIds: [member.id], strategy: 'all-up' },
    })

    const isSuppressed = (monitorId: number): boolean => {
      const [latest] = db.listHeartbeats(group.id, { limit: 1 })
      return monitorId === member.id && latest?.status === 'down'
    }

    let notifierCalls = 0
    const engine = new IncidentEngine({
      db,
      notifier: {
        notifyMonitor: async () => {
          notifierCalls += 1
          return []
        },
      },
      tags: () => [],
      isSuppressed,
    })

    // Mark the group down (as GroupEngine would), then fail the member past its retries.
    db.insertHeartbeat({ monitorId: group.id, status: 'down' })
    for (let i = 0; i < member.retries; i++) {
      await engine.onResult(member, { status: 'down', latencyMs: 5 }, new Date())
    }
    expect(db.getOpenIncident(member.id)).not.toBeNull()
    expect(notifierCalls).toBe(0)
    db.close()
  })
})
