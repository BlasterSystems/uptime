import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Agent } from 'supertest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Express } from 'express'
import { Database, SecretBox } from '@uptime/db'
import type { ScheduledMonitor } from '@uptime/core'
import { Notifier } from '@uptime/notify'
import { createApp, type SchedulerLike } from './app.js'
import { createAuthModule } from './auth/index.js'
import { IncidentEngine } from './incidents.js'
import { Metrics } from './metrics.js'

const KEY = 'a'.repeat(64)

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

const httpConfig = { url: 'https://example.com/', method: 'GET', timeoutMs: 10000, acceptedStatus: [200, 299] }

function makeNotifier(): Notifier {
  return new Notifier({
    channels: () => [],
    monitorChannelIds: () => [],
    defaultChannelIds: () => [],
  })
}

function makeApp() {
  const db = Database.open({ file: ':memory:' })
  const secrets = new SecretBox(KEY)
  const scheduler = new StubScheduler()
  const app = createApp({
    db,
    secrets,
    notifier: makeNotifier(),
    auth: createAuthModule({ db, secrets }),
    scheduler,
    metrics: new Metrics(),
    incidentEngine: new IncidentEngine({ db, notifier: makeNotifier(), tags: () => [] }),
  })
  return { db, app, scheduler }
}

async function authed(app: Express): Promise<{ agent: Agent; csrf: string }> {
  const agent = request.agent(app)
  const res = await agent.post('/api/v1/auth/setup').send({ email: 'admin@example.com', password: 'password123' })
  expect(res.status).toBe(200)
  return { agent, csrf: res.body.csrfToken as string }
}

describe('public endpoints', () => {
  it('serves healthz, state and metrics without auth', async () => {
    const { app } = makeApp()
    expect((await request(app).get('/healthz')).status).toBe(200)
    const state = await request(app).get('/api/v1/auth/state')
    expect(state.body).toEqual({ setupRequired: true })
    const metrics = await request(app).get('/metrics')
    expect(metrics.text).toContain('monitor_up')
  })

  it('rejects protected routes without a session', async () => {
    const { app } = makeApp()
    expect((await request(app).get('/api/v1/monitors')).status).toBe(401)
    expect((await request(app).get('/api/v1/incidents')).status).toBe(401)
    expect((await request(app).get('/api/v1/notifications')).status).toBe(401)
    expect((await request(app).get('/api/v1/tags')).status).toBe(401)
  })
})

describe('monitor CRUD (authenticated)', () => {
  let app: Express
  let db: Database
  let scheduler: StubScheduler
  let agent: Agent
  let csrf: string

  afterEach(() => {
    db?.close()
  })

  beforeEach(async () => {
    const ctx = makeApp()
    app = ctx.app
    db = ctx.db
    scheduler = ctx.scheduler
    const auth = await authed(app)
    agent = auth.agent
    csrf = auth.csrf
  })

  const post = (url: string, body: object) => agent.post(url).set('x-csrf-token', csrf).send(body)
  const patch = (url: string, body: object) => agent.patch(url).set('x-csrf-token', csrf).send(body)
  const del = (url: string) => agent.delete(url).set('x-csrf-token', csrf)

  it('creates, lists, patches and deletes a monitor with tags and channels', async () => {
    const channel = await post('/api/v1/notifications', {
      type: 'webhook',
      name: 'Ops hook',
      config: { url: 'https://hooks.example.com/x' },
    })
    expect(channel.status).toBe(201)
    const channelId = channel.body.channel.id as number

    const created = await post('/api/v1/monitors', {
      name: 'Example',
      type: 'http',
      config: httpConfig,
      tags: ['prod', 'web'],
      channelIds: [channelId],
    })
    expect(created.status).toBe(201)
    expect(created.body.monitor.tags.map((t: { name: string }) => t.name).sort()).toEqual(['prod', 'web'])
    expect(created.body.monitor.channelIds).toEqual([channelId])
    expect(scheduler.upserts).toHaveLength(1)

    const list = await agent.get('/api/v1/monitors')
    expect(list.status).toBe(200)
    expect(list.body.monitors).toHaveLength(1)
    expect(list.body.monitors[0].latestHeartbeat).toBeNull()

    const tags = await agent.get('/api/v1/tags')
    expect(tags.body.tags.map((t: { name: string }) => t.name).sort()).toEqual(['prod', 'web'])

    const patched = await patch(`/api/v1/monitors/${created.body.monitor.id}`, { intervalS: 120 })
    expect(patched.status).toBe(200)
    expect(patched.body.monitor.intervalS).toBe(120)
    expect(scheduler.upserts).toHaveLength(2)

    const deleted = await del(`/api/v1/monitors/${created.body.monitor.id}`)
    expect(deleted.status).toBe(204)
    expect(scheduler.removed).toEqual([created.body.monitor.id])
    expect((await agent.get(`/api/v1/monitors/${created.body.monitor.id}`)).status).toBe(404)
  })

  it('rejects invalid input and enforces CSRF', async () => {
    expect((await post('/api/v1/monitors', { name: 'x', config: { url: 'ftp://nope' } })).status).toBe(400)
    expect((await post('/api/v1/monitors', { name: 'x', intervalS: 5, config: httpConfig })).status).toBe(400)
    expect((await agent.post('/api/v1/monitors').send({ name: 'x', config: httpConfig })).status).toBe(403)
    expect((await post('/api/v1/monitors', { name: 'x', type: 'snmp', config: {} })).status).toBe(400)
  })

  it('serves heartbeats newest-first with a limit', async () => {
    const created = await post('/api/v1/monitors', { name: 'A', config: httpConfig })
    const id = created.body.monitor.id as number
    for (let i = 0; i < 3; i++) {
      db.insertHeartbeat({ monitorId: id, status: i === 2 ? 'down' : 'up', latencyMs: 10 + i })
    }
    const res = await agent.get(`/api/v1/monitors/${id}/heartbeats?limit=2`)
    expect(res.status).toBe(200)
    expect(res.body.heartbeats).toHaveLength(2)
    expect(res.body.heartbeats[0].status).toBe('down')
    const list = await agent.get('/api/v1/monitors')
    expect(list.body.monitors[0].latestHeartbeat.status).toBe('down')
  })
})

describe('push monitors', () => {
  let app: Express
  let db: Database
  let agent: Agent
  let csrf: string

  afterEach(() => {
    db?.close()
  })

  beforeEach(async () => {
    const ctx = makeApp()
    app = ctx.app
    db = ctx.db
    const auth = await authed(app)
    agent = auth.agent
    csrf = auth.csrf
  })

  const post = (url: string, body: object) => agent.post(url).set('x-csrf-token', csrf).send(body)

  it('creates a push monitor with a retrievable push URL and records pings', async () => {
    const created = await post('/api/v1/monitors', {
      name: 'Nightly job',
      type: 'push',
      intervalS: 60,
      config: { graceSeconds: 60 },
    })
    expect(created.status).toBe(201)
    const pushUrl = created.body.monitor.pushUrl as string
    expect(pushUrl).toMatch(/^\/api\/v1\/push\//)
    const token = pushUrl.split('/').pop() as string

    expect((await request(app).post(`/api/v1/push/${token}`)).status).toBe(200)
    expect((await request(app).get(`/api/v1/push/${token}`)).status).toBe(200)
    expect((await request(app).post('/api/v1/push/unknown')).status).toBe(404)

    const fail = await request(app).post(`/api/v1/push/${token}/fail?body=boom`)
    expect(fail.status).toBe(200)
    const beats = await agent.get(`/api/v1/monitors/${created.body.monitor.id}/heartbeats`)
    expect(beats.body.heartbeats[0].status).toBe('down')
    expect(beats.body.heartbeats[0].responseSnippet).toBe('boom')

    const incidents = await agent.get('/api/v1/incidents?active=1')
    expect(incidents.body.incidents).toHaveLength(1)
    expect(incidents.body.incidents[0].monitorName).toBe('Nightly job')

    // A plain ping recovers the incident.
    await request(app).post(`/api/v1/push/${token}`)
    const resolved = await agent.get('/api/v1/incidents?active=0')
    expect(resolved.body.incidents).toHaveLength(1)
  })

  it('rejects /start and /fail for non-push monitors', async () => {
    const created = await post('/api/v1/monitors', { name: 'Web', config: httpConfig })
    const push = await db.createPushToken(created.body.monitor.id)
    expect((await request(app).post(`/api/v1/push/${push}/start`)).status).toBe(400)
    expect((await request(app).post(`/api/v1/push/${push}/fail`)).status).toBe(400)
    expect((await request(app).post(`/api/v1/push/${push}`)).status).toBe(200)
  })

  it('records pending heartbeat on /start', async () => {
    const created = await post('/api/v1/monitors', { name: 'Job', type: 'push', config: { graceSeconds: 60 } })
    const token = (created.body.monitor.pushUrl as string).split('/').pop() as string
    expect((await request(app).post(`/api/v1/push/${token}/start`)).status).toBe(200)
    const beats = await agent.get(`/api/v1/monitors/${created.body.monitor.id}/heartbeats`)
    expect(beats.body.heartbeats[0].status).toBe('pending')
  })
})

describe('notification channels', () => {
  let app: Express
  let agent: Agent
  let csrf: string

  afterEach(() => {
    db?.close()
  })

  let db: Database

  beforeEach(async () => {
    const ctx = makeApp()
    app = ctx.app
    db = ctx.db
    const auth = await authed(app)
    agent = auth.agent
    csrf = auth.csrf
  })

  const post = (url: string, body: object) => agent.post(url).set('x-csrf-token', csrf).send(body)
  const del = (url: string) => agent.delete(url).set('x-csrf-token', csrf)

  it('creates, lists (without config), tests and deletes channels', async () => {
    const created = await post('/api/v1/notifications', {
      type: 'webhook',
      name: 'Ops',
      config: { url: 'https://hooks.example.internal/nope' },
    })
    expect(created.status).toBe(201)

    const list = await agent.get('/api/v1/notifications')
    expect(list.body.channels).toHaveLength(1)
    expect(list.body.channels[0].configEnc).toBeUndefined()
    expect(list.body.channels[0].config).toBeUndefined()

    // Test-send fails (connection refused) and surfaces the provider error.
    const test = await post(`/api/v1/notifications/${created.body.channel.id}/test`, {})
    expect(test.status).toBe(400)
    expect(typeof test.body.error).toBe('string')

    expect((await del(`/api/v1/notifications/${created.body.channel.id}`)).status).toBe(204)
    expect((await agent.get('/api/v1/notifications')).body.channels).toHaveLength(0)
  })

  it('rejects invalid channel type and config', async () => {
    expect((await post('/api/v1/notifications', { type: 'smoke-signals', name: 'x', config: {} })).status).toBe(400)
    expect((await post('/api/v1/notifications', { type: 'webhook', name: 'x', config: {} })).status).toBe(400)
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
    db = Database.open({ file: ':memory:' })
    const secrets = new SecretBox(KEY)
    const app = createApp({
      db,
      secrets,
      notifier: makeNotifier(),
      auth: createAuthModule({ db, secrets }),
      webDist: dir,
    })
    const res = await request(app).get('/monitors/123')
    expect(res.status).toBe(200)
    expect(res.text).toContain('shell')
    const apiMiss = await request(app).get('/api/v1/nope')
    expect(apiMiss.status).toBe(404)
    expect(apiMiss.body).toEqual({ error: 'not found' })
  })
})
