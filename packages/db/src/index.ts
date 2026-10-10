import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Sqlite from 'better-sqlite3'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { and, desc, eq, lt } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

import * as schema from './schema.js'
import { heartbeats, monitors, pushTokens, settings, type HeartbeatStatus } from './schema.js'

export type { HeartbeatStatus } from './schema.js'

/** Migrations live at the package root, next to `src/` and the compiled `dist/`. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url))

export interface MonitorRow {
  id: number
  type: string
  name: string
  active: boolean
  intervalS: number
  retries: number
  retryIntervalS: number
  resendNotificationS: number
  upsideDown: boolean
  parentMonitorId: number | null
  config: unknown
  createdAt: Date
  updatedAt: Date
}

export interface NewMonitor {
  type: string
  name: string
  active?: boolean
  intervalS: number
  retries: number
  retryIntervalS: number
  resendNotificationS?: number
  upsideDown?: boolean
  parentMonitorId?: number | null
  config: unknown
}

export interface HeartbeatRow {
  id: number
  monitorId: number
  status: HeartbeatStatus
  latencyMs: number | null
  responseSnippet: string | null
  time: Date
}

type MonitorSelect = typeof monitors.$inferSelect

/** `config_json` is parsed back to the per-type config object the caller stored. */
function toMonitorRow(row: MonitorSelect): MonitorRow {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    active: row.active,
    intervalS: row.intervalS,
    retries: row.retries,
    retryIntervalS: row.retryIntervalS,
    resendNotificationS: row.resendNotificationS,
    upsideDown: row.upsideDown,
    parentMonitorId: row.parentId,
    config: JSON.parse(row.configJson) as unknown,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export class Database {
  readonly #sqlite: SqliteConnection
  readonly #db: BetterSQLite3Database<typeof schema>

  private constructor(sqlite: SqliteConnection, db: BetterSQLite3Database<typeof schema>) {
    this.#sqlite = sqlite
    this.#db = db
  }

  /** Opens (creating if needed) `opts.file` — a path or `':memory:'` — and migrates it. */
  static open(opts: { file: string }): Database {
    const file = opts.file
    const sqlite = new Sqlite(file)
    sqlite.pragma('foreign_keys = ON')
    sqlite.pragma('busy_timeout = 5000')
    sqlite.pragma('synchronous = NORMAL')
    // WAL is persistent in the file and unsupported for in-memory databases.
    if (file !== ':memory:') {
      sqlite.pragma('journal_mode = WAL')
    }
    const db = drizzle(sqlite, { schema })
    try {
      migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
    } catch (error) {
      sqlite.close()
      throw error
    }
    return new Database(sqlite, db)
  }

  /** Creates `dataDir` if needed and opens `dataDir/uptime.db`. */
  static openDir(dataDir: string): Database {
    mkdirSync(dataDir, { recursive: true })
    return Database.open({ file: join(dataDir, 'uptime.db') })
  }

  close(): void {
    this.#sqlite.close()
  }

  listMonitors(): MonitorRow[] {
    return this.#db.select().from(monitors).orderBy(monitors.id).all().map(toMonitorRow)
  }

  getMonitor(id: number): MonitorRow | null {
    const row = this.#db.select().from(monitors).where(eq(monitors.id, id)).get()
    return row === undefined ? null : toMonitorRow(row)
  }

  createMonitor(input: NewMonitor): MonitorRow {
    const now = new Date()
    const row = this.#db
      .insert(monitors)
      .values({
        type: input.type,
        name: input.name,
        active: input.active ?? true,
        intervalS: input.intervalS,
        retries: input.retries,
        retryIntervalS: input.retryIntervalS,
        resendNotificationS: input.resendNotificationS ?? 0,
        upsideDown: input.upsideDown ?? false,
        parentId: input.parentMonitorId ?? null,
        configJson: JSON.stringify(input.config ?? null),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all()[0]
    if (row === undefined) {
      throw new Error('createMonitor: insert returned no row')
    }
    return toMonitorRow(row)
  }

  updateMonitor(id: number, patch: Partial<NewMonitor>): MonitorRow | null {
    const values: Partial<MonitorSelect> = { updatedAt: new Date() }
    if (patch.type !== undefined) values.type = patch.type
    if (patch.name !== undefined) values.name = patch.name
    if (patch.active !== undefined) values.active = patch.active
    if (patch.intervalS !== undefined) values.intervalS = patch.intervalS
    if (patch.retries !== undefined) values.retries = patch.retries
    if (patch.retryIntervalS !== undefined) values.retryIntervalS = patch.retryIntervalS
    if (patch.resendNotificationS !== undefined) {
      values.resendNotificationS = patch.resendNotificationS
    }
    if (patch.upsideDown !== undefined) values.upsideDown = patch.upsideDown
    if (patch.parentMonitorId !== undefined) values.parentId = patch.parentMonitorId
    if (patch.config !== undefined) values.configJson = JSON.stringify(patch.config)

    const row = this.#db
      .update(monitors)
      .set(values)
      .where(eq(monitors.id, id))
      .returning()
      .all()[0]
    return row === undefined ? null : toMonitorRow(row)
  }

  deleteMonitor(id: number): boolean {
    const result = this.#db.delete(monitors).where(eq(monitors.id, id)).run()
    return result.changes > 0
  }

  insertHeartbeat(input: {
    monitorId: number
    status: HeartbeatStatus
    latencyMs?: number
    responseSnippet?: string
    time?: Date
  }): HeartbeatRow {
    const row = this.#db
      .insert(heartbeats)
      .values({
        monitorId: input.monitorId,
        status: input.status,
        latencyMs: input.latencyMs ?? null,
        responseSnippet: input.responseSnippet ?? null,
        time: input.time ?? new Date(),
      })
      .returning()
      .all()[0]
    if (row === undefined) {
      throw new Error('insertHeartbeat: insert returned no row')
    }
    return row
  }

  /** Newest first; `before` is an exclusive time cursor. */
  listHeartbeats(monitorId: number, opts: { limit?: number; before?: Date } = {}): HeartbeatRow[] {
    const filter =
      opts.before === undefined
        ? eq(heartbeats.monitorId, monitorId)
        : and(eq(heartbeats.monitorId, monitorId), lt(heartbeats.time, opts.before))
    return this.#db
      .select()
      .from(heartbeats)
      .where(filter)
      .orderBy(desc(heartbeats.time), desc(heartbeats.id))
      .limit(opts.limit ?? 100)
      .all()
  }

  /** Returns the raw token (shown once); only its sha256 hex digest is stored. */
  createPushToken(monitorId: number): string {
    const token = randomBytes(16).toString('hex')
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const now = new Date()
    this.#db
      .insert(pushTokens)
      .values({ monitorId, tokenHash, createdAt: now })
      .onConflictDoUpdate({ target: pushTokens.monitorId, set: { tokenHash, createdAt: now } })
      .run()
    return token
  }

  pushTokenLookup(tokenHash: string): number | null {
    const row = this.#db
      .select({ monitorId: pushTokens.monitorId })
      .from(pushTokens)
      .where(eq(pushTokens.tokenHash, tokenHash))
      .get()
    return row?.monitorId ?? null
  }

  getSetting(key: string): string | null {
    const row = this.#db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .get()
    return row?.value ?? null
  }

  setSetting(key: string, value: string): void {
    this.#db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run()
  }
}
