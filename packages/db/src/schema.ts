import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
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
  /** Shown on the unauthenticated public status overview (`GET /api/v1/public/status`). */
  isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
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

/** `docker_hosts` — Docker endpoint credentials for `docker` monitors (SPEC §4). */
export const dockerHosts = sqliteTable('docker_hosts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  uri: text('uri').notNull(),
  tlsCaEnc: text('tls_ca_enc'),
  tlsCertEnc: text('tls_cert_enc'),
  tlsKeyEnc: text('tls_key_enc'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
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

/** Maintenance-window scope — SPEC §4 (`all` monitors, explicit `ids` or `tags`). */
export const MAINTENANCE_SCOPES = ['all', 'ids', 'tags'] as const
export type MaintenanceScope = (typeof MAINTENANCE_SCOPES)[number]

/** Maintenance-window recurrence strategies — SPEC §4/§5. */
export const MAINTENANCE_STRATEGIES = [
  'single',
  'recurring-interval',
  'recurring-weekday',
  'cron',
] as const
export type MaintenanceStrategy = (typeof MAINTENANCE_STRATEGIES)[number]

/**
 * `status_pages` — public pages addressed by `slug` (SPEC §4/§11). `monitorIds`
 * is a JSON array; `theme` is a JSON object `{ accent?, dark? }`, `null` for
 * the default theme; `structure` is the component/group tree as JSON (shape
 * validated by `@uptime/core`); `password_hash` is the argon2 hash when the
 * page is password-protected, `null` otherwise.
 */
export const statusPages = sqliteTable('status_pages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  logo: text('logo'),
  published: integer('published', { mode: 'boolean' }).notNull().default(false),
  monitorIds: text('monitor_ids').notNull().default('[]'),
  theme: text('theme'),
  structure: text('structure').notNull().default('{}'),
  footerText: text('footer_text'),
  passwordHash: text('password_hash'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/** Incident lifecycle, shared with the API boundary (statuspage.io semantics). */
export const STATUS_INCIDENT_STATUSES = [
  'investigating',
  'identified',
  'monitoring',
  'resolved',
] as const
export type StatusIncidentStatus = (typeof STATUS_INCIDENT_STATUSES)[number]

/** Incident impact levels, worst last. */
export const STATUS_INCIDENT_IMPACTS = ['none', 'minor', 'major', 'critical'] as const
export type StatusIncidentImpact = (typeof STATUS_INCIDENT_IMPACTS)[number]

/** `auto` incidents are monitor-linked; `manual` ones are typed by an admin. */
export const STATUS_INCIDENT_SOURCES = ['auto', 'manual'] as const
export type StatusIncidentSource = (typeof STATUS_INCIDENT_SOURCES)[number]

/**
 * `status_incidents` — public incident communication for a status page
 * (STATUS_PAGES_PLAN §4). `componentIds` is a JSON array of component ids;
 * `monitor_id` links auto-created incidents to the monitor that triggered them
 * and is intentionally not a foreign key, so history outlives the monitor.
 */
export const statusIncidents = sqliteTable(
  'status_incidents',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pageId: integer('page_id')
      .notNull()
      .references(() => statusPages.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: text('status', { enum: STATUS_INCIDENT_STATUSES }).notNull().default('investigating'),
    impact: text('impact', { enum: STATUS_INCIDENT_IMPACTS }).notNull().default('major'),
    componentIds: text('component_ids').notNull().default('[]'),
    source: text('source', { enum: STATUS_INCIDENT_SOURCES }).notNull().default('manual'),
    monitorId: integer('monitor_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('status_incidents_page_monitor_idx').on(table.pageId, table.monitorId),
    index('status_incidents_page_resolved_idx').on(table.pageId, table.resolvedAt),
  ],
)

/** `status_incident_updates` — the public timeline of an incident, oldest first. */
export const statusIncidentUpdates = sqliteTable(
  'status_incident_updates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    incidentId: integer('incident_id')
      .notNull()
      .references(() => statusIncidents.id, { onDelete: 'cascade' }),
    status: text('status', { enum: STATUS_INCIDENT_STATUSES }).notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('status_incident_updates_incident_idx').on(table.incidentId)],
)

/** Events a status-page subscriber can opt into (STATUS_PAGES_PLAN §4/§6). */
export const STATUS_SUBSCRIPTION_EVENTS = [
  'incident_open',
  'incident_update',
  'incident_resolved',
  'maintenance_start',
  'maintenance_end',
] as const
export type StatusSubscriptionEvent = (typeof STATUS_SUBSCRIPTION_EVENTS)[number]

/**
 * `status_subscriptions` — a page's subscribers, one per notification channel
 * (Slack/Telegram/email/webhook/ntfy/gotify). `componentIds` is a JSON array of
 * component ids (`[]` = the whole page); `events` is a JSON array of
 * {@link STATUS_SUBSCRIPTION_EVENTS}. Delivery settings live on the channel.
 */
export const statusSubscriptions = sqliteTable(
  'status_subscriptions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pageId: integer('page_id')
      .notNull()
      .references(() => statusPages.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    componentIds: text('component_ids').notNull().default('[]'),
    events: text('events').notNull().default('[]'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('status_subscriptions_page_channel_idx').on(table.pageId, table.channelId),
  ],
)

/**
 * `maintenance_windows` — suppression windows (SPEC §4/§5). `monitorIds`,
 * `tagIds` and `weekdays` are JSON arrays; `startAt`/`endAt` are unix ms for
 * `single`; `startTime`/`endTime` are `HH:mm` local times for the recurring
 * strategies, whose `intervalS`/`weekdays`/`cronExpr` options are per-strategy.
 */
export const maintenanceWindows = sqliteTable('maintenance_windows', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  scope: text('scope', { enum: MAINTENANCE_SCOPES }).notNull(),
  monitorIds: text('monitor_ids').notNull().default('[]'),
  tagIds: text('tag_ids').notNull().default('[]'),
  strategy: text('strategy', { enum: MAINTENANCE_STRATEGIES }).notNull(),
  startAt: integer('start_at', { mode: 'timestamp_ms' }),
  endAt: integer('end_at', { mode: 'timestamp_ms' }),
  intervalS: integer('interval_s'),
  weekdays: text('weekdays'),
  startTime: text('start_time'),
  endTime: text('end_time'),
  cronExpr: text('cron_expr'),
  cronTz: text('cron_tz'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/**
 * `heartbeats_hourly` — per-hour counters keyed by UTC hour start (unix ms),
 * written by `Database.rollupHeartbeats` with additive upserts so reruns and
 * partial buckets stay correct. `count` covers every beat (pending included)
 * and `totalMs` sums non-null latencies for averages.
 */
export const heartbeatsHourly = sqliteTable(
  'heartbeats_hourly',
  {
    monitorId: integer('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    hourBucket: integer('hour_bucket').notNull(),
    up: integer('up').notNull().default(0),
    down: integer('down').notNull().default(0),
    maintenance: integer('maintenance').notNull().default(0),
    totalMs: integer('total_ms').notNull().default(0),
    count: integer('count').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.monitorId, table.hourBucket] })],
)

/** `heartbeats_daily` — the same counters keyed by UTC day start (unix ms). */
export const heartbeatsDaily = sqliteTable(
  'heartbeats_daily',
  {
    monitorId: integer('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    dayBucket: integer('day_bucket').notNull(),
    up: integer('up').notNull().default(0),
    down: integer('down').notNull().default(0),
    maintenance: integer('maintenance').notNull().default(0),
    totalMs: integer('total_ms').notNull().default(0),
    count: integer('count').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.monitorId, table.dayBucket] })],
)
