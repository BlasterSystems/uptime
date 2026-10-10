import { Gauge, Registry, collectDefaultMetrics } from 'prom-client'

/** Prometheus registry plus the M1 `monitor_up` gauge (SPEC §5: uptime gauge only). */
export class Metrics {
  readonly registry = new Registry()
  private readonly up: Gauge<string>
  private readonly names = new Map<number, string>()

  constructor() {
    collectDefaultMetrics({ register: this.registry })
    this.up = new Gauge({
      name: 'monitor_up',
      help: '1 if the monitor is currently up, 0 if down',
      labelNames: ['monitor_id', 'monitor_name'],
      registers: [this.registry],
    })
  }

  setMonitorUp(id: number, name: string, up: boolean): void {
    this.names.set(id, name)
    this.up.set({ monitor_id: String(id), monitor_name: name }, up ? 1 : 0)
  }

  removeMonitor(id: number): void {
    const name = this.names.get(id)
    if (name !== undefined) {
      this.up.remove({ monitor_id: String(id), monitor_name: name })
    }
    this.names.delete(id)
  }
}
