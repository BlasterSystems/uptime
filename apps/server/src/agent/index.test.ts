import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { Express } from 'express'
import request from 'supertest'
import { Database, SecretBox } from '@uptime/db'
import { createAgentRouter } from './index.js'

const TOKEN = 'agent-shared-token'
const KEY = 'a'.repeat(64)
const httpConfig = {
  method: 'GET',
  url: 'https://example.test/health',
  timeoutMs: 10_000,
  acceptedStatus: 'any',
}

let db: Database | undefined

function makeApp(token = TOKEN): Express {
  db = Database.open({ file: ':memory:' })
  const app = express()
  app.use(express.json())
  app.use('/api/v1/agent', createAgentRouter({ db, secrets: new SecretBox(KEY), token }))
  return app
}

function seedMonitors(): { activeId: number; groupId: number } {
  const database = db as Database
  const active = database.createMonitor({
    type: 'http',
    name: 'web',
    active: true,
    intervalS: 60,
    retries: 2,
    retryIntervalS: 30,
    config: httpConfig,
  })
  database.createMonitor({
    type: 'http',
    name: 'paused',
    active: false,
    intervalS: 60,
    retries: 2,
    retryIntervalS: 30,
    config: httpConfig,
  })
  const group = database.createMonitor({
    type: 'group',
    name: 'cluster',
    active: true,
    intervalS: 60,
    retries: 2,
    retryIntervalS: 30,
    config: { memberIds: [active.id], strategy: 'any-up' },
  })
  return { activeId: active.id, groupId: group.id }
}

afterEach(() => {
  db?.close()
  db = undefined
})

describe('agent hub', () => {
  it('returns active, non-group monitors as the default agent assignment', async () => {
    const app = makeApp()
    const { activeId, groupId } = seedMonitors()

    const res = await request(app).get('/api/v1/agent/assigned').set('x-agent-token', TOKEN)
    expect(res.status).toBe(200)
    expect(res.body.agentId).toBe('default')
    expect(res.body.monitors).toHaveLength(1)
    expect(res.body.monitors[0]).toEqual({
      id: activeId,
      type: 'http',
      name: 'web',
      intervalS: 60,
      retries: 2,
      retryIntervalS: 30,
      config: httpConfig,
    })
    expect(res.body.monitors.map((m: { id: number }) => m.id)).not.toContain(groupId)
  })

  it('rejects missing, wrong and disabled tokens on every route', async () => {
    const app = makeApp()
    seedMonitors()

    expect((await request(app).get('/api/v1/agent/assigned')).status).toBe(401)
    expect(
      (await request(app).get('/api/v1/agent/assigned').set('x-agent-token', 'agent-shared-tokeX'))
        .status,
    ).toBe(401)
    expect(
      (await request(app).get('/api/v1/agent/assigned').set('x-agent-token', 'short')).status,
    ).toBe(401)
    expect(
      (await request(app).get('/api/v1/agent/healthz').set('x-agent-token', 'nope')).status,
    ).toBe(401)
    expect(
      (
        await request(app)
          .post('/api/v1/agent/pulse')
          .set('x-agent-token', 'nope')
          .send({ results: [] })
      ).status,
    ).toBe(401)
    expect(
      (await request(app).get('/api/v1/agent/healthz').set('x-agent-token', TOKEN)).body,
    ).toEqual({ ok: true })

    // An unset UPTIME_AGENT_TOKEN disables the hub entirely.
    const disabled = makeApp('')
    expect(
      (await request(disabled).get('/api/v1/agent/healthz').set('x-agent-token', TOKEN)).status,
    ).toBe(401)
  })

  it('writes valid pulses, acks their ids and rejects malformed entries', async () => {
    const app = makeApp()
    const { activeId } = seedMonitors()
    const database = db as Database
    const first = new Date('2026-10-10T10:00:00.000Z')
    const second = first.getTime() + 1000

    const res = await request(app)
      .post('/api/v1/agent/pulse')
      .set('x-agent-token', TOKEN)
      .send({
        results: [
          {
            id: activeId,
            status: 'up',
            latencyMs: 12,
            responseSnippet: 'ok',
            time: first.toISOString(),
          },
          { id: activeId, status: 'down', latencyMs: 3, time: second },
          { id: 999, status: 'up', latencyMs: 1, time: first.toISOString() },
          { id: activeId, status: 'weird', latencyMs: 1, time: first.toISOString() },
          { id: activeId, status: 'up', latencyMs: -1, time: first.toISOString() },
          { id: activeId, status: 'up', latencyMs: 1, time: 'not-a-date' },
          { id: 'x', status: 'up', latencyMs: 1, time: first.toISOString() },
          'nope',
        ],
      })

    expect(res.status).toBe(200)
    expect(res.body.acked).toEqual([activeId, activeId])
    expect(res.body.rejected).toEqual([
      { id: 999, reason: 'unknown monitor' },
      { id: activeId, reason: 'invalid status' },
      { id: activeId, reason: 'invalid latencyMs' },
      { id: activeId, reason: 'invalid time' },
      { id: 'x', reason: 'invalid id' },
      { reason: 'result must be an object' },
    ])

    const beats = database.listHeartbeats(activeId)
    expect(beats).toHaveLength(2)
    expect(beats[0]).toMatchObject({ status: 'down', latencyMs: 3, time: new Date(second) })
    expect(beats[1]).toMatchObject({
      status: 'up',
      latencyMs: 12,
      responseSnippet: 'ok',
      time: first,
    })
  })

  it('rejects a malformed pulse envelope', async () => {
    const app = makeApp()
    expect(
      (await request(app).post('/api/v1/agent/pulse').set('x-agent-token', TOKEN).send({})).status,
    ).toBe(400)
    expect(
      (
        await request(app)
          .post('/api/v1/agent/pulse')
          .set('x-agent-token', TOKEN)
          .send({ results: 'nope' })
      ).status,
    ).toBe(400)
  })
})
