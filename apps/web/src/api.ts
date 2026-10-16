/**
 * Typed client for the `/api/v1` HTTP API. Session auth uses an httpOnly cookie,
 * so mutating requests carry the CSRF token issued by login / `GET /auth/me`
 * in the `x-csrf-token` header.
 */

export type UserRole = 'admin' | 'editor' | 'viewer'
export type ApiKeyScope = 'read' | 'write' | 'admin'
export type MonitorType =
  | 'http'
  | 'push'
  | 'tcp'
  | 'dns'
  | 'icmp'
  | 'postgres'
  | 'mysql'
  | 'mssql'
  | 'mongodb'
  | 'redis'
  | 'docker'
  | 'group'
export type HeartbeatStatus = 'up' | 'down' | 'pending' | 'maintenance'
export type ChannelType = 'telegram' | 'discord' | 'slack' | 'email' | 'ntfy' | 'gotify' | 'webhook'

export const API_KEY_SCOPES: readonly ApiKeyScope[] = ['read', 'write', 'admin']
export const CHANNEL_TYPES: readonly ChannelType[] = [
  'telegram',
  'discord',
  'slack',
  'email',
  'ntfy',
  'gotify',
  'webhook',
]
export const MONITOR_TYPES: readonly MonitorType[] = [
  'http',
  'push',
  'tcp',
  'dns',
  'icmp',
  'postgres',
  'mysql',
  'mssql',
  'mongodb',
  'redis',
  'docker',
  'group',
]

/** Record types a `dns` monitor can resolve. */
export const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV'] as const
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number]

/** Container states a `docker` monitor can expect (`State.Status`). */
export const DOCKER_CONTAINER_STATES = [
  'running',
  'exited',
  'paused',
  'created',
  'restarting',
  'removing',
  'dead',
] as const
export type DockerContainerState = (typeof DOCKER_CONTAINER_STATES)[number]

/** Strategies a `group` monitor can combine its members with. */
export const GROUP_STRATEGIES = ['any-up', 'all-up', 'percentage'] as const
export type GroupStrategy = (typeof GROUP_STRATEGIES)[number]

/** HTTP methods accepted by the check engine. */
export const HTTP_METHODS = ['GET', 'POST', 'HEAD', 'PUT', 'DELETE'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

/** Mirrors the `MIN_INTERVAL_S` limit enforced by the server/core check engine. */
export const MIN_INTERVAL_S = 20

export interface User {
  id: number
  email: string
  role: UserRole
}

export interface AuthSession {
  user: User
  csrfToken: string | null
}

export interface Tag {
  id: number
  name: string
  color: string
}

export interface Heartbeat {
  id?: number
  monitorId?: number
  status: HeartbeatStatus
  latencyMs: number | null
  responseSnippet: string | null
  time: string
}

/** Aggregate for `GET /monitors/:id/uptime`. */
export interface UptimeStats {
  total: number
  up: number
  down: number
  maintenance: number
  uptimePct: number
}

export type StatusPageDark = 'light' | 'dark' | 'auto'

export interface StatusPageTheme {
  accent?: string
  dark?: StatusPageDark
}

/** How one component combines the statuses of its monitors. */
export type StatusAggregation = 'worst' | 'any'

/**
 * One tracked unit on a status page. Its monitors are the asynchronous
 * processes that share the unit (a web app and its worker, a push pulse, …).
 * Shape validated by `parseStatusPageStructure` in `@uptime/core`.
 */
export interface StatusPageComponent {
  /** Stable slug (`^[a-z0-9-]{1,60}$`), generated from the label; used by incidents. */
  id: string
  label: string
  /** Omitted when empty; the API rejects an explicit `null`. */
  description?: string
  monitorIds: number[]
  aggregation: StatusAggregation
  /** Per-component degraded threshold; omit to fall back to the page value. */
  degradedLatencyMs?: number
  showUptime: boolean
  showChart: boolean
}

export interface StatusPageGroup {
  name: string
  components: StatusPageComponent[]
}

/** The `structure` JSON of a status page; `null` for pages without components. */
export interface StatusPageStructure {
  groups: StatusPageGroup[]
  /** Page-level degraded threshold; omitted when unset. */
  degradedLatencyMs?: number
  autoPublish?: boolean
}

export interface StatusPage {
  id: number
  slug: string
  title: string
  logo: string | null
  published: boolean
  monitorIds: number[]
  theme: StatusPageTheme | null
  /** Normalized structure; `{}`-equivalent (no groups) for pages never given one. */
  structure: StatusPageStructure | null
  footerText: string | null
  /** Whether a public password is set; the hash itself never leaves the server. */
  hasPassword: boolean
}

/** Body of `POST /status-pages` / `PATCH /status-pages/:id`. */
export interface StatusPageInput {
  slug?: string
  title?: string
  logo?: string | null
  published?: boolean
  monitorIds?: number[]
  theme?: StatusPageTheme | null
  /** Carries the page threshold and auto-publish flag inside the structure. */
  structure?: StatusPageStructure | null
  footerText?: string | null
  /** Plain password to set (`null` clears it); the server stores a hash. */
  password?: string | null
}

/** Overall and per-component severity, worst first. */
export type StatusSeverity =
  'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'maintenance' | 'unknown'

export type StatusIncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved'
export type StatusIncidentImpact = 'none' | 'minor' | 'major' | 'critical'
export type StatusIncidentSource = 'auto' | 'manual'

export interface StatusIncidentUpdate {
  id: number
  status: StatusIncidentStatus
  body: string
  createdAt: string
}

/**
 * A status incident as served by both the admin endpoints and the public page
 * (`GET /status-pages/:id/incidents`, `GET /status/:slug`, `…/incidents`).
 */
export interface StatusIncident {
  id: number
  title: string
  status: StatusIncidentStatus
  impact: StatusIncidentImpact
  /** Component ids within the page structure. */
  componentIds: string[]
  source: StatusIncidentSource
  createdAt: string
  resolvedAt: string | null
  /** Oldest first. */
  updates: StatusIncidentUpdate[]
}

/** Shape served by the unauthenticated `GET /status/:slug`. */
export interface PublicStatusMonitor {
  id: number
  name: string
  type: MonitorType
  status: HeartbeatStatus
  latencyMs: number | null
  lastBeatAt: string | null
}

/** One heartbeat of a charted component; `latencyMs === null` marks a down beat. */
export interface PublicStatusSeriesPoint {
  /** ISO timestamp. */
  t: string
  latencyMs: number | null
}

export interface PublicStatusDaily {
  date: string
  uptimePct: number
  total: number
  down: number
  maintenance: number
}

export interface PublicStatusComponent {
  id: string
  label: string
  description: string | null
  status: StatusSeverity
  showUptime: boolean
  showChart: boolean
  monitors: PublicStatusMonitor[]
  uptimePct: number
  /** Oldest first, one entry per local calendar day. */
  daily: PublicStatusDaily[]
  /** Present only for `showChart` components: heartbeats of the last 24 h. */
  series?: PublicStatusSeriesPoint[]
}

export interface PublicStatusGroup {
  name: string
  components: PublicStatusComponent[]
}

/** A maintenance window of a page's components, as shown publicly. */
export interface PublicStatusMaintenanceWindow {
  id: number
  name: string
  startAt: string | null
  endAt: string | null
}

export interface PublicStatusMaintenance {
  active: PublicStatusMaintenanceWindow[]
  upcoming: PublicStatusMaintenanceWindow[]
}

export interface PublicStatusPage {
  slug: string
  title: string
  logo: string | null
  theme: StatusPageTheme | null
  footerText: string | null
  overall: StatusSeverity
  degradedLatencyMs: number | null
  groups: PublicStatusGroup[]
  /** Active incidents only. */
  incidents: StatusIncident[]
  maintenance: PublicStatusMaintenance
  passwordRequired: boolean
}

/** Body of `POST /status-pages/:id/incidents` (manual incident + first update). */
export interface StatusIncidentInput {
  title: string
  impact: StatusIncidentImpact
  componentIds: string[]
  /** Becomes the incident's first update; defaults to the title when omitted. */
  body?: string
}

/** Body of `POST /status-incidents/:id/updates`; `resolved` closes the incident. */
export interface StatusIncidentUpdateInput {
  status: StatusIncidentStatus
  body: string
}

/** Body of `PATCH /status-incidents/:id` (field edits; narrative goes in updates). */
export interface StatusIncidentPatch {
  title?: string
  impact?: StatusIncidentImpact
  componentIds?: string[]
}

export type StatusSubscriptionEvent =
  | 'incident_open'
  | 'incident_update'
  | 'incident_resolved'
  | 'maintenance_start'
  | 'maintenance_end'

/** A notification channel subscribed to a page's incidents and maintenance. */
export interface StatusSubscription {
  id: number
  pageId: number
  channelId: number
  /** Channel name/type as resolved by the server; null when the channel is gone. */
  channelName: string | null
  channelType: ChannelType | null
  /** Empty means the whole page. */
  componentIds: string[]
  events: StatusSubscriptionEvent[]
  createdAt: string
}

/** Body of `POST /status-pages/:id/subscriptions`. */
export interface StatusSubscriptionInput {
  channelId: number
  componentIds: string[]
  events: StatusSubscriptionEvent[]
}

export type MaintenanceScope = 'all' | 'ids' | 'tags'
export type MaintenanceStrategy = 'single' | 'recurring-interval' | 'recurring-weekday' | 'cron'

export interface MaintenanceWindow {
  id: number
  name: string
  scope: MaintenanceScope
  monitorIds: number[]
  tagIds: number[]
  strategy: MaintenanceStrategy
  startAt: string | null
  endAt: string | null
  intervalS: number | null
  /** Day indices (`0` = Sunday … `6` = Saturday) for `recurring-weekday`. */
  weekdays: number[]
  /** `HH:MM` local time bound. */
  startTime: string | null
  endTime: string | null
  cronExpr: string | null
  cronTz: string | null
  active: boolean
}

/** Body of `POST /maintenance-windows` / `PATCH /maintenance-windows/:id`. */
export interface MaintenanceWindowInput {
  name?: string
  scope?: MaintenanceScope
  monitorIds?: number[]
  tagIds?: number[]
  strategy?: MaintenanceStrategy
  startAt?: string | null
  endAt?: string | null
  intervalS?: number | null
  weekdays?: number[]
  startTime?: string | null
  endTime?: string | null
  cronExpr?: string | null
  cronTz?: string | null
  active?: boolean
}

export interface AppSettings {
  title: string
  timezone: string
}

export interface HttpMonitorConfig {
  url: string
  method?: HttpMethod
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  acceptedStatus?: [number, number] | 'any'
  keyword?: { value: string; inverse?: boolean }
  maxResponseMs?: number
  certExpiryDays?: number
}

export interface PushMonitorConfig {
  graceSeconds?: number
  cron?: string
  expectsBody?: boolean
}

export interface TcpMonitorConfig {
  host: string
  port: number
  timeoutMs?: number
  payload?: string
  /** Substring the response must contain (used with `payload`). */
  expectResponse?: string
}

export interface DnsMonitorConfig {
  host: string
  resolver?: string
  port?: number
  recordType: DnsRecordType
  expectedValue?: string
  timeoutMs?: number
}

export interface IcmpMonitorConfig {
  host: string
  timeoutMs?: number
  packetCount?: number
}

export interface DatabaseMonitorConfig {
  connectionString: string
  timeoutMs?: number
  query?: string
}

export interface MongodbMonitorConfig {
  connectionString: string
  timeoutMs?: number
}

export interface RedisMonitorConfig {
  connectionString: string
  timeoutMs?: number
  query?: string
}

export interface DockerMonitorConfig {
  hostUri: string
  containerNameOrId: string
  expectedState?: DockerContainerState
  tlsCaPem?: string
  tlsCertPem?: string
  tlsKeyPem?: string
  timeoutMs?: number
}

export interface GroupMonitorConfig {
  memberIds: number[]
  strategy: GroupStrategy
  percentage?: number
}

/** Validated configuration per monitor type, keyed by {@link MonitorType}. */
export interface MonitorConfigMap {
  http: HttpMonitorConfig
  push: PushMonitorConfig
  tcp: TcpMonitorConfig
  dns: DnsMonitorConfig
  icmp: IcmpMonitorConfig
  postgres: DatabaseMonitorConfig
  mysql: DatabaseMonitorConfig
  mssql: DatabaseMonitorConfig
  mongodb: MongodbMonitorConfig
  redis: RedisMonitorConfig
  docker: DockerMonitorConfig
  group: GroupMonitorConfig
}

interface MonitorBase {
  id: number
  name: string
  active: boolean
  isPublic: boolean
  intervalS: number
  retries: number
  retryIntervalS: number
  tags: Tag[]
  channelIds: number[]
  latestHeartbeat: Heartbeat | null
  pushUrl?: string
}

/** A monitor whose `config` matches its `type`. */
export type Monitor = {
  [T in MonitorType]: MonitorBase & { type: T; config: MonitorConfigMap[T] }
}[MonitorType]

/** Body of `POST /monitors` / `PATCH /monitors/:id`. */
export interface MonitorInput {
  name?: string
  intervalS?: number
  retries?: number
  retryIntervalS?: number
  type?: MonitorType
  config?: Record<string, unknown>
  /** Shown by name on the unauthenticated public status overview. */
  isPublic?: boolean
  /** Either existing tag ids or names (the server maps names onto tags). */
  tagIds?: number[]
  tags?: string[]
  channelIds?: number[]
}

/** A reusable Docker endpoint (`GET /docker-hosts`); TLS material is write-only. */
export interface DockerHost {
  id: number
  name: string
  uri: string
  hasTls: boolean
  createdAt: string
  updatedAt: string
}

/** Body of `POST /docker-hosts` / `PATCH /docker-hosts/:id`. */
export interface DockerHostInput {
  name?: string
  uri?: string
  tlsCa?: string
  tlsCert?: string
  tlsKey?: string
}

export interface Channel {
  id: number
  type: ChannelType
  name: string
  isDefault: boolean
  active: boolean
}

export interface ChannelInput {
  type: ChannelType
  name: string
  config: Record<string, unknown>
  isDefault?: boolean
}

export interface Incident {
  id: number
  monitorId: number
  monitorName: string
  openedAt: string
  resolvedAt: string | null
  title: string
  body: string | null
}

export interface ApiKey {
  id: number
  name: string
  scopes: ApiKeyScope[]
  createdBy: number | null
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
}

export class ApiError extends Error {
  readonly status: number
  /** Machine-readable server code (e.g. `invalid_credentials`), when the body carried one. */
  readonly code: string | null
  readonly retryAfterMs: number | null

  constructor(status: number, code: string | null, retryAfterMs: number | null = null) {
    super(code ?? `Request failed with status ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

/** Shown when the API cannot be reached at all (fetch rejection). */
export const NETWORK_ERROR = 'network_error'

const BASE_PATH = '/api/v1'

let csrfToken: string | null = null

export function setCsrfToken(token: string | null): void {
  csrfToken = token
}

/** Called when an authenticated request is rejected with 401 (session expired). */
let unauthorizedHandler: (() => void) | null = null

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler
}

interface RequestOptions {
  /** 401 is an expected outcome for this call (sign-in, session probe); skip the global handler. */
  allowUnauthenticated?: boolean
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  options: RequestOptions = {},
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (method !== 'GET' && method !== 'HEAD' && csrfToken !== null) {
    headers.set('x-csrf-token', csrfToken)
  }

  let response: Response
  try {
    response = await fetch(`${BASE_PATH}${path}`, { ...init, headers })
  } catch {
    throw new ApiError(0, NETWORK_ERROR)
  }

  if (!response.ok) {
    const body = await errorBody(response)
    if (response.status === 401 && options.allowUnauthenticated !== true) {
      unauthorizedHandler?.()
    }
    throw new ApiError(response.status, body.code, body.retryAfterMs)
  }

  if (response.status === 204) {
    return null as T
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return null as T
  }
  return (await response.json()) as T
}

interface ErrorBody {
  code: string | null
  retryAfterMs: number | null
}

async function errorBody(response: Response): Promise<ErrorBody> {
  try {
    const body = (await response.json()) as { error?: unknown; retryAfterMs?: unknown }
    return {
      code: typeof body.error === 'string' && body.error !== '' ? body.error : null,
      retryAfterMs: typeof body.retryAfterMs === 'number' ? body.retryAfterMs : null,
    }
  } catch {
    return { code: null, retryAfterMs: null }
  }
}

/** Human-readable messages for the API's machine-readable error codes. */
const ERROR_MESSAGES: Record<string, string> = {
  [NETWORK_ERROR]: 'Cannot reach the server.',
  csrf: 'Your session token is no longer valid. Sign in again.',
  unauthenticated: 'Your session has expired. Sign in again.',
  forbidden: 'You do not have permission to do that.',
  insufficient_scope: 'Your API key does not cover this action.',
  not_found: 'That item no longer exists.',
  invalid_credentials: 'Incorrect email or password.',
  '2fa_required': 'Enter the code from your authenticator app.',
  invalid_otp: 'That code is not valid. Try again.',
  invalid_recovery_code: 'That recovery code is not valid.',
  too_many_attempts: 'Too many attempts. Try again later.',
  setup_complete: 'Setup is already complete. Sign in instead.',
  invalid_email: 'Enter a valid email address.',
  invalid_password: 'Password must be at least 8 characters.',
  totp_already_enabled: 'Two-factor authentication is already enabled.',
  totp_not_setup: 'Start the two-factor setup first.',
  invalid_name: 'Enter a name.',
  invalid_scopes: 'Select at least one scope.',
  invalid_id: 'That item no longer exists.',
}

/**
 * Maps an error from {@link ApiError} (or anything else) onto display text.
 * Unknown snake_case codes fall back to `fallback`; server sentences (plain
 * text, e.g. config validation) are passed through as-is.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback

  if (error.code === null) return error.status === 0 ? ERROR_MESSAGES[NETWORK_ERROR]! : fallback

  if (error.code === 'too_many_attempts' && error.retryAfterMs !== null) {
    return `Too many attempts. Try again in ${formatRetry(error.retryAfterMs)}.`
  }

  const known = ERROR_MESSAGES[error.code]
  if (known !== undefined) return known
  return error.code.includes('_') ? fallback : error.code
}

export function formatRetry(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.ceil(seconds / 60)}m`
}

/* Authentication */

export function fetchAuthState(): Promise<{ setupRequired: boolean }> {
  return request('/auth/state', {}, { allowUnauthenticated: true })
}

export function setupAdmin(input: { email: string; password: string }): Promise<AuthSession> {
  return request(
    '/auth/setup',
    { method: 'POST', body: JSON.stringify(input) },
    { allowUnauthenticated: true },
  )
}

export function login(input: {
  email: string
  password: string
  otp?: string
}): Promise<AuthSession> {
  return request(
    '/auth/login',
    { method: 'POST', body: JSON.stringify(input) },
    { allowUnauthenticated: true },
  )
}

export function logout(): Promise<void> {
  return request('/auth/logout', { method: 'POST' })
}

/** Rotates the signed-in user's password; other sessions are signed out. */
export function changePassword(input: {
  currentPassword: string
  nextPassword: string
}): Promise<void> {
  return request('/auth/change-password', { method: 'POST', body: JSON.stringify(input) })
}

export async function fetchMe(): Promise<AuthSession | null> {
  try {
    return await request<AuthSession>('/auth/me', {}, { allowUnauthenticated: true })
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null
    throw error
  }
}

export function startTotpSetup(): Promise<{ secret: string; otpauthUrl: string }> {
  return request('/auth/2fa/setup', { method: 'POST' })
}

export async function verifyTotpSetup(otp: string): Promise<string[]> {
  const body = await request<{ recoveryCodes?: string[] }>('/auth/2fa/verify', {
    method: 'POST',
    body: JSON.stringify({ otp }),
  })
  return body.recoveryCodes ?? []
}

export function disableTotp(password: string): Promise<void> {
  return request('/auth/2fa/disable', { method: 'POST', body: JSON.stringify({ password }) })
}

export async function fetchApiKeys(): Promise<ApiKey[]> {
  const body = await request<{ apiKeys?: ApiKey[] }>('/auth/api-keys')
  return body.apiKeys ?? []
}

export async function createApiKey(name: string, scopes: ApiKeyScope[]): Promise<string> {
  const body = await request<{ key?: string }>('/auth/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name, scopes }),
  })
  return body.key ?? ''
}

export function deleteApiKey(id: number): Promise<void> {
  return request(`/auth/api-keys/${encodeURIComponent(String(id))}`, { method: 'DELETE' })
}

/* Users (admin) */

export interface ManagedUser {
  id: number
  email: string
  role: UserRole
  totpEnabled: boolean
  createdAt: string
}

export async function fetchUsers(): Promise<ManagedUser[]> {
  const body = await request<{ users?: ManagedUser[] }>('/users')
  return body.users ?? []
}

export async function createUser(input: {
  email: string
  password: string
  role: UserRole
}): Promise<ManagedUser> {
  const body = await request<{ user: ManagedUser }>('/users', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return body.user
}

export async function updateUser(
  id: number,
  input: { role?: UserRole; password?: string },
): Promise<ManagedUser> {
  const body = await request<{ user: ManagedUser }>(
    `/users/${encodeURIComponent(String(id))}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  )
  return body.user
}

export function deleteUser(id: number): Promise<void> {
  return request(`/users/${encodeURIComponent(String(id))}`, { method: 'DELETE' })
}

/* Monitors */

export async function fetchMonitors(): Promise<Monitor[]> {
  const body = await request<{ monitors?: Monitor[] }>('/monitors')
  return body.monitors ?? []
}

export async function createMonitor(input: MonitorInput): Promise<Monitor> {
  const body = await request<{ monitor: Monitor }>('/monitors', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return body.monitor
}

export async function updateMonitor(id: number, input: MonitorInput): Promise<Monitor> {
  const body = await request<{ monitor: Monitor }>(`/monitors/${encodeURIComponent(String(id))}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
  return body.monitor
}

export function deleteMonitor(id: number): Promise<void> {
  return request(`/monitors/${encodeURIComponent(String(id))}`, { method: 'DELETE' })
}

export async function fetchHeartbeats(id: number, limit = 100): Promise<Heartbeat[]> {
  const body = await request<{ heartbeats?: Heartbeat[] }>(
    `/monitors/${encodeURIComponent(String(id))}/heartbeats?limit=${limit}`,
  )
  return body.heartbeats ?? []
}

export async function fetchTags(): Promise<Tag[]> {
  const body = await request<{ tags?: Tag[] }>('/tags')
  return body.tags ?? []
}

/* Docker hosts */

export async function fetchDockerHosts(): Promise<DockerHost[]> {
  const body = await request<{ dockerHosts?: DockerHost[] }>('/docker-hosts')
  return body.dockerHosts ?? []
}

export async function createDockerHost(input: DockerHostInput): Promise<DockerHost> {
  const body = await request<{ dockerHost: DockerHost }>('/docker-hosts', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return body.dockerHost
}

export async function updateDockerHost(id: number, input: DockerHostInput): Promise<DockerHost> {
  const body = await request<{ dockerHost: DockerHost }>(
    `/docker-hosts/${encodeURIComponent(String(id))}`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  )
  return body.dockerHost
}

export function deleteDockerHost(id: number): Promise<void> {
  return request(`/docker-hosts/${encodeURIComponent(String(id))}`, { method: 'DELETE' })
}

/* Notification channels */

export async function fetchChannels(): Promise<Channel[]> {
  const body = await request<{ channels?: Channel[] }>('/notifications')
  return body.channels ?? []
}

export async function createChannel(input: ChannelInput): Promise<void> {
  await request('/notifications', { method: 'POST', body: JSON.stringify(input) })
}

export async function testChannel(id: number): Promise<void> {
  await request(`/notifications/${encodeURIComponent(String(id))}/test`, { method: 'POST' })
}

export function deleteChannel(id: number): Promise<void> {
  return request(`/notifications/${encodeURIComponent(String(id))}`, { method: 'DELETE' })
}

/* Incidents */

export async function fetchIncidents(activeOnly = false): Promise<Incident[]> {
  const body = await request<{ incidents?: Incident[] }>(
    activeOnly ? '/incidents?active=1' : '/incidents',
  )
  return body.incidents ?? []
}

/* Uptime */

/** Aggregate uptime for the trailing `hours` window. */
export function fetchUptime(id: number, hours: number): Promise<UptimeStats> {
  return request<UptimeStats>(
    `/monitors/${encodeURIComponent(String(id))}/uptime?hours=${encodeURIComponent(String(hours))}`,
  )
}

/* Status pages (admin) */

export async function fetchStatusPages(): Promise<StatusPage[]> {
  const body = await request<{ statusPages?: StatusPage[] }>('/status-pages')
  return body.statusPages ?? []
}

export async function createStatusPage(input: StatusPageInput): Promise<StatusPage> {
  const body = await request<{ statusPage: StatusPage }>('/status-pages', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return body.statusPage
}

export async function updateStatusPage(id: number, input: StatusPageInput): Promise<StatusPage> {
  const body = await request<{ statusPage: StatusPage }>(
    `/status-pages/${encodeURIComponent(String(id))}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  )
  return body.statusPage
}

export function deleteStatusPage(id: number): Promise<void> {
  return request(`/status-pages/${encodeURIComponent(String(id))}`, { method: 'DELETE' })
}

/** Unauthenticated status page payload rendered at `/status/:slug`. */
export function fetchPublicStatus(slug: string): Promise<PublicStatusPage> {
  return request<PublicStatusPage>(
    `/status/${encodeURIComponent(slug)}`,
    {},
    {
      allowUnauthenticated: true,
    },
  )
}

/** Exchanges the page password for the unlock cookie; rejects with 401 when wrong. */
export function unlockStatusPage(slug: string, password: string): Promise<void> {
  return request(
    `/status/${encodeURIComponent(slug)}/unlock`,
    { method: 'POST', body: JSON.stringify({ password }) },
    { allowUnauthenticated: true },
  )
}

/** Incident archive for a page: newest first, resolved incidents included. */
export async function fetchPublicStatusIncidents(slug: string): Promise<StatusIncident[]> {
  const body = await request<{ incidents?: StatusIncident[] }>(
    `/status/${encodeURIComponent(slug)}/incidents`,
    {},
    { allowUnauthenticated: true },
  )
  return body.incidents ?? []
}

/* Public status overview */

export type PublicOverviewOverall = 'operational' | 'outage' | 'maintenance' | 'unknown'

/** One service on the public status overview (`GET /public/status`). */
export interface PublicOverviewService {
  id: number
  name: string
  type: string
  status: HeartbeatStatus
  paused: boolean
  inMaintenance: boolean
  latencyMs: number | null
  lastBeatAt: string | null
  uptimePct: number
}

export interface PublicOverviewMaintenanceWindow {
  id: number
  name: string
  startAt: string | null
  endAt: string | null
}

/** Shape served by the unauthenticated `GET /public/status`. */
export interface PublicOverview {
  title: string
  overall: PublicOverviewOverall
  services: PublicOverviewService[]
  maintenance: {
    active: PublicOverviewMaintenanceWindow[]
    upcoming: PublicOverviewMaintenanceWindow[]
  }
}

/** Unauthenticated status overview for every monitor flagged public. */
export function fetchPublicOverview(): Promise<PublicOverview> {
  return request('/public/status', {}, { allowUnauthenticated: true })
}

/* Status incidents (admin) */

export async function fetchStatusIncidents(pageId: number): Promise<StatusIncident[]> {
  const body = await request<{ incidents?: StatusIncident[] }>(
    `/status-pages/${encodeURIComponent(String(pageId))}/incidents`,
  )
  return body.incidents ?? []
}

/** Opens a manual incident; `body` becomes its first update. */
export async function createStatusIncident(
  pageId: number,
  input: StatusIncidentInput,
): Promise<void> {
  await request(`/status-pages/${encodeURIComponent(String(pageId))}/incidents`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function addStatusIncidentUpdate(
  incidentId: number,
  input: StatusIncidentUpdateInput,
): Promise<void> {
  await request(`/status-incidents/${encodeURIComponent(String(incidentId))}/updates`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function updateStatusIncident(
  incidentId: number,
  input: StatusIncidentPatch,
): Promise<void> {
  await request(`/status-incidents/${encodeURIComponent(String(incidentId))}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

/* Status subscriptions (admin) */

export async function fetchStatusSubscriptions(pageId: number): Promise<StatusSubscription[]> {
  const body = await request<{ subscriptions?: StatusSubscription[] }>(
    `/status-pages/${encodeURIComponent(String(pageId))}/subscriptions`,
  )
  return body.subscriptions ?? []
}

export async function createStatusSubscription(
  pageId: number,
  input: StatusSubscriptionInput,
): Promise<void> {
  await request(`/status-pages/${encodeURIComponent(String(pageId))}/subscriptions`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function deleteStatusSubscription(id: number): Promise<void> {
  return request(`/status-subscriptions/${encodeURIComponent(String(id))}`, { method: 'DELETE' })
}

/** Sends a test notification through the subscription's channel. */
export function testStatusSubscription(id: number): Promise<void> {
  return request(`/status-subscriptions/${encodeURIComponent(String(id))}/test`, {
    method: 'POST',
  })
}

/* Maintenance windows (admin) */

export async function fetchMaintenanceWindows(): Promise<MaintenanceWindow[]> {
  const body = await request<{ windows?: MaintenanceWindow[] }>('/maintenance-windows')
  return body.windows ?? []
}

export async function createMaintenanceWindow(input: MaintenanceWindowInput): Promise<void> {
  await request('/maintenance-windows', { method: 'POST', body: JSON.stringify(input) })
}

export async function updateMaintenanceWindow(
  id: number,
  input: MaintenanceWindowInput,
): Promise<void> {
  await request(`/maintenance-windows/${encodeURIComponent(String(id))}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function deleteMaintenanceWindow(id: number): Promise<void> {
  return request(`/maintenance-windows/${encodeURIComponent(String(id))}`, { method: 'DELETE' })
}

/* Instance settings */

export function fetchSettings(): Promise<AppSettings> {
  return request<AppSettings>('/settings')
}

export async function updateSettings(input: {
  title?: string
  timezone?: string
}): Promise<AppSettings | null> {
  return request<AppSettings | null>('/settings', {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}
