import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'

import {
  isIpAllowed,
  metricsAllowlistMiddleware,
  parseAllowlist,
  parseIpv4Range,
} from './metrics-auth.js'
import { Metrics } from './metrics.js'

/** Invoke a handler directly — no HTTP server — capturing next()/403/json calls. */
function invoke(handler: RequestHandler, req: Partial<Request>) {
  const next = vi.fn()
  const json = vi.fn()
  const status = vi.fn(() => ({ json }))
  handler(req as Request, { status } as unknown as Response, next as unknown as NextFunction)
  return { next, status, json }
}

describe('parseIpv4Range', () => {
  it('parses bare addresses as /32 and CIDR blocks with the masked network', () => {
    expect(parseIpv4Range('10.0.0.1')).toEqual({ network: 0x0a000001, mask: 0xffffffff })
    expect(parseIpv4Range('10.0.0.0/8')).toEqual({ network: 0x0a000000, mask: 0xff000000 })
    expect(parseIpv4Range('0.0.0.0/0')).toEqual({ network: 0, mask: 0 })
    expect(parseIpv4Range('192.168.1.128/25')).toEqual({ network: 0xc0a80180, mask: 0xffffff80 })
    expect(parseIpv4Range('255.255.255.255/32')).toEqual({
      network: 0xffffffff,
      mask: 0xffffffff,
    })
  })

  it('rejects malformed or non-IPv4 entries', () => {
    const bad = [
      '',
      'nope',
      '10.0.0',
      '10.0.0.256',
      '10.0.0.1/33',
      '10.0.0.1/',
      '10.0.0.1/8/8',
      '10.0.0.1/-1',
      '::1',
      '2001:db8::/32',
      ' 10.0.0.1',
    ]
    for (const entry of bad) {
      expect(parseIpv4Range(entry), entry).toBeNull()
    }
  })
})

describe('parseAllowlist', () => {
  it('treats unset and empty values as "open"', () => {
    expect(parseAllowlist(undefined)).toEqual([])
    expect(parseAllowlist('')).toEqual([])
    expect(parseAllowlist(' , ,')).toEqual([])
  })

  it('splits on commas and trims entries', () => {
    expect(parseAllowlist(' 10.0.0.0/8 ,192.168.1.5, ')).toEqual([
      { network: 0x0a000000, mask: 0xff000000 },
      { network: 0xc0a80105, mask: 0xffffffff },
    ])
  })

  it('throws on malformed entries instead of silently ignoring them', () => {
    expect(() => parseAllowlist('10.0.0.0/8,not-an-ip')).toThrowError(
      /METRICS_ALLOWLIST.*not-an-ip/,
    )
  })
})

describe('isIpAllowed', () => {
  const ranges = parseAllowlist('10.0.0.0/8,192.168.1.5,172.16.0.0/12')

  it('matches CIDR boundaries', () => {
    expect(isIpAllowed('10.0.0.0', ranges)).toBe(true)
    expect(isIpAllowed('10.255.255.255', ranges)).toBe(true)
    expect(isIpAllowed('11.0.0.0', ranges)).toBe(false)
    expect(isIpAllowed('172.15.255.255', ranges)).toBe(false)
    expect(isIpAllowed('172.16.0.0', ranges)).toBe(true)
    expect(isIpAllowed('172.31.255.255', ranges)).toBe(true)
    expect(isIpAllowed('172.32.0.0', ranges)).toBe(false)
  })

  it('matches bare addresses exactly', () => {
    expect(isIpAllowed('192.168.1.5', ranges)).toBe(true)
    expect(isIpAllowed('192.168.1.4', ranges)).toBe(false)
  })

  it('rejects addresses that are not IPv4', () => {
    expect(isIpAllowed('::1', ranges)).toBe(false)
    expect(isIpAllowed('', ranges)).toBe(false)
  })

  it('allows everything with 0.0.0.0/0', () => {
    expect(isIpAllowed('8.8.8.8', parseAllowlist('0.0.0.0/0'))).toBe(true)
  })
})

describe('metricsAllowlistMiddleware', () => {
  it('stays open when METRICS_ALLOWLIST is unset or empty', () => {
    expect(Metrics.ALLOWLIST_ENV).toBe('METRICS_ALLOWLIST')
    for (const env of [{}, { METRICS_ALLOWLIST: '' }, { METRICS_ALLOWLIST: ' , ' }]) {
      const { next, status } = invoke(metricsAllowlistMiddleware(env), { ip: '203.0.113.9' })
      expect(next).toHaveBeenCalledTimes(1)
      expect(status).not.toHaveBeenCalled()
    }
  })

  it('lets listed addresses and loopback through', () => {
    const handler = metricsAllowlistMiddleware({ METRICS_ALLOWLIST: '10.0.0.0/8,192.168.1.5' })
    for (const ip of ['10.1.2.3', '192.168.1.5', '127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const { next, status } = invoke(handler, { ip })
      expect(next, ip).toHaveBeenCalledTimes(1)
      expect(status, ip).not.toHaveBeenCalled()
    }
  })

  it('answers 403 for unlisted addresses', () => {
    const handler = metricsAllowlistMiddleware({ METRICS_ALLOWLIST: '10.0.0.0/8' })
    for (const ip of ['11.0.0.1', '203.0.113.9', '2001:db8::1', '::ffff:203.0.113.9']) {
      const { next, status, json } = invoke(handler, { ip })
      expect(next, ip).not.toHaveBeenCalled()
      expect(status, ip).toHaveBeenCalledWith(403)
      expect(json, ip).toHaveBeenCalledWith({ error: 'forbidden' })
    }
  })

  it('falls back to the socket address and fails closed without one', () => {
    const handler = metricsAllowlistMiddleware({ METRICS_ALLOWLIST: '10.0.0.0/8' })
    const fromSocket = invoke(handler, {
      socket: { remoteAddress: '10.1.2.3' },
    } as Partial<Request>)
    expect(fromSocket.next).toHaveBeenCalledTimes(1)

    const noAddress = invoke(handler, {})
    expect(noAddress.next).not.toHaveBeenCalled()
    expect(noAddress.status).toHaveBeenCalledWith(403)
  })

  it('refuses to build an enforcement handler for a malformed allowlist', () => {
    expect(() => metricsAllowlistMiddleware({ METRICS_ALLOWLIST: '10.0.0.1/33' })).toThrowError(
      /METRICS_ALLOWLIST/,
    )
  })
})
