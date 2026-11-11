import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Agent } from 'supertest'
import type { Express } from 'express'
import { Database, SecretBox } from '@uptime/db'
import { Notifier } from '@uptime/notify'
import { createApp, normalizeTrustProxy } from './app.js'
import { createAuthModule } from './auth/index.js'
import { Metrics } from './metrics.js'

const KEY = 'a'.repeat(64)

function makeApp(eventHub?: unknown) {
  const db = Database.open({ file: ':memory:' })
  const secrets = new SecretBox(KEY)
  const app = createApp({
    db,
    secrets,
    notifier: new Notifier({
      channels: () => [],
      monitorChannelIds: () => [],
      defaultChannelIds: () => [],
    }),
    auth: createAuthModule({ db, secrets }),
    metrics: new Metrics(),
    ...(eventHub === undefined ? {} : { eventHub: eventHub as never }),
  })
  return { db, app }
}

async function authed(app: Express): Promise<{ agent: Agent; csrf: string }> {
  const agent = request.agent(app)
  const res = await agent
    .post('/api/v1/auth/setup')
    .send({ email: 'admin@example.com', password: 'password123' })
  expect(res.status).toBe(200)
  return { agent, csrf: res.body.csrfToken as string }
}

describe('M3 routes', () => {
  let app: Express
  let db: Database
  let agent: Agent
  let csrf: string

  beforeEach(async () => {
    const ctx = makeApp()
    app = ctx.app
    db = ctx.db
    const auth = await authed(app)
    agent = auth.agent
    csrf = auth.csrf
  })

  afterEach(() => {
    db?.close()
  })

  const post = (url: string, body: object) => agent.post(url).set('x-csrf-token', csrf).send(body)
  const patch = (url: string, body: object) => agent.patch(url).set('x-csrf-token', csrf).send(body)
  const del = (url: string) => agent.delete(url).set('x-csrf-token', csrf)
  const put = (url: string, body: object) => agent.put(url).set('x-csrf-token', csrf).send(body)

  it('manages status pages end-to-end', async () => {
    const created = await post('/api/v1/status-pages', {
      slug: 'corp',
      title: 'Corp Status',
      published: true,
      monitorIds: [],
    })
    expect(created.status).toBe(201)
    expect((await agent.get('/api/v1/status-pages')).body.statusPages).toHaveLength(1)

    // Public payload exists while published; 404 once unpublished.
    expect((await request(app).get('/api/v1/status/corp')).status).toBe(200)
    await patch(`/api/v1/status-pages/${created.body.statusPage.id}`, { published: false })
    expect((await request(app).get('/api/v1/status/corp')).status).toBe(404)

    expect((await del(`/api/v1/status-pages/${created.body.statusPage.id}`)).status).toBe(204)
    expect((await post('/api/v1/status-pages', { slug: 'BAD SLUG', title: 'x' })).status).toBe(400)
  })

  it('reads and writes instance settings', async () => {
    const initial = await agent.get('/api/v1/settings')
    expect(initial.body).toEqual({ title: 'Uptime Monitoring', timezone: 'UTC' })

    const saved = await put('/api/v1/settings', { title: 'Acme Uptime', timezone: 'Europe/Berlin' })
    expect(saved.status).toBe(200)
    expect(saved.body).toEqual({ title: 'Acme Uptime', timezone: 'Europe/Berlin' })
    expect((await put('/api/v1/settings', { title: '' })).status).toBe(400)
  })

  it('forwards TRUST_PROXY to express and normalizes it', () => {
    const db = Database.open({ file: ':memory:' })
    const secrets = new SecretBox(KEY)
    const app = createApp({
      db,
      secrets,
      notifier: new Notifier({ channels: () => [], monitorChannelIds: () => [], defaultChannelIds: () => [] }),
      auth: createAuthModule({ db, secrets }),
      metrics: new Metrics(),
      trustProxy: '1',
    })
    expect(app.get('trust proxy')).toBe(1)
    expect(normalizeTrustProxy('true')).toBe(true)
    expect(normalizeTrustProxy('loopback')).toBe('loopback')
    expect(normalizeTrustProxy('10.0.0.0/8,192.168.1.5')).toBe('10.0.0.0/8,192.168.1.5')
    db.close()
  })

  it('manages maintenance windows and coerces ISO dates', async () => {
    const created = await post('/api/v1/maintenance-windows', {
      name: 'nightly',
      scope: 'all',
      strategy: 'recurring-weekday',
      weekdays: [0, 6],
      startTime: '02:00',
      endTime: '04:00',
    })
    expect(created.status).toBe(201)
    expect((await agent.get('/api/v1/maintenance-windows')).body.windows).toHaveLength(1)

    const single = await post('/api/v1/maintenance-windows', {
      name: 'one-off',
      scope: 'all',
      strategy: 'single',
      startAt: '2026-01-01T00:00:00.000Z',
      endAt: '2026-01-02T00:00:00.000Z',
    })
    expect(single.status).toBe(201)
    expect(single.body.window.startAt).toBe('2026-01-01T00:00:00.000Z') // ISO-serialized

    expect((await del(`/api/v1/maintenance-windows/${created.body.window.id}`)).status).toBe(204)
    expect((await post('/api/v1/maintenance-windows', { name: 'x' })).status).toBe(400)

    // Unknown enum values are rejected before they reach SQLite (the text
    // columns carry no CHECK — a bad strategy would persist and silently
    // disable the window, rendering a blank Strategy cell in the UI).
    const badStrategy = await post('/api/v1/maintenance-windows', {
      name: 'x',
      scope: 'all',
      strategy: 'weekly',
    })
    expect(badStrategy.status).toBe(400)
    expect(badStrategy.body.error).toContain('strategy must be one of')
    const badScope = await post('/api/v1/maintenance-windows', {
      name: 'x',
      scope: 'some',
      strategy: 'single',
    })
    expect(badScope.status).toBe(400)
    expect(badScope.body.error).toContain('scope must be one of')

    const patchable = await post('/api/v1/maintenance-windows', {
      name: 'patchable',
      scope: 'all',
      strategy: 'single',
      startAt: '2026-01-01T00:00:00.000Z',
      endAt: '2026-01-02T00:00:00.000Z',
    })
    expect(patchable.status).toBe(201)
    expect(
      (
        await patch(`/api/v1/maintenance-windows/${patchable.body.window.id}`, {
          strategy: 'cronned',
        })
      ).status,
    ).toBe(400)
    const switched = await patch(`/api/v1/maintenance-windows/${patchable.body.window.id}`, {
      strategy: 'cron',
      cronExpr: '0 3 * * *',
      cronTz: 'UTC',
    })
    expect(switched.status).toBe(200)
    expect(switched.body.window.strategy).toBe('cron')
  })

  it('exposes the events endpoint when a hub is configured', async () => {
    const fakeHub = {
      handle: (_req: unknown, res: { end: () => void }) => res.end(),
      broadcast: () => {},
      stop: () => {},
      clientCount: 0,
    }
    const ctx = makeApp(fakeHub)
    const auth = await authed(ctx.app)
    const res = await auth.agent.get('/api/v1/events')
    expect(res.status).toBe(200)
  })
})
