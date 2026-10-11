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

export interface MaintenanceListing {
  active: MaintenanceWindowRow[]
  upcoming: MaintenanceWindowRow[]
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
      if (!this.matches(w, [monitorId], tagIds)) continue
      if (this.applies(w, now)) return true
    }
    return false
  }

  /** True when the window is scoped to at least one of `monitorIds` (scope all/ids/tags). */
  matches(w: MaintenanceWindowRow, monitorIds: number[], tagIds?: Set<number>): boolean {
    if (w.scope === 'all') return true
    if (w.scope === 'ids') return w.monitorIds.some((id) => monitorIds.includes(id))
    const tags = tagIds ?? new Set(monitorIds.flatMap((id) => this.deps.tagIdsOf(id)))
    return w.tagIds.some((t) => tags.has(t))
  }

  /**
   * Active + upcoming (within `horizonMs`, default 7 days) windows scoped to
   * `monitorIds` — the public status-page maintenance section.
   */
  listFor(monitorIds: number[], now: Date = new Date(), horizonMs = 7 * 24 * 3600_000): MaintenanceListing {
    const tagIds = new Set(monitorIds.flatMap((id) => this.deps.tagIdsOf(id)))
    const active: MaintenanceWindowRow[] = []
    const upcoming: Array<{ w: MaintenanceWindowRow; start: number }> = []
    for (const w of this.deps.db.listMaintenanceWindows()) {
      if (!w.active) continue
      if (!this.matches(w, monitorIds, tagIds)) continue
      if (this.applies(w, now)) {
        active.push(w)
        continue
      }
      const next = this.nextStart(w, now)
      if (next !== null && next - now.getTime() <= horizonMs) upcoming.push({ w, start: next })
    }
    upcoming.sort((a, b) => a.start - b.start)
    return { active, upcoming: upcoming.map((u) => u.w) }
  }

  /** Epoch ms of the next opening for the window, or null when it never opens again. */
  private nextStart(w: MaintenanceWindowRow, now: Date): number | null {
    const t = now.getTime()
    switch (w.strategy) {
      case 'single':
        return w.startAt && w.endAt && w.startAt.getTime() > t ? w.startAt.getTime() : null
      case 'recurring-interval': {
        if (!w.startAt || !w.intervalS) return null
        const cycle = w.intervalS * 1000
        if (w.startAt.getTime() > t) return w.startAt.getTime()
        const phase = (t - w.startAt.getTime()) % cycle
        return t + (cycle - phase)
      }
      case 'recurring-weekday': {
        if (!w.weekdays || w.weekdays.length === 0 || !w.startTime) return null
        const startMs = timeOfDayMs(w.startTime)
        for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
          const day = new Date(t + dayOffset * 24 * 3600_000)
          if (!w.weekdays.includes(day.getUTCDay())) continue
          const candidate = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) + startMs
          if (candidate > t) return candidate
        }
        return null
      }
      case 'cron': {
        if (!w.cronExpr) return null
        const next = new Cron(w.cronExpr, { timezone: w.cronTz ?? 'UTC' }).nextRun()
        return next ? next.getTime() : null
      }
      default:
        return null
    }
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
