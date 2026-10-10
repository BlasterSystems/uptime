import { MIN_INTERVAL_S } from './config.js'
import type { CheckResult, ScheduledMonitor } from './types.js'

/** Scheduler wiring and limits; the concurrency defaults follow SPEC §6. */
export interface SchedulerOptions {
  check: (monitor: ScheduledMonitor) => Promise<CheckResult>
  onResult: (monitor: ScheduledMonitor, result: CheckResult, time: Date) => void
  /** Maximum number of checks running at once across all monitors (default 50). */
  globalConcurrency?: number
  /** Maximum number of concurrent checks against a single hostname (default 5). */
  perHostConcurrency?: number
}

const DEFAULT_GLOBAL_CONCURRENCY = 50
const DEFAULT_PER_HOST_CONCURRENCY = 5
/** Jitter applied to every scheduled spacing (SPEC §6: ±10 %). */
const JITTER_RATIO = 0.1

type Mode = 'grid' | 'retry'

interface Entry {
  monitor: ScheduledMonitor
  mode: Mode
  /** Drift-corrected anchor: a slot is due at `anchorMs + slot × spacing`. */
  anchorMs: number
  /** Index of the next due slot relative to `anchorMs`; slot 0 is the anchor itself. */
  slot: number
  /** Bumped by upsert/remove so stale in-flight results cannot reschedule the entry. */
  generation: number
  inFlight: boolean
  timer: NodeJS.Timeout | undefined
}

/** Counting semaphore with FIFO waiters; a check queues instead of exceeding a cap. */
class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(permits: number) {
    this.available = Math.max(1, Math.floor(permits))
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1
      return Promise.resolve()
    }
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  release(): void {
    const next = this.waiters.shift()
    if (next === undefined) this.available += 1
    else next()
  }
}

/** Global and per-hostname concurrency caps (SPEC §6). */
class Limiter {
  private readonly global: Semaphore
  private readonly perHost: number
  private readonly hosts = new Map<string, { semaphore: Semaphore; refs: number }>()

  constructor(globalConcurrency: number, perHostConcurrency: number) {
    this.global = new Semaphore(globalConcurrency)
    this.perHost = Math.max(1, Math.floor(perHostConcurrency))
  }

  /** Resolves once a global and a host slot are held; the result releases both. */
  async acquire(host: string): Promise<() => void> {
    await this.global.acquire()
    const existing = this.hosts.get(host)
    const target = existing ?? { semaphore: new Semaphore(this.perHost), refs: 0 }
    if (existing === undefined) this.hosts.set(host, target)
    target.refs += 1
    await target.semaphore.acquire()
    return () => {
      target.semaphore.release()
      target.refs -= 1
      if (target.refs === 0) this.hosts.delete(host)
      this.global.release()
    }
  }
}

/**
 * Drift-corrected probe scheduler (SPEC §6).
 *
 * - `upsert`/`start` probe an active monitor immediately, then on the grid
 *   `anchor + n × interval` (±10 % jitter per slot), so slow checks never accumulate drift.
 * - A failed check re-anchors the monitor to `retryIntervalS` spacing; the next success
 *   re-anchors it back onto the interval grid.
 * - A tick is skipped while the monitor's previous check is still running.
 * - Checks wait for a global and a per-hostname concurrency slot before starting.
 */
export class Scheduler {
  private readonly check: (monitor: ScheduledMonitor) => Promise<CheckResult>
  private readonly onResult: (monitor: ScheduledMonitor, result: CheckResult, time: Date) => void
  private readonly limiter: Limiter
  private readonly entries = new Map<number, Entry>()
  private running = false

  constructor(opts: SchedulerOptions) {
    this.check = opts.check
    this.onResult = opts.onResult
    this.limiter = new Limiter(
      opts.globalConcurrency ?? DEFAULT_GLOBAL_CONCURRENCY,
      opts.perHostConcurrency ?? DEFAULT_PER_HOST_CONCURRENCY,
    )
  }

  /** Add or replace a monitor; while running this restarts its schedule and probes it now. */
  upsert(monitor: ScheduledMonitor): void {
    // Only `http` monitors are probe-scheduled (SPEC §6): push is heartbeat-driven and
    // the remaining types are not wired into the scheduler yet; drop a stale entry.
    if (monitor.type !== 'http') {
      this.remove(monitor.id)
      return
    }
    let entry = this.entries.get(monitor.id)
    if (entry === undefined) {
      entry = {
        monitor,
        mode: 'grid',
        anchorMs: 0,
        slot: 0,
        generation: 0,
        inFlight: false,
        timer: undefined,
      }
      this.entries.set(monitor.id, entry)
    }
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.monitor = monitor
    entry.mode = 'grid'
    entry.anchorMs = Date.now()
    entry.slot = 0
    entry.generation += 1
    this.schedule(entry)
  }

  /** Cancel a monitor's timer; a result from its in-flight check is dropped. */
  remove(id: number): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.generation += 1
    this.entries.delete(id)
  }

  /** Begin scheduling; every active monitor is probed immediately. Idempotent. */
  start(): void {
    if (this.running) return
    this.running = true
    const anchorMs = Date.now()
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer)
      entry.timer = undefined
      entry.mode = 'grid'
      entry.anchorMs = anchorMs
      entry.slot = 0
      this.schedule(entry)
    }
  }

  /** Stop scheduling and clear every timer; results of in-flight checks are still reported. */
  stop(): void {
    this.running = false
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
  }

  private schedule(entry: Entry): void {
    if (!this.running || !entry.monitor.active) return
    const spacing = spacingMs(entry.monitor, entry.mode)
    const idealMs = entry.anchorMs + entry.slot * spacing
    // Slot 0 is the immediate first probe; later slots jitter ±10 % around the grid.
    const dueMs =
      entry.slot === 0 ? idealMs : idealMs + (Math.random() * 2 - 1) * JITTER_RATIO * spacing
    entry.timer = setTimeout(() => this.tick(entry), Math.max(0, dueMs - Date.now()))
  }

  private tick(entry: Entry): void {
    entry.timer = undefined
    if (!this.running || !entry.monitor.active) return
    // Arm the next slot before running the check, so a slow check cannot shift the grid.
    entry.slot += 1
    this.schedule(entry)
    if (entry.inFlight) return
    entry.inFlight = true
    void this.execute(entry, entry.generation, entry.monitor).catch((error: unknown) => {
      console.error('scheduler: unexpected failure while running a check', error)
    })
  }

  private async execute(
    entry: Entry,
    generation: number,
    monitor: ScheduledMonitor,
  ): Promise<void> {
    let result: CheckResult
    try {
      const release = await this.limiter.acquire(hostOf(monitor))
      try {
        result = await this.check(monitor)
      } finally {
        release()
      }
    } catch (error) {
      result = {
        status: 'down',
        latencyMs: 0,
        responseSnippet:
          error instanceof Error && error.message !== '' ? error.message : String(error),
      }
    }
    entry.inFlight = false

    // Removed (or replaced) while the check was in flight: drop the stale result.
    if (this.entries.get(monitor.id) !== entry) return

    try {
      this.onResult(monitor, result, new Date())
    } catch (error) {
      // A broken callback must not stop the schedule.
      console.error('scheduler: onResult callback threw', error)
    }

    // Upserted while the check was in flight: the new schedule is already armed.
    if (entry.generation !== generation) return

    if (result.status === 'down') this.reanchor(entry, 'retry')
    else if (entry.mode === 'retry') this.reanchor(entry, 'grid')
  }

  private reanchor(entry: Entry, mode: Mode): void {
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.mode = mode
    entry.anchorMs = Date.now()
    entry.slot = 1
    this.schedule(entry)
  }
}

/** Spacing for the current mode, falling back to sane values for non-positive input. */
function spacingMs(monitor: ScheduledMonitor, mode: Mode): number {
  const intervalS =
    Number.isFinite(monitor.intervalS) && monitor.intervalS > 0 ? monitor.intervalS : MIN_INTERVAL_S
  if (mode === 'grid') return intervalS * 1000
  const retryS =
    Number.isFinite(monitor.retryIntervalS) && monitor.retryIntervalS > 0
      ? monitor.retryIntervalS
      : intervalS
  return retryS * 1000
}

/** Per-host concurrency bucket: the hostname of an `http` monitor's URL. */
function hostOf(monitor: ScheduledMonitor): string {
  if ('url' in monitor.config) {
    try {
      return new URL(monitor.config.url).hostname
    } catch {
      // Not a parseable URL: fall back to a per-monitor bucket.
    }
  }
  return `monitor-${monitor.id}`
}
