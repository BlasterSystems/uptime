import { describe, expect, it, vi } from 'vitest'
import { Database } from '@uptime/db'
import type { CheckResult } from '@uptime/core'
import { IncidentEngine } from '../incidents.js'
import { MaintenanceEngine } from '../maintenance.js'
import { createPulseIntegrator } from './integrate.js'

function makeDb() {
  return Database.open({ file: ':memory:' })
}

function monitor(db: Database) {
  return db.createMonitor({
    type: 'tcp',
    name: 'db-node',
    intervalS: 60,
    retries: 2,
    retryIntervalS: 30,
    config: { host: 'db.internal', port: 5432 },
  })
}

const BASE_TIME = Date.UTC(2026, 9, 10, 10, 0, 0)

describe('createPulseIntegrator', () => {
  it('persists the beat and fans out to metrics, SSE and the incident engine', async () => {
    const db = makeDb()
    try {
      const row = monitor(db)
      const metrics = { setMonitorUp: vi.fn(), setMaintenance: vi.fn(), observeLatency: vi.fn() }
      const hub = { broadcast: vi.fn() }
      const incidentEngine = { onResult: vi.fn().mockResolvedValue(undefined) }
      const integrate = createPulseIntegrator({
        db,
        metrics: metrics as never,
        hub: hub as never,
        incidentEngine: incidentEngine as never,
      })
      const time = new Date(BASE_TIME)

      integrate({ id: row.id, status: 'up', latencyMs: 7, time })

      expect(db.listHeartbeats(row.id)).toHaveLength(1)
      expect(metrics.setMonitorUp).toHaveBeenCalledWith(row.id, 'db-node', true)
      expect(metrics.observeLatency).toHaveBeenCalledWith(row.id, 'db-node', 7)
      expect(hub.broadcast).toHaveBeenCalledWith({
        type: 'heartbeat',
        monitorId: row.id,
        status: 'up',
        latencyMs: 7,
        time: time.toISOString(),
      })
      expect(incidentEngine.onResult).toHaveBeenCalledWith(
        expect.objectContaining({ id: row.id, name: 'db-node', retries: 2 }),
        { status: 'up', latencyMs: 7 } satisfies Partial<CheckResult>,
        time,
      )
    } finally {
      db.close()
    }
  })

  it('gates beats by maintenance and skips incident processing while under', () => {
    const db = makeDb()
    try {
      const row = monitor(db)
      db.createMaintenanceWindow({
        name: 'window',
        scope: 'ids',
        monitorIds: [row.id],
        strategy: 'single',
        startAt: new Date('2026-10-10T09:00:00.000Z'),
        endAt: new Date('2026-10-10T11:00:00.000Z'),
      })
      const maintenance = new MaintenanceEngine({
        db,
        tagIdsOf: (id) => db.listMonitorTagIds(id),
      })
      const metrics = { setMonitorUp: vi.fn(), setMaintenance: vi.fn(), observeLatency: vi.fn() }
      const incidentEngine = { onResult: vi.fn() }
      const integrate = createPulseIntegrator({
        db,
        metrics: metrics as never,
        maintenance,
        incidentEngine: incidentEngine as never,
      })

      integrate({ id: row.id, status: 'down', latencyMs: 3, time: new Date(BASE_TIME) })

      const [beat] = db.listHeartbeats(row.id)
      expect(beat?.status).toBe('maintenance')
      expect(metrics.setMonitorUp).toHaveBeenCalledWith(row.id, 'db-node', false)
      expect(metrics.setMaintenance).toHaveBeenCalledWith(row.id, 'db-node', true)
      expect(incidentEngine.onResult).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('opens incidents after enough consecutive down pulses and recovers on up', async () => {
    const db = makeDb()
    try {
      const row = monitor(db) // retries: 2
      const notified: Array<{ status: string; title: string }> = []
      const incidentEngine = new IncidentEngine({
        db,
        notifier: {
          notifyMonitor: async (_id, payload) => {
            notified.push({ status: payload.status, title: payload.title })
          },
        },
        tags: () => [],
      })
      const integrate = createPulseIntegrator({ db, incidentEngine })

      integrate({ id: row.id, status: 'down', latencyMs: 1, time: new Date(BASE_TIME) })
      integrate({ id: row.id, status: 'down', latencyMs: 1, time: new Date(BASE_TIME + 1000) })
      expect(db.getOpenIncident(row.id)).not.toBeNull()
      expect(notified.map((n) => n.status)).toEqual(['down'])

      integrate({ id: row.id, status: 'up', latencyMs: 5, time: new Date(BASE_TIME + 2000) })
      expect(db.getOpenIncident(row.id)).toBeNull()
      expect(notified.map((n) => n.status)).toEqual(['down', 'up'])
    } finally {
      db.close()
    }
  })
})
