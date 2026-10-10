import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Database, type MonitorRow } from '@uptime/db'
import type { ScheduledMonitor } from '@uptime/core'
import { createApp, type SchedulerLike } from './app.js'
import { Metrics } from './metrics.js'

class StubScheduler implements SchedulerLike {
  upserts: ScheduledMonitor[] = []
  removed: number[] = []

  upsert(m: ScheduledMonitor): void {
    this.upserts.push(m)
  }

  remove(id: number): void {
    this.removed.push(id)
  }
}

function openDb() {
  return Database.open({ file: ':memory:' })
}

const httpConfig = { url: 'https://example.com/', method: 'GET', timeoutMs: 10000, acceptedStatus: [200, 299] }

function createHttpMonitor(db: Database, name = 'test'): MonitorRow {
  return db.createMonitor({ type: 'http', name, intervalS: 60, retries: 1, retryIntervalS: 60, config: httpConfig })
}

describe('healthz', () => {
  it('reports ok with a live db', async () => {
    const app = createApp({ db: openDb() })
    const res = await request(app).get('/healthz')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok', db: 'ok' })
  })
})

describe('monitor CRUD', () => {
  let scheduler: StubScheduler
  let db: Database

  afterEach(() => {
    db?.close()
  })

  function setup() {
    scheduler = new StubScheduler()
    db = openDb()
    return createApp({ db, scheduler })
  }

  it('creates a monitor, schedules it, and lists it', async () => {
    const app = setup()
    const res = await request(app).post('/api/v1/monitors').send({ name: 'Example', config: httpConfig })
    expect(res.status).toBe(201)
    expect(res.body.monitor.name).toBe('Example')
    expect(res.body.monitor.intervalS).toBe(60)
    expect(res.body.monitor.latestHeartbeat).toBeNull()

    const list = await request(app).get('/api/v1/monitors')
    expect(list.status).toBe(200)
    expect(list.body.monitors).toHaveLength(1)
    expect(scheduler.upserts).toHaveLength(1)
    expect(scheduler.upserts[0]?.name).toBe('Example')
    expect(scheduler.upserts[0]?.intervalS).toBe(60)
  })

  it('rejects invalid input with 400', async () => {
    const app = setup()
    const badUrl = await request(app).post('/api/v1/monitors').send({ name: 'x', config: { url: 'ftp://nope' } })
    expect(badUrl.status).toBe(400)
    const shortInterval = await request(app)
      .post('/api/v1/monitors')
      .send({ name: 'x', intervalS: 5, config: httpConfig })
    expect(shortInterval.status).toBe(400)
    const missingName = await request(app).post('/api/v1/monitors').send({ config: httpConfig })
    expect(missingName.status).toBe(400)
    expect(scheduler.upserts).toHaveLength(0)
  })

  it('patches and deletes a monitor', async () => {
    const app = setup()
    const created = await request(app).post('/api/v1/monitors').send({ name: 'A', config: httpConfig })
    const id = created.body.monitor.id

    const patched = await request(app).patch(`/api/v1/monitors/${id}`).send({ intervalS: 120 })
    expect(patched.status).toBe(200)
    expect(patched.body.monitor.intervalS).toBe(120)
    expect(scheduler.upserts).toHaveLength(2)
    expect(scheduler.upserts[1]?.intervalS).toBe(120)

    const deleted = await request(app).delete(`/api/v1/monitors/${id}`)
    expect(deleted.status).toBe(204)
    expect(scheduler.removed).toEqual([id])
    const gone = await request(app).get(`/api/v1/monitors/${id}`)
    expect(gone.status).toBe(404)
  })

  it('serves heartbeats newest-first with a limit', async () => {
    const app = setup()
    const created = await request(app).post('/api/v1/monitors').send({ name: 'A', config: httpConfig })
    const id = created.body.monitor.id as number
    for (let i = 0; i < 3; i++) {
      db.insertHeartbeat({ monitorId: id, status: i === 2 ? 'down' : 'up', latencyMs: 10 + i })
    }
    const res = await request(app).get(`/api/v1/monitors/${id}/heartbeats?limit=2`)
    expect(res.status).toBe(200)
    expect(res.body.heartbeats).toHaveLength(2)
    expect(res.body.heartbeats[0].status).toBe('down')
    const list = await request(app).get('/api/v1/monitors')
    expect(list.body.monitors[0].latestHeartbeat.status).toBe('down')
  })
})

describe('push receiver', () => {
  let db: Database

  afterEach(() => {
    db?.close()
  })

  it('records an up heartbeat for a known token and 404s unknown tokens', async () => {
    db = openDb()
    const metrics = new Metrics()
    const app = createApp({ db, metrics })
    const row = createHttpMonitor(db)
    const token = db.createPushToken(row.id)

    const push = await request(app).post(`/api/v1/push/${token}`)
    expect(push.status).toBe(200)
    const pushGet = await request(app).get(`/api/v1/push/${token}`)
    expect(pushGet.status).toBe(200)

    const beats = await request(app).get(`/api/v1/monitors/${row.id}/heartbeats`)
    expect(beats.body.heartbeats).toHaveLength(2)
    expect(beats.body.heartbeats.every((h: { status: string }) => h.status === 'up')).toBe(true)

    const unknown = await request(app).post('/api/v1/push/nope')
    expect(unknown.status).toBe(404)

    const metricsText = await request(app).get('/metrics')
    expect(metricsText.status).toBe(200)
    expect(metricsText.text).toContain('monitor_up')
  })
})

describe('push token hash contract', () => {
  it('looks up monitors by sha256 of the raw token', () => {
    const db = openDb()
    const row = createHttpMonitor(db)
    const token = db.createPushToken(row.id)
    const hash = createHash('sha256').update(token).digest('hex')
    expect(db.pushTokenLookup(hash)).toBe(row.id)
    expect(db.pushTokenLookup('deadbeef')).toBeNull()
    db.close()
  })
})

describe('static SPA fallback', () => {
  let dir: string
  let db: Database

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    db?.close()
  })

  it('serves index.html for deep links and 404 JSON for unknown api routes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'web-'))
    writeFileSync(join(dir, 'index.html'), '<html><body>shell</body></html>')
    db = openDb()
    const app = createApp({ db, webDist: dir })

    const deep = await request(app).get('/monitors/123')
    expect(deep.status).toBe(200)
    expect(deep.text).toContain('shell')

    const apiMiss = await request(app).get('/api/v1/nope')
    expect(apiMiss.status).toBe(404)
    expect(apiMiss.body).toEqual({ error: 'not found' })
  })
})
