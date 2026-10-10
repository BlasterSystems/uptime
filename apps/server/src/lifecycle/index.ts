import { Router, type Request, type Response } from 'express'
import { closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { MIN_INTERVAL_S, parseMonitorConfig } from '@uptime/core'
import type { MonitorType } from '@uptime/core'
import type { Database, KumaImportInput, MonitorRow, NewMonitor, SecretBox } from '@uptime/db'
import { createAuthModule } from '../auth/index.js'

export interface LifecycleDeps {
  db: Database
  secrets: SecretBox
  dataDir: string
}

/** Every SQLite 3 database file starts with these 15 bytes (PLAN M6 restore check). */
const SQLITE_MAGIC = 'SQLite format 3'

/** True when the file at `path` starts with the SQLite magic header. */
function isSqliteFile(path: string): boolean {
  const fd = openSync(path, 'r')
  try {
    const header = Buffer.alloc(16)
    if (readSync(fd, header, 0, 16, 0) < 15) return false
    return header.toString('utf8', 0, 15) === SQLITE_MAGIC
  } finally {
    closeSync(fd)
  }
}

/** Raw-heartbeat retention default (SPEC §4): 180 days. */
export const DEFAULT_RETENTION_DAYS = 180

/**
 * `settings` keys describing local rollup/ingest progress rather than human
 * configuration. They never travel in an export — importing a foreign watermark
 * would mark local heartbeats as already aggregated — and are ignored on import.
 */
const INTERNAL_SETTINGS: Record<string, true> = { rollup_watermark: true }

/** A monitor as it appears in a `POST /config/export` snapshot. */
export interface ExportedMonitor {
  type: string
  name: string
  active: boolean
  intervalS: number
  retries: number
  retryIntervalS: number
  resendNotificationS: number
  upsideDown: boolean
  /** Tag names; tag ids are instance-local. */
  tags: string[]
  /**
   * Channel names routed to the monitor. Channel *configs* are intentionally
   * excluded: they hold per-instance secrets (tokens, SMTP credentials).
   */
  channels: string[]
  config: unknown
}

export interface ConfigExport {
  monitors: ExportedMonitor[]
  /** Instance settings minus the internal bookkeeping keys. */
  settings: Record<string, string>
  exportedAt: string
}

/** A monitor entry accepted by `POST /config/import` after validation. */
interface ImportMonitor {
  type: MonitorType
  name: string
  config: unknown
  intervalS?: number
  retries?: number
  retryIntervalS?: number
  resendNotificationS?: number
  active?: boolean
  upsideDown?: boolean
  tags?: string[]
}

/**
 * Validates one import entry: the type must be a `@uptime/core` type (group
 * monitors are instance-local and skipped) and the config must satisfy that
 * type's schema. Returns `null` for entries that should count as skipped.
 */
function parseImportMonitor(raw: unknown): ImportMonitor | null {
  if (typeof raw !== 'object' || raw === null) return null
  const body = raw as Record<string, unknown>
  const type = body.type
  if (typeof type !== 'string' || type === 'group') return null
  const name = body.name
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) return null
  let config: unknown
  try {
    config = parseMonitorConfig(type as MonitorType, body.config)
  } catch {
    return null
  }
  const monitor: ImportMonitor = { type: type as MonitorType, name, config }
  if (body.intervalS !== undefined) {
    const value = Number(body.intervalS)
    if (!Number.isInteger(value) || value < MIN_INTERVAL_S) return null
    monitor.intervalS = value
  }
  if (body.retries !== undefined) {
    const value = Number(body.retries)
    if (!Number.isInteger(value) || value < 1 || value > 100) return null
    monitor.retries = value
  }
  if (body.retryIntervalS !== undefined) {
    const value = Number(body.retryIntervalS)
    if (!Number.isInteger(value) || value < 1) return null
    monitor.retryIntervalS = value
  }
  if (body.resendNotificationS !== undefined) {
    const value = Number(body.resendNotificationS)
    if (!Number.isInteger(value) || value < 0) return null
    monitor.resendNotificationS = value
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') return null
    monitor.active = body.active
  }
  if (body.upsideDown !== undefined) {
    if (typeof body.upsideDown !== 'boolean') return null
    monitor.upsideDown = body.upsideDown
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) return null
    const tags: string[] = []
    for (const tag of body.tags) {
      if (typeof tag !== 'string' || tag.trim().length === 0 || tag.length > 100) return null
      tags.push(tag)
    }
    monitor.tags = tags
  }
  return monitor
}

/**
 * Lifecycle routes (PLAN M6) mounted under `/api/v1` by `createApp`: config
 * export/import, SQLite snapshot backup, heartbeat retention and the
 * best-effort Uptime-Kuma import. Every route requires the admin role/scope;
 * the module builds its own `requireAuth` from the same database and secret box.
 */
export function createLifecycleRouter(deps: LifecycleDeps): Router {
  const { db, dataDir, secrets } = deps
  const { requireAuth } = createAuthModule({ db, secrets })
  const admin = requireAuth('admin')
  const router = Router()

  // JSON only: TOML would add a serializer dependency and the UI/CLI flows read JSON.
  router.post('/config/export', admin, (_req: Request, res: Response) => {
    const rows = db.listMonitors()
    const ids = rows.map((row) => row.id)
    const tagIdsBy = db.listTagIdsForMonitors(ids)
    const channelIdsBy = db.listChannelIdsForMonitors(ids)
    const tagNameById = new Map(db.listTags().map((tag) => [tag.id, tag.name]))
    const channelNameById = new Map(db.listChannels().map((channel) => [channel.id, channel.name]))
    const monitors: ExportedMonitor[] = rows.map((row) => ({
      type: row.type,
      name: row.name,
      active: row.active,
      intervalS: row.intervalS,
      retries: row.retries,
      retryIntervalS: row.retryIntervalS,
      resendNotificationS: row.resendNotificationS,
      upsideDown: row.upsideDown,
      tags: (tagIdsBy[row.id] ?? []).flatMap((id) => {
        const tagName = tagNameById.get(id)
        return tagName === undefined ? [] : [tagName]
      }),
      channels: (channelIdsBy[row.id] ?? []).flatMap((id) => {
        const channelName = channelNameById.get(id)
        return channelName === undefined ? [] : [channelName]
      }),
      config: row.config,
    }))
    const settings: Record<string, string> = {}
    for (const [key, value] of Object.entries(db.listSettings())) {
      if (INTERNAL_SETTINGS[key] !== true) settings[key] = value
    }
    res.json({ monitors, settings, exportedAt: new Date().toISOString() })
  })

  // Upsert by (type, name), never deleting: groups are skipped since their
  // member ids are instance-local, as are entries whose config does not validate.
  router.post('/config/import', admin, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    if (!Array.isArray(body.monitors)) {
      return res.status(400).json({ error: 'monitors must be an array' })
    }
    let settings: Record<string, unknown> | null = null
    if (body.settings !== undefined) {
      if (
        typeof body.settings !== 'object' ||
        body.settings === null ||
        Array.isArray(body.settings)
      ) {
        return res.status(400).json({ error: 'settings must be an object' })
      }
      settings = body.settings as Record<string, unknown>
      for (const value of Object.values(settings)) {
        if (typeof value !== 'string') {
          return res.status(400).json({ error: 'settings values must be strings' })
        }
      }
    }

    const existing = new Map<string, MonitorRow>()
    for (const row of db.listMonitors()) existing.set(`${row.type}\u0000${row.name}`, row)

    let created = 0
    let updated = 0
    let skipped = 0
    for (const raw of body.monitors) {
      const monitor = parseImportMonitor(raw)
      if (monitor === null) {
        skipped += 1
        continue
      }
      const key = `${monitor.type}\u0000${monitor.name}`
      let row = existing.get(key)
      if (row === undefined) {
        row = db.createMonitor({
          type: monitor.type,
          name: monitor.name,
          intervalS: monitor.intervalS ?? 60,
          retries: monitor.retries ?? 1,
          retryIntervalS: monitor.retryIntervalS ?? 60,
          resendNotificationS: monitor.resendNotificationS ?? 0,
          upsideDown: monitor.upsideDown ?? false,
          active: monitor.active ?? true,
          config: monitor.config,
        })
        existing.set(key, row)
        if (row.type === 'push') {
          // Push URLs are instance secrets and never exported; issue a fresh
          // token like POST /monitors so the imported monitor can be used.
          const token = secrets.token(24)
          db.setPushToken(row.id, token, secrets.encrypt(token))
        }
        created += 1
      } else {
        const patch: Partial<NewMonitor> = { config: monitor.config }
        if (monitor.intervalS !== undefined) patch.intervalS = monitor.intervalS
        if (monitor.retries !== undefined) patch.retries = monitor.retries
        if (monitor.retryIntervalS !== undefined) patch.retryIntervalS = monitor.retryIntervalS
        if (monitor.resendNotificationS !== undefined) {
          patch.resendNotificationS = monitor.resendNotificationS
        }
        if (monitor.upsideDown !== undefined) patch.upsideDown = monitor.upsideDown
        if (monitor.active !== undefined) patch.active = monitor.active
        db.updateMonitor(row.id, patch)
        updated += 1
      }
      if (monitor.tags !== undefined) {
        db.setMonitorTags(
          row.id,
          monitor.tags.map((name) => db.createTag(name).id),
        )
      }
    }

    if (settings !== null) {
      for (const [key, value] of Object.entries(settings)) {
        if (INTERNAL_SETTINGS[key] !== true) db.setSetting(key, value as string)
      }
    }

    res.json({ created, updated, skipped })
  })

  router.post('/backup', admin, async (_req: Request, res: Response) => {
    mkdirSync(join(dataDir, 'backups'), { recursive: true })
    // ISO timestamp with filesystem-safe separators, e.g. uptime-2026-10-10T12-34-56-789Z.db
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const relativePath = join('backups', `uptime-${stamp}.db`)
    try {
      await db.backupTo(join(dataDir, relativePath))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'backup failed' })
      return
    }
    res.json({ path: relativePath })
  })

  // Restores a snapshot written by POST /backup (PLAN M6). The snapshot must
  // live inside dataDir/backups; the live database is snapshotted to
  // pre-restore-*.db first, so a regretted restore is recoverable.
  router.post('/restore', admin, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const requested = body.path
    if (typeof requested !== 'string' || requested.length === 0) {
      return res.status(400).json({ error: 'path must be a non-empty string' })
    }
    const backupsDir = resolve(dataDir, 'backups')
    // POST /backup reports paths relative to dataDir (`backups/…`); accept that
    // shape as well as a path relative to the backups directory itself.
    const relativeRequest = requested.replaceAll('\\', '/').replace(/^backups\//, '')
    const snapshot = resolve(backupsDir, relativeRequest)
    const inside = relative(backupsDir, snapshot)
    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      return res.status(400).json({ error: 'path must point inside the backups directory' })
    }
    const stats = statSync(snapshot, { throwIfNoEntry: false })
    if (stats === undefined || !stats.isFile()) {
      return res.status(404).json({ error: 'snapshot not found' })
    }
    if (!isSqliteFile(snapshot)) {
      return res.status(400).json({ error: 'not a SQLite database' })
    }

    mkdirSync(backupsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      await db.backupTo(join(backupsDir, `pre-restore-${stamp}.db`))
      await db.restoreFrom(snapshot)
    } catch (error) {
      return res
        .status(500)
        .json({ error: error instanceof Error ? error.message : 'restore failed' })
    }
    res.json({ restored: true })
  })

  router.post('/retention/run', admin, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const days = body.days === undefined ? DEFAULT_RETENTION_DAYS : Number(body.days)
    if (!Number.isInteger(days) || days < 1) {
      return res.status(400).json({ error: 'days must be a positive integer' })
    }
    const cutoff = new Date(Date.now() - days * 86_400_000)
    // Already-aggregated beats go first; the second sweep removes everything
    // else older than the cutoff, so `heartbeatsDeleted` counts the part that
    // had not been rolled up yet (total removed = heartbeatsDeleted + rolledupDeleted).
    const rolledupDeleted = db.deleteRolledupBefore(cutoff)
    const heartbeatsDeleted = db.deleteHeartbeatsBefore(cutoff)
    res.json({ heartbeatsDeleted, rolledupDeleted })
  })

  // An operator-side CLI converts Kuma's SQLite into exactly this JSON body:
  // `{ kumaVersion, monitors: [...], heartbeats: [...] }`. Per-entry shape is
  // validated (and invalid entries skipped) inside Database#importKuma.
  router.post('/import/kuma', admin, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    if (!Array.isArray(body.monitors)) {
      return res.status(400).json({ error: 'monitors must be an array' })
    }
    if (!Array.isArray(body.heartbeats)) {
      return res.status(400).json({ error: 'heartbeats must be an array' })
    }
    if (body.kumaVersion !== undefined && typeof body.kumaVersion !== 'string') {
      return res.status(400).json({ error: 'kumaVersion must be a string' })
    }
    const result = db.importKuma({
      monitors: body.monitors as KumaImportInput['monitors'],
      heartbeats: body.heartbeats as KumaImportInput['heartbeats'],
    })
    res.json(result)
  })

  return router
}
