import type { Database } from '@uptime/db'
import type { MaintenanceEngine } from './maintenance.js'
import { maintenanceView } from './status-pages.js'

/**
 * The unauthenticated public status overview (`GET /api/v1/public/status`).
 * Only monitors explicitly flagged `isPublic` appear, and the payload carries
 * status metadata only — never a monitor's target URL or config.
 */

export type PublicOverallStatus = 'operational' | 'outage' | 'maintenance' | 'unknown'

export interface PublicServiceView {
  id: number
  name: string
  type: string
  /** Latest recorded heartbeat status; `pending` until the first check runs. */
  status: 'up' | 'down' | 'pending' | 'maintenance'
  /** The monitor exists but is paused; paused services never drive the overall status. */
  paused: boolean
  /** Currently inside a maintenance window that covers this monitor. */
  inMaintenance: boolean
  latencyMs: number | null
  lastBeatAt: string | null
  /**
   * `up / (up + down)` over the trailing 24 hours; planned maintenance is
   * excluded, and there is 100 % when nothing decisive was recorded.
   */
  uptimePct: number
}

export interface PublicStatusPayload {
  /** Instance title (`Settings`), so the public page can greet without auth. */
  title: string
  overall: PublicOverallStatus
  services: PublicServiceView[]
  maintenance: {
    active: { id: number; name: string; startAt: string | null; endAt: string | null }[]
    upcoming: { id: number; name: string; startAt: string | null; endAt: string | null }[]
  }
}

/** Assembles the public overview payload (status, uptime, maintenance). */
export function buildPublicStatusPayload(
  db: Database,
  maintenance: MaintenanceEngine,
  now: Date = new Date(),
): PublicStatusPayload {
  const rows = db.listMonitors().filter((row) => row.isPublic)
  const services: PublicServiceView[] = rows.map((row) => {
    const [latest] = db.listHeartbeats(row.id, { limit: 1 })
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      status: latest?.status ?? 'pending',
      paused: !row.active,
      inMaintenance: maintenance.isUnder(row.id, now),
      latencyMs: latest?.latencyMs ?? null,
      lastBeatAt: latest ? latest.time.toISOString() : null,
      uptimePct: db.getUptime(row.id, 24).uptimePct,
    }
  })
  services.sort((a, b) => a.name.localeCompare(b.name))

  // Overall ladder, worst first: outage > maintenance > unknown > operational.
  // Paused services and down-during-maintenance never alarm.
  const active = services.filter((service) => !service.paused)
  let overall: PublicOverallStatus
  if (active.length === 0) {
    overall = 'unknown'
  } else if (
    active.some((service) => service.status === 'down' && !service.inMaintenance)
  ) {
    overall = 'outage'
  } else if (
    active.some(
      (service) =>
        service.status === 'maintenance' ||
        (service.inMaintenance && service.status !== 'down'),
    )
  ) {
    overall = 'maintenance'
  } else if (active.some((service) => service.status === 'pending')) {
    overall = 'unknown'
  } else {
    overall = 'operational'
  }

  const listing = maintenance.listFor(rows.map((row) => row.id), now)

  return {
    title: db.getSetting('title') ?? 'Uptime Monitoring',
    overall,
    services,
    maintenance: {
      active: listing.active.map(maintenanceView),
      upcoming: listing.upcoming.map(maintenanceView),
    },
  }
}
