import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { MIN_INTERVAL_S, parseMonitorConfig } from './config.js'
import type { MonitorType } from './types.js'

describe('parseMonitorConfig', () => {
  it('applies the documented defaults', () => {
    expect(parseMonitorConfig('http', { url: 'https://example.com/healthz' })).toEqual({
      method: 'GET',
      url: 'https://example.com/healthz',
      timeoutMs: 10_000,
      acceptedStatus: [200, 299],
    })
  })

  it('defaults keyword.inverse to false', () => {
    const config = parseMonitorConfig('http', {
      url: 'http://localhost:3001/healthz',
      keyword: { value: 'ok' },
    })
    expect(config.keyword).toEqual({ value: 'ok', inverse: false })
  })

  it('keeps a fully specified config intact', () => {
    const raw = {
      method: 'POST',
      url: 'https://example.com/hook',
      headers: { authorization: 'Bearer token' },
      body: '{"ping":true}',
      timeoutMs: 2500,
      acceptedStatus: [200, 201],
      keyword: { value: 'pong', inverse: true },
      maxResponseMs: 800,
      certExpiryDays: 14,
      jsonPaths: { activeUsers: 'metrics.users.active', first: 'queue[0].id' },
    }
    expect(parseMonitorConfig('http', raw)).toEqual(raw)
  })

  it('accepts "any" as the accepted status', () => {
    const config = parseMonitorConfig('http', {
      url: 'https://example.com',
      acceptedStatus: 'any',
    })
    expect(config.acceptedStatus).toBe('any')
  })

  it('keeps certExpiryDays and strips unknown keys', () => {
    const config = parseMonitorConfig('http', {
      url: 'https://example.com',
      certExpiryDays: 7,
      bogus: true,
    })
    expect(config.certExpiryDays).toBe(7)
    expect(config).not.toHaveProperty('bogus')
  })

  it('rejects invalid configs with a ZodError', () => {
    const invalids: Array<[label: string, raw: unknown]> = [
      ['missing url', {}],
      ['url without a scheme', { url: 'example.com/healthz' }],
      ['non-http scheme', { url: 'ftp://example.com/file' }],
      ['unknown method', { url: 'https://example.com', method: 'PATCH' }],
      ['non-positive timeout', { url: 'https://example.com', timeoutMs: 0 }],
      ['fractional timeout', { url: 'https://example.com', timeoutMs: 100.5 }],
      ['inverted accepted range', { url: 'https://example.com', acceptedStatus: [500, 400] }],
      ['empty keyword', { url: 'https://example.com', keyword: { value: '' } }],
      ['non-string keyword', { url: 'https://example.com', keyword: { value: 42 } }],
      ['non-positive response cap', { url: 'https://example.com', maxResponseMs: 0 }],
      ['fractional response cap', { url: 'https://example.com', maxResponseMs: 10.5 }],
      ['non-positive cert expiry', { url: 'https://example.com', certExpiryDays: 0 }],
      ['fractional cert expiry', { url: 'https://example.com', certExpiryDays: 14.5 }],
      ['non-string header value', { url: 'https://example.com', headers: { a: 1 } }],
      ['empty jsonPath', { url: 'https://example.com', jsonPaths: { x: '' } }],
      ['bracket-only jsonPath', { url: 'https://example.com', jsonPaths: { x: '[0]' } }],
      ['jsonPath with empty segment', { url: 'https://example.com', jsonPaths: { x: 'a..b' } }],
      ['jsonPath with wildcard index', { url: 'https://example.com', jsonPaths: { x: 'a[*]' } }],
      ['empty jsonPaths metric name', { url: 'https://example.com', jsonPaths: { '': 'a' } }],
      ['non-string jsonPath', { url: 'https://example.com', jsonPaths: { x: 42 } }],
    ]
    for (const [label, raw] of invalids) {
      expect(() => parseMonitorConfig('http', raw), label).toThrowError(ZodError)
    }
  })

  it('rejects unsupported monitor types', () => {
    // `snmp` is a SPEC §3 phase-2 type and intentionally outside `MonitorType`.
    expect(() => parseMonitorConfig('snmp' as unknown as 'http', {})).toThrowError(
      /unsupported monitor type/,
    )
  })

  it('dispatches by monitor type', () => {
    expect(parseMonitorConfig('http', { url: 'https://example.com' }).method).toBe('GET')
    expect(parseMonitorConfig('push', {})).toEqual({ graceSeconds: 60 })
    expect(parseMonitorConfig('tcp', { host: 'db.internal', port: 5432 })).toEqual({
      host: 'db.internal',
      port: 5432,
      timeoutMs: 10_000,
    })

    // Dynamic dispatch (the API layer passes a validated `type` column value).
    const type: MonitorType = 'push'
    expect(parseMonitorConfig(type, { graceSeconds: 30 })).toEqual({ graceSeconds: 30 })
  })

  it('exposes the minimum interval', () => {
    expect(MIN_INTERVAL_S).toBe(20)
  })
})

describe('parseMonitorConfig push', () => {
  it('defaults graceSeconds to 60', () => {
    expect(parseMonitorConfig('push', {})).toEqual({ graceSeconds: 60 })
  })

  it('keeps a fully specified config intact and accepts 1 s of grace', () => {
    const raw = { graceSeconds: 300, cron: '*/5 * * * *', expectsBody: true }
    expect(parseMonitorConfig('push', raw)).toEqual(raw)
    expect(parseMonitorConfig('push', { graceSeconds: 1 })).toEqual({ graceSeconds: 1 })
  })

  it('accepts 5- and 6-field cron schedules', () => {
    for (const cron of ['* * * * *', '0 9 * * 1-5', '*/30 0-23/2,5 1 * * *']) {
      expect(parseMonitorConfig('push', { cron }).cron).toBe(cron)
    }
  })

  it('strips unknown keys', () => {
    expect(parseMonitorConfig('push', { graceSeconds: 120, token: 'secret' })).toEqual({
      graceSeconds: 120,
    })
  })

  it('rejects invalid configs with a ZodError', () => {
    const invalids: Array<[label: string, raw: unknown]> = [
      ['zero grace', { graceSeconds: 0 }],
      ['negative grace', { graceSeconds: -1 }],
      ['fractional grace', { graceSeconds: 1.5 }],
      ['non-numeric grace', { graceSeconds: '60' }],
      ['cron with 4 fields', { cron: '* * * *' }],
      ['cron with 7 fields', { cron: '* * * * * * *' }],
      ['cron with a word alias', { cron: '* * * * MON' }],
      ['cron with an unsupported character', { cron: '* * * * ?' }],
      ['blank cron', { cron: '   ' }],
      ['non-string cron', { cron: 5 }],
      ['non-boolean expectsBody', { expectsBody: 'yes' }],
    ]
    for (const [label, raw] of invalids) {
      expect(() => parseMonitorConfig('push', raw), label).toThrowError(ZodError)
    }
  })
})
