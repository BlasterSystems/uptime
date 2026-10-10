export type HeartbeatStatus = 'up' | 'down' | 'pending' | 'maintenance'

export interface MonitorHeartbeat {
  status: HeartbeatStatus
  latencyMs: number | null
  responseSnippet: string | null
  time: string
}

export interface MonitorConfigSummary {
  url: string
  method?: string
  [key: string]: unknown
}

export interface Monitor {
  id: number
  type: string
  name: string
  active: boolean
  intervalS: number
  retries: number
  retryIntervalS: number
  config: MonitorConfigSummary
  latestHeartbeat: MonitorHeartbeat | null
}

export interface CreateMonitorInput {
  name: string
  intervalS?: number
  retries?: number
  retryIntervalS?: number
  config: { url: string }
}

/** Mirrors the `MIN_INTERVAL_S` limit enforced by the server/core check engine. */
export const MIN_INTERVAL_S = 20

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const BASE_PATH = '/api/v1'

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  let response: Response
  try {
    response = await fetch(`${BASE_PATH}${path}`, { ...init, headers })
  } catch {
    throw new ApiError(0, 'Cannot reach the server')
  }

  if (!response.ok) {
    throw new ApiError(response.status, await errorMessage(response))
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return null
  }
  return response.json()
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error !== '') {
      return body.error
    }
  } catch {
    // Non-JSON error body; fall back to the generic message below.
  }
  return `Request failed with status ${response.status}`
}

export async function fetchMonitors(): Promise<Monitor[]> {
  const body = (await request('/monitors')) as { monitors?: Monitor[] } | null
  return body?.monitors ?? []
}

export async function createMonitor(input: CreateMonitorInput): Promise<void> {
  await request('/monitors', { method: 'POST', body: JSON.stringify(input) })
}

export async function deleteMonitor(id: number): Promise<void> {
  await request(`/monitors/${encodeURIComponent(String(id))}`, { method: 'DELETE' })
}
