import type { CheckResult } from '@uptime/core'
import type { Database } from '@uptime/db'
import type { EventHub } from '../events.js'
import type { IncidentEngine } from '../incidents.js'
import type { MaintenanceEngine } from '../maintenance.js'
import type { Metrics } from '../metrics.js'
import type { AgentPulseResult } from './index.js'

export interface PulseIntegratorDeps {
  db: Database
  metrics?: Metrics
  hub?: EventHub
  maintenance?: MaintenanceEngine
  incidentEngine?: Pick<IncidentEngine, 'onResult'>
}

/**
 * Turns an accepted agent pulse into the same downstream effects the server's
 * own scheduler produces for its checks (SPEC §6): a heartbeat row gated by
 * maintenance windows, Prometheus gauges, an SSE broadcast and the incident
 * engine (open after `retries` consecutive failures, recover, notify).
 *
 * Without this wiring, agent-run monitor types (tcp/dns/icmp/db — the ones
 * that are never server-scheduled) would record heartbeats but never alert.
 */
export function createPulseIntegrator(
  deps: PulseIntegratorDeps,
): (result: AgentPulseResult) => void {
  return (result) => {
    const row = deps.db.getMonitor(result.id)
    if (row === null) return // the hub and router reject unknown ids before this
    const check: CheckResult = {
      status: result.status,
      latencyMs: result.latencyMs,
      ...(result.responseSnippet === undefined ? {} : { responseSnippet: result.responseSnippet }),
    }
    const under = deps.maintenance?.isUnder(row.id, result.time) ?? false
    const status = under ? 'maintenance' : result.status
    deps.db.insertHeartbeat({
      monitorId: row.id,
      status,
      latencyMs: result.latencyMs,
      responseSnippet: result.responseSnippet,
      time: result.time,
    })
    deps.metrics?.setMonitorUp(row.id, row.name, status === 'up')
    deps.metrics?.setMaintenance(row.id, row.name, under)
    if (result.latencyMs >= 0) deps.metrics?.observeLatency(row.id, row.name, result.latencyMs)
    deps.hub?.broadcast({
      type: 'heartbeat',
      monitorId: row.id,
      status,
      latencyMs: result.latencyMs,
      time: result.time.toISOString(),
    })
    if (!under) void deps.incidentEngine?.onResult(row, check, result.time)
  }
}
