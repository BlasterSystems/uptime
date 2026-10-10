import type { Database, MonitorRow } from '@uptime/db'
import type { CheckResult } from '@uptime/core'

/** Minimal monitor shape the engine needs — decoupled from the scheduler's type. */
export interface MonitorRef {
  id: number
  name: string
  retries: number
  /** Seconds between repeat notifications while down; 0/undefined = never. */
  resendNotificationS?: number
}

export interface NotificationPayload {
  title: string
  body: string
  monitorName: string
  status: 'up' | 'down'
  latencyMs: number | null
  downtimeMs: number | null
  tags: string[]
}

export interface NotifierLike {
  notifyMonitor(monitorId: number, payload: NotificationPayload): Promise<unknown>
}

export interface IncidentEngineDeps {
  db: Database
  notifier: NotifierLike
  tags: (monitorId: number) => string[]
  /** When true, notifications for this monitor are suppressed (group-down rule, SPEC §3). */
  isSuppressed?: (monitorId: number) => boolean
  /** Optional sink for realtime events (SSE hub). */
  onEvent?: (event: {
    type: 'incident'
    monitorId: number
    incidentId: number
    state: 'open' | 'resolved'
    title: string
    time: string
  }) => void
}

interface MonitorState {
  consecutiveFails: number
  lastNotifiedAt: number
}

function humanDuration(ms: number): string {
  const totalS = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(totalS / 3600)
  const m = Math.floor((totalS % 3600) / 60)
  const s = totalS % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/**
 * Opens/resolves incidents after `retries` consecutive failures and fans out
 * notifications (open, recovery, resend interval while down — SPEC §6/§7).
 */
export class IncidentEngine {
  private readonly states = new Map<number, MonitorState>()

  constructor(private readonly deps: IncidentEngineDeps) {}

  private state(id: number): MonitorState {
    let st = this.states.get(id)
    if (!st) {
      st = { consecutiveFails: 0, lastNotifiedAt: 0 }
      this.states.set(id, st)
    }
    return st
  }

  private async notify(m: MonitorRef, payload: NotificationPayload): Promise<void> {
    if (this.deps.isSuppressed?.(m.id)) return
    await this.deps.notifier.notifyMonitor(m.id, payload)
  }

  async onResult(m: MonitorRef, result: CheckResult, time: Date): Promise<void> {
    const st = this.state(m.id)
    const open = this.deps.db.getOpenIncident(m.id)
    if (result.status === 'up') {
      st.consecutiveFails = 0
      if (open) {
        const downtimeMs = time.getTime() - open.openedAt.getTime()
        this.deps.db.resolveIncident(open.id, time)
        this.deps.onEvent?.({
          type: 'incident',
          monitorId: m.id,
          incidentId: open.id,
          state: 'resolved',
          title: open.title,
          time: time.toISOString(),
        })
        await this.notify(m, {
          title: `${m.name} is back UP`,
          body: `Recovered after ${humanDuration(downtimeMs)}${result.latencyMs !== undefined ? ` (${result.latencyMs} ms)` : ''}.`,
          monitorName: m.name,
          status: 'up',
          latencyMs: result.latencyMs ?? null,
          downtimeMs,
          tags: this.deps.tags(m.id),
        })
        st.lastNotifiedAt = time.getTime()
      }
      return
    }

    st.consecutiveFails += 1
    if (!open && st.consecutiveFails >= m.retries) {
      const incident = this.deps.db.openIncident({
        monitorId: m.id,
        openedAt: time,
        title: `${m.name} is DOWN`,
        body: result.responseSnippet ?? undefined,
      })
      this.deps.onEvent?.({
        type: 'incident',
        monitorId: m.id,
        incidentId: incident.id,
        state: 'open',
        title: incident.title,
        time: time.toISOString(),
      })
      await this.notify(m, {
        title: incident.title,
        body: `${result.responseSnippet ?? 'Check failed'}${result.latencyMs !== undefined ? ` (${result.latencyMs} ms)` : ''}`,
        monitorName: m.name,
        status: 'down',
        latencyMs: result.latencyMs ?? null,
        downtimeMs: null,
        tags: this.deps.tags(m.id),
      })
      st.lastNotifiedAt = time.getTime()
      return
    }
    if (open && (m.resendNotificationS ?? 0) > 0) {
      if (time.getTime() - st.lastNotifiedAt >= (m.resendNotificationS ?? 0) * 1000) {
        await this.notify(m, {
          title: `${m.name} is still DOWN`,
          body: `Down for ${humanDuration(time.getTime() - open.openedAt.getTime())}. ${result.responseSnippet ?? ''}`.trim(),
          monitorName: m.name,
          status: 'down',
          latencyMs: result.latencyMs ?? null,
          downtimeMs: time.getTime() - open.openedAt.getTime(),
          tags: this.deps.tags(m.id),
        })
        st.lastNotifiedAt = time.getTime()
      }
    }
  }

  /** Push monitor went down out-of-band (/fail or missed grace) — incident opens immediately. */
  async onPushDown(m: MonitorRef, reason: string, time: Date): Promise<void> {
    const st = this.state(m.id)
    st.consecutiveFails = m.retries
    await this.onResult(m, { status: 'down', latencyMs: 0, responseSnippet: reason }, time)
  }

  reset(monitorId: number): void {
    this.states.delete(monitorId)
  }
}
