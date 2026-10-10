import { describe, expect, it } from 'vitest'
import { Metrics } from './metrics.js'

/** Values of every series registered under `name` (filters out prom-client's defaults). */
async function series(metrics: Metrics, name: string) {
  const all = await metrics.registry.getMetricsAsJSON()
  return all.filter((metric) => metric.name === name).flatMap((metric) => metric.values)
}

describe('Metrics', () => {
  it('sets and removes the monitor_up gauge', async () => {
    const metrics = new Metrics()
    metrics.setMonitorUp(7, 'api', true)
    expect(await series(metrics, 'monitor_up')).toEqual([
      { value: 1, labels: { monitor_id: '7', monitor_name: 'api' } },
    ])

    metrics.setMonitorUp(7, 'api', false)
    expect(await series(metrics, 'monitor_up')).toEqual([
      { value: 0, labels: { monitor_id: '7', monitor_name: 'api' } },
    ])
  })

  it('creates a response-time histogram series with the documented buckets', async () => {
    const metrics = new Metrics()
    metrics.observeLatency(7, 'api', 42)

    const text = await metrics.registry.metrics()
    expect(text).toContain(
      'monitor_response_ms_bucket{le="10",monitor_id="7",monitor_name="api"} 0',
    )
    expect(text).toContain(
      'monitor_response_ms_bucket{le="50",monitor_id="7",monitor_name="api"} 1',
    )
    expect(text).toContain(
      'monitor_response_ms_bucket{le="10000",monitor_id="7",monitor_name="api"} 1',
    )
    expect(text).toContain('monitor_response_ms_sum{monitor_id="7",monitor_name="api"} 42')
    expect(text).toContain('monitor_response_ms_count{monitor_id="7",monitor_name="api"} 1')
    // 9 finite buckets + `+Inf` for the single label set.
    expect(text.match(/monitor_response_ms_bucket\{le="/g)).toHaveLength(10)
  })

  it('sets the certificate expiry gauge and drops it when days is null', async () => {
    const metrics = new Metrics()
    metrics.setCertExpiryDays(7, 'api', 30)
    expect(await series(metrics, 'monitor_cert_expiry_days')).toEqual([
      { value: 30, labels: { monitor_id: '7', monitor_name: 'api' } },
    ])

    metrics.setCertExpiryDays(7, 'api', null)
    expect(await series(metrics, 'monitor_cert_expiry_days')).toEqual([])
  })

  it('sets the maintenance gauge per monitor', async () => {
    const metrics = new Metrics()
    metrics.setMaintenance(7, 'api', true)
    metrics.setMaintenance(8, 'db', false)
    expect(await series(metrics, 'monitor_maintenance')).toEqual([
      { value: 1, labels: { monitor_id: '7', monitor_name: 'api' } },
      { value: 0, labels: { monitor_id: '8', monitor_name: 'db' } },
    ])
  })

  it('removeMonitor drops every series for the id, including renamed label sets', async () => {
    const metrics = new Metrics()
    metrics.setMonitorUp(7, 'api', true)
    metrics.observeLatency(7, 'api', 12)
    metrics.setCertExpiryDays(7, 'api', 30)
    metrics.setMaintenance(7, 'api', true)
    metrics.setMonitorUp(7, 'api-v2', false) // rename: both label sets are tracked
    metrics.setMonitorUp(8, 'db', true)

    metrics.removeMonitor(7)

    const text = await metrics.registry.metrics()
    expect(text).not.toContain('monitor_id="7"')
    expect(text).toContain('monitor_up{monitor_id="8",monitor_name="db"} 1')
    expect(await series(metrics, 'monitor_up')).toEqual([
      { value: 1, labels: { monitor_id: '8', monitor_name: 'db' } },
    ])
    expect(await series(metrics, 'monitor_response_ms')).toEqual([])
    expect(await series(metrics, 'monitor_cert_expiry_days')).toEqual([])
    expect(await series(metrics, 'monitor_maintenance')).toEqual([])
  })

  it('handles removing label sets that do not exist', () => {
    const metrics = new Metrics()
    expect(() => metrics.removeMonitor(999)).not.toThrow()
    metrics.setCertExpiryDays(7, 'api', 30)
    metrics.setCertExpiryDays(7, 'api', null)
    expect(() => metrics.removeMonitor(7)).not.toThrow()
    expect(() => metrics.removeMonitor(7)).not.toThrow()
  })

  it('exposes every metric name alongside the prom-client defaults', async () => {
    const metrics = new Metrics()
    metrics.setMonitorUp(1, 'a', true)
    metrics.observeLatency(1, 'a', 1)
    metrics.setCertExpiryDays(1, 'a', 1)
    metrics.setMaintenance(1, 'a', false)

    const text = await metrics.registry.metrics()
    for (const name of [
      'monitor_up',
      'monitor_response_ms',
      'monitor_cert_expiry_days',
      'monitor_maintenance',
    ]) {
      expect(text).toContain(name)
    }
    expect(text).toContain('process_cpu_seconds_total')
  })
})
