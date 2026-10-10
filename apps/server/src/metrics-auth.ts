import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { isIPv4 } from 'node:net'

import { Metrics } from './metrics.js'

/**
 * `/metrics` IP allowlist enforcement (SPEC §5: "Prometheus — no auth by
 * default, IP/allowlist option"). When {@link Metrics.ALLOWLIST_ENV} is unset
 * or empty the endpoint stays open; when set it lists IPv4 addresses and CIDR
 * blocks (comma-separated) allowed to scrape, plus loopback (`127.0.0.1` /
 * `::1`), which is always permitted. IPv6 scraping addresses are not
 * expressible in the list — IPv4 only, matching the SPEC option.
 *
 * Mount the middleware before the `/metrics` route:
 * `app.use(metricsAllowlistMiddleware(process.env))`.
 */

/** One parsed allowlist entry: an IPv4 network address plus its netmask (uint32). */
export interface Ipv4Range {
  /** Network address; host bits already masked off. */
  network: number
  /** Netmask, e.g. `0xff000000` for `/8` and `0xffffffff` for a bare address. */
  mask: number
}

/** `a.b.c.d` (or `a.b.c.d/len`) to a uint32; `null` when malformed or not IPv4. */
function ipv4ToInt(ip: string): number | null {
  if (!isIPv4(ip)) return null
  let value = 0
  for (const octet of ip.split('.')) value = (value << 8) | Number(octet)
  return value >>> 0
}

/** Parse one allowlist entry (bare address or CIDR); `null` when malformed. */
export function parseIpv4Range(entry: string): Ipv4Range | null {
  const slash = entry.indexOf('/')
  const address = slash === -1 ? entry : entry.slice(0, slash)
  const value = ipv4ToInt(address)
  if (value === null) return null
  if (slash === -1) return { network: value, mask: 0xffffffff }
  const prefixText = entry.slice(slash + 1)
  if (!/^\d{1,2}$/.test(prefixText)) return null
  const prefix = Number(prefixText)
  if (prefix > 32) return null
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return { network: (value & mask) >>> 0, mask }
}

/**
 * Parse the raw env value into ranges; `[]` means "unset/empty" (endpoint open).
 * Malformed entries throw: a typo must abort startup, never silently shrink
 * (or, worse, reshape) the allowlist.
 */
export function parseAllowlist(raw: string | undefined): Ipv4Range[] {
  if (raw === undefined) return []
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return entries.map((entry) => {
    const range = parseIpv4Range(entry)
    if (range === null) {
      throw new Error(
        `invalid ${Metrics.ALLOWLIST_ENV} entry "${entry}": expected an IPv4 address or CIDR block`,
      )
    }
    return range
  })
}

/** True when the IPv4 literal `ip` falls inside any of `ranges`. */
export function isIpAllowed(ip: string, ranges: readonly Ipv4Range[]): boolean {
  const value = ipv4ToInt(ip)
  if (value === null) return false
  for (const range of ranges) {
    if ((value & range.mask) >>> 0 === range.network) return true
  }
  return false
}

/** `::ffff:a.b.c.d` (dual-stack sockets report loopback this way) to `a.b.c.d`. */
function normalizeIp(ip: string): string {
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice('::ffff:'.length)
    if (isIPv4(mapped)) return mapped
  }
  return ip
}

/**
 * Express middleware enforcing {@link Metrics.ALLOWLIST_ENV}. Requests from
 * loopback or a listed range call `next()`; everything else gets `403`.
 */
export function metricsAllowlistMiddleware(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const ranges = parseAllowlist(env[Metrics.ALLOWLIST_ENV])
  if (ranges.length === 0) {
    // SPEC §5: the endpoint is open by default; only an explicit list restricts it.
    return (_req: Request, _res: Response, next: NextFunction) => next()
  }
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = normalizeIp(req.ip ?? req.socket?.remoteAddress ?? '')
    if (ip === '127.0.0.1' || ip === '::1' || isIpAllowed(ip, ranges)) {
      next()
      return
    }
    res.status(403).json({ error: 'forbidden' })
  }
}
