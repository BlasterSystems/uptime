import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Agent } from 'supertest'
import type { Express } from 'express'
import { Database, SecretBox } from '@uptime/db'
import { Notifier } from '@uptime/notify'
import { createApp } from './app.js'
import { createAuthModule } from './auth/index.js'
import { Metrics } from './metrics.js'

const KEY = 'a'.repeat(64)
const PRIVATE_URL = 'https://internal.example.internal/health'

const HTTP_CONFIG = {
  url: PRIVATE_URL,
  method: 'GET',
  timeoutMs: 10000,
  acceptedStatus: [200, 299],
}

function makeApp(): { app: Express; db: Database } {
  const db = Database.open({ file: ':memory:' })
  const secrets = new SecretBox(KEY)
  const app = createApp({
    db,
    secrets,
    notifier: new Notifier({ channels: () => [], monitorChannelIds: () => [], defaultChannelIds: () => [] }),
    auth: createAuthModule({ db, secrets }),
    metrics: new Metrics(),
  })
  return { db, app }
}

function createMonitor(
  db: Database,
  name: string,
  overrides: { isPublic?: boolean; active?: boolean } = {},
): number {
  return db.createMonitor({
    type: 'http',
    name,
    intervalS: 60,
    retries: 1,
    retryIntervalS: 60,
    config: HTTP_CONFIG,
    ...overrides,
  }).id
}

async function authed(app: Express): Promise<{ agent: Agent; csrf: string }> {
  const agent = request.agent(app)
  const res = await agent.post('/api/v1/auth/setup').send({ email: 'admin@example.com', password: 'password123' })
  expect(res.status).toBe(200)
  return { agent, csrf: res.body.csrfToken as string }
}

describe('public status overview', () => {
  let app: Express
  let db: Database

  beforeEach(() => {
    const ctx = makeApp()
    app = ctx.app
    db = ctx.db
  })

  afterEach(() => {
    db.close()
  })

  it('serves only public monitors without authentication and leaks no config', async () => {
    createMonitor(db, 'private', { isPublic: false })
    const publicId = createMonitor(db, 'public-api', { isPublic: true })
    db.insertHeartbeat({ monitorId: publicId, status: 'up', latencyMs: 12, time: new Date() })
    db.setSetting('title', 'Acme Status')

    const res = await request(app).get('/api/v1/public/status')
    expect(res.status).toBe(200)
    expect(res.body.title).toBe('Acme Status')
    expect(res.body.overall).toBe('operational')
    expect(res.body.services.map((s: { name: string }) => s.name)).toEqual(['public-api'])
    expect(res.body.services[0]).toMatchObject({ status: 'up', latencyMs: 12, paused: false })

    // The private monitor's name and its target URL must not appear anywhere.
    const body = JSON.stringify(res.body)
    expect(body).not.toContain('private')
    expect(body).not.toContain(PRIVATE_URL)
    expect(body).not.toContain('config')
  })

  it('flags paused services and excludes them from the overall status', async () => {
    const downId = createMonitor(db, 'down-service', { isPublic: true })
    createMonitor(db, 'paused-service', { isPublic: true, active: false })
    db.insertHeartbeat({ monitorId: downId, status: 'down', time: new Date() })

    const res = await request(app).get('/api/v1/public/status')
    expect(res.status).toBe(200)
    expect(res.body.overall).toBe('outage')
    const down = res.body.services.find((s: { name: string }) => s.name === 'down-service')
    const paused = res.body.services.find((s: { name: string }) => s.name === 'paused-service')
    expect(down).toMatchObject({ status: 'down', paused: false })
    expect(paused).toMatchObject({ paused: true })
  })

  it('toggles visibility through the monitor PATCH endpoint', async () => {
    const { agent, csrf } = await authed(app)
    const monitorId = createMonitor(db, 'toggle-me')

    const before = await request(app).get('/api/v1/public/status')
    expect(before.body.services).toEqual([])

    const patched = await agent
      .patch(`/api/v1/monitors/${monitorId}`)
      .set('x-csrf-token', csrf)
      .send({ isPublic: true })
    expect(patched.status).toBe(200)
    expect(patched.body.monitor.isPublic).toBe(true)

    const after = await request(app).get('/api/v1/public/status')
    expect(after.body.services.map((s: { id: number }) => s.id)).toEqual([monitorId])
    expect(after.body.services[0]).toMatchObject({ status: 'pending' })
  })

  it('rejects a non-boolean isPublic on create and patch', async () => {
    const { agent, csrf } = await authed(app)

    const created = await agent
      .post('/api/v1/monitors')
      .set('x-csrf-token', csrf)
      .send({ name: 'x', intervalS: 60, retries: 1, retryIntervalS: 60, config: HTTP_CONFIG, isPublic: 'yes' })
    expect(created.status).toBe(400)

    const monitorId = createMonitor(db, 'x')
    const patched = await agent
      .patch(`/api/v1/monitors/${monitorId}`)
      .set('x-csrf-token', csrf)
      .send({ isPublic: 1 })
    expect(patched.status).toBe(400)
  })
})
