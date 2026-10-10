import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Sqlite from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import { Database } from './index.js'
import type { MonitorRow, NewMonitor } from './index.js'

const HTTP_CONFIG = {
  method: 'GET',
  url: 'https://example.com/health',
  timeoutMs: 10_000,
  acceptedStatus: [200, 299],
}

function createHttpMonitor(db: Database, overrides: Partial<NewMonitor> = {}): MonitorRow {
  return db.createMonitor({
    type: 'http',
    name: 'example',
    intervalS: 60,
    retries: 1,
    retryIntervalS: 60,
    config: HTTP_CONFIG,
    ...overrides,
  })
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('migrations', () => {
  it('migrates an in-memory database', () => {
    const db = Database.open({ file: ':memory:' })
    try {
      const monitor = createHttpMonitor(db)
      expect(monitor.id).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('migrates a file database and keeps it in WAL mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptime-db-'))
    try {
      const db = Database.openDir(dir)
      const file = join(dir, 'uptime.db')
      try {
        expect(existsSync(file)).toBe(true)

        const raw = new Sqlite(file)
        try {
          expect(raw.pragma('journal_mode', { simple: true })).toBe('wal')
          const tables = raw
            .prepare<[], string>("select name from sqlite_master where type = 'table'")
            .pluck()
            .all()
          expect(tables).toEqual(
            expect.arrayContaining(['monitors', 'heartbeats', 'push_tokens', 'settings']),
          )
        } finally {
          raw.close()
        }

        const monitor = createHttpMonitor(db)
        expect(db.getMonitor(monitor.id)?.name).toBe('example')
      } finally {
        db.close()
      }

      // Re-opening an already migrated file must be a no-op, not an error.
      const reopened = Database.open({ file })
      try {
        expect(createHttpMonitor(reopened, { name: 'second' }).name).toBe('second')
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates nested data directories and enforces foreign keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptime-db-'))
    try {
      const db = Database.openDir(join(dir, 'nested', 'data'))
      try {
        expect(existsSync(join(dir, 'nested', 'data', 'uptime.db'))).toBe(true)
        expect(() => db.insertHeartbeat({ monitorId: 4242, status: 'up' })).toThrow()
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('monitors', () => {
  it('round-trips a monitor, defaults included', () => {
    const db = Database.open({ file: ':memory:' })
    try {
      const created = createHttpMonitor(db)
      expect(created).toMatchObject({
        type: 'http',
        name: 'example',
        active: true,
        intervalS: 60,
        retries: 1,
        retryIntervalS: 60,
        resendNotificationS: 0,
        upsideDown: false,
        parentMonitorId: null,
      })
      expect(created.config).toEqual(HTTP_CONFIG)
      expect(created.createdAt).toBeInstanceOf(Date)
      expect(created.updatedAt).toBeInstanceOf(Date)
      expect(created.createdAt.getTime()).toBe(created.updatedAt.getTime())

      expect(db.getMonitor(created.id)).toEqual(created)
      expect(db.getMonitor(created.id + 1000)).toBeNull()
    } finally {
      db.close()
    }
  })

  it('lists monitors and honours explicit options', () => {
    const db = Database.open({ file: ':memory:' })
    try {
      const parent = createHttpMonitor(db, { name: 'parent', active: false })
      const child = createHttpMonitor(db, {
        name: 'child',
        intervalS: 20,
        retries: 3,
        resendNotificationS: 600,
        upsideDown: true,
        parentMonitorId: parent.id,
        config: {
          method: 'HEAD',
          url: 'https://example.com',
          timeoutMs: 5000,
          acceptedStatus: 'any',
        },
      })

      expect(db.listMonitors().map((m) => m.id)).toEqual([parent.id, child.id])
      expect(db.getMonitor(parent.id)?.active).toBe(false)
      expect(child).toMatchObject({
        intervalS: 20,
        retries: 3,
        resendNotificationS: 600,
        upsideDown: true,
        parentMonitorId: parent.id,
      })
      expect(child.config).toEqual({
        method: 'HEAD',
        url: 'https://example.com',
        timeoutMs: 5000,
        acceptedStatus: 'any',
      })

      // Deleting the parent nulls the child's reference (ON DELETE SET NULL).
      expect(db.deleteMonitor(parent.id)).toBe(true)
      expect(db.getMonitor(child.id)?.parentMonitorId).toBeNull()
    } finally {
      db.close()
    }
  })

  it('patches only the provided fields and bumps updatedAt', () => {
    const db = Database.open({ file: ':memory:' })
    try {
      const created = createHttpMonitor(db)
      const config = { ...HTTP_CONFIG, url: 'https://example.org/health', keyword: { value: 'ok' } }
      const updated = db.updateMonitor(created.id, { name: 'renamed', config })

      expect(updated).not.toBeNull()
      expect(updated).toMatchObject({ id: created.id, name: 'renamed', type: 'http', retries: 1 })
      expect(updated?.config).toEqual(config)
      expect(updated?.createdAt).toEqual(created.createdAt)
      expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime())

      expect(db.updateMonitor(created.id + 1000, { name: 'nope' })).toBeNull()

      const deactivated = db.updateMonitor(created.id, {
        active: false,
        upsideDown: true,
        retryIntervalS: 15,
        resendNotificationS: 0,
      })
      expect(deactivated).toMatchObject({
        name: 'renamed',
        active: false,
        upsideDown: true,
        retryIntervalS: 15,
        resendNotificationS: 0,
      })
    } finally {
      db.close()
    }
  })
})

describe('heartbeats', () => {
  it('inserts and lists newest first with limit and before cursor', () => {
    const db = Database.open({ file: ':memory:' })
    try {
      const monitor = createHttpMonitor(db)
      const other = createHttpMonitor(db, { name: 'other' })
      const times = [1_700_000_000_000, 1_700_000_060_000, 1_700_000_120_000] as const
      for (const [index, ms] of times.entries()) {
        db.insertHeartbeat({
          monitorId: monitor.id,
          status: index === 1 ? 'down' : 'up',
          latencyMs: 10 + index,
          responseSnippet: `snippet ${index}`,
          time: new Date(ms),
        })
      }
      db.insertHeartbeat({ monitorId: other.id, status: 'up', time: new Date(times[2]) })

      const all = db.listHeartbeats(monitor.id)
      expect(all.map((h) => h.time.getTime())).toEqual([...times].reverse())
      expect(all[0]).toMatchObject({ status: 'up', latencyMs: 12, responseSnippet: 'snippet 2' })
      expect(db.listHeartbeats(monitor.id, { limit: 2 }).map((h) => h.time.getTime())).toEqual([
        times[2],
        times[1],
      ])
      expect(
        db.listHeartbeats(monitor.id, { before: new Date(times[1]) }).map((h) => h.time.getTime()),
      ).toEqual([times[0]])
      expect(db.listHeartbeats(other.id)).toHaveLength(1)

      const nullable = db.insertHeartbeat({
        monitorId: monitor.id,
        status: 'pending',
        time: new Date(times[0]),
      })
      expect(nullable).toMatchObject({ latencyMs: null, responseSnippet: null })
    } finally {
      db.close()
    }
  })

  it('defaults to the 100 most recent heartbeats', () => {
    const db = Database.open({ file: ':memory:' })
    try {
      const monitor = createHttpMonitor(db)
      const start = 1_700_000_000_000
      for (let index = 0; index < 105; index += 1) {
        db.insertHeartbeat({
          monitorId: monitor.id,
          status: 'up',
          time: new Date(start + index * 1000),
        })
      }
      const listed = db.listHeartbeats(monitor.id)
      expect(listed).toHaveLength(100)
      expect(listed[0]?.time.getTime()).toBe(start + 104_000)
      expect(listed.at(-1)?.time.getTime()).toBe(start + 5000)
      expect(db.listHeartbeats(monitor.id, { limit: 105 })).toHaveLength(105)
    } finally {
      db.close()
    }
  })

  it('cascades heartbeats when the monitor is deleted', () => {
    const db = Database.open({ file: ':memory:' })
    try {
      const monitor = createHttpMonitor(db)
      db.insertHeartbeat({ monitorId: monitor.id, status: 'up' })
      db.insertHeartbeat({ monitorId: monitor.id, status: 'down', responseSnippet: 'boom' })
      expect(db.listHeartbeats(monitor.id)).toHaveLength(2)

      expect(db.deleteMonitor(monitor.id)).toBe(true)
      expect(db.listHeartbeats(monitor.id)).toEqual([])
      expect(db.deleteMonitor(monitor.id)).toBe(false)
    } finally {
      db.close()
    }
  })
})

describe('push tokens', () => {
  it('stores only the hash and looks monitors up by it', () => {
    const db = Database.open({ file: ':memory:' })
    try {
      const monitor = createHttpMonitor(db)
      const token = db.createPushToken(monitor.id)
      expect(token).toMatch(/^[0-9a-f]{32}$/)

      expect(db.pushTokenLookup(sha256(token))).toBe(monitor.id)
      expect(db.pushTokenLookup(token)).toBeNull()
      expect(db.pushTokenLookup(sha256('someone-elses-token'))).toBeNull()

      const rotated = db.createPushToken(monitor.id)
      expect(rotated).toMatch(/^[0-9a-f]{32}$/)
      expect(rotated).not.toBe(token)
      expect(db.pushTokenLookup(sha256(token))).toBeNull()
      expect(db.pushTokenLookup(sha256(rotated))).toBe(monitor.id)
    } finally {
      db.close()
    }
  })

  it('cascades tokens when the monitor is deleted', () => {
    const db = Database.open({ file: ':memory:' })
    try {
      const monitor = createHttpMonitor(db)
      const hash = sha256(db.createPushToken(monitor.id))

      expect(db.deleteMonitor(monitor.id)).toBe(true)
      expect(db.pushTokenLookup(hash)).toBeNull()
    } finally {
      db.close()
    }
  })
})

describe('settings', () => {
  it('gets null for unknown keys and upserts values', () => {
    const db = Database.open({ file: ':memory:' })
    try {
      expect(db.getSetting('instance.title')).toBeNull()

      db.setSetting('instance.title', 'Uptime')
      db.setSetting('instance.timezone', 'Europe/Lisbon')
      expect(db.getSetting('instance.title')).toBe('Uptime')
      expect(db.getSetting('instance.timezone')).toBe('Europe/Lisbon')

      db.setSetting('instance.title', 'Uptime Monitoring')
      expect(db.getSetting('instance.title')).toBe('Uptime Monitoring')
    } finally {
      db.close()
    }
  })
})
