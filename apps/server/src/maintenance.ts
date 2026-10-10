import { Cron } from 'croner'
import type { Database } from '@uptime/db'
import type { MaintenanceWindowRow } from '@uptime/db'

export interface MaintenanceEngineDeps {
  db: Database
  tagIdsOf: (monitorId: number) => number[]
}

function timeOfDayMs(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return ((h ?? 0) * 60 + (m ?? 0)) * 60_000
}

/** Duration between two HH:mm times; wraps past midnight when end <= start. */
function spanMs(start: string, end: string): number {
  const s = timeOfDayMs(start)
  const e = timeOfDayMs(end)
  return e > s ? e - s : 24 * 3600_000 - s + e
}

function inTimeSpan(nowMs: number, start: string, end: string): boolean {
  const dayMs = 24 * 3600_000
  const t = ((nowMs % dayMs) + dayMs) % dayMs
  const s = timeOfDayMs(start)
  const e = timeOfDayMs(end)
  return s <= e ? t >= s && t < e : t >= s || t < e
}

/**
 * Evaluates maintenance windows (SPEC §4/§11). All comparisons are UTC unless a
 * cron window specifies cron_tz (Croner evaluates those in-zone).
 */
export class MaintenanceEngine {
  constructor(private readonly deps: MaintenanceEngineDeps) {}

  isUnder(monitorId: number, now: Date = new Date()): boolean {
    const tagIds = new Set(this.deps.tagIdsOf(monitorId))
    for (const w of this.deps.db.listMaintenanceWindows()) {
      if (!w.active) continue
      if (w.scope === 'ids' && !w.monitorIds.includes(monitorId)) continue
      if (w.scope === 'tags' && !w.tagIds.some((t) => tagIds.has(t))) continue
      if (this.applies(w, now)) return true
    }
    return false
  }

  private applies(w: MaintenanceWindowRow, now: Date): boolean {
    const t = now.getTime()
    switch (w.strategy) {
      case 'single':
        if (!w.startAt || !w.endAt) return false
        return t >= w.startAt.getTime() && t <= w.endAt.getTime()
      case 'recurring-interval': {
        if (!w.startAt || !w.intervalS || !w.startTime || !w.endTime) return false
        if (t < w.startAt.getTime()) return false
        const cycle = w.intervalS * 1000
        const phase = (t - w.startAt.getTime()) % cycle
        return phase < spanMs(w.startTime, w.endTime)
      }
      case 'recurring-weekday': {
        if (!w.weekdays || w.weekdays.length === 0 || !w.startTime || !w.endTime) return false
        if (!w.weekdays.includes(now.getUTCDay())) return false
        return inTimeSpan(t, w.startTime, w.endTime)
      }
      case 'cron': {
        if (!w.cronExpr || !w.startTime || !w.endTime) return false
        const job = new Cron(w.cronExpr, { timezone: w.cronTz ?? 'UTC' })
        const duration = spanMs(w.startTime, w.endTime)
        const prev = job.previousRun()
        if (!prev) return false
        return t - prev.getTime() < duration
      }
      default:
        return false
    }
  }
}
