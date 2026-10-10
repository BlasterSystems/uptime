import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Sqlite from 'better-sqlite3'
import type { Database as SqliteConnection } from 'better-sqlite3'
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  sql,
  sum,
} from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

import * as schema from './schema.js'
import {
  apiKeys,
  dockerHosts,
  heartbeats,
  heartbeatsDaily,
  heartbeatsHourly,
  incidents,
  maintenanceWindows,
  monitorNotifications,
  monitors,
  monitorTags,
  notificationChannels,
  pushTokens,
  sessions,
  settings,
  statusPages,
  tags,
  users,
  type HeartbeatStatus,
  type MaintenanceScope,
  type MaintenanceStrategy,
  type UserRole,
} from './schema.js'

export { SecretBox } from './crypto.js'
export * from './schema.js'
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

export interface UserRow {
  id: number
  email: string
  passwordHash: string
  totpSecretEnc: string | null
  totpEnabled: boolean
  recoveryCodesEnc: string | null
  role: UserRole
  createdAt: Date
  updatedAt: Date
}

export interface SessionRow {
  id: string
  userId: number
  csrfToken: string
  expiresAt: Date
  ip: string | null
  userAgent: string | null
  createdAt: Date
}

export interface ApiKeyRow {
  id: number
  name: string
  keyHash: string
  scopes: string[]
  createdBy: number | null
  lastUsedAt: Date | null
  expiresAt: Date | null
  createdAt: Date
}

export interface ChannelRow {
  id: number
  type: string
  name: string
  configEnc: string
  isDefault: boolean
  active: boolean
  createdAt: Date
  updatedAt: Date
}

export interface IncidentRow {
  id: number
  monitorId: number
  openedAt: Date
  resolvedAt: Date | null
  title: string
  body: string | null
}

export interface TagRow {
  id: number
  name: string
  color: string
  createdAt: Date
}

export interface StatusPageRow {
  id: number
  slug: string
  title: string
  logo: string | null
  published: boolean
  monitorIds: number[]
  theme: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

export interface NewStatusPage {
  slug: string
  title: string
  logo?: string | null
  published?: boolean
  monitorIds?: number[]
  theme?: Record<string, unknown> | null
}

export interface MaintenanceWindowRow {
  id: number
  name: string
  scope: MaintenanceScope
  monitorIds: number[]
  tagIds: number[]
  strategy: MaintenanceStrategy
  startAt: Date | null
  endAt: Date | null
  intervalS: number | null
  weekdays: number[] | null
  startTime: string | null
  endTime: string | null
  cronExpr: string | null
  cronTz: string | null
  active: boolean
  createdAt: Date
  updatedAt: Date
}

export interface NewMaintenanceWindow {
  name: string
  scope: MaintenanceScope
  monitorIds?: number[]
  tagIds?: number[]
  strategy: MaintenanceStrategy
  startAt?: Date | null
  endAt?: Date | null
  intervalS?: number | null
  weekdays?: number[] | null
  startTime?: string | null
  endTime?: string | null
  cronExpr?: string | null
  cronTz?: string | null
  active?: boolean
}

export interface UptimeStats {
  /** Every rolled-up beat in the window, `pending` included. */
  total: number
  up: number
  down: number
  maintenance: number
  /** `up / (up + down)` in percent — maintenance is planned, so excluded; 100 with no up/down. */
  uptimePct: number
}

/** A monitor converted from Uptime-Kuma; the CLI (scripts/) produces these from Kuma's SQLite. */
export interface KumaMonitorInput {
  type: string
  name: string
  intervalS?: number
  retries?: number
  retryIntervalS?: number
  config: unknown
}

/** A heartbeat converted from Uptime-Kuma; `monitorSlug` identifies the monitor by `name`. */
export interface KumaHeartbeatInput {
  monitorSlug: string
  status: 'up' | 'down'
  latencyMs: number | null
  /** Unix milliseconds, as stored by Kuma. */
  time: number
}

export interface KumaImportInput {
  monitors: KumaMonitorInput[]
  heartbeats: KumaHeartbeatInput[]
}

export interface KumaImportResult {
  monitorsCreated: number
  heartbeatsImported: number
}

type MonitorSelect = typeof monitors.$inferSelect

export interface DockerHostRow {
  id: number
  name: string
  uri: string
  tlsCaEnc: string | null
  tlsCertEnc: string | null
  tlsKeyEnc: string | null
  createdAt: Date
  updatedAt: Date
}

type DockerHostSelect = typeof dockerHosts.$inferSelect

function toDockerHostRow(row: DockerHostSelect): DockerHostRow {
  return {
    id: row.id,
    name: row.name,
    uri: row.uri,
    tlsCaEnc: row.tlsCaEnc,
    tlsCertEnc: row.tlsCertEnc,
    tlsKeyEnc: row.tlsKeyEnc,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

type ApiKeySelect = typeof apiKeys.$inferSelect
type StatusPageSelect = typeof statusPages.$inferSelect
type MaintenanceWindowSelect = typeof maintenanceWindows.$inferSelect

/** `scopes` is stored as a JSON array and parsed back at the boundary. */
function toApiKeyRow(row: ApiKeySelect): ApiKeyRow {
  return { ...row, scopes: JSON.parse(row.scopes) as string[] }
}

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

/** JSON id arrays are stored as text and parsed back at the boundary. */
function toStatusPageRow(row: StatusPageSelect): StatusPageRow {
  return {
    ...row,
    monitorIds: JSON.parse(row.monitorIds) as number[],
    theme: row.theme === null ? null : (JSON.parse(row.theme) as Record<string, unknown>),
  }
}

function toMaintenanceWindowRow(row: MaintenanceWindowSelect): MaintenanceWindowRow {
  return {
    ...row,
    monitorIds: JSON.parse(row.monitorIds) as number[],
    tagIds: JSON.parse(row.tagIds) as number[],
    weekdays: row.weekdays === null ? null : (JSON.parse(row.weekdays) as number[]),
  }
}

/** `settings` key holding the exclusive lower bound (unix ms) of the last rollup run. */
const ROLLUP_WATERMARK_KEY = 'rollup_watermark'

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
      .onConflictDoUpdate({
        target: pushTokens.monitorId,
        set: { tokenHash, tokenEnc: null, createdAt: now },
      })
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

  /**
   * Upserts the monitor's push token row: sha256 of `rawToken` for lookup plus the
   * caller-encrypted token (SecretBox ciphertext, stored verbatim for display).
   */
  setPushToken(monitorId: number, rawToken: string, tokenEnc: string): void {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    const now = new Date()
    this.#db
      .insert(pushTokens)
      .values({ monitorId, tokenHash, tokenEnc, createdAt: now })
      .onConflictDoUpdate({
        target: pushTokens.monitorId,
        set: { tokenHash, tokenEnc, createdAt: now },
      })
      .run()
  }

  /** The stored ciphertext for caller-side decryption; `null` when absent. */
  getPushToken(monitorId: number): string | null {
    const row = this.#db
      .select({ tokenEnc: pushTokens.tokenEnc })
      .from(pushTokens)
      .where(eq(pushTokens.monitorId, monitorId))
      .get()
    return row?.tokenEnc ?? null
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

  /** Every `settings` entry as a plain object (used by config export). */
  listSettings(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const row of this.#db.select().from(settings).orderBy(asc(settings.key)).all()) {
      result[row.key] = row.value
    }
    return result
  }

  // Users

  countUsers(): number {
    const row = this.#db.select({ value: count() }).from(users).get()
    return row?.value ?? 0
  }

  /** `role` defaults to `'admin'` (first-run bootstrap); a duplicate email throws. */
  createUser(input: { email: string; passwordHash: string; role?: UserRole }): UserRow {
    const now = new Date()
    const row = this.#db
      .insert(users)
      .values({
        email: input.email,
        passwordHash: input.passwordHash,
        role: input.role ?? 'admin',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all()[0]
    if (row === undefined) {
      throw new Error('createUser: insert returned no row')
    }
    return row
  }

  getUserByEmail(email: string): UserRow | null {
    const row = this.#db.select().from(users).where(eq(users.email, email)).get()
    return row ?? null
  }

  getUser(id: number): UserRow | null {
    const row = this.#db.select().from(users).where(eq(users.id, id)).get()
    return row ?? null
  }

  updateUser(
    id: number,
    patch: Partial<
      Pick<UserRow, 'passwordHash' | 'totpSecretEnc' | 'totpEnabled' | 'recoveryCodesEnc' | 'role'>
    >,
  ): UserRow | null {
    const values: Partial<typeof users.$inferInsert> = { updatedAt: new Date() }
    if (patch.passwordHash !== undefined) values.passwordHash = patch.passwordHash
    if (patch.totpSecretEnc !== undefined) values.totpSecretEnc = patch.totpSecretEnc
    if (patch.totpEnabled !== undefined) values.totpEnabled = patch.totpEnabled
    if (patch.recoveryCodesEnc !== undefined) values.recoveryCodesEnc = patch.recoveryCodesEnc
    if (patch.role !== undefined) values.role = patch.role

    const row = this.#db.update(users).set(values).where(eq(users.id, id)).returning().all()[0]
    return row ?? null
  }

  deleteUser(id: number): boolean {
    return this.#db.delete(users).where(eq(users.id, id)).run().changes > 0
  }

  listUsers(): UserRow[] {
    return this.#db.select().from(users).orderBy(users.id).all()
  }

  // Sessions

  createSession(input: {
    userId: number
    csrfToken: string
    expiresAt: Date
    ip?: string
    userAgent?: string
    id?: string
  }): SessionRow {
    const row = this.#db
      .insert(sessions)
      .values({
        id: input.id ?? randomBytes(32).toString('hex'),
        userId: input.userId,
        csrfToken: input.csrfToken,
        expiresAt: input.expiresAt,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        createdAt: new Date(),
      })
      .returning()
      .all()[0]
    if (row === undefined) {
      throw new Error('createSession: insert returned no row')
    }
    return row
  }

  /** Expired sessions are deleted and reported as missing. */
  getSession(id: string): SessionRow | null {
    const row = this.#db.select().from(sessions).where(eq(sessions.id, id)).get()
    if (row === undefined) return null
    if (row.expiresAt.getTime() <= Date.now()) {
      this.deleteSession(id)
      return null
    }
    return row
  }

  deleteSession(id: string): boolean {
    return this.#db.delete(sessions).where(eq(sessions.id, id)).run().changes > 0
  }

  deleteExpiredSessions(now: Date): number {
    return this.#db.delete(sessions).where(lte(sessions.expiresAt, now)).run().changes
  }

  // API keys

  createApiKey(input: {
    name: string
    keyHash: string
    scopes: string[]
    createdBy?: number
    expiresAt?: Date
  }): ApiKeyRow {
    const row = this.#db
      .insert(apiKeys)
      .values({
        name: input.name,
        keyHash: input.keyHash,
        scopes: JSON.stringify(input.scopes),
        createdBy: input.createdBy ?? null,
        lastUsedAt: null,
        expiresAt: input.expiresAt ?? null,
        createdAt: new Date(),
      })
      .returning()
      .all()[0]
    if (row === undefined) {
      throw new Error('createApiKey: insert returned no row')
    }
    return toApiKeyRow(row)
  }

  /** Expired keys are treated as unknown. */
  getApiKeyByKeyHash(keyHash: string): ApiKeyRow | null {
    const row = this.#db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).get()
    if (row === undefined) return null
    if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) return null
    return toApiKeyRow(row)
  }

  touchApiKey(id: number, usedAt: Date): void {
    this.#db.update(apiKeys).set({ lastUsedAt: usedAt }).where(eq(apiKeys.id, id)).run()
  }

  listApiKeys(): ApiKeyRow[] {
    return this.#db.select().from(apiKeys).orderBy(apiKeys.id).all().map(toApiKeyRow)
  }

  deleteApiKey(id: number): boolean {
    return this.#db.delete(apiKeys).where(eq(apiKeys.id, id)).run().changes > 0
  }

  // Notification channels

  createChannel(input: {
    type: string
    name: string
    configEnc: string
    isDefault?: boolean
    active?: boolean
  }): ChannelRow {
    const now = new Date()
    const row = this.#db
      .insert(notificationChannels)
      .values({
        type: input.type,
        name: input.name,
        configEnc: input.configEnc,
        isDefault: input.isDefault ?? false,
        active: input.active ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all()[0]
    if (row === undefined) {
      throw new Error('createChannel: insert returned no row')
    }
    return row
  }

  listChannels(): ChannelRow[] {
    return this.#db.select().from(notificationChannels).orderBy(notificationChannels.id).all()
  }

  getChannel(id: number): ChannelRow | null {
    const row = this.#db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, id))
      .get()
    return row ?? null
  }

  updateChannel(
    id: number,
    patch: Partial<{ name: string; configEnc: string; isDefault: boolean; active: boolean }>,
  ): ChannelRow | null {
    const values: Partial<typeof notificationChannels.$inferInsert> = { updatedAt: new Date() }
    if (patch.name !== undefined) values.name = patch.name
    if (patch.configEnc !== undefined) values.configEnc = patch.configEnc
    if (patch.isDefault !== undefined) values.isDefault = patch.isDefault
    if (patch.active !== undefined) values.active = patch.active

    const row = this.#db
      .update(notificationChannels)
      .set(values)
      .where(eq(notificationChannels.id, id))
      .returning()
      .all()[0]
    return row ?? null
  }

  deleteChannel(id: number): boolean {
    const result = this.#db
      .delete(notificationChannels)
      .where(eq(notificationChannels.id, id))
      .run()
    return result.changes > 0
  }

  // Monitor-channel routing

  /** Replace-all: the given channel ids become the monitor's complete set. */
  setMonitorChannels(monitorId: number, channelIds: number[]): void {
    const unique = [...new Set(channelIds)]
    this.#db.transaction((tx) => {
      tx.delete(monitorNotifications).where(eq(monitorNotifications.monitorId, monitorId)).run()
      if (unique.length > 0) {
        tx.insert(monitorNotifications)
          .values(unique.map((channelId) => ({ monitorId, channelId })))
          .run()
      }
    })
  }

  listMonitorChannelIds(monitorId: number): number[] {
    return this.#db
      .select()
      .from(monitorNotifications)
      .where(eq(monitorNotifications.monitorId, monitorId))
      .orderBy(monitorNotifications.channelId)
      .all()
      .map((row) => row.channelId)
  }

  /** Every requested monitor gets a key, `[]` included when unrouted. */
  listChannelIdsForMonitors(monitorIds: number[]): Record<number, number[]> {
    const result: Record<number, number[]> = {}
    for (const monitorId of monitorIds) {
      result[monitorId] = []
    }
    if (monitorIds.length === 0) return result

    const rows = this.#db
      .select()
      .from(monitorNotifications)
      .where(inArray(monitorNotifications.monitorId, monitorIds))
      .orderBy(monitorNotifications.monitorId, monitorNotifications.channelId)
      .all()
    for (const row of rows) {
      result[row.monitorId]?.push(row.channelId)
    }
    return result
  }

  // Incidents

  /** Returns the monitor's existing open incident instead of opening a second one. */
  openIncident(input: {
    monitorId: number
    openedAt: Date
    title: string
    body?: string
  }): IncidentRow {
    const existing = this.getOpenIncident(input.monitorId)
    if (existing !== null) return existing

    const row = this.#db
      .insert(incidents)
      .values({
        monitorId: input.monitorId,
        openedAt: input.openedAt,
        title: input.title,
        body: input.body ?? null,
      })
      .returning()
      .all()[0]
    if (row === undefined) {
      throw new Error('openIncident: insert returned no row')
    }
    return row
  }

  getOpenIncident(monitorId: number): IncidentRow | null {
    const row = this.#db
      .select()
      .from(incidents)
      .where(and(eq(incidents.monitorId, monitorId), isNull(incidents.resolvedAt)))
      .orderBy(desc(incidents.openedAt), desc(incidents.id))
      .get()
    return row ?? null
  }

  /** Resolving an already-resolved incident is a no-op that returns the row. */
  resolveIncident(id: number, resolvedAt: Date): IncidentRow | null {
    const updated = this.#db
      .update(incidents)
      .set({ resolvedAt })
      .where(and(eq(incidents.id, id), isNull(incidents.resolvedAt)))
      .returning()
      .all()[0]
    if (updated !== undefined) return updated

    const row = this.#db.select().from(incidents).where(eq(incidents.id, id)).get()
    return row ?? null
  }

  /** Newest first; `active` narrows to open (`true`) or resolved (`false`) incidents. */
  listIncidents(
    opts: { active?: boolean; monitorId?: number; limit?: number } = {},
  ): IncidentRow[] {
    return this.#db
      .select()
      .from(incidents)
      .where(
        and(
          opts.monitorId !== undefined ? eq(incidents.monitorId, opts.monitorId) : undefined,
          opts.active === true ? isNull(incidents.resolvedAt) : undefined,
          opts.active === false ? isNotNull(incidents.resolvedAt) : undefined,
        ),
      )
      .orderBy(desc(incidents.openedAt), desc(incidents.id))
      .limit(opts.limit ?? 50)
      .all()
  }

  // Tags

  listTags(): TagRow[] {
    return this.#db.select().from(tags).orderBy(tags.id).all()
  }

  /** Get-or-create keyed on a case-insensitive name match; the colour is kept once set. */
  createTag(name: string, color?: string): TagRow {
    const existing = this.#db
      .select()
      .from(tags)
      .where(sql`lower(${tags.name}) = ${name.toLowerCase()}`)
      .get()
    if (existing !== undefined) return existing

    const row = this.#db
      .insert(tags)
      .values({ name, color, createdAt: new Date() })
      .returning()
      .all()[0]
    if (row === undefined) {
      throw new Error('createTag: insert returned no row')
    }
    return row
  }

  deleteTag(id: number): boolean {
    return this.#db.delete(tags).where(eq(tags.id, id)).run().changes > 0
  }

  /** Replace-all: the given tag ids become the monitor's complete set. */
  setMonitorTags(monitorId: number, tagIds: number[]): void {
    const unique = [...new Set(tagIds)]
    this.#db.transaction((tx) => {
      tx.delete(monitorTags).where(eq(monitorTags.monitorId, monitorId)).run()
      if (unique.length > 0) {
        tx.insert(monitorTags)
          .values(unique.map((tagId) => ({ monitorId, tagId })))
          .run()
      }
    })
  }

  listMonitorTagIds(monitorId: number): number[] {
    return this.#db
      .select()
      .from(monitorTags)
      .where(eq(monitorTags.monitorId, monitorId))
      .orderBy(monitorTags.tagId)
      .all()
      .map((row) => row.tagId)
  }

  /** Every requested monitor gets a key, `[]` included when untagged. */
  listTagIdsForMonitors(monitorIds: number[]): Record<number, number[]> {
    const result: Record<number, number[]> = {}
    for (const monitorId of monitorIds) {
      result[monitorId] = []
    }
    if (monitorIds.length === 0) return result

    const rows = this.#db
      .select()
      .from(monitorTags)
      .where(inArray(monitorTags.monitorId, monitorIds))
      .orderBy(monitorTags.monitorId, monitorTags.tagId)
      .all()
    for (const row of rows) {
      result[row.monitorId]?.push(row.tagId)
    }
    return result
  }

  // Push monitors

  /**
   * Active `push` monitors with the time of their latest heartbeat (`null` when
   * never probed) — used to open missed-heartbeat incidents.
   */
  listActivePushMonitors(): Array<{ monitor: MonitorRow; lastBeatAt: Date | null }> {
    const rows = this.#db
      .select({ monitor: monitors, lastBeatAt: max(heartbeats.time) })
      .from(monitors)
      .leftJoin(heartbeats, eq(heartbeats.monitorId, monitors.id))
      .where(and(eq(monitors.type, 'push'), eq(monitors.active, true)))
      .groupBy(monitors.id)
      .orderBy(monitors.id)
      .all()
    return rows.map((row) => ({ monitor: toMonitorRow(row.monitor), lastBeatAt: row.lastBeatAt }))
  }

  // Status pages

  /** `slug` is unique; a duplicate throws (SQLITE_CONSTRAINT_UNIQUE). */
  createStatusPage(input: NewStatusPage): StatusPageRow {
    const now = new Date()
    const row = this.#db
      .insert(statusPages)
      .values({
        slug: input.slug,
        title: input.title,
        logo: input.logo ?? null,
        published: input.published ?? false,
        monitorIds: JSON.stringify(input.monitorIds ?? []),
        theme:
          input.theme === undefined || input.theme === null ? null : JSON.stringify(input.theme),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all()[0]
    if (row === undefined) {
      throw new Error('createStatusPage: insert returned no row')
    }
    return toStatusPageRow(row)
  }

  listStatusPages(): StatusPageRow[] {
    return this.#db.select().from(statusPages).orderBy(statusPages.id).all().map(toStatusPageRow)
  }

  getStatusPage(id: number): StatusPageRow | null {
    const row = this.#db.select().from(statusPages).where(eq(statusPages.id, id)).get()
    return row === undefined ? null : toStatusPageRow(row)
  }

  /** Published pages only — drafts and unknown slugs resolve to `null`. */
  getPublicStatusPage(slug: string): StatusPageRow | null {
    const row = this.#db
      .select()
      .from(statusPages)
      .where(and(eq(statusPages.slug, slug), eq(statusPages.published, true)))
      .get()
    return row === undefined ? null : toStatusPageRow(row)
  }

  /** `null` and `undefined` clear `logo`/`theme`; the other patches replace wholesale. */
  updateStatusPage(id: number, patch: Partial<NewStatusPage>): StatusPageRow | null {
    const values: Partial<typeof statusPages.$inferInsert> = { updatedAt: new Date() }
    if (patch.slug !== undefined) values.slug = patch.slug
    if (patch.title !== undefined) values.title = patch.title
    if (patch.logo !== undefined) values.logo = patch.logo
    if (patch.published !== undefined) values.published = patch.published
    if (patch.monitorIds !== undefined) values.monitorIds = JSON.stringify(patch.monitorIds)
    if (patch.theme !== undefined) {
      values.theme = patch.theme === null ? null : JSON.stringify(patch.theme)
    }

    const row = this.#db
      .update(statusPages)
      .set(values)
      .where(eq(statusPages.id, id))
      .returning()
      .all()[0]
    return row === undefined ? null : toStatusPageRow(row)
  }

  deleteStatusPage(id: number): boolean {
    return this.#db.delete(statusPages).where(eq(statusPages.id, id)).run().changes > 0
  }

  // Maintenance windows

  createMaintenanceWindow(input: NewMaintenanceWindow): MaintenanceWindowRow {
    const now = new Date()
    const row = this.#db
      .insert(maintenanceWindows)
      .values({
        name: input.name,
        scope: input.scope,
        monitorIds: JSON.stringify(input.monitorIds ?? []),
        tagIds: JSON.stringify(input.tagIds ?? []),
        strategy: input.strategy,
        startAt: input.startAt ?? null,
        endAt: input.endAt ?? null,
        intervalS: input.intervalS ?? null,
        weekdays:
          input.weekdays === undefined || input.weekdays === null
            ? null
            : JSON.stringify(input.weekdays),
        startTime: input.startTime ?? null,
        endTime: input.endTime ?? null,
        cronExpr: input.cronExpr ?? null,
        cronTz: input.cronTz ?? null,
        active: input.active ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all()[0]
    if (row === undefined) {
      throw new Error('createMaintenanceWindow: insert returned no row')
    }
    return toMaintenanceWindowRow(row)
  }

  listMaintenanceWindows(): MaintenanceWindowRow[] {
    return this.#db
      .select()
      .from(maintenanceWindows)
      .orderBy(maintenanceWindows.id)
      .all()
      .map(toMaintenanceWindowRow)
  }

  /** `null` clears the optional fields; the id lists and `weekdays` replace wholesale. */
  updateMaintenanceWindow(
    id: number,
    patch: Partial<NewMaintenanceWindow>,
  ): MaintenanceWindowRow | null {
    const values: Partial<typeof maintenanceWindows.$inferInsert> = { updatedAt: new Date() }
    if (patch.name !== undefined) values.name = patch.name
    if (patch.scope !== undefined) values.scope = patch.scope
    if (patch.monitorIds !== undefined) values.monitorIds = JSON.stringify(patch.monitorIds)
    if (patch.tagIds !== undefined) values.tagIds = JSON.stringify(patch.tagIds)
    if (patch.strategy !== undefined) values.strategy = patch.strategy
    if (patch.startAt !== undefined) values.startAt = patch.startAt
    if (patch.endAt !== undefined) values.endAt = patch.endAt
    if (patch.intervalS !== undefined) values.intervalS = patch.intervalS
    if (patch.weekdays !== undefined) {
      values.weekdays = patch.weekdays === null ? null : JSON.stringify(patch.weekdays)
    }
    if (patch.startTime !== undefined) values.startTime = patch.startTime
    if (patch.endTime !== undefined) values.endTime = patch.endTime
    if (patch.cronExpr !== undefined) values.cronExpr = patch.cronExpr
    if (patch.cronTz !== undefined) values.cronTz = patch.cronTz
    if (patch.active !== undefined) values.active = patch.active

    const row = this.#db
      .update(maintenanceWindows)
      .set(values)
      .where(eq(maintenanceWindows.id, id))
      .returning()
      .all()[0]
    return row === undefined ? null : toMaintenanceWindowRow(row)
  }

  deleteMaintenanceWindow(id: number): boolean {
    return (
      this.#db.delete(maintenanceWindows).where(eq(maintenanceWindows.id, id)).run().changes > 0
    )
  }

  // Heartbeat rollups

  /**
   * Aggregates raw heartbeats earlier than `before` into the hourly and daily
   * counter rows and advances the `rollup_watermark` setting (unix ms) so the
   * next run only reads the new window. Counters add into existing buckets, so
   * partial hours accumulate correctly and rerunning is a no-op; the whole run
   * is one transaction, hence a crash cannot double-count. Beats that arrive
   * with a time older than the watermark are not re-counted.
   *
   * Returns the number of raw heartbeats aggregated.
   */
  rollupHeartbeats(before: Date): number {
    const beforeMs = before.getTime()
    const watermarkRaw = this.getSetting(ROLLUP_WATERMARK_KEY)
    const parsed = watermarkRaw === null ? Number.NaN : Number(watermarkRaw)
    const watermark = Number.isFinite(parsed) ? parsed : null
    if (watermark !== null && beforeMs <= watermark) return 0

    const windowFilter =
      watermark === null
        ? lt(heartbeats.time, before)
        : and(gte(heartbeats.time, new Date(watermark)), lt(heartbeats.time, before))
    const hourBucketExpr = sql<number>`cast(${heartbeats.time} / 3600000 as integer) * 3600000`
    const dayBucketExpr = sql<number>`cast(${heartbeats.time} / 86400000 as integer) * 86400000`
    const hourBucket = hourBucketExpr.as('hour_bucket')
    const dayBucket = dayBucketExpr.as('day_bucket')
    const upCount = sql<number>`sum(case when ${heartbeats.status} = 'up' then 1 else 0 end)`.as(
      'up',
    )
    const downCount =
      sql<number>`sum(case when ${heartbeats.status} = 'down' then 1 else 0 end)`.as('down')
    const maintenanceCount =
      sql<number>`sum(case when ${heartbeats.status} = 'maintenance' then 1 else 0 end)`.as(
        'maintenance',
      )
    const totalMs = sql<number>`sum(coalesce(${heartbeats.latencyMs}, 0))`.as('total_ms')
    const beatCount = sql<number>`count(*)`.as('count')

    return this.#db.transaction((tx) => {
      const counted = tx.select({ value: count() }).from(heartbeats).where(windowFilter).get()
      const aggregated = counted?.value ?? 0

      tx.insert(heartbeatsHourly)
        .select(
          tx
            .select({
              monitorId: heartbeats.monitorId,
              hourBucket,
              up: upCount,
              down: downCount,
              maintenance: maintenanceCount,
              totalMs,
              count: beatCount,
            })
            .from(heartbeats)
            .where(windowFilter)
            .groupBy(heartbeats.monitorId, hourBucketExpr),
        )
        .onConflictDoUpdate({
          target: [heartbeatsHourly.monitorId, heartbeatsHourly.hourBucket],
          set: {
            up: sql`${heartbeatsHourly.up} + excluded.up`,
            down: sql`${heartbeatsHourly.down} + excluded.down`,
            maintenance: sql`${heartbeatsHourly.maintenance} + excluded.maintenance`,
            totalMs: sql`${heartbeatsHourly.totalMs} + excluded.total_ms`,
            count: sql`${heartbeatsHourly.count} + excluded.count`,
          },
        })
        .run()

      tx.insert(heartbeatsDaily)
        .select(
          tx
            .select({
              monitorId: heartbeats.monitorId,
              dayBucket,
              up: upCount,
              down: downCount,
              maintenance: maintenanceCount,
              totalMs,
              count: beatCount,
            })
            .from(heartbeats)
            .where(windowFilter)
            .groupBy(heartbeats.monitorId, dayBucketExpr),
        )
        .onConflictDoUpdate({
          target: [heartbeatsDaily.monitorId, heartbeatsDaily.dayBucket],
          set: {
            up: sql`${heartbeatsDaily.up} + excluded.up`,
            down: sql`${heartbeatsDaily.down} + excluded.down`,
            maintenance: sql`${heartbeatsDaily.maintenance} + excluded.maintenance`,
            totalMs: sql`${heartbeatsDaily.totalMs} + excluded.total_ms`,
            count: sql`${heartbeatsDaily.count} + excluded.count`,
          },
        })
        .run()

      tx.insert(settings)
        .values({ key: ROLLUP_WATERMARK_KEY, value: String(beforeMs) })
        .onConflictDoUpdate({ target: settings.key, set: { value: String(beforeMs) } })
        .run()

      return aggregated
    })
  }

  /**
   * Rolled-up availability for the trailing `hours`: hourly counters up to 48 h,
   * daily counters beyond. Rollups lag the newest raw heartbeats until the next
   * {@link rollupHeartbeats} run (`uptimePct` is `up / (up + down)`, so planned
   * maintenance neither helps nor hurts; 100 when there is nothing to divide).
   */
  getUptime(monitorId: number, hours: number): UptimeStats {
    const sinceMs = Date.now() - hours * 3_600_000
    const counters =
      hours <= 48
        ? this.#db
            .select({
              up: sum(heartbeatsHourly.up),
              down: sum(heartbeatsHourly.down),
              maintenance: sum(heartbeatsHourly.maintenance),
              total: sum(heartbeatsHourly.count),
            })
            .from(heartbeatsHourly)
            .where(
              and(
                eq(heartbeatsHourly.monitorId, monitorId),
                gte(heartbeatsHourly.hourBucket, sinceMs),
              ),
            )
            .get()
        : this.#db
            .select({
              up: sum(heartbeatsDaily.up),
              down: sum(heartbeatsDaily.down),
              maintenance: sum(heartbeatsDaily.maintenance),
              total: sum(heartbeatsDaily.count),
            })
            .from(heartbeatsDaily)
            .where(
              and(
                eq(heartbeatsDaily.monitorId, monitorId),
                gte(heartbeatsDaily.dayBucket, sinceMs),
              ),
            )
            .get()
    const up = Number(counters?.up ?? 0)
    const down = Number(counters?.down ?? 0)
    const decisive = up + down
    return {
      total: Number(counters?.total ?? 0),
      up,
      down,
      maintenance: Number(counters?.maintenance ?? 0),
      uptimePct: decisive === 0 ? 100 : (up / decisive) * 100,
    }
  }

  /** Oldest first; `since` is inclusive and `limit` caps the batch for streaming reads. */
  listHeartbeatsSince(monitorId: number, since: Date, limit = 5000): HeartbeatRow[] {
    return this.#db
      .select()
      .from(heartbeats)
      .where(and(eq(heartbeats.monitorId, monitorId), gte(heartbeats.time, since)))
      .orderBy(asc(heartbeats.time), asc(heartbeats.id))
      .limit(limit)
      .all()
  }

  // ---- Docker hosts (SPEC §4) ----

  createDockerHost(input: {
    name: string
    uri: string
    tlsCaEnc?: string
    tlsCertEnc?: string
    tlsKeyEnc?: string
  }): DockerHostRow {
    const now = new Date()
    const row = this.#db
      .insert(dockerHosts)
      .values({
        name: input.name,
        uri: input.uri,
        tlsCaEnc: input.tlsCaEnc ?? null,
        tlsCertEnc: input.tlsCertEnc ?? null,
        tlsKeyEnc: input.tlsKeyEnc ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all()[0]
    if (row === undefined) throw new Error('createDockerHost: insert returned no row')
    return toDockerHostRow(row)
  }

  listDockerHosts(): DockerHostRow[] {
    return this.#db
      .select()
      .from(dockerHosts)
      .orderBy(asc(dockerHosts.id))
      .all()
      .map(toDockerHostRow)
  }

  getDockerHost(id: number): DockerHostRow | null {
    const row = this.#db.select().from(dockerHosts).where(eq(dockerHosts.id, id)).all()[0]
    return row === undefined ? null : toDockerHostRow(row)
  }

  updateDockerHost(
    id: number,
    patch: Partial<{
      name: string
      uri: string
      tlsCaEnc: string | null
      tlsCertEnc: string | null
      tlsKeyEnc: string | null
    }>,
  ): DockerHostRow | null {
    const values: Partial<typeof dockerHosts.$inferSelect> = { updatedAt: new Date() }
    if (patch.name !== undefined) values.name = patch.name
    if (patch.uri !== undefined) values.uri = patch.uri
    if (patch.tlsCaEnc !== undefined) values.tlsCaEnc = patch.tlsCaEnc
    if (patch.tlsCertEnc !== undefined) values.tlsCertEnc = patch.tlsCertEnc
    if (patch.tlsKeyEnc !== undefined) values.tlsKeyEnc = patch.tlsKeyEnc
    const row = this.#db
      .update(dockerHosts)
      .set(values)
      .where(eq(dockerHosts.id, id))
      .returning()
      .all()[0]
    return row === undefined ? null : toDockerHostRow(row)
  }

  deleteDockerHost(id: number): boolean {
    const result = this.#db.delete(dockerHosts).where(eq(dockerHosts.id, id)).run()
    return result.changes > 0
  }

  // ---- Snapshot backup, retention, Uptime-Kuma import (SPEC §4/§9, M6) ----

  /**
   * Writes a consistent copy of the database to `filePath` via SQLite's online
   * backup API. WAL-safe: committed WAL frames are included and the copy is made
   * while readers/writers continue (no `VACUUM`/lock). The parent directory must
   * exist; an existing destination file is overwritten, and a failed backup
   * removes the partial destination. Async by nature of `backup()` — callers
   * await it before reporting success.
   */
  async backupTo(filePath: string): Promise<void> {
    await this.#sqlite.backup(filePath)
  }

  /** Deletes every raw heartbeat with `time < cutoff`; returns the number removed. */
  deleteHeartbeatsBefore(cutoff: Date): number {
    return this.#db.delete(heartbeats).where(lt(heartbeats.time, cutoff)).run().changes
  }

  /**
   * Deletes raw heartbeats that are both older than `cutoff` and already covered
   * by the aggregates: `time < rollup_watermark`, the exclusive lower bound
   * recorded by {@link rollupHeartbeats}. Returns 0 when no rollup has run —
   * without a watermark nothing is known to be aggregated, so nothing is safe
   * to drop.
   */
  deleteRolledupBefore(cutoff: Date): number {
    const watermarkRaw = this.getSetting(ROLLUP_WATERMARK_KEY)
    const watermark = watermarkRaw === null ? Number.NaN : Number(watermarkRaw)
    if (!Number.isFinite(watermark)) return 0
    const limit = new Date(Math.min(cutoff.getTime(), watermark))
    return this.#db.delete(heartbeats).where(lt(heartbeats.time, limit)).run().changes
  }

  /**
   * Inserts many heartbeats in one transaction (bulk imports); an empty batch is
   * a no-op. Live checks keep using the single-row {@link insertHeartbeat}.
   */
  insertHeartbeatsBatch(
    rows: Array<{
      monitorId: number
      status: HeartbeatStatus
      latencyMs?: number | null
      responseSnippet?: string | null
      time: Date
    }>,
  ): void {
    if (rows.length === 0) return
    this.#db.transaction((tx) => {
      for (const row of rows) {
        tx.insert(heartbeats)
          .values({
            monitorId: row.monitorId,
            status: row.status,
            latencyMs: row.latencyMs ?? null,
            responseSnippet: row.responseSnippet ?? null,
            time: row.time,
          })
          .run()
      }
    })
  }

  /**
   * Best-effort Uptime-Kuma import (PLAN M6). Monitors are created unless a
   * monitor with the same `type` + `name` already exists — existing rows are
   * never modified or deleted. Heartbeats are matched to monitors by
   * `monitorSlug` = monitor `name` and inserted in one transaction. The import
   * is idempotent: beats whose `(monitor_id, time)` pair already exists locally
   * are skipped, as are entries with an unknown slug, an invalid status or a
   * non-finite time. The CLI (scripts/) converts Kuma's SQLite into this JSON
   * and maps each monitor's config to a shape `@uptime/core` validates; configs
   * arrive here already converted and are stored verbatim.
   */
  importKuma(input: KumaImportInput): KumaImportResult {
    const existingByKey = new Map<string, MonitorRow>()
    const idByName = new Map<string, number>()
    for (const row of this.listMonitors()) {
      existingByKey.set(`${row.type}\u0000${row.name}`, row)
      if (!idByName.has(row.name)) idByName.set(row.name, row.id)
    }

    let monitorsCreated = 0
    for (const monitor of input.monitors) {
      if (typeof monitor !== 'object' || monitor === null) continue
      if (typeof monitor.type !== 'string' || monitor.type.length === 0) continue
      if (typeof monitor.name !== 'string' || monitor.name.length === 0) continue
      const key = `${monitor.type}\u0000${monitor.name}`
      const existing = existingByKey.get(key)
      if (existing !== undefined) {
        if (!idByName.has(monitor.name)) idByName.set(monitor.name, existing.id)
        continue
      }
      // Kuma stores interval/retries; fall back to the SPEC §3 defaults when a
      // converted row omits them (mirrors the `monitors` column defaults).
      const schedule = { intervalS: 60, retries: 1, retryIntervalS: 60 }
      for (const field of ['intervalS', 'retries', 'retryIntervalS'] as const) {
        const value = monitor[field]
        if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
          schedule[field] = value
        }
      }
      const row = this.createMonitor({
        type: monitor.type,
        name: monitor.name,
        config: monitor.config,
        ...schedule,
      })
      existingByKey.set(key, row)
      if (!idByName.has(row.name)) idByName.set(row.name, row.id)
      monitorsCreated += 1
    }

    let heartbeatsImported = 0
    const pending: Array<{
      monitorId: number
      status: 'up' | 'down'
      latencyMs: number | null
      time: Date
    }> = []
    const bounds = new Map<number, { min: number; max: number }>()
    const queued = new Set<string>()
    for (const beat of input.heartbeats) {
      if (typeof beat !== 'object' || beat === null) continue
      if (typeof beat.monitorSlug !== 'string' || !Number.isFinite(beat.time)) continue
      if (beat.status !== 'up' && beat.status !== 'down') continue
      const monitorId = idByName.get(beat.monitorSlug)
      if (monitorId === undefined) continue
      const key = `${monitorId}\u0000${beat.time}`
      if (queued.has(key)) continue
      queued.add(key)
      pending.push({
        monitorId,
        status: beat.status,
        latencyMs:
          typeof beat.latencyMs === 'number' && Number.isFinite(beat.latencyMs)
            ? Math.round(beat.latencyMs)
            : null,
        time: new Date(beat.time),
      })
      const range = bounds.get(monitorId)
      if (range === undefined) bounds.set(monitorId, { min: beat.time, max: beat.time })
      else if (beat.time < range.min) range.min = beat.time
      else if (beat.time > range.max) range.max = beat.time
    }
    if (pending.length > 0) {
      // One indexed range query per monitor instead of per beat: Kuma exports
      // can carry years of history, and re-runs must not duplicate it.
      const present = new Set<string>()
      for (const [monitorId, range] of bounds) {
        const times = this.#db
          .select({ time: heartbeats.time })
          .from(heartbeats)
          .where(
            and(
              eq(heartbeats.monitorId, monitorId),
              gte(heartbeats.time, new Date(range.min)),
              lte(heartbeats.time, new Date(range.max)),
            ),
          )
          .all()
        for (const row of times) present.add(`${monitorId}\u0000${row.time.getTime()}`)
      }
      const fresh = pending.filter(
        (row) => !present.has(`${row.monitorId}\u0000${row.time.getTime()}`),
      )
      this.insertHeartbeatsBatch(fresh)
      heartbeatsImported = fresh.length
    }

    return { monitorsCreated, heartbeatsImported }
  }
}
