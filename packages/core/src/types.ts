/** Lifecycle state recorded for a monitor heartbeat (SPEC §4). */
export type HeartbeatStatus = 'up' | 'down' | 'pending' | 'maintenance'

/** Monitor types whose configuration `@uptime/core` validates (SPEC §3). */
export type MonitorType = 'http' | 'push'

/** Validated configuration of an `http` monitor (SPEC §3). */
export interface HttpMonitorConfig {
  method: 'GET' | 'POST' | 'HEAD' | 'PUT' | 'DELETE'
  url: string
  headers?: Record<string, string>
  body?: string
  /** Request timeout in milliseconds. */
  timeoutMs: number
  /** Accepted HTTP status: an inclusive range, or no restriction at all. */
  acceptedStatus: [number, number] | 'any'
  /** Optional body assertion; `inverse` flips it to "must not appear". */
  keyword?: { value: string; inverse?: boolean }
  /** Optional response-time cap in milliseconds. */
  maxResponseMs?: number
}

/** Outcome of a single check execution. */
export interface CheckResult {
  status: 'up' | 'down'
  latencyMs: number
  /** Body excerpt (first 1024 bytes) on success, failure reason on `down`. */
  responseSnippet?: string
}

/** The subset of a monitor record the scheduler needs (SPEC §6). */
export interface ScheduledMonitor {
  id: number
  type: MonitorType
  name: string
  active: boolean
  intervalS: number
  retries: number
  retryIntervalS: number
  /** Notification resend interval while down (seconds, 0 = never); unused by the scheduler. */
  resendNotificationS?: number
  /** Only meaningful for `http` monitors; `push` monitors are never scheduled (SPEC §6). */
  config: HttpMonitorConfig
}
