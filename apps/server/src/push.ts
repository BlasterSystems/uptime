import { Cron } from 'croner'
import { parseMonitorConfig } from '@uptime/core'
import type { Database } from '@uptime/db'

/** Minimal shape the incident engine needs for push monitors. */
export interface PushDownTarget {
  id: number
  name: string
  retries: number
  resendNotificationS: number
}

export interface PushEngineDeps {
  db: Database
  onDown: (m: PushDownTarget, reason: string, time: Date) => Promise<void>
}

/**
 * Grace sweep for push monitors (SPEC §6): every 30 s, mark push monitors down
 * once `interval + grace` (or next cron run + grace) has elapsed since the last
 * heartbeat. A monitor that never pushed stays `pending` — no rows are written
 * for it. Only state *changes* produce heartbeats.
 */
export class PushEngine {
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: PushEngineDeps) {}

  async sweep(now: Date = new Date()): Promise<void> {
    const rows = this.deps.db.listActivePushMonitors()
    for (const { monitor, lastBeatAt } of rows) {
      if (!lastBeatAt) continue
      const cfg = parseMonitorConfig('push', monitor.config)
      const graceMs = cfg.graceSeconds * 1000
      let deadline: number
      if (cfg.cron) {
        const next = new Cron(cfg.cron).nextRun(lastBeatAt)
        if (!next) continue
        deadline = next.getTime() + graceMs
      } else {
        deadline = lastBeatAt.getTime() + monitor.intervalS * 1000 + graceMs
      }
      if (now.getTime() <= deadline) continue
      const [latest] = this.deps.db.listHeartbeats(monitor.id, { limit: 1 })
      if (latest && latest.status === 'down') continue
      await this.deps.db.insertHeartbeat({
        monitorId: monitor.id,
        status: 'down',
        responseSnippet: `no push received within ${monitor.intervalS}s + ${cfg.graceSeconds}s grace`,
      })
      await this.deps.onDown(
        {
          id: monitor.id,
          name: monitor.name,
          retries: monitor.retries,
          resendNotificationS: monitor.resendNotificationS,
        },
        'push deadline missed',
        now,
      )
    }
  }

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => {
      void this.sweep().catch(() => {})
    }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
