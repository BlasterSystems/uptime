import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Agent } from 'supertest'
import type { Express } from 'express'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database, SecretBox } from '@uptime/db'
import { Notifier } from '@uptime/notify'
import { createApp } from './app.js'
import { createAuthModule } from './auth/index.js'
import { Metrics } from './metrics.js'

const KEY = 'a'.repeat(64)

function makeApp(webDist?: string) {
  const db = Database.open({ file: ':memory:' })
  const secrets = new SecretBox(KEY)
  const app = createApp({
    db,
    secrets,
    notifier: new Notifier({ channels: () => [], monitorChannelIds: () => [], defaultChannelIds: () => [] }),
    auth: createAuthModule({ db, secrets }),
    metrics: new Metrics(),
    ...(webDist === undefined ? {} : { webDist }),
  })
  return { db, app, secrets }
}

async function authed(app: Express): Promise<{ agent: Agent; csrf: string }> {
  const agent = request.agent(app)
  const res = await agent.post('/api/v1/auth/setup').send({ email: 'admin@example.com', password: 'password123' })
  expect(res.status).toBe(200)
  return { agent, csrf: res.body.csrfToken as string }
}

describe('status page API', () => {
  let app: Express
  let db: Database
  let agent: Agent
  let csrf: string
  let monitorId: number

  beforeEach(async () => {
    const ctx = makeApp()
    app = ctx.app
    db = ctx.db
    const auth = await authed(app)
    agent = auth.agent
    csrf = auth.csrf
    monitorId = db.createMonitor({
      type: 'http',
      name: 'API monitor',
      intervalS: 60,
      retries: 1,
      retryIntervalS: 60,
      config: { url: 'https://api.example.com', method: 'GET', timeoutMs: 1000, acceptedStatus: [200, 299] },
    }).id
  })

  afterEach(() => {
    db?.close()
  })

  const post = (url: string, body: object) => agent.post(url).set('x-csrf-token', csrf).send(body)
  const patch = (url: string, body: object) => agent.patch(url).set('x-csrf-token', csrf).send(body)
  const del = (url: string) => agent.delete(url).set('x-csrf-token', csrf)

  function structure() {
    return { groups: [{ name: 'Backend', components: [{ id: 'api', label: 'API', monitorIds: [monitorId] }] }] }
  }

  async function createPage(extra: Record<string, unknown> = {}) {
    const res = await post('/api/v1/status-pages', {
      slug: 'acme',
      title: 'Acme Status',
      published: true,
      monitorIds: [monitorId],
      structure: structure(),
      ...extra,
    })
    expect(res.status).toBe(201)
    return res.body.statusPage
  }

  it('stores the normalized structure and hides password material', async () => {
    const page = await createPage({ password: 'letmein', footerText: 'Acme Inc' })
    expect(page.hasPassword).toBe(true)
    expect(page.passwordHash).toBeUndefined()
    expect(page.footerText).toBe('Acme Inc')
    expect(page.structure.groups[0].components[0]).toMatchObject({ id: 'api', aggregation: 'worst' })

    const list = await agent.get('/api/v1/status-pages')
    expect(list.body.statusPages[0].structure.groups).toHaveLength(1)

    const cleared = await patch(`/api/v1/status-pages/${page.id}`, { password: null, footerText: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body.statusPage.hasPassword).toBe(false)

    expect((await post('/api/v1/status-pages', { slug: 'bad', title: 'x', structure: { groups: [{ name: 'g', components: [{ id: 'BAD ID', label: 'x', monitorIds: [1] }] }] } })).status).toBe(400)
  })

  it('serves the public payload with severity and per-component data', async () => {
    db.insertHeartbeat({ monitorId, status: 'up', latencyMs: 12 })
    await createPage()
    const res = await request(app).get('/api/v1/status/acme')
    expect(res.status).toBe(200)
    expect(res.body.overall).toBe('operational')
    const component = res.body.groups[0].components[0]
    expect(component.status).toBe('operational')
    expect(component.monitors[0]).toMatchObject({ id: monitorId, status: 'up', latencyMs: 12 })
    expect(component.daily.length).toBe(90)
    expect(component.series).toBeUndefined()
    expect(res.body.passwordRequired).toBe(false)
    expect((await request(app).get('/api/v1/status/nope')).status).toBe(404)
  })

  it('gates password pages until unlocked', async () => {
    db.insertHeartbeat({ monitorId, status: 'up', latencyMs: 5 })
    await createPage({ password: 'letmein' })
    const locked = await request(app).get('/api/v1/status/acme')
    expect(locked.status).toBe(401)
    expect(locked.body).toEqual({ error: 'password_required' })

    const bad = await request(app).post('/api/v1/status/acme/unlock').send({ password: 'wrong' })
    expect(bad.status).toBe(401)

    const browser = request.agent(app)
    const good = await browser.post('/api/v1/status/acme/unlock').send({ password: 'letmein' })
    expect(good.status).toBe(204)
    expect((await browser.get('/api/v1/status/acme')).status).toBe(200)
    expect((await browser.get('/status/acme/badge.svg')).status).toBe(200)
    // Without the cookie the feeds/badge stay hidden.
    expect((await request(app).get('/status/acme/rss.xml')).status).toBe(404)
  })

  it('manages manual incidents with update timelines', async () => {
    await createPage()
    const created = await post('/api/v1/status-pages/1/incidents', {
      title: 'Database maintenance',
      impact: 'minor',
      componentIds: ['api'],
      body: 'We are applying a migration.',
    })
    expect(created.status).toBe(201)
    expect(created.body.incident.updates).toHaveLength(2) // title + body

    const updated = await post(`/api/v1/status-incidents/${created.body.incident.id}/updates`, {
      status: 'monitoring',
      body: 'Migration applied, verifying.',
    })
    expect(updated.status).toBe(200)

    const resolved = await post(`/api/v1/status-incidents/${created.body.incident.id}/updates`, {
      status: 'resolved',
      body: 'All good.',
    })
    expect(resolved.body.incident.resolvedAt).not.toBeNull()

    const list = await agent.get('/api/v1/status-pages/1/incidents')
    expect(list.body.incidents).toHaveLength(1)
    expect(list.body.incidents[0].updates).toHaveLength(4)

    expect((await post('/api/v1/status-incidents/1/updates', { status: 'nope', body: 'x' })).status).toBe(400)
    expect((await post('/api/v1/status-pages/1/incidents', { title: '' })).status).toBe(400)
  })

  it('publishes monitor incidents automatically and resolves them', async () => {
    await createPage()
    const { autoPublishIncident, autoResolveIncidents } = await import('./status-pages.js')
    const deps = { db, dispatch: async () => {} }
    expect(await autoPublishIncident(deps, monitorId, { title: 'x', body: 'y' })).toBe(1)
    const public1 = await request(app).get('/api/v1/status/acme')
    expect(public1.body.incidents).toHaveLength(1)
    expect(public1.body.overall).toBe('unknown') // no heartbeats yet

    await autoResolveIncidents(deps, monitorId, 'recovered')
    const public2 = await request(app).get('/api/v1/status/acme')
    expect(public2.body.incidents).toHaveLength(0)
    const archive = await request(app).get('/api/v1/status/acme/incidents')
    expect(archive.body.incidents).toHaveLength(1)
  })

  it('manages channel subscriptions and test-sends', async () => {
    await createPage()
    const channel = await post('/api/v1/notifications', {
      type: 'webhook',
      name: 'ops hook',
      config: { url: 'https://hooks.example.invalid/status' },
    })
    expect(channel.status).toBe(201)

    const created = await post('/api/v1/status-pages/1/subscriptions', {
      channelId: channel.body.channel.id,
      events: ['incident_open', 'incident_resolved'],
      componentIds: ['api'],
    })
    expect(created.status).toBe(201)

    // Duplicate channel for the same page → 400.
    expect((await post('/api/v1/status-pages/1/subscriptions', { channelId: channel.body.channel.id })).status).toBe(400)

    const list = await agent.get('/api/v1/status-pages/1/subscriptions')
    expect(list.body.subscriptions).toHaveLength(1)
    expect(list.body.subscriptions[0].channelName).toBe('ops hook')

    // Delivery to an unreachable webhook surfaces as 400 on the test route.
    const test = await post(`/api/v1/status-subscriptions/${created.body.subscription.id}/test`, {})
    expect(test.status).toBe(400)

    expect((await del(`/api/v1/status-subscriptions/${created.body.subscription.id}`)).status).toBe(204)
    expect((await agent.get('/api/v1/status-pages/1/subscriptions')).body.subscriptions).toHaveLength(0)
  })

  it('serves feeds and badges', async () => {
    db.insertHeartbeat({ monitorId, status: 'down', latencyMs: null })
    const page = await createPage()
    await post(`/api/v1/status-pages/${page.id}/incidents`, { title: 'Outage & fire', impact: 'critical' })

    const rss = await request(app).get('/status/acme/rss.xml')
    expect(rss.status).toBe(200)
    expect(rss.headers['content-type']).toContain('rss')
    expect(rss.text).toContain('Outage &amp; fire')

    const atom = await request(app).get('/status/acme/atom.xml')
    expect(atom.status).toBe(200)
    expect(atom.text).toContain('<feed')

    const badge = await request(app).get('/status/acme/badge.svg')
    expect(badge.status).toBe(200)
    expect(badge.headers['content-type']).toContain('svg')
    expect(badge.body.toString('utf8')).toContain('#ef4444') // major outage color (monitor down)

    const componentBadge = await request(app).get('/status/acme/badge.svg?component=api')
    expect(componentBadge.status).toBe(200)
    expect(componentBadge.body.toString('utf8')).toContain('#ef4444')
  })
})

describe('status page OG shell', () => {
  let dir: string
  let db: Database

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    db?.close()
  })

  it('injects OG meta into the SPA shell for status routes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'web-'))
    writeFileSync(join(dir, 'index.html'), '<html><head><title>App</title></head><body>shell</body></html>')
    const ctx = makeApp(dir)
    db = ctx.db
    const { agent, csrf } = await authed(ctx.app)
    const created = await agent
      .post('/api/v1/status-pages')
      .set('x-csrf-token', csrf)
      .send({ slug: 'acme', title: 'Acme Status', published: true, monitorIds: [], structure: { groups: [] } })
    expect(created.status).toBe(201)

    const res = await request(ctx.app).get('/status/acme')
    expect(res.status).toBe(200)
    expect(res.text).toContain('og:title')
    expect(res.text).toContain('Acme Status — status')
    expect(res.text).toContain('shell')
  })
})
