import { describe, expect, it } from 'vitest'
import {
  HEARTBEAT_META,
  IMPACT_LEVELS,
  INCIDENT_STATUS_META,
  SEVERITY_META,
  SUBSCRIPTION_EVENT_LABELS,
} from './statusDisplay.js'

describe('severity metadata', () => {
  it('ranks every severity with the worst first', () => {
    const order = Object.keys(SEVERITY_META)
    expect(order.indexOf('major_outage')).toBeLessThan(order.indexOf('partial_outage'))
    expect(order.indexOf('partial_outage')).toBeLessThan(order.indexOf('degraded'))
    expect(order.indexOf('degraded')).toBeLessThan(order.indexOf('maintenance'))
    expect(order.indexOf('maintenance')).toBeLessThan(order.indexOf('operational'))
    expect(order.indexOf('operational')).toBeLessThan(order.indexOf('unknown'))
  })

  it('maps severities to badge variants', () => {
    expect(SEVERITY_META.operational.variant).toBe('success')
    expect(SEVERITY_META.degraded.variant).toBe('warning')
    expect(SEVERITY_META.major_outage.variant).toBe('error')
    expect(SEVERITY_META.unknown.variant).toBe('neutral')
  })
})

describe('heartbeat and incident metadata', () => {
  it('maps statuses to badge variants', () => {
    expect(HEARTBEAT_META.up).toEqual({ label: 'Up', variant: 'success' })
    expect(HEARTBEAT_META.down.variant).toBe('error')
    expect(HEARTBEAT_META.pending.variant).toBe('neutral')
    expect(HEARTBEAT_META.maintenance.variant).toBe('warning')
    expect(INCIDENT_STATUS_META.resolved.variant).toBe('success')
  })
})

describe('subscription events', () => {
  it('labels every subscription event', () => {
    expect(Object.keys(SUBSCRIPTION_EVENT_LABELS)).toEqual([
      'incident_open',
      'incident_update',
      'incident_resolved',
      'maintenance_start',
      'maintenance_end',
    ])
  })
})

describe('impact levels', () => {
  it('orders impacts from none to critical', () => {
    expect(IMPACT_LEVELS).toEqual(['none', 'minor', 'major', 'critical'])
  })
})
