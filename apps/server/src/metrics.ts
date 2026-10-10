import { Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

type MonitorLabel = 'monitor_id' | 'monitor_name'

const MONITOR_LABELS: MonitorLabel[] = ['monitor_id', 'monitor_name']

/** Response-time buckets in milliseconds (SPEC §3 http `maxResponseMs` / M3 charts). */
const RESPONSE_MS_BUCKETS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000]

/**
 * Prometheus registry plus the per-monitor gauges/histogram exposed at `/metrics`
 * (SPEC §5, M3): `monitor_up`, `monitor_response_ms`, `monitor_cert_expiry_days`
 * and `monitor_maintenance`. Metric names are distinct from prom-client's
 * `collectDefaultMetrics` (`process_*`, `nodejs_*`).
 */
export class Metrics {
  readonly registry = new Registry()
  private readonly up: Gauge<MonitorLabel>
  private readonly responseMs: Histogram<MonitorLabel>
  private readonly certExpiryDays: Gauge<MonitorLabel>
  private readonly maintenance: Gauge<MonitorLabel>
  private readonly tagUp: Gauge<'tag'>
  private readonly tagDown: Gauge<'tag'>
  /** Display names seen per monitor id, so `removeMonitor` can drop every label set. */
  private readonly names = new Map<number, Set<string>>()

  constructor() {
    collectDefaultMetrics({ register: this.registry })
    this.up = new Gauge({
      name: 'monitor_up',
      help: '1 if the monitor is currently up, 0 if down',
      labelNames: MONITOR_LABELS,
      registers: [this.registry],
    })
    this.responseMs = new Histogram({
      name: 'monitor_response_ms',
      help: 'Check response time in milliseconds',
      labelNames: MONITOR_LABELS,
      buckets: RESPONSE_MS_BUCKETS,
      registers: [this.registry],
    })
    this.certExpiryDays = new Gauge({
      name: 'monitor_cert_expiry_days',
      help: 'Days until the monitor TLS certificate expires',
      labelNames: MONITOR_LABELS,
      registers: [this.registry],
    })
    this.maintenance = new Gauge({
      name: 'monitor_maintenance',
      help: '1 if the monitor is inside a maintenance window, 0 otherwise',
      labelNames: MONITOR_LABELS,
      registers: [this.registry],
    })
    this.tagUp = new Gauge({
      name: 'tag_monitors_up',
      help: 'Number of monitors currently up per tag',
      labelNames: ['tag'],
      registers: [this.registry],
    })
    this.tagDown = new Gauge({
      name: 'tag_monitors_down',
      help: 'Number of monitors currently down per tag',
      labelNames: ['tag'],
      registers: [this.registry],
    })
  }

  setMonitorUp(id: number, name: string, up: boolean): void {
    this.track(id, name)
    this.up.set(this.labels(id, name), up ? 1 : 0)
  }

  observeLatency(id: number, name: string, ms: number): void {
    this.track(id, name)
    this.responseMs.observe(this.labels(id, name), ms)
  }

  /** `days === null` (no TLS certificate / check not applicable) drops the label set. */
  setCertExpiryDays(id: number, name: string, days: number | null): void {
    this.track(id, name)
    if (days === null) {
      this.certExpiryDays.remove(this.labels(id, name))
      return
    }
    this.certExpiryDays.set(this.labels(id, name), days)
  }

  setMaintenance(id: number, name: string, under: boolean): void {
    this.track(id, name)
    this.maintenance.set(this.labels(id, name), under ? 1 : 0)
  }

  /** Refreshes the per-tag aggregate gauges (SPEC §11). */
  setTagCounts(tag: string, up: number, down: number): void {
    this.tagUp.set({ tag }, up)
    this.tagDown.set({ tag }, down)
  }

  /** Drops every series written for the monitor (unknown ids are a no-op). */
  removeMonitor(id: number): void {
    for (const name of this.names.get(id) ?? []) {
      const labels = this.labels(id, name)
      this.up.remove(labels)
      this.responseMs.remove(labels)
      this.certExpiryDays.remove(labels)
      this.maintenance.remove(labels)
    }
    this.names.delete(id)
  }

  private track(id: number, name: string): void {
    let names = this.names.get(id)
    if (names === undefined) {
      names = new Set()
      this.names.set(id, names)
    }
    names.add(name)
  }

  private labels(id: number, name: string): Record<MonitorLabel, string> {
    return { monitor_id: String(id), monitor_name: name }
  }
}
