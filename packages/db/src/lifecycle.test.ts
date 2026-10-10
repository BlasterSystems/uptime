import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Sqlite from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Database } from './index.js'
import type { KumaImportInput, MonitorRow } from './index.js'

const httpConfig = {
  url: 'https://example.com/',
  method: 'GET',
  timeoutMs: 10_000,
  acceptedStatus: [200, 299],
}

const DAY_MS = 24 * 3600_000

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function createHttpMonitor(db: Database, name = 'http'): MonitorRow {
  return db.createMonitor({
    type: 'http',
    name,
    intervalS: 60,
    retries: 1,
    retryIntervalS: 60,
    config: httpConfig,
  })
}

describe('backupTo', () => {
  it('writes a SQLite snapshot that a fresh Database can open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptime-backup-'))
    tempDirs.push(dir)
    // A file-backed source runs in WAL mode, like the real server.
    const source = Database.open({ file: join(dir, 'source.db') })
    const monitor = createHttpMonitor(source, 'api')
    source.insertHeartbeat({ monitorId: monitor.id, status: 'up', latencyMs: 42 })

    const file = join(dir, 'snapshot.db')
    await source.backupTo(file)
    source.close()

    const bytes = readFileSync(file)
    expect(bytes.subarray(0, 15).toString('utf8')).toBe('SQLite format 3')
    expect(bytes.length).toBeGreaterThan(0)

    const copy = Database.open({ file })
    expect(copy.listMonitors().map((row) => row.name)).toEqual(['api'])
    expect(copy.listHeartbeats(monitor.id)).toMatchObject([{ status: 'up', latencyMs: 42 }])
    copy.close()
  })
})

describe('restoreFrom', () => {
  it('replaces the live rows with the snapshot content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptime-restore-'))
    tempDirs.push(dir)
    const db = Database.open({ file: join(dir, 'live.db') })
    try {
      const monitor = createHttpMonitor(db, 'api')
      db.insertHeartbeat({ monitorId: monitor.id, status: 'up', latencyMs: 42 })

      const snapshot = join(dir, 'snapshot.db')
      await db.backupTo(snapshot)

      // Mutate after the snapshot: an extra monitor and an extra heartbeat.
      createHttpMonitor(db, 'mutant')
      db.insertHeartbeat({ monitorId: monitor.id, status: 'down' })
      expect(db.listMonitors().map((row) => row.name)).toEqual(['api', 'mutant'])

      await db.restoreFrom(snapshot)

      expect(db.listMonitors().map((row) => row.name)).toEqual(['api'])
      expect(db.listHeartbeats(monitor.id)).toMatchObject([{ status: 'up', latencyMs: 42 }])
    } finally {
      db.close()
    }
  })

  it('restores a snapshot that predates a schema column', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptime-restore-'))
    tempDirs.push(dir)
    const db = Database.open({ file: join(dir, 'live.db') })
    try {
      createHttpMonitor(db, 'api')
      const snapshot = join(dir, 'snapshot.db')
      await db.backupTo(snapshot)

      // Simulate a snapshot taken before a migration added the column.
      const old = new Sqlite(snapshot)
      old.exec('ALTER TABLE monitors DROP COLUMN resend_notification_s')
      old.close()

      await db.restoreFrom(snapshot)
      expect(db.listMonitors().map((row) => row.name)).toEqual(['api'])
    } finally {
      db.close()
    }
  })

  it('rejects a missing snapshot and leaves the database usable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptime-restore-'))
    tempDirs.push(dir)
    const db = Database.open({ file: join(dir, 'live.db') })
    try {
      createHttpMonitor(db, 'api')

      await expect(db.restoreFrom(join(dir, 'nope.db'))).rejects.toThrowError(/snapshot not found/)
      expect(db.listMonitors().map((row) => row.name)).toEqual(['api'])
    } finally {
      db.close()
    }
  })

  it('rejects a file that is not a SQLite database without touching the live rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptime-restore-'))
    tempDirs.push(dir)
    const db = Database.open({ file: join(dir, 'live.db') })
    try {
      createHttpMonitor(db, 'api')
      const garbage = join(dir, 'garbage.db')
      writeFileSync(garbage, 'this is definitely not a SQLite database')

      await expect(db.restoreFrom(garbage)).rejects.toThrow()
      expect(db.listMonitors().map((row) => row.name)).toEqual(['api'])
    } finally {
      db.close()
    }
  })
})

describe('heartbeat retention', () => {
  let db: Database

  beforeEach(() => {
    db = Database.open({ file: ':memory:' })
  })

  afterEach(() => {
    db.close()
  })

  it('deleteRolledupBefore finds nothing to drop without a rollup watermark', () => {
    const monitor = createHttpMonitor(db)
    const now = Date.now()
    db.insertHeartbeat({
      monitorId: monitor.id,
      status: 'up',
      time: new Date(now - 200 * DAY_MS),
    })

    const cutoff = new Date(now - 180 * DAY_MS)
    expect(db.deleteRolledupBefore(cutoff)).toBe(0)
    expect(db.deleteHeartbeatsBefore(cutoff)).toBe(1)
  })

  it('splits rolled-up beats from unaggregated ones at the cutoff', () => {
    const monitor = createHttpMonitor(db)
    const now = Date.now()
    db.insertHeartbeat({
      monitorId: monitor.id,
      status: 'up',
      time: new Date(now - 200 * DAY_MS),
    })
    db.insertHeartbeat({
      monitorId: monitor.id,
      status: 'down',
      time: new Date(now - 190 * DAY_MS),
    })
    db.insertHeartbeat({ monitorId: monitor.id, status: 'up', time: new Date(now) })
    // The watermark covers only the 200-day-old beat.
    db.rollupHeartbeats(new Date(now - 195 * DAY_MS))

    const cutoff = new Date(now - 180 * DAY_MS)
    expect(db.deleteRolledupBefore(cutoff)).toBe(1)
    expect(db.deleteHeartbeatsBefore(cutoff)).toBe(1)
    expect(db.listHeartbeats(monitor.id).map((row) => row.time.getTime())).toEqual([now])
  })
})

describe('insertHeartbeatsBatch', () => {
  it('inserts a batch in one call and treats an empty batch as a no-op', () => {
    const db = Database.open({ file: ':memory:' })
    try {
      const monitor = createHttpMonitor(db)
      const now = Date.now()

      db.insertHeartbeatsBatch([])
      expect(db.listHeartbeats(monitor.id)).toHaveLength(0)

      db.insertHeartbeatsBatch([
        { monitorId: monitor.id, status: 'up', latencyMs: 12, time: new Date(now - 1000) },
        { monitorId: monitor.id, status: 'down', latencyMs: null, time: new Date(now) },
        { monitorId: monitor.id, status: 'up', time: new Date(now - 2000) },
      ])

      const beats = db.listHeartbeats(monitor.id)
      expect(beats).toHaveLength(3)
      expect(beats[0]).toMatchObject({ status: 'down', latencyMs: null })
      expect(beats[1]).toMatchObject({ status: 'up', latencyMs: 12 })
      expect(beats[2]?.latencyMs).toBeNull()
    } finally {
      db.close()
    }
  })
})

describe('importKuma', () => {
  it('creates monitors, imports heartbeats and is idempotent by name+type', () => {
    const db = Database.open({ file: ':memory:' })
    try {
      const now = Date.now()
      const input: KumaImportInput = {
        monitors: [
          {
            type: 'http',
            name: 'shop',
            intervalS: 30,
            retries: 2,
            retryIntervalS: 60,
            config: httpConfig,
          },
          { type: 'tcp', name: 'db', config: { host: 'db.internal', port: 5432, timeoutMs: 5000 } },
        ],
        heartbeats: [
          { monitorSlug: 'shop', status: 'up', latencyMs: 120, time: now - 60_000 },
          { monitorSlug: 'shop', status: 'down', latencyMs: null, time: now - 30_000 },
          { monitorSlug: 'db', status: 'up', latencyMs: 3.6, time: now - 10_000 },
          { monitorSlug: 'ghost', status: 'up', latencyMs: 1, time: now - 1_000 },
        ],
      }

      expect(db.importKuma(input)).toEqual({ monitorsCreated: 2, heartbeatsImported: 3 })
      const monitors = db.listMonitors()
      const shop = monitors.find((row) => row.name === 'shop')
      expect(shop).toMatchObject({ type: 'http', intervalS: 30, retries: 2, config: httpConfig })
      expect(db.listHeartbeats(shop?.id ?? 0)).toHaveLength(2)
      const tcp = monitors.find((row) => row.name === 'db')
      // Kuma's fractional latency is rounded to the integer millisecond column.
      expect(db.listHeartbeats(tcp?.id ?? 0)).toMatchObject([{ status: 'up', latencyMs: 4 }])
      // Rows without interval/retries fall back to the column defaults.
      expect(tcp).toMatchObject({ type: 'tcp', intervalS: 60, retries: 1, retryIntervalS: 60 })

      // Re-running the same import is a no-op for monitors and heartbeats alike.
      expect(db.importKuma(input)).toEqual({ monitorsCreated: 0, heartbeatsImported: 0 })
      expect(db.listMonitors()).toHaveLength(2)

      // Same name with a different type is a monitor of its own.
      expect(
        db.importKuma({
          monitors: [{ type: 'http', name: 'db', config: httpConfig }],
          heartbeats: [],
        }),
      ).toEqual({ monitorsCreated: 1, heartbeatsImported: 0 })
      expect(db.listMonitors()).toHaveLength(3)

      // Entries that cannot be mapped are skipped, never fatal.
      expect(
        db.importKuma({
          monitors: [{ type: '', name: 'broken', config: {} }],
          heartbeats: [{ monitorSlug: 'broken', status: 'up', latencyMs: 1, time: now }],
        }),
      ).toEqual({ monitorsCreated: 0, heartbeatsImported: 0 })
    } finally {
      db.close()
    }
  })
})
