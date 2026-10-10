import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { MIN_INTERVAL_S, parseMonitorConfig } from '@uptime/core'
import type { MonitorType, PushMonitorConfig, ScheduledMonitor } from '@uptime/core'
import { parseChannelConfig, type ChannelType } from '@uptime/notify'
import type { Database, MonitorRow, NewMonitor, TagRow } from '@uptime/db'
import type { SecretBox } from '@uptime/db'
import type { NewMaintenanceWindow } from '@uptime/db'
import type { Notifier } from '@uptime/notify'
import type { Metrics } from './metrics.js'
import type { AuthModule } from './auth/index.js'
import type { IncidentEngine } from './incidents.js'
import type { EventHub } from './events.js'
import type { MaintenanceEngine } from './maintenance.js'
import { parseGroupConfig } from './groups.js'

export interface SchedulerLike {
  upsert(monitor: ScheduledMonitor): void
  remove(id: number): void
}

export interface AppOptions {
  db: Database
  secrets: SecretBox
  notifier: Notifier
  auth: AuthModule
  scheduler?: SchedulerLike
  metrics?: Metrics
  webDist?: string | null
  incidentEngine?: Pick<IncidentEngine, 'onPushDown' | 'onResult' | 'reset'>
  eventHub?: EventHub
  maintenance?: MaintenanceEngine
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

export interface ApiTag {
  id: number
  name: string
  color: string
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
  type: MonitorType
  name: string
  active: boolean
  intervalS: number
  retries: number
  retryIntervalS: number
  config: unknown
  tags: ApiTag[]
  channelIds: number[]
  latestHeartbeat: ApiHeartbeat | null
  pushUrl?: string
}

function toApiHeartbeat(h: {
  id: number
  monitorId: number
  status: string
  latencyMs: number | null
  responseSnippet: string | null
  time: Date
}): ApiHeartbeat {
  return {
    id: h.id,
    monitorId: h.monitorId,
    status: h.status,
    latencyMs: h.latencyMs,
    responseSnippet: h.responseSnippet,
    time: h.time.toISOString(),
  }
}

type ParsedInput =
  | {
      ok: true
      input: Partial<NewMonitor>
      tagIds?: number[]
      tags?: string[]
      channelIds?: number[]
    }
  | { ok: false; error: string }

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

function parseMonitorBody(
  body: unknown,
  partial: boolean,
): ParsedInput {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be a JSON object' }
  const b = body as Record<string, unknown>
  const input: Partial<NewMonitor> = {}
  let type: string = 'http'
  if (!partial || b.type !== undefined) {
    if (b.type !== undefined && (typeof b.type !== 'string' || !['http', 'push', 'group'].includes(b.type))) {
      return { ok: false, error: 'type must be http, push or group' }
    }
    type = (b.type as string | undefined) ?? 'http'
  }
  input.type = type
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
      input.config = type === 'group' ? parseGroupConfig(b.config) : parseMonitorConfig(type as MonitorType, b.config)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'invalid config' }
    }
  }
  let tagIds: number[] | undefined
  let tags: string[] | undefined
  let channelIds: number[] | undefined
  if (b.tagIds !== undefined) {
    const arr = b.tagIds
    if (!Array.isArray(arr) || !arr.every(isPositiveInt)) return { ok: false, error: 'tagIds must be an array of positive integers' }
    tagIds = arr
  }
  if (b.tags !== undefined) {
    const arr = b.tags
    if (
      !Array.isArray(arr) ||
      !arr.every((t) => typeof t === 'string' && t.trim().length > 0 && t.length <= 100)
    ) {
      return { ok: false, error: 'tags must be an array of non-empty strings (max 100 chars)' }
    }
    tags = arr
  }
  if (b.channelIds !== undefined) {
    const arr = b.channelIds
    if (!Array.isArray(arr) || !arr.every(isPositiveInt)) {
      return { ok: false, error: 'channelIds must be an array of positive integers' }
    }
    channelIds = arr
  }
  return { ok: true, input, tagIds, tags, channelIds }
}

function monitorId(req: Request): number | null {
  const id = Number(req.params.id)
  return Number.isInteger(id) && id > 0 ? id : null
}

export function createApp(opts: AppOptions): Express {
  const { db, secrets, notifier, auth, scheduler, metrics } = opts
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

  // ---- Push receiver (no auth — the token IS the secret; SPEC §5) ----
  const resolvePushMonitor = (token: string) => {
    const monitorId = db.pushTokenLookup(secrets.hash(token))
    return monitorId === null ? null : db.getMonitor(monitorId)
  }
  const pushPing = async (req: Request, res: Response) => {
    const monitor = resolvePushMonitor(String(req.params.token ?? ''))
    if (!monitor) return res.status(404).json({ error: 'unknown push token' })
    const time = new Date()
    db.insertHeartbeat({ monitorId: monitor.id, status: 'up', responseSnippet: 'push received' })
    opts.eventHub?.broadcast({
      type: 'heartbeat',
      monitorId: monitor.id,
      status: 'up',
      latencyMs: null,
      time: time.toISOString(),
    })
    if (monitor.type === 'push' && opts.incidentEngine && monitor.active) {
      await opts.incidentEngine.onResult(
        { id: monitor.id, name: monitor.name, retries: monitor.retries, resendNotificationS: monitor.resendNotificationS },
        { status: 'up', latencyMs: 0 },
        new Date(),
      )
    }
    if (monitor.active) metrics?.setMonitorUp(monitor.id, monitor.name, true)
    res.status(200).json({ ok: true })
  }
  app.get('/api/v1/push/:token', pushPing)
  app.post('/api/v1/push/:token', pushPing)

  const pushStart = (req: Request, res: Response) => {
    const monitor = resolvePushMonitor(String(req.params.token ?? ''))
    if (!monitor) return res.status(404).json({ error: 'unknown push token' })
    if (monitor.type !== 'push') return res.status(400).json({ error: 'not a push monitor' })
    db.insertHeartbeat({ monitorId: monitor.id, status: 'pending', responseSnippet: 'run started' })
    res.status(200).json({ ok: true })
  }
  app.get('/api/v1/push/:token/start', pushStart)
  app.post('/api/v1/push/:token/start', pushStart)

  const pushFail = async (req: Request, res: Response) => {
    const monitor = resolvePushMonitor(String(req.params.token ?? ''))
    if (!monitor) return res.status(404).json({ error: 'unknown push token' })
    if (monitor.type !== 'push') return res.status(400).json({ error: 'not a push monitor' })
    const body = typeof req.query.body === 'string' ? req.query.body : undefined
    const snippet = body ? body.slice(0, 1024) : 'push failed'
    const time = new Date()
    db.insertHeartbeat({ monitorId: monitor.id, status: 'down', responseSnippet: snippet })
    opts.eventHub?.broadcast({
      type: 'heartbeat',
      monitorId: monitor.id,
      status: 'down',
      latencyMs: null,
      time: time.toISOString(),
    })
    if (opts.incidentEngine && monitor.active) {
      await opts.incidentEngine.onPushDown(
        { id: monitor.id, name: monitor.name, retries: monitor.retries, resendNotificationS: monitor.resendNotificationS },
        snippet,
        time,
      )
    }
    res.status(200).json({ ok: true })
  }
  app.get('/api/v1/push/:token/fail', pushFail)
  app.post('/api/v1/push/:token/fail', pushFail)

  // ---- Auth ----
  app.use('/api/v1/auth', auth.router)

  // ---- Tags ----
  app.get('/api/v1/tags', auth.requireAuth('viewer'), (_req, res) => {
    res.json({ tags: db.listTags() })
  })

  // ---- Notification channels ----
  const channelApi = (row: { id: number; type: string; name: string; isDefault: boolean; active: boolean }) => ({
    id: row.id,
    type: row.type,
    name: row.name,
    isDefault: row.isDefault,
    active: row.active,
  })

  app.get('/api/v1/notifications', auth.requireAuth('viewer'), (_req, res) => {
    res.json({ channels: db.listChannels().map(channelApi) })
  })

  app.post('/api/v1/notifications', auth.requireAuth('admin'), (req, res) => {
    const b = req.body as Record<string, unknown>
    const type = b.type
    if (typeof type !== 'string') return res.status(400).json({ error: 'type is required' })
    if (typeof b.name !== 'string' || b.name.trim().length === 0) {
      return res.status(400).json({ error: 'name must be a non-empty string' })
    }
    try {
      const config = parseChannelConfig(type as ChannelType, b.config)
      const row = db.createChannel({
        type,
        name: b.name,
        configEnc: secrets.encryptJson(config),
        isDefault: b.isDefault === true,
      })
      res.status(201).json({ channel: channelApi(row) })
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'invalid channel config' })
    }
  })

  app.patch('/api/v1/notifications/:id', auth.requireAuth('admin'), (req, res) => {
    const id = monitorId(req)
    if (id === null) return res.status(400).json({ error: 'invalid channel id' })
    const b = req.body as Record<string, unknown>
    const patch: { name?: string; configEnc?: string; isDefault?: boolean; active?: boolean } = {}
    if (b.name !== undefined) {
      if (typeof b.name !== 'string' || b.name.trim().length === 0) {
        return res.status(400).json({ error: 'name must be a non-empty string' })
      }
      patch.name = b.name
    }
    if (b.isDefault !== undefined) patch.isDefault = b.isDefault === true
    if (b.active !== undefined) patch.active = b.active === true
    if (b.config !== undefined) {
      const existing = db.getChannel(id)
      if (!existing) return res.status(404).json({ error: 'channel not found' })
      try {
        const config = parseChannelConfig(existing.type as ChannelType, b.config)
        patch.configEnc = secrets.encryptJson(config)
      } catch (err) {
        return res.status(400).json({ error: err instanceof Error ? err.message : 'invalid channel config' })
      }
    }
    const updated = db.updateChannel(id, patch)
    if (!updated) return res.status(404).json({ error: 'channel not found' })
    res.json({ channel: channelApi(updated) })
  })

  app.delete('/api/v1/notifications/:id', auth.requireAuth('admin'), (req, res) => {
    const id = monitorId(req)
    if (id === null) return res.status(400).json({ error: 'invalid channel id' })
    if (!db.deleteChannel(id)) return res.status(404).json({ error: 'channel not found' })
    res.status(204).send()
  })

  app.post('/api/v1/notifications/:id/test', auth.requireAuth('admin'), async (req, res) => {
    const id = monitorId(req)
    if (id === null) return res.status(400).json({ error: 'invalid channel id' })
    const row = db.getChannel(id)
    if (!row) return res.status(404).json({ error: 'channel not found' })
    try {
      const config = secrets.decryptJson(row.configEnc)
      await notifier.testChannel({ id: row.id, type: row.type as ChannelType, name: row.name, config, active: row.active })
      res.status(204).send()
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'test failed' })
    }
  })

  // ---- Incidents ----
  app.get('/api/v1/incidents', auth.requireAuth('viewer'), (req, res) => {
    const active = req.query.active
    const listOpts =
      active === '1' ? { active: true } : active === '0' ? { active: false } : {}
    const incidents = db
      .listIncidents(listOpts)
      .map((i) => ({ ...i, monitorName: db.getMonitor(i.monitorId)?.name ?? null }))
    res.json({ incidents })
  })

  // ---- Realtime (SSE) ----
  app.get('/api/v1/events', auth.requireAuth('viewer'), (req, res) => {
    if (!opts.eventHub) return res.status(404).json({ error: 'events disabled' })
    opts.eventHub.handle(req, res)
  })

  // ---- Status pages ----
  const statusPageApi = (row: {
    id: number
    slug: string
    title: string
    logo: string | null
    published: boolean
    monitorIds: number[]
    theme: Record<string, unknown> | null
  }) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    logo: row.logo,
    published: row.published,
    monitorIds: row.monitorIds,
    theme: row.theme,
  })

  app.get('/api/v1/status-pages', auth.requireAuth('admin'), (_req, res) => {
    res.json({ statusPages: db.listStatusPages().map(statusPageApi) })
  })

  app.post('/api/v1/status-pages', auth.requireAuth('admin'), (req, res) => {
    const b = req.body as Record<string, unknown>
    if (typeof b.slug !== 'string' || !/^[a-z0-9-]{1,100}$/.test(b.slug)) {
      return res.status(400).json({ error: 'slug must be lowercase letters, digits and dashes' })
    }
    if (typeof b.title !== 'string' || b.title.trim().length === 0) {
      return res.status(400).json({ error: 'title must be a non-empty string' })
    }
    try {
      const row = db.createStatusPage({
        slug: b.slug,
        title: b.title,
        logo: typeof b.logo === 'string' ? b.logo : undefined,
        published: b.published === true,
        monitorIds: Array.isArray(b.monitorIds) ? (b.monitorIds as number[]) : [],
        theme: (b.theme ?? undefined) as Record<string, unknown> | undefined,
      })
      res.status(201).json({ statusPage: statusPageApi(row) })
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'could not create status page' })
    }
  })

  app.patch('/api/v1/status-pages/:id', auth.requireAuth('admin'), (req, res) => {
    const id = monitorId(req)
    if (id === null) return res.status(400).json({ error: 'invalid status page id' })
    const b = req.body as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    for (const key of ['slug', 'title', 'logo', 'published', 'monitorIds', 'theme'] as const) {
      if (b[key] !== undefined) patch[key] = b[key]
    }
    const updated = db.updateStatusPage(id, patch)
    if (!updated) return res.status(404).json({ error: 'status page not found' })
    res.json({ statusPage: statusPageApi(updated) })
  })

  app.delete('/api/v1/status-pages/:id', auth.requireAuth('admin'), (req, res) => {
    const id = monitorId(req)
    if (id === null) return res.status(400).json({ error: 'invalid status page id' })
    if (!db.deleteStatusPage(id)) return res.status(404).json({ error: 'status page not found' })
    res.status(204).send()
  })

  // Public status page payload (SPEC §5).
  app.get('/api/v1/status/:slug', (req, res) => {
    const page = db.getPublicStatusPage(String(req.params.slug ?? ''))
    if (!page) return res.status(404).json({ error: 'status page not found' })
    const monitors = page.monitorIds.flatMap((id) => {
      const row = db.getMonitor(id)
      if (!row) return []
      const [latest] = db.listHeartbeats(id, { limit: 1 })
      const uptime = db.getUptime(id, 24)
      const tagById = tagMap()
      const monitorTagIds = db.listMonitorTagIds(id)
      return [
        {
          id: row.id,
          name: row.name,
          status: latest?.status ?? 'pending',
          latencyMs: latest?.latencyMs ?? null,
          uptimePct: uptime.uptimePct,
          tags: monitorTagIds.flatMap((tid) => {
            const t = tagById.get(tid)
            return t ? [{ id: t.id, name: t.name, color: t.color }] : []
          }),
        },
      ]
    })
    const openIncidents = db.listIncidents({ active: true }).filter((i) => page.monitorIds.includes(i.monitorId))
    res.json({
      slug: page.slug,
      title: page.title,
      logo: page.logo,
      theme: page.theme,
      monitors,
      incidents: openIncidents.map((i) => ({
        id: i.id,
        monitorId: i.monitorId,
        monitorName: db.getMonitor(i.monitorId)?.name ?? null,
        openedAt: i.openedAt.toISOString(),
        title: i.title,
        body: i.body,
      })),
    })
  })

  // ---- Maintenance windows ----
  // JSON bodies carry ISO date strings; the repo contract wants Dates.
  const coerceWindow = (body: Record<string, unknown>): NewMaintenanceWindow => {
    const out = { ...body } as unknown as NewMaintenanceWindow
    if (typeof body.startAt === 'string') out.startAt = new Date(body.startAt)
    if (typeof body.endAt === 'string') out.endAt = new Date(body.endAt)
    return out
  }

  app.get('/api/v1/maintenance-windows', auth.requireAuth('viewer'), (_req, res) => {
    res.json({ windows: db.listMaintenanceWindows() })
  })

  app.post('/api/v1/maintenance-windows', auth.requireAuth('admin'), (req, res) => {
    try {
      const row = db.createMaintenanceWindow(coerceWindow(req.body))
      res.status(201).json({ window: row })
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'invalid maintenance window' })
    }
  })

  app.patch('/api/v1/maintenance-windows/:id', auth.requireAuth('admin'), (req, res) => {
    const id = monitorId(req)
    if (id === null) return res.status(400).json({ error: 'invalid maintenance window id' })
    try {
      const updated = db.updateMaintenanceWindow(id, coerceWindow(req.body))
      if (!updated) return res.status(404).json({ error: 'maintenance window not found' })
      res.json({ window: updated })
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'invalid maintenance window' })
    }
  })

  app.delete('/api/v1/maintenance-windows/:id', auth.requireAuth('admin'), (req, res) => {
    const id = monitorId(req)
    if (id === null) return res.status(400).json({ error: 'invalid maintenance window id' })
    if (!db.deleteMaintenanceWindow(id)) return res.status(404).json({ error: 'maintenance window not found' })
    res.status(204).send()
  })

  // ---- Instance settings ----
  const DEFAULT_TITLE = 'Uptime Monitoring'
  app.get('/api/v1/settings', auth.requireAuth('viewer'), (_req, res) => {
    res.json({
      title: db.getSetting('title') ?? DEFAULT_TITLE,
      timezone: db.getSetting('timezone') ?? 'UTC',
    })
  })

  app.put('/api/v1/settings', auth.requireAuth('admin'), (req, res) => {
    const b = req.body as Record<string, unknown>
    if (b.title !== undefined) {
      if (typeof b.title !== 'string' || b.title.trim().length === 0 || b.title.length > 200) {
        return res.status(400).json({ error: 'title must be a non-empty string of at most 200 characters' })
      }
      db.setSetting('title', b.title)
    }
    if (b.timezone !== undefined) {
      if (typeof b.timezone !== 'string' || b.timezone.length === 0 || b.timezone.length > 64) {
        return res.status(400).json({ error: 'timezone must be a non-empty string' })
      }
      db.setSetting('timezone', b.timezone)
    }
    res.json({ title: db.getSetting('title') ?? DEFAULT_TITLE, timezone: db.getSetting('timezone') ?? 'UTC' })
  })

  // ---- Docker hosts (SPEC §4) ----
  const dockerHostApi = (row: { id: number; name: string; uri: string; createdAt: Date; updatedAt: Date }) => ({
    id: row.id,
    name: row.name,
    uri: row.uri,
    hasTls: false as boolean,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })

  app.get('/api/v1/docker-hosts', auth.requireAuth('viewer'), (_req, res) => {
    res.json({ dockerHosts: db.listDockerHosts().map((row) => ({ ...dockerHostApi(row), hasTls: row.tlsCaEnc !== null })) })
  })

  app.post('/api/v1/docker-hosts', auth.requireAuth('admin'), (req, res) => {
    const b = req.body as Record<string, unknown>
    if (typeof b.name !== 'string' || b.name.trim().length === 0) {
      return res.status(400).json({ error: 'name must be a non-empty string' })
    }
    if (typeof b.uri !== 'string' || b.uri.length === 0) {
      return res.status(400).json({ error: 'uri must be a non-empty string' })
    }
    const row = db.createDockerHost({
      name: b.name,
      uri: b.uri,
      tlsCaEnc: typeof b.tlsCa === 'string' ? secrets.encrypt(b.tlsCa) : undefined,
      tlsCertEnc: typeof b.tlsCert === 'string' ? secrets.encrypt(b.tlsCert) : undefined,
      tlsKeyEnc: typeof b.tlsKey === 'string' ? secrets.encrypt(b.tlsKey) : undefined,
    })
    res.status(201).json({ dockerHost: dockerHostApi(row) })
  })

  app.patch('/api/v1/docker-hosts/:id', auth.requireAuth('admin'), (req, res) => {
    const id = monitorId(req)
    if (id === null) return res.status(400).json({ error: 'invalid docker host id' })
    const b = req.body as Record<string, unknown>
    const patch: Record<string, string | null> = {}
    if (b.name !== undefined) {
      if (typeof b.name !== 'string' || b.name.trim().length === 0) {
        return res.status(400).json({ error: 'name must be a non-empty string' })
      }
      patch.name = b.name
    }
    if (b.uri !== undefined) {
      if (typeof b.uri !== 'string' || b.uri.length === 0) return res.status(400).json({ error: 'uri must be a non-empty string' })
      patch.uri = b.uri
    }
    if (b.tlsCa !== undefined) patch.tlsCaEnc = typeof b.tlsCa === 'string' ? secrets.encrypt(b.tlsCa) : null
    if (b.tlsCert !== undefined) patch.tlsCertEnc = typeof b.tlsCert === 'string' ? secrets.encrypt(b.tlsCert) : null
    if (b.tlsKey !== undefined) patch.tlsKeyEnc = typeof b.tlsKey === 'string' ? secrets.encrypt(b.tlsKey) : null
    const updated = db.updateDockerHost(id, patch)
    if (!updated) return res.status(404).json({ error: 'docker host not found' })
    res.json({ dockerHost: { ...dockerHostApi(updated), hasTls: updated.tlsCaEnc !== null } })
  })

  app.delete('/api/v1/docker-hosts/:id', auth.requireAuth('admin'), (req, res) => {
    const id = monitorId(req)
    if (id === null) return res.status(400).json({ error: 'invalid docker host id' })
    if (!db.deleteDockerHost(id)) return res.status(404).json({ error: 'docker host not found' })
    res.status(204).send()
  })

  // ---- Monitors ----
  const tagMap = (): Map<number, TagRow> => new Map(db.listTags().map((t) => [t.id, t]))

  const pushUrlFor = (row: MonitorRow): string | undefined => {
    if (row.type !== 'push') return undefined
    const enc = db.getPushToken(row.id)
    if (!enc) return undefined
    try {
      return `/api/v1/push/${secrets.decrypt(enc)}`
    } catch {
      return undefined
    }
  }

  const toApiMonitor = (
    row: MonitorRow,
    ctx: {
      tagIds: number[]
      tagById: Map<number, TagRow>
      channelIds: number[]
      latest: ReturnType<typeof toApiHeartbeat> | null
    },
  ): ApiMonitor => ({
    id: row.id,
    type: row.type as MonitorType,
    name: row.name,
    active: row.active,
    intervalS: row.intervalS,
    retries: row.retries,
    retryIntervalS: row.retryIntervalS,
    config: row.config,
    tags: ctx.tagIds.flatMap((id) => {
      const t = ctx.tagById.get(id)
      return t ? [{ id: t.id, name: t.name, color: t.color }] : []
    }),
    channelIds: ctx.channelIds,
    latestHeartbeat: ctx.latest,
    pushUrl: pushUrlFor(row),
  })

  const apiContextFor = (rows: MonitorRow[]) => {
    const ids = rows.map((r) => r.id)
    const tagIdsBy = db.listTagIdsForMonitors(ids)
    const channelIdsBy = db.listChannelIdsForMonitors(ids)
    return { tagIdsBy, channelIdsBy, tagById: tagMap() }
  }

  app.get('/api/v1/monitors', auth.requireAuth('viewer'), (_req, res) => {
    const rows = db.listMonitors()
    const { tagIdsBy, channelIdsBy, tagById } = apiContextFor(rows)
    const monitors = rows.map((row) =>
      toApiMonitor(row, {
        tagIds: tagIdsBy[row.id] ?? [],
        tagById,
        channelIds: channelIdsBy[row.id] ?? [],
        latest: latestFor(row.id),
      }),
    )
    res.json({ monitors })
  })

  const latestFor = (id: number) => {
    const [h] = db.listHeartbeats(id, { limit: 1 })
    return h ? toApiHeartbeat(h) : null
  }

  const resolveTagIds = (tagIds?: number[], names?: string[]): number[] => {
    const ids = new Set(tagIds ?? [])
    for (const name of names ?? []) ids.add(db.createTag(name).id)
    return [...ids]
  }

  app.get('/api/v1/monitors/:id', auth.requireAuth('viewer'), (req, res) => {
    const id = monitorId(req)
    if (id === null) return res.status(400).json({ error: 'invalid monitor id' })
    const row = db.getMonitor(id)
    if (!row) return res.status(404).json({ error: 'monitor not found' })
    const { tagIdsBy, channelIdsBy, tagById } = apiContextFor([row])
    res.json({
      monitor: toApiMonitor(row, {
        tagIds: tagIdsBy[row.id] ?? [],
        tagById,
        channelIds: channelIdsBy[row.id] ?? [],
        latest: latestFor(id),
      }),
    })
  })

  app.post('/api/v1/monitors', auth.requireAuth('editor'), (req, res) => {
    const parsed = parseMonitorBody(req.body, false)
    if (!parsed.ok) return res.status(400).json({ error: parsed.error })
    const row = db.createMonitor(parsed.input as NewMonitor)
    if (row.type === 'push') {
      const token = secrets.token(24)
      db.setPushToken(row.id, token, secrets.encrypt(token))
    }
    const tagIds = resolveTagIds(parsed.tagIds, parsed.tags)
    if (tagIds.length > 0) db.setMonitorTags(row.id, tagIds)
    if (parsed.channelIds) db.setMonitorChannels(row.id, parsed.channelIds)
    if (row.type === 'http' && row.active) scheduler?.upsert(toScheduled(row))
    const { tagIdsBy, channelIdsBy, tagById } = apiContextFor([row])
    res.status(201).json({
      monitor: toApiMonitor(row, {
        tagIds: tagIds.length > 0 ? tagIds : [],
        tagById,
        channelIds: parsed.channelIds ?? [],
        latest: null,
      }),
    })
  })

  app.patch('/api/v1/monitors/:id', auth.requireAuth('editor'), (req, res) => {
    const id = monitorId(req)
    if (id === null) return res.status(400).json({ error: 'invalid monitor id' })
    const existing = db.getMonitor(id)
    if (!existing) return res.status(404).json({ error: 'monitor not found' })
    const parsed = parseMonitorBody({ type: existing.type, ...req.body }, true)
    if (!parsed.ok) return res.status(400).json({ error: parsed.error })
    const updated = db.updateMonitor(id, parsed.input)
    if (!updated) return res.status(404).json({ error: 'monitor not found' })
    if (parsed.tagIds !== undefined || parsed.tags !== undefined) {
      db.setMonitorTags(id, resolveTagIds(parsed.tagIds, parsed.tags))
    }
    if (parsed.channelIds !== undefined) db.setMonitorChannels(id, parsed.channelIds)
    if (updated.type === 'http') {
      if (updated.active) scheduler?.upsert(toScheduled(updated))
      else scheduler?.remove(id)
    }
    if (!updated.active) metrics?.removeMonitor(id)
    const { tagIdsBy, channelIdsBy, tagById } = apiContextFor([updated])
    res.json({
      monitor: toApiMonitor(updated, {
        tagIds: tagIdsBy[updated.id] ?? [],
        tagById,
        channelIds: channelIdsBy[updated.id] ?? [],
        latest: latestFor(id),
      }),
    })
  })

  app.delete('/api/v1/monitors/:id', auth.requireAuth('editor'), (req, res) => {
    const id = monitorId(req)
    if (id === null) return res.status(400).json({ error: 'invalid monitor id' })
    const deleted = db.deleteMonitor(id)
    if (!deleted) return res.status(404).json({ error: 'monitor not found' })
    scheduler?.remove(id)
    metrics?.removeMonitor(id)
    opts.incidentEngine?.reset(id)
    res.status(204).send()
  })

  app.get('/api/v1/monitors/:id/uptime', auth.requireAuth('viewer'), (req, res) => {
    const id = monitorId(req)
    if (id === null) return res.status(400).json({ error: 'invalid monitor id' })
    if (!db.getMonitor(id)) return res.status(404).json({ error: 'monitor not found' })
    const raw = Number(req.query.hours ?? 24)
    // 7/30/365 are day-based ranges per SPEC §5; 24 stays hours.
    const HOURS_BY_RANGE: Record<number, number> = { 24: 24, 7: 168, 30: 720, 365: 8760 }
    const hours = HOURS_BY_RANGE[raw] ?? raw
    res.json(db.getUptime(id, hours))
  })

  app.get('/api/v1/monitors/:id/heartbeats', auth.requireAuth('viewer'), (req, res) => {
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
  // SPA fallback.
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
