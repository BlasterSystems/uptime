import type {
  DockerMonitorConfig,
  DnsMonitorConfig,
  IcmpMonitorConfig,
  MongodbMonitorConfig,
  MssqlMonitorConfig,
  MysqlMonitorConfig,
  PostgresMonitorConfig,
  RedisMonitorConfig,
  TcpMonitorConfig,
} from './config-checks.js'
import type { PushMonitorConfig } from './config-push.js'

/** Lifecycle state recorded for a monitor heartbeat (SPEC §4). */
export type HeartbeatStatus = 'up' | 'down' | 'pending' | 'maintenance'

/** Monitor types whose configuration `@uptime/core` validates (SPEC §3). */
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
  /** Optional minimum TLS certificate validity in days (https URLs only). */
  certExpiryDays?: number
}

/** Validated configuration per monitor type (SPEC §3). */
export interface MonitorConfigMap {
  http: HttpMonitorConfig
  push: PushMonitorConfig
  tcp: TcpMonitorConfig
  dns: DnsMonitorConfig
  icmp: IcmpMonitorConfig
  postgres: PostgresMonitorConfig
  mysql: MysqlMonitorConfig
  mssql: MssqlMonitorConfig
  mongodb: MongodbMonitorConfig
  redis: RedisMonitorConfig
  docker: DockerMonitorConfig
}

/** Outcome of a single check execution. */
export interface CheckResult {
  status: 'up' | 'down'
  latencyMs: number
  /** Body excerpt (first 1024 bytes) on success, failure reason on `down`. */
  responseSnippet?: string
  /** Structured extras surfaced by a check (answer count, container state, ...). */
  details?: Record<string, number | string | boolean>
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
  /** Validated config of the monitor's type; only `http` monitors are scheduled (SPEC §6). */
  config: MonitorConfigMap[MonitorType]
}
