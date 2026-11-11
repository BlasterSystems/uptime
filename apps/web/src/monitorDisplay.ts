import type { HeartbeatStatus, Monitor, MonitorType } from './api.js'

/** Short human label for each monitor type, used in badges and pickers. */
export const MONITOR_TYPE_LABELS: Record<MonitorType, string> = {
  http: 'HTTP',
  push: 'Push',
  tcp: 'TCP',
  dns: 'DNS',
  icmp: 'ICMP',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mssql: 'SQL Server',
  mongodb: 'MongoDB',
  redis: 'Redis',
  group: 'Group',
}

/**
 * Masks credentials in a connection string for display: the `user:password@`
 * userinfo of URLs (`postgres://db:secret@host` becomes `postgres://***@host`)
 * and `Password=`/`Pwd=` segments of ADO-style strings.
 */
export function maskConnectionString(value: string): string {
  return value
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?]*@/i, '$1***@')
    .replace(/(password|pwd)=[^;]*/gi, '$1=***')
}

/** One-line target summary for a monitor card or detail header. */
export function monitorTarget(monitor: Monitor): string {
  switch (monitor.type) {
    case 'http':
      return monitor.config.url
    case 'push':
      return 'Waiting for incoming heartbeats'
    case 'tcp':
      return `${monitor.config.host}:${monitor.config.port}`
    case 'dns':
      return `${monitor.config.recordType} ${monitor.config.host}`
    case 'icmp':
      return monitor.config.host
    case 'postgres':
    case 'mysql':
    case 'mssql':
    case 'mongodb':
    case 'redis':
      return maskConnectionString(monitor.config.connectionString)
    case 'group': {
      const count = monitor.config.memberIds.length
      return `${count} member${count === 1 ? '' : 's'}`
    }
  }
}

/**
 * Response body of the current outage for the detail header: shown only while
 * the newest heartbeat is a failure, so a recovered monitor no longer presents
 * stale failure text — the resolved incident row keeps it. `header` is the
 * current-state beat (live SSE beat or `latestHeartbeat`); `beats` is the
 * newest-first heartbeat window, consulted only when the header beat carries
 * no snippet itself (a fresh SSE beat inherits the previous one).
 */
export function downSnippetOf(
  header: { status: HeartbeatStatus; responseSnippet: string | null } | null | undefined,
  beats: ReadonlyArray<{ status: string; responseSnippet: string | null }>,
): string | null {
  if (header === null || header === undefined || header.status !== 'down') return null
  return (
    header.responseSnippet ??
    beats.find((beat) => beat.status === 'down')?.responseSnippet ??
    null
  )
}
