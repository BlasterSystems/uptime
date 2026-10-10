import { z } from 'zod'
import {
  dockerMonitorConfigSchema,
  dnsMonitorConfigSchema,
  icmpMonitorConfigSchema,
  mongodbMonitorConfigSchema,
  mssqlMonitorConfigSchema,
  mysqlMonitorConfigSchema,
  postgresMonitorConfigSchema,
  redisMonitorConfigSchema,
  tcpMonitorConfigSchema,
} from './config-checks.js'
import { pushMonitorConfigSchema } from './config-push.js'
import type { MonitorConfigMap, MonitorType } from './types.js'

/** Minimum allowed monitor interval in seconds (SPEC §3); enforced by the API layer. */
export const MIN_INTERVAL_S = 20

const HTTP_METHODS = ['GET', 'POST', 'HEAD', 'PUT', 'DELETE'] as const

const httpUrlSchema = z.string().refine((value) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'http:' || url.protocol === 'https:'
}, 'url must be a valid http(s) URL')

const keywordSchema = z.object({
  value: z.string().min(1, 'keyword.value must not be empty'),
  inverse: z.boolean().default(false),
})

const acceptedStatusSchema = z.union([
  z
    .tuple([z.int(), z.int()])
    .refine(([min, max]) => min <= max, 'acceptedStatus min must be <= max'),
  z.literal('any'),
])

/**
 * Zod schema for the `http` monitor config, including its defaults:
 * `method: 'GET'`, `timeoutMs: 10000`, `acceptedStatus: [200, 299]`.
 */
export const httpMonitorConfigSchema = z.object({
  method: z.enum(HTTP_METHODS).default('GET'),
  url: httpUrlSchema,
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  timeoutMs: z.int().positive().default(10_000),
  acceptedStatus: acceptedStatusSchema.default([200, 299]),
  keyword: keywordSchema.optional(),
  maxResponseMs: z.int().positive().optional(),
  certExpiryDays: z.int().positive().optional(),
})

/**
 * Validate a raw monitor config of the given type, applying defaults.
 * Throws a `ZodError` when `raw` does not match the type's schema.
 */
export function parseMonitorConfig<T extends MonitorType>(
  type: T,
  raw: unknown,
): MonitorConfigMap[T]
export function parseMonitorConfig(type: MonitorType, raw: unknown): MonitorConfigMap[MonitorType]
export function parseMonitorConfig(type: MonitorType, raw: unknown): MonitorConfigMap[MonitorType] {
  switch (type) {
    case 'http':
      return httpMonitorConfigSchema.parse(raw)
    case 'push':
      return pushMonitorConfigSchema.parse(raw)
    case 'tcp':
      return tcpMonitorConfigSchema.parse(raw)
    case 'dns':
      return dnsMonitorConfigSchema.parse(raw)
    case 'icmp':
      return icmpMonitorConfigSchema.parse(raw)
    case 'postgres':
      return postgresMonitorConfigSchema.parse(raw)
    case 'mysql':
      return mysqlMonitorConfigSchema.parse(raw)
    case 'mssql':
      return mssqlMonitorConfigSchema.parse(raw)
    case 'mongodb':
      return mongodbMonitorConfigSchema.parse(raw)
    case 'redis':
      return redisMonitorConfigSchema.parse(raw)
    case 'docker':
      return dockerMonitorConfigSchema.parse(raw)
    default:
      throw new Error(`unsupported monitor type: ${String(type)}`)
  }
}
