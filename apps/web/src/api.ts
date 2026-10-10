/**
 * Typed client for the `/api/v1` HTTP API. Session auth uses an httpOnly cookie,
 * so mutating requests carry the CSRF token issued by login / `GET /auth/me`
 * in the `x-csrf-token` header.
 */

export type UserRole = 'admin' | 'editor' | 'viewer'
export type ApiKeyScope = 'read' | 'write' | 'admin'
export type MonitorType = 'http' | 'push'
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
export const MONITOR_TYPES: readonly MonitorType[] = ['http', 'push']

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

export interface StatusPage {
  id: number
  slug: string
  title: string
  logo: string | null
  published: boolean
  monitorIds: number[]
  theme: StatusPageTheme | null
}

/** Body of `POST /status-pages` / `PATCH /status-pages/:id`. */
export interface StatusPageInput {
  slug?: string
  title?: string
  logo?: string | null
  published?: boolean
  monitorIds?: number[]
  theme?: StatusPageTheme | null
}

/** Shape served by the unauthenticated `GET /status/:slug`. */
export interface PublicStatusMonitor {
  id: number
  name: string
  status: HeartbeatStatus
  latencyMs: number | null
  uptimePct: number
  tags: Tag[]
}

export interface PublicStatusIncident {
  id: number
  monitorId: number
  monitorName: string
  openedAt: string
  title: string
  body: string | null
}

export interface PublicStatusPage {
  slug: string
  title: string
  logo: string | null
  theme: StatusPageTheme | null
  monitors: PublicStatusMonitor[]
  incidents: PublicStatusIncident[]
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

export interface MonitorConfig {
  url?: string
  method?: string
  timeoutMs?: number
  graceSeconds?: number
  [key: string]: unknown
}

export interface Monitor {
  id: number
  type: MonitorType
  name: string
  active: boolean
  intervalS: number
  retries: number
  retryIntervalS: number
  config: MonitorConfig
  tags: Tag[]
  channelIds: number[]
  latestHeartbeat: Heartbeat | null
  pushUrl?: string
}

/** Body of `POST /monitors` / `PATCH /monitors/:id`. */
export interface MonitorInput {
  name?: string
  intervalS?: number
  retries?: number
  retryIntervalS?: number
  type?: MonitorType
  config?: Record<string, unknown>
  /** Either existing tag ids or names (the server maps names onto tags). */
  tagIds?: number[]
  tags?: string[]
  channelIds?: number[]
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
  return request<PublicStatusPage>(`/status/${encodeURIComponent(slug)}`, {}, {
    allowUnauthenticated: true,
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
