import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { MIN_INTERVAL_S, parseMonitorConfig } from './config.js'

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
      ['non-string header value', { url: 'https://example.com', headers: { a: 1 } }],
    ]
    for (const [label, raw] of invalids) {
      expect(() => parseMonitorConfig('http', raw), label).toThrowError(ZodError)
    }
  })

  it('rejects unsupported monitor types', () => {
    expect(() => parseMonitorConfig('tcp' as unknown as 'http', {})).toThrowError(
      /unsupported monitor type/,
    )
  })

  it('exposes the minimum interval', () => {
    expect(MIN_INTERVAL_S).toBe(20)
  })
})
