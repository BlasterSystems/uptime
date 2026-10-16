import { describe, expect, it } from 'vitest'
import {
  formatDateTime,
  formatDuration,
  formatInterval,
  formatLatency,
  relativeTime,
} from './format.js'

describe('relativeTime', () => {
  const now = Date.parse('2026-10-16T12:00:00Z')

  it('renders just-now for tiny deltas', () => {
    expect(relativeTime('2026-10-16T11:59:59Z', now)).toBe('just now')
  })

  it('renders seconds, minutes, hours and days with the ago suffix', () => {
    expect(relativeTime('2026-10-16T11:59:01Z', now)).toBe('59s ago')
    expect(relativeTime('2026-10-16T11:58:00Z', now)).toBe('2m ago')
    expect(relativeTime('2026-10-16T09:00:00Z', now)).toBe('3h ago')
    expect(relativeTime('2026-10-14T12:00:00Z', now)).toBe('2d ago')
  })

  it('renders future deltas with the from-now suffix', () => {
    expect(relativeTime('2026-10-16T12:00:30Z', now)).toBe('30s from now')
    expect(relativeTime('2026-10-16T12:30:00Z', now)).toBe('30m from now')
  })

  it('falls back to the medium datetime beyond 30 days and for invalid input', () => {
    expect(relativeTime('2026-01-01T00:00:00Z', now)).toBe(formatDateTime('2026-01-01T00:00:00Z'))
    expect(relativeTime('not a date', now)).toBe('unknown')
  })
})

describe('formatDuration', () => {
  it('renders sub-second, seconds and composite durations', () => {
    expect(formatDuration(400)).toBe('under 1s')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(200_000)).toBe('3m 20s')
    expect(formatDuration(180_000)).toBe('3m')
    expect(formatDuration(7_500_000)).toBe('2h 5m')
    expect(formatDuration(97_200_000)).toBe('1d 3h')
  })

  it('renders an em dash for non-finite or negative input', () => {
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
  })
})

describe('formatInterval', () => {
  it('renders seconds below a minute and rounded minutes/hours above', () => {
    expect(formatInterval(59)).toBe('59s')
    expect(formatInterval(1300)).toBe('22m')
    expect(formatInterval(3600)).toBe('1h')
    expect(formatInterval(5400)).toBe('1.5h')
    expect(formatInterval(-5)).toBe('—')
  })
})

describe('formatLatency', () => {
  it('renders null, sub-second and second-scale latencies', () => {
    expect(formatLatency(null)).toBe('—')
    expect(formatLatency(52)).toBe('52 ms')
    expect(formatLatency(1500)).toBe('1.50 s')
  })
})

describe('formatDateTime', () => {
  it('reports unknown for invalid input', () => {
    expect(formatDateTime('nope')).toBe('unknown')
  })
})
