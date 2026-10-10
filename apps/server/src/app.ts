import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { MIN_INTERVAL_S, parseMonitorConfig } from '@uptime/core'
import type { ScheduledMonitor } from '@uptime/core'
import type { Database, HeartbeatRow, MonitorRow, NewMonitor } from '@uptime/db'
import type { Metrics } from './metrics.js'

export interface SchedulerLike {
  upsert(monitor: ScheduledMonitor): void
  remove(id: number): void
}

export interface AppOptions {
  db: Database
  scheduler?: SchedulerLike
  metrics?: Metrics
  webDist?: string | null
}

export function toScheduled(row: MonitorRow): ScheduledMonitor {
  if (row.type !== 'http') {
    throw new Error(`unsupported monitor type: ${row.type}`)
  }
  return {
    id: row.id,
    type: 'http',
    name: row.name,
    active: row.active,
    intervalS: row.intervalS,
    retries: row.retries,
    retryIntervalS: row.retryIntervalS,
    config: parseMonitorConfig('http', row.config),
  }
}

export interface ApiHeartbeat {
  id: number
  monitorId: number
  status: string
  latencyMs: number | null
  responseSnippet: string | null
  time: string
}

export interface ApiMonitor {
  id: number
  type: string
  name: string
  active: boolean
  intervalS: number
  retries: number
  retryIntervalS: number
  config: unknown
  latestHeartbeat: ApiHeartbeat | null
}

function toApiHeartbeat(h: HeartbeatRow): ApiHeartbeat {
  return {
    id: h.id,
    monitorId: h.monitorId,
    status: h.status,
    latencyMs: h.latencyMs,
    responseSnippet: h.responseSnippet,
    time: h.time.toISOString(),
  }
}

function toApiMonitor(row: MonitorRow, latest: ApiHeartbeat | null): ApiMonitor {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    active: row.active,
    intervalS: row.intervalS,
    retries: row.retries,
    retryIntervalS: row.retryIntervalS,
    config: row.config,
    latestHeartbeat: latest,
  }
}

type ParsedInput = { ok: true; input: Partial<NewMonitor> } | { ok: false; error: string }

function parseMonitorBody(body: unknown, partial: boolean): ParsedInput {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be a JSON object' }
  const b = body as Record<string, unknown>
  const input: Partial<NewMonitor> = {}
  if (!partial || b.name !== undefined) {
    if (typeof b.name !== 'string' || b.name.trim().length === 0 || b.name.length > 200) {
      return { ok: false, error: 'name must be a non-empty string of at most 200 characters' }
    }
    input.name = b.name
  }
  if (!partial || b.intervalS !== undefined) {
    const n = Number(b.intervalS ?? 60)
    if (!Number.isInteger(n) || n < MIN_INTERVAL_S) {
      return { ok: false, error: `intervalS must be an integer >= ${MIN_INTERVAL_S}` }
    }
    input.intervalS = n
  }
  if (!partial || b.retries !== undefined) {
    const n = Number(b.retries ?? 1)
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      return { ok: false, error: 'retries must be an integer in [1, 100]' }
    }
    input.retries = n
  }
  if (!partial || b.retryIntervalS !== undefined) {
    const n = Number(b.retryIntervalS ?? 60)
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, error: 'retryIntervalS must be a positive integer' }
    }
    input.retryIntervalS = n
  }
  if (!partial || b.config !== undefined) {
    try {
      input.type = 'http'
      input.config = parseMonitorConfig('http', b.config)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'invalid config' }
    }
  }
  return { ok: true, input }
}

function monitorId(req: Request): number | null {
  const id = Number(req.params.id)
  return Number.isInteger(id) && id > 0 ? id : null
}

export function createApp(opts: AppOptions): Express {
  const { db, scheduler, metrics } = opts
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))

  app.get('/healthz', (_req, res) => {
    try {
      db.listMonitors()
      res.json({ status: 'ok', db: 'ok' })
    } catch (err) {
      res.status(503).json({ status: 'fail', db: 'fail', error: err instanceof Error ? err.message : 'db error' })
    }
  })

  app.get('/metrics', async (_req, res) => {
    if (!metrics) return res.status(404).json({ error: 'metrics disabled' })
    res.set('Content-Type', metrics.registry.contentType)
    res.send(await metrics.registry.metrics())
  })

  // Push receiver (Healthchecks-style; /start /fail semantics land in M2).
  const pushHandler = (req: Request, res: Response) => {
    const token = String(req.params.token ?? '')
    const hash = createHash('sha256').update(token).digest('hex')
    const monitorId = db.pushTokenLookup(hash)
    if (monitorId === null) return res.status(404).json({ error: 'unknown push token' })
    db.insertHeartbeat({ monitorId, status: 'up', responseSnippet: 'push received' })
    const monitor = db.getMonitor(monitorId)
    if (monitor?.active) metrics?.setMonitorUp(monitorId, monitor.name, true)
    res.status(200).json({ ok: true })
  }
  app.get('/api/v1/push/:token', pushHandler)
  app.post('/api/v1/push/:token', pushHandler)

  const latestFor = (id: number) => {
    const [h] = db.listHeartbeats(id, { limit: 1 })
    return h ? toApiHeartbeat(h) : null
  }

  app.get('/api/v1/monitors', (_req, res) => {
    res.json({ monitors: db.listMonitors().map((m) => toApiMonitor(m, latestFor(m.id))) })
  })

  app.get('/api/v1/monitors/:id', (req, res) => {
    const id = monitorId(req)
    if (id === null) return res.status(400).json({ error: 'invalid monitor id' })
    const row = db.getMonitor(id)
    if (!row) return res.status(404).json({ error: 'monitor not found' })
    res.json({ monitor: toApiMonitor(row, latestFor(id)) })
  })

  app.post('/api/v1/monitors', (req, res) => {
    const parsed = parseMonitorBody(req.body, false)
    if (!parsed.ok) return res.status(400).json({ error: parsed.error })
    const row = db.createMonitor(parsed.input as NewMonitor)
    scheduler?.upsert(toScheduled(row))
    res.status(201).json({ monitor: toApiMonitor(row, null) })
  })

  app.patch('/api/v1/monitors/:id', (req, res) => {
    const id = monitorId(req)
    if (id === null) return res.status(400).json({ error: 'invalid monitor id' })
    const parsed = parseMonitorBody(req.body, true)
    if (!parsed.ok) return res.status(400).json({ error: parsed.error })
    const updated = db.updateMonitor(id, parsed.input)
    if (!updated) return res.status(404).json({ error: 'monitor not found' })
    if (updated.type === 'http') {
      if (updated.active) scheduler?.upsert(toScheduled(updated))
      else scheduler?.remove(id)
    }
    if (!updated.active) metrics?.removeMonitor(id)
    res.json({ monitor: toApiMonitor(updated, latestFor(id)) })
  })

  app.delete('/api/v1/monitors/:id', (req, res) => {
    const id = monitorId(req)
    if (id === null) return res.status(400).json({ error: 'invalid monitor id' })
    const deleted = db.deleteMonitor(id)
    if (!deleted) return res.status(404).json({ error: 'monitor not found' })
    scheduler?.remove(id)
    metrics?.removeMonitor(id)
    res.status(204).send()
  })

  app.get('/api/v1/monitors/:id/heartbeats', (req, res) => {
    const id = monitorId(req)
    if (id === null) return res.status(400).json({ error: 'invalid monitor id' })
    if (!db.getMonitor(id)) return res.status(404).json({ error: 'monitor not found' })
    const limit = Number(req.query.limit ?? 100)
    const clamped = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 1000) : 100
    res.json({ heartbeats: db.listHeartbeats(id, { limit: clamped }).map(toApiHeartbeat) })
  })

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' })
  })

  // Static SPA. Express 5 has no '*' route syntax — a terminator middleware is the
  // SPA fallback (J6 in the plan review).
  const webDist = opts.webDist
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    app.use(express.static(webDist))
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET') return next()
      if (req.path.startsWith('/api') || req.path === '/metrics' || req.path === '/healthz') return next()
      res.sendFile(join(webDist, 'index.html'))
    })
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // express body-parser/http-errors attach statusCode or status to their errors.
    const httpErr = err as { statusCode?: number; status?: number }
    const status = httpErr.statusCode ?? httpErr.status ?? 500
    const message = err instanceof Error ? err.message : 'internal error'
    res.status(status).json({ error: message })
  })

  return app
}
