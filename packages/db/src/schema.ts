import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
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

/** `push_tokens` — one token per monitor; only the sha256 hash is persisted. */
export const pushTokens = sqliteTable('push_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  monitorId: integer('monitor_id')
    .notNull()
    .unique()
    .references(() => monitors.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

/** `settings` — instance-level key/value store. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
