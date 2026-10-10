import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

/** Heartbeat statuses, shared by schema, rows and the API boundary. */
export const HEARTBEAT_STATUSES = ['up', 'down', 'pending', 'maintenance'] as const

export type HeartbeatStatus = (typeof HEARTBEAT_STATUSES)[number]

/**
 * `monitors` — SPEC §4. `config_json` holds the per-type config validated by
 * `@uptime/core`; timestamps are unix milliseconds.
 */
export const monitors = sqliteTable('monitors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  name: text('name').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  intervalS: integer('interval_s').notNull().default(60),
  retries: integer('retries').notNull().default(1),
  retryIntervalS: integer('retry_interval_s').notNull().default(60),
  resendNotificationS: integer('resend_notification_s').notNull().default(0),
  upsideDown: integer('upside_down', { mode: 'boolean' }).notNull().default(false),
  parentId: integer('parent_id').references((): AnySQLiteColumn => monitors.id, {
    onDelete: 'set null',
  }),
  configJson: text('config_json').notNull().default('{}'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/** `heartbeats` — raw check results; read newest-first by `(monitor_id, time)`. */
export const heartbeats = sqliteTable(
  'heartbeats',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    monitorId: integer('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    status: text('status', { enum: HEARTBEAT_STATUSES }).notNull(),
    latencyMs: integer('latency_ms'),
    responseSnippet: text('response_snippet'),
    time: integer('time', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('heartbeats_monitor_time_idx').on(table.monitorId, table.time)],
)

/** `push_tokens` — one token per monitor; sha256 for lookup + encrypted copy for URL display. */
export const pushTokens = sqliteTable('push_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  monitorId: integer('monitor_id')
    .notNull()
    .unique()
    .references(() => monitors.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  tokenEnc: text('token_enc'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

/** `settings` — instance-level key/value store. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const USER_ROLES = ['admin', 'editor', 'viewer'] as const
export type UserRole = (typeof USER_ROLES)[number]

/** `users` — SPEC §4. TOTP + recovery codes are stored encrypted (ADR-0002). */
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  totpSecretEnc: text('totp_secret_enc'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
  recoveryCodesEnc: text('recovery_codes_enc'),
  role: text('role', { enum: USER_ROLES }).notNull().default('admin'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/** `sessions` — server-side session store; `id` is the cookie value. */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  csrfToken: text('csrf_token').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

/** `api_keys` — hashed bearer tokens for the admin API (SPEC §5/§8). */
export const apiKeys = sqliteTable('api_keys', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  scopes: text('scopes').notNull().default('[]'),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

/** `notification_channels` — per-type config stored AES-256-GCM encrypted. */
export const notificationChannels = sqliteTable('notification_channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  name: text('name').notNull(),
  configEnc: text('config_enc').notNull(),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/** `monitor_notifications` — per-monitor channel routing. */
export const monitorNotifications = sqliteTable(
  'monitor_notifications',
  {
    monitorId: integer('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.monitorId, table.channelId] })],
)

/** `incidents` — open/resolved record per monitor (SPEC §4). */
export const incidents = sqliteTable(
  'incidents',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    monitorId: integer('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    openedAt: integer('opened_at', { mode: 'timestamp_ms' }).notNull(),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
    title: text('title').notNull(),
    body: text('body'),
  },
  (table) => [index('incidents_monitor_opened_idx').on(table.monitorId, table.openedAt)],
)

/** `tags` + `monitor_tags` — Kuma-style tag filtering. */
export const tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  color: text('color').notNull().default('#64748b'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

export const monitorTags = sqliteTable(
  'monitor_tags',
  {
    monitorId: integer('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.monitorId, table.tagId] })],
)
