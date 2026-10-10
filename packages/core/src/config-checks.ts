import { z } from 'zod'

/**
 * Zod schemas and validated interfaces for the non-HTTP monitor types (SPEC §3).
 * Every schema strips unknown keys, matching `httpMonitorConfigSchema`.
 */

/**
 * Hostname or IP literal accepted by the network probes. Probes are executed
 * without a shell, so the only argument-injection hazard is a leading `-`.
 */
const hostSchema = z
  .string()
  .min(1, 'host must not be empty')
  .max(255, 'host must be at most 255 characters')
  .refine((value) => !value.startsWith('-'), 'host must not start with "-"')
  .refine((value) => !/\s/.test(value), 'host must not contain whitespace')

const portSchema = z.int().min(1).max(65_535)

/** Docker host URI: `unix:///var/run/docker.sock` or `tcp://host:port`. */
const dockerHostUriSchema = z
  .string()
  .refine(
    (value) =>
      (value.startsWith('unix://') && value.length > 'unix://'.length) ||
      value.startsWith('tcp://'),
    'hostUri must be a unix:// path or a tcp://host:port URL',
  )
  .refine((value) => {
    if (!value.startsWith('tcp://')) return true
    if (!URL.canParse(value)) return false
    return new URL(value).hostname !== ''
  }, 'hostUri must be a valid tcp:// URL')

// --- tcp -------------------------------------------------------------------

/** Validated configuration of a `tcp` monitor (SPEC §3). */
export interface TcpMonitorConfig {
  host: string
  port: number
  /** Connect (and response) timeout in milliseconds. */
  timeoutMs: number
  /** Payload written after the connection is established; a response is then awaited. */
  payload?: string
  /** Substring the response chunk must contain (meaningful together with `payload`). */
  expectResponse?: string
}

/** Zod schema for {@link TcpMonitorConfig}: `timeoutMs` defaults to 10000. */
export const tcpMonitorConfigSchema = z.object({
  host: hostSchema,
  port: portSchema,
  timeoutMs: z.int().positive().default(10_000),
  payload: z.string().optional(),
  expectResponse: z.string().optional(),
})

// --- dns -------------------------------------------------------------------

/** Record types a `dns` monitor can resolve. */
export const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV'] as const

export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number]

/** Validated configuration of a `dns` monitor (SPEC §3). */
export interface DnsMonitorConfig {
  host: string
  /** Custom resolver as `host[:port]`; the system resolvers are used when omitted. */
  resolver?: string
  /** Resolver port, appended when `resolver` carries no port of its own. */
  port: number
  recordType: DnsRecordType
  /**
   * Answer the resolver must return. TXT answers are matched with their chunks
   * joined, MX with the exchange, SRV with `name:port` (a bare `name` matches too)
   * and every other type with its first answer.
   */
  expectedValue?: string
  timeoutMs: number
}

/** Zod schema for {@link DnsMonitorConfig}: `port` defaults to 53, `timeoutMs` to 10000. */
export const dnsMonitorConfigSchema = z.object({
  host: hostSchema,
  resolver: z.string().min(1).optional(),
  port: z.int().min(1).max(65_535).default(53),
  recordType: z.enum(DNS_RECORD_TYPES),
  expectedValue: z.string().optional(),
  timeoutMs: z.int().positive().default(10_000),
})

// --- icmp ------------------------------------------------------------------

/** Validated configuration of an `icmp` monitor (SPEC §3). */
export interface IcmpMonitorConfig {
  host: string
  timeoutMs: number
  /** Echo requests sent per probe (1-10). */
  packetCount: number
}

/** Zod schema for {@link IcmpMonitorConfig}: `timeoutMs` defaults to 5000, `packetCount` to 3. */
export const icmpMonitorConfigSchema = z.object({
  host: hostSchema,
  timeoutMs: z.int().positive().default(5_000),
  packetCount: z.int().min(1).max(10).default(3),
})

// --- postgres / mysql / mssql ----------------------------------------------

/** Validated configuration of a `postgres` monitor (SPEC §3). */
export interface PostgresMonitorConfig {
  connectionString: string
  timeoutMs: number
  query: string
}

/** Zod schema for {@link PostgresMonitorConfig}: `timeoutMs` defaults to 10000, `query` to `SELECT 1`. */
export const postgresMonitorConfigSchema = z.object({
  connectionString: z.string().min(1),
  timeoutMs: z.int().positive().default(10_000),
  query: z.string().min(1).default('SELECT 1'),
})

/** Validated configuration of a `mysql` monitor (SPEC §3). */
export interface MysqlMonitorConfig {
  connectionString: string
  timeoutMs: number
  query: string
}

/** Zod schema for {@link MysqlMonitorConfig}: `timeoutMs` defaults to 10000, `query` to `SELECT 1`. */
export const mysqlMonitorConfigSchema = z.object({
  connectionString: z.string().min(1),
  timeoutMs: z.int().positive().default(10_000),
  query: z.string().min(1).default('SELECT 1'),
})

/** Validated configuration of an `mssql` monitor (SPEC §3). */
export interface MssqlMonitorConfig {
  connectionString: string
  timeoutMs: number
  query: string
}

/** Zod schema for {@link MssqlMonitorConfig}: `timeoutMs` defaults to 10000, `query` to `SELECT 1`. */
export const mssqlMonitorConfigSchema = z.object({
  connectionString: z.string().min(1),
  timeoutMs: z.int().positive().default(10_000),
  query: z.string().min(1).default('SELECT 1'),
})

// --- mongodb / redis -------------------------------------------------------

/** Validated configuration of a `mongodb` monitor (SPEC §3). */
export interface MongodbMonitorConfig {
  connectionString: string
  timeoutMs: number
}

/** Zod schema for {@link MongodbMonitorConfig}: `timeoutMs` defaults to 10000. */
export const mongodbMonitorConfigSchema = z.object({
  connectionString: z.string().min(1),
  timeoutMs: z.int().positive().default(10_000),
})

/** Validated configuration of a `redis` monitor (SPEC §3). */
export interface RedisMonitorConfig {
  connectionString: string
  timeoutMs: number
  /** Command sent after connecting; whitespace-separated arguments (default `PING`). */
  query: string
}

/** Zod schema for {@link RedisMonitorConfig}: `timeoutMs` defaults to 10000, `query` to `PING`. */
export const redisMonitorConfigSchema = z.object({
  connectionString: z.string().min(1),
  timeoutMs: z.int().positive().default(10_000),
  query: z.string().min(1).default('PING'),
})

// --- docker ----------------------------------------------------------------

/** Validated configuration of a `docker` monitor (SPEC §3). */
export interface DockerMonitorConfig {
  /** Docker host URI (`unix:///var/run/docker.sock` or `tcp://host:port`). */
  hostUri: string
  /** Container name or id used in the inspect request path. */
  containerNameOrId: string
  /** Container state (`State.Status`) the monitor expects. */
  expectedState: string
  /** PEM CA bundle; when any TLS material is set the probe talks TLS. */
  tlsCaPem?: string
  tlsCertPem?: string
  tlsKeyPem?: string
  timeoutMs: number
}

/** Zod schema for {@link DockerMonitorConfig}: `expectedState` defaults to `running`. */
export const dockerMonitorConfigSchema = z.object({
  hostUri: dockerHostUriSchema,
  containerNameOrId: z.string().min(1),
  expectedState: z.string().min(1).default('running'),
  tlsCaPem: z.string().optional(),
  tlsCertPem: z.string().optional(),
  tlsKeyPem: z.string().optional(),
  timeoutMs: z.int().positive().default(10_000),
})
