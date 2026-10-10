import { z } from 'zod'
import type { Database, MonitorRow } from '@uptime/db'
import type { CheckResult } from '@uptime/core'

export interface GroupConfig {
  memberIds: number[]
  strategy: 'any-up' | 'all-up' | 'percentage'
  percentage?: number
}

export const groupConfigSchema: z.ZodType<GroupConfig> = z
  .object({
    memberIds: z.array(z.int().positive()).min(1),
    strategy: z.enum(['any-up', 'all-up', 'percentage']),
    percentage: z.number().min(0).max(100).optional(),
  })
  .refine((c) => c.strategy !== 'percentage' || c.percentage !== undefined, {
    message: 'percentage is required for strategy "percentage"',
  })

export function parseGroupConfig(raw: unknown): GroupConfig {
  return groupConfigSchema.parse(raw)
}

export interface GroupEngineDeps {
  db: Database
  onResult: (m: { id: number; name: string; retries: number; resendNotificationS?: number }, result: CheckResult, time: Date) => Promise<void>
  broadcast: (event: { type: 'heartbeat'; monitorId: number; status: string; latencyMs: number | null; time: string }) => void
}

/**
 * Evaluates group monitors (SPEC §3): any-up | all-up | percentage:N over the
 * members' latest heartbeat statuses. Only state *changes* produce heartbeats;
 * incidents/notifications flow through the normal engine via onResult.
 */
export class GroupEngine {
  private timer: NodeJS.Timeout | null = null
  private readonly nextRun = new Map<number, number>()

  constructor(private readonly deps: GroupEngineDeps) {}

  async sweep(now: Date = new Date()): Promise<void> {
    for (const row of this.deps.db.listMonitors()) {
      if (row.type !== 'group' || !row.active) continue
      const next = this.nextRun.get(row.id) ?? 0
      if (now.getTime() < next) continue
      this.nextRun.set(row.id, now.getTime() + row.intervalS * 1000)
      try {
        await this.evaluate(row, now)
      } catch {
        // invalid config or transient db error: skip this group until the next sweep
      }
    }
  }

  private async evaluate(row: MonitorRow, now: Date): Promise<void> {
    const cfg = parseGroupConfig(row.config)
    let up = 0
    let down = 0
    let total = 0
    for (const memberId of cfg.memberIds) {
      const [beat] = this.deps.db.listHeartbeats(memberId, { limit: 1 })
      if (!beat || beat.status === 'pending' || beat.status === 'maintenance') continue
      total += 1
      if (beat.status === 'up') up += 1
      else down += 1
    }

    let status: 'up' | 'down'
    if (cfg.strategy === 'any-up') status = up > 0 ? 'up' : 'down'
    else if (cfg.strategy === 'all-up') status = total > 0 && down === 0 ? 'up' : 'down'
    else status = total > 0 && (up / total) * 100 >= (cfg.percentage ?? 100) ? 'up' : 'down'

    const [latest] = this.deps.db.listHeartbeats(row.id, { limit: 1 })
    if (latest?.status === status) return

    const result: CheckResult = { status, latencyMs: 0, responseSnippet: `group: ${up}/${total} members up` }
    await this.deps.onResult(
      { id: row.id, name: row.name, retries: row.retries, resendNotificationS: row.resendNotificationS },
      result,
      now,
    )
    this.deps.broadcast({
      type: 'heartbeat',
      monitorId: row.id,
      status,
      latencyMs: null,
      time: now.toISOString(),
    })
  }

  start(intervalMs = 20_000): void {
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
