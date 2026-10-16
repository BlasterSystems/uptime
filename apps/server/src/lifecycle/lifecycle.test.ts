import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import express, { type Express } from 'express'
import request from 'supertest'
import type { Agent } from 'supertest'
import { describe, expect, it, afterEach } from 'vitest'
import { Database, SecretBox } from '@uptime/db'

import { createAuthModule } from '../auth/index.js'
import { createLifecycleRouter } from './index.js'

const KEY = 'a'.repeat(64)

const httpConfig = {
  url: 'https://example.com/',
  method: 'GET',
  timeoutMs: 10_000,
  acceptedStatus: [200, 299],
}

const DAY_MS = 24 * 3600_000

interface Harness {
  db: Database
  app: Express
  dataDir: string
}

const harnesses: Harness[] = []

function makeApp(): Harness {
  const db = Database.open({ file: ':memory:' })
  const secrets = new SecretBox(KEY)
  const dataDir = mkdtempSync(join(tmpdir(), 'uptime-lifecycle-'))
  const auth = createAuthModule({ db, secrets })
  const app = express()
  app.use(express.json())
  app.use('/api/v1/auth', auth.router)
  app.use('/api/v1', createLifecycleRouter({ db, secrets, dataDir }))
  const harness = { db, app, dataDir }
  harnesses.push(harness)
  return harness
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.db.close()
    rmSync(harness.dataDir, { recursive: true, force: true })
  }
})

async function authed(app: Express): Promise<{ agent: Agent; csrf: string }> {
  const agent = request.agent(app)
  const res = await agent
    .post('/api/v1/auth/setup')
    .send({ email: 'admin@example.com', password: 'password123' })
  expect(res.status).toBe(200)
  return { agent, csrf: res.body.csrfToken as string }
}

describe('auth guard', () => {
  it('rejects lifecycle routes without a session', async () => {
    const { app } = makeApp()
    expect((await request(app).post('/api/v1/config/export')).status).toBe(401)
    expect((await request(app).post('/api/v1/config/import')).status).toBe(401)
    expect((await request(app).post('/api/v1/backup')).status).toBe(401)
    expect((await request(app).post('/api/v1/restore')).status).toBe(401)
    expect((await request(app).post('/api/v1/retention/run')).status).toBe(401)
    expect((await request(app).post('/api/v1/import/kuma')).status).toBe(401)
  })
})

describe('config export/import', () => {
  it('round-trips monitor configuration into a fresh database', async () => {
    const source = makeApp()
    const { agent, csrf } = await authed(source.app)
    const monitor = source.db.createMonitor({
      type: 'http',
      name: 'api',
      intervalS: 30,
      retries: 2,
      retryIntervalS: 45,
      config: httpConfig,
    })
    source.db.setMonitorTags(monitor.id, [source.db.createTag('prod').id])
    source.db.setSetting('title', 'Carrigo')
    source.db.setSetting('rollup_watermark', String(Date.now()))

    const exported = await agent.post('/api/v1/config/export').set('x-csrf-token', csrf)
    expect(exported.status).toBe(200)
    expect(exported.body.exportedAt).toEqual(expect.any(String))
    expect(exported.body.monitors).toEqual([
      expect.objectContaining({
        type: 'http',
        name: 'api',
        active: true,
        intervalS: 30,
        retries: 2,
        retryIntervalS: 45,
        tags: ['prod'],
        channels: [],
        config: httpConfig,
      }),
    ])
    // Internal rollup bookkeeping never leaves the instance.
    expect(exported.body.settings).toEqual({ title: 'Carrigo' })

    const target = makeApp()
    const { agent: targetAgent, csrf: targetCsrf } = await authed(target.app)
    const imported = await targetAgent
      .post('/api/v1/config/import')
      .set('x-csrf-token', targetCsrf)
      .send({ monitors: exported.body.monitors, settings: exported.body.settings })
    expect(imported.status).toBe(200)
    expect(imported.body).toEqual({ created: 1, updated: 0, skipped: 0 })

    const row = target.db.listMonitors()[0]
    expect(row).toMatchObject({
      type: 'http',
      name: 'api',
      intervalS: 30,
      retries: 2,
      retryIntervalS: 45,
      config: httpConfig,
    })
    expect(row?.id).toBeDefined()
    expect(target.db.listMonitorTagIds(row?.id ?? 0)).toHaveLength(1)
    expect(target.db.getSetting('title')).toBe('Carrigo')

    // A second import updates in place instead of duplicating.
    const again = await targetAgent
      .post('/api/v1/config/import')
      .set('x-csrf-token', targetCsrf)
      .send({ monitors: exported.body.monitors })
    expect(again.body).toEqual({ created: 0, updated: 1, skipped: 0 })
    expect(target.db.listMonitors()).toHaveLength(1)
  })

  it('skips group monitors and configs that fail schema validation', async () => {
    const { app, db } = makeApp()
    const { agent, csrf } = await authed(app)

    const res = await agent
      .post('/api/v1/config/import')
      .set('x-csrf-token', csrf)
      .send({
        monitors: [
          { type: 'group', name: 'all-apis', config: { memberIds: [1], strategy: 'all-up' } },
          { type: 'http', name: 'broken', config: { url: 'not-a-url' } },
          { type: 'http', name: 'ok', config: httpConfig },
        ],
      })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ created: 1, updated: 0, skipped: 2 })
    expect(db.listMonitors().map((monitor) => monitor.name)).toEqual(['ok'])
  })
})

describe('backup', () => {
  it('writes a non-empty SQLite snapshot under dataDir/backups', async () => {
    const { app, db, dataDir } = makeApp()
    const { agent, csrf } = await authed(app)
    db.createMonitor({
      type: 'http',
      name: 'api',
      intervalS: 60,
      retries: 1,
      retryIntervalS: 60,
      config: httpConfig,
    })

    const res = await agent.post('/api/v1/backup').set('x-csrf-token', csrf)
    expect(res.status).toBe(200)
    expect(res.body.path).toMatch(/^backups[\\/]uptime-.*\.db$/)

    const bytes = readFileSync(join(dataDir, res.body.path))
    expect(bytes.subarray(0, 15).toString('utf8')).toBe('SQLite format 3')
    expect(bytes.length).toBeGreaterThan(0)

    // The snapshot is a real database carrying the monitor.
    const copy = Database.open({ file: join(dataDir, res.body.path) })
    try {
      expect(copy.listMonitors().map((monitor) => monitor.name)).toEqual(['api'])
    } finally {
      copy.close()
    }
  })
})

describe('restore', () => {
  it('restores a snapshot taken through POST /backup and keeps a pre-restore copy', async () => {
    const { app, db, dataDir } = makeApp()
    const { agent, csrf } = await authed(app)
    const original = db.createMonitor({
      type: 'http',
      name: 'api',
      intervalS: 60,
      retries: 1,
      retryIntervalS: 60,
      config: httpConfig,
    })

    const backup = await agent.post('/api/v1/backup').set('x-csrf-token', csrf)
    expect(backup.status).toBe(200)

    // Mutate after the snapshot: replace the monitor set.
    db.deleteMonitor(original.id)
    db.createMonitor({
      type: 'http',
      name: 'mutant',
      intervalS: 60,
      retries: 1,
      retryIntervalS: 60,
      config: httpConfig,
    })

    const res = await agent
      .post('/api/v1/restore')
      .set('x-csrf-token', csrf)
      .send({ path: backup.body.path })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ restored: true })
    expect(db.listMonitors().map((monitor) => monitor.name)).toEqual(['api'])

    // The pre-restore snapshot of the mutated state is recoverable.
    const files = readdirSync(join(dataDir, 'backups'))
    expect(files.some((file) => file.startsWith('pre-restore-'))).toBe(true)
  })

  it('rejects paths that escape the backups directory', async () => {
    const { app, dataDir } = makeApp()
    const { agent, csrf } = await authed(app)
    const paths = [
      '../uptime.db',
      'backups/../uptime.db',
      '..',
      'backups/',
      join(dataDir, 'uptime.db'),
      '/etc/passwd',
    ]
    for (const path of paths) {
      const res = await agent.post('/api/v1/restore').set('x-csrf-token', csrf).send({ path })
      expect(res.status, path).toBe(400)
      expect(res.body, path).toEqual({ error: 'path must point inside the backups directory' })
    }

    for (const body of [{}, { path: '' }, { path: 42 }]) {
      const res = await agent.post('/api/v1/restore').set('x-csrf-token', csrf).send(body)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'path must be a non-empty string' })
    }
  })

  it('rejects missing and non-SQLite snapshots', async () => {
    const { app, dataDir } = makeApp()
    const { agent, csrf } = await authed(app)

    const missing = await agent
      .post('/api/v1/restore')
      .set('x-csrf-token', csrf)
      .send({ path: 'nope.db' })
    expect(missing.status).toBe(404)

    mkdirSync(join(dataDir, 'backups'), { recursive: true })
    writeFileSync(join(dataDir, 'backups', 'evil.db'), 'definitely not a SQLite database')
    const notSqlite = await agent
      .post('/api/v1/restore')
      .set('x-csrf-token', csrf)
      .send({ path: 'evil.db' })
    expect(notSqlite.status).toBe(400)
    expect(notSqlite.body).toEqual({ error: 'not a SQLite database' })
  })
})

describe('retention', () => {
  it('deletes raw heartbeats older than the cutoff and reports rollup coverage', async () => {
    const { app, db } = makeApp()
    const { agent, csrf } = await authed(app)
    const monitor = db.createMonitor({
      type: 'http',
      name: 'api',
      intervalS: 60,
      retries: 1,
      retryIntervalS: 60,
      config: httpConfig,
    })
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
    // Roll up only the 200-day-old beat: the watermark sits at now - 195 days.
    db.rollupHeartbeats(new Date(now - 195 * DAY_MS))

    const res = await agent.post('/api/v1/retention/run').set('x-csrf-token', csrf).send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ heartbeatsDeleted: 1, rolledupDeleted: 1 })
    expect(db.listHeartbeats(monitor.id).map((beat) => beat.time.getTime())).toEqual([now])

    // A narrower window deletes only the extra beat, not the fresh one.
    db.insertHeartbeat({
      monitorId: monitor.id,
      status: 'up',
      time: new Date(now - 2 * DAY_MS),
    })
    const narrow = await agent
      .post('/api/v1/retention/run')
      .set('x-csrf-token', csrf)
      .send({ days: 1 })
    expect(narrow.body).toEqual({ heartbeatsDeleted: 1, rolledupDeleted: 0 })
    expect(db.listHeartbeats(monitor.id).map((beat) => beat.time.getTime())).toEqual([now])

    const invalid = await agent
      .post('/api/v1/retention/run')
      .set('x-csrf-token', csrf)
      .send({ days: 0 })
    expect(invalid.status).toBe(400)
  })
})

describe('Kuma import', () => {
  it('creates monitors and heartbeats and is idempotent by name+type', async () => {
    const { app, db } = makeApp()
    const { agent, csrf } = await authed(app)
    const now = Date.now()
    const payload = {
      kumaVersion: '1.23.2',
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
        { monitorSlug: 'ghost', status: 'up', latencyMs: 1, time: now - 1_000 },
      ],
    }

    const first = await agent.post('/api/v1/import/kuma').set('x-csrf-token', csrf).send(payload)
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ monitorsCreated: 2, heartbeatsImported: 2 })

    const monitors = db.listMonitors()
    const shop = monitors.find((monitor) => monitor.name === 'shop')
    expect(shop).toMatchObject({ type: 'http', intervalS: 30, retries: 2 })
    expect(db.listHeartbeats(shop?.id ?? 0)).toHaveLength(2)
    // Rows without schedule fields fall back to the schema defaults.
    const tcp = monitors.find((monitor) => monitor.type === 'tcp')
    expect(tcp).toMatchObject({ intervalS: 60, retries: 1, retryIntervalS: 60 })

    const second = await agent.post('/api/v1/import/kuma').set('x-csrf-token', csrf).send(payload)
    expect(second.status).toBe(200)
    expect(second.body).toEqual({ monitorsCreated: 0, heartbeatsImported: 0 })
    expect(db.listMonitors()).toHaveLength(2)
    expect(db.listHeartbeats(shop?.id ?? 0)).toHaveLength(2)

    const malformed = await agent
      .post('/api/v1/import/kuma')
      .set('x-csrf-token', csrf)
      .send({ monitors: 'nope', heartbeats: [] })
    expect(malformed.status).toBe(400)
  })

  it('honors zero retries and falls back to defaults for out-of-range values', async () => {
    const { app, db } = makeApp()
    const { agent, csrf } = await authed(app)
    const res = await agent.post('/api/v1/import/kuma').set('x-csrf-token', csrf).send({
      kumaVersion: '1.23.2',
      monitors: [
        { type: 'http', name: 'zero', retries: 0, config: httpConfig },
        { type: 'http', name: 'over', retries: 101, config: httpConfig },
        { type: 'http', name: 'negative', retries: -1, config: httpConfig },
      ],
      heartbeats: [],
    })
    expect(res.status).toBe(200)
    // Import is lenient: out-of-range retries fall back to the default 1.
    expect(res.body).toEqual({ monitorsCreated: 3, heartbeatsImported: 0 })
    const retriesByName = Object.fromEntries(
      db.listMonitors().map((monitor) => [monitor.name, monitor.retries]),
    )
    expect(retriesByName).toEqual({ zero: 0, over: 1, negative: 1 })
  })
})
