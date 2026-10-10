import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Sqlite from 'better-sqlite3'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { and, count, desc, eq, inArray, isNotNull, isNull, lt, lte, max, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

import * as schema from './schema.js'
import {
  apiKeys,
  heartbeats,
  incidents,
  monitorNotifications,
  monitors,
  monitorTags,
  notificationChannels,
  pushTokens,
  sessions,
  settings,
  tags,
  users,
  type HeartbeatStatus,
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

type MonitorSelect = typeof monitors.$inferSelect
type ApiKeySelect = typeof apiKeys.$inferSelect

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
}
