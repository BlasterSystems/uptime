import { execFile, type ExecFileException } from 'node:child_process'
import { Resolver } from 'node:dns/promises'
import { Socket } from 'node:net'
// mssql is CommonJS with dynamically built exports: only a default import resolves at runtime.
import mssql from 'mssql'
import { MongoClient } from 'mongodb'
import {
  createConnection as createMysqlConnection,
  type Connection as MysqlConnection,
} from 'mysql2/promise'
import { Client as PostgresClient } from 'pg'
import { createClient as createRedisClient } from 'redis'
import type {
  DnsMonitorConfig,
  IcmpMonitorConfig,
  MongodbMonitorConfig,
  MssqlMonitorConfig,
  MysqlMonitorConfig,
  PostgresMonitorConfig,
  RedisMonitorConfig,
  TcpMonitorConfig,
} from './config-checks.js'
import { parseMonitorConfig } from './config.js'
import { describeFailure, runHttpCheck } from './http.js'
import type { CheckResult, MonitorType } from './types.js'

/** Results carry at most the first 1024 bytes of a body / failure reason (SPEC §4). */
const SNIPPET_BYTES = 1024

/**
 * Run one probe of any supported monitor type (SPEC §3).
 *
 * Probe failures never reject: transport errors, unmet expectations and timeouts
 * all resolve to `status: 'down'` with the reason in `responseSnippet`. The
 * function throws instead for configuration errors (`ZodError` from the type's
 * schema), `push` monitors (heartbeat-driven, never probed) and unsupported
 * types.
 *
 * `signal` cancels the transports that accept one (http, tcp, icmp);
 * the DNS and database probes rely on their driver timeouts.
 */
export async function runCheck(
  type: MonitorType,
  config: unknown,
  signal?: AbortSignal,
): Promise<CheckResult> {
  switch (type) {
    case 'http':
      return runHttpCheck(parseMonitorConfig('http', config), signal)
    case 'push':
      throw new Error('push monitors are not probed')
    case 'tcp':
      return runTcpCheck(parseMonitorConfig('tcp', config), signal)
    case 'dns':
      return runDnsCheck(parseMonitorConfig('dns', config))
    case 'icmp':
      return runIcmpCheck(parseMonitorConfig('icmp', config), signal)
    case 'postgres':
      return runPostgresCheck(parseMonitorConfig('postgres', config))
    case 'mysql':
      return runMysqlCheck(parseMonitorConfig('mysql', config))
    case 'mssql':
      return runMssqlCheck(parseMonitorConfig('mssql', config))
    case 'mongodb':
      return runMongodbCheck(parseMonitorConfig('mongodb', config))
    case 'redis':
      return runRedisCheck(parseMonitorConfig('redis', config))
    default:
      throw new Error(`unsupported monitor type: ${String(type)}`)
  }
}

/** TCP probe: connect within `timeoutMs`, optionally exchange a payload (SPEC §3). */
async function runTcpCheck(config: TcpMonitorConfig, signal?: AbortSignal): Promise<CheckResult> {
  const startedAt = performance.now()
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs)
  const combined = AbortSignal.any(signal === undefined ? [timeoutSignal] : [timeoutSignal, signal])
  const socket = new Socket()
  try {
    await connectSocket(socket, config.host, config.port, combined)
    if (config.payload === undefined && config.expectResponse === undefined) {
      return { status: 'up', latencyMs: Math.round(performance.now() - startedAt) }
    }
    // A payload turns the probe into a round trip; latency covers write → response.
    const writeStartedAt = performance.now()
    const response = await exchange(socket, config.payload ?? '', combined)
    const latencyMs = Math.round(performance.now() - writeStartedAt)
    const expected = config.expectResponse
    if (expected !== undefined && !response.includes(expected)) {
      return downResult(latencyMs, `expected "${expected}" in response, got: ${response}`)
    }
    return { status: 'up', latencyMs, responseSnippet: snippet(response) }
  } catch (error) {
    return downResult(
      Math.round(performance.now() - startedAt),
      describeFailure(error, timeoutSignal, signal, config.timeoutMs),
    )
  } finally {
    socket.destroy()
  }
}

/** Resolve once the socket connects; reject on error, timeout or caller abort. */
function connectSocket(
  socket: Socket,
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      socket.off('connect', onConnect)
      socket.off('error', onError)
      signal.removeEventListener('abort', onAbort)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onConnect = (): void => finish()
    const onError = (error: Error): void => finish(error)
    const onAbort = (): void =>
      finish(
        signal.reason instanceof Error ? signal.reason : new Error('the operation was aborted'),
      )

    if (signal.aborted) {
      finish(
        signal.reason instanceof Error ? signal.reason : new Error('the operation was aborted'),
      )
      return
    }
    socket.once('connect', onConnect)
    socket.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    socket.connect(port, host)
  })
}

/** Write `payload` and resolve with the first response chunk. */
function exchange(socket: Socket, payload: string, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const finish = (error: Error | undefined, chunk?: Buffer): void => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      signal.removeEventListener('abort', onAbort)
      if (error === undefined) resolve(chunk === undefined ? '' : chunk.toString('utf8'))
      else reject(error)
    }
    const onData = (chunk: Buffer): void => finish(undefined, chunk)
    const onError = (error: Error): void => finish(error)
    const onClose = (): void =>
      finish(new Error('connection closed before a response was received'))
    const onAbort = (): void =>
      finish(
        signal.reason instanceof Error ? signal.reason : new Error('the operation was aborted'),
      )

    if (signal.aborted) {
      finish(
        signal.reason instanceof Error ? signal.reason : new Error('the operation was aborted'),
      )
      return
    }
    socket.once('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    socket.write(payload)
  })
}

/** DNS probe: resolve `host` with the configured record type (SPEC §3). */
async function runDnsCheck(config: DnsMonitorConfig): Promise<CheckResult> {
  const startedAt = performance.now()
  const resolver = new Resolver({ timeout: config.timeoutMs, tries: 1 })
  const server = config.resolver
  if (server !== undefined) {
    // `host[:port]`; the configured port is appended only when the server has none.
    const hasPort = server.startsWith('[') ? server.includes(']:') : server.includes(':')
    resolver.setServers([hasPort ? server : `${server}:${config.port}`])
  }
  try {
    const answers = await resolveAnswers(resolver, config)
    const latencyMs = Math.round(performance.now() - startedAt)
    if (answers.length === 0) return downResult(latencyMs, `no ${config.recordType} records`)
    const expected = config.expectedValue
    if (
      expected !== undefined &&
      !answers.some(
        (answer) =>
          answer === expected || (config.recordType === 'SRV' && answer.startsWith(`${expected}:`)),
      )
    ) {
      return downResult(
        latencyMs,
        `expected "${expected}" among ${config.recordType} ${answers.join(', ')}`,
      )
    }
    return {
      status: 'up',
      latencyMs,
      responseSnippet: snippet(`${config.recordType} ${answers.join(', ')}`),
      details: { records: answers.length },
    }
  } catch (error) {
    return downResult(Math.round(performance.now() - startedAt), errorMessage(error))
  }
}

/** Answer strings for the configured record type: MX exchanges, joined TXT chunks, `name:port` for SRV. */
async function resolveAnswers(resolver: Resolver, config: DnsMonitorConfig): Promise<string[]> {
  switch (config.recordType) {
    case 'A':
      return resolver.resolve4(config.host)
    case 'AAAA':
      return resolver.resolve6(config.host)
    case 'CNAME':
      return resolver.resolveCname(config.host)
    case 'NS':
      return resolver.resolveNs(config.host)
    case 'TXT':
      return (await resolver.resolveTxt(config.host)).map((chunks) => chunks.join(''))
    case 'MX':
      return (await resolver.resolveMx(config.host)).map((record) => record.exchange)
    case 'SRV':
      return (await resolver.resolveSrv(config.host)).map(
        (record) => `${record.name}:${record.port}`,
      )
  }
}

/** `time=` / `time<` values printed by ping for each reply, in milliseconds. */
const PING_TIME_PATTERN = /time[=<]\s*([\d.]+)\s*ms/g

interface PingOutput {
  stdout: string
  stderr: string
  error: ExecFileException | null
}

/**
 * ICMP probe: `packetCount` echo requests within `timeoutMs` (SPEC §3).
 *
 * Node's `dgram` has no raw/ICMP socket type (`ERR_SOCKET_BAD_TYPE` on every
 * platform), so the probe shells out to the system `ping`, which sends genuine
 * ICMP echo requests and needs `CAP_NET_RAW`/root only on hardened Linux hosts.
 */
async function runIcmpCheck(config: IcmpMonitorConfig, signal?: AbortSignal): Promise<CheckResult> {
  const startedAt = performance.now()
  const { stdout, stderr, error } = await new Promise<PingOutput>((resolve) => {
    execFile(
      'ping',
      ['-n', '-c', String(config.packetCount), config.host],
      { timeout: config.timeoutMs, killSignal: 'SIGKILL', signal, maxBuffer: 1024 * 1024 },
      (err, out, errOut) => resolve({ stdout: out, stderr: errOut, error: err }),
    )
  })
  const replies: number[] = []
  for (const match of stdout.matchAll(PING_TIME_PATTERN)) {
    const value = Number.parseFloat(match[1] ?? '')
    if (Number.isFinite(value)) replies.push(value)
  }

  const elapsedMs = Math.round(performance.now() - startedAt)
  if (signal?.aborted === true) return downResult(elapsedMs, 'check aborted')
  if (replies.length > 0) {
    return {
      status: 'up',
      latencyMs: Math.round(Math.min(...replies)),
      responseSnippet: snippet(`${replies.length}/${config.packetCount} replies`),
      details: { replies: replies.length, packetCount: config.packetCount },
    }
  }
  if (error !== null && error.killed === true) {
    return downResult(elapsedMs, `timeout after ${config.timeoutMs}ms`)
  }
  if (/operation not permitted|permission denied|are you root/i.test(stderr)) {
    return downResult(elapsedMs, `icmp requires NET_RAW capability or root: ${stderr.trim()}`)
  }
  if (error !== null && error.code === 'ENOENT') {
    return downResult(elapsedMs, 'ping binary not found on PATH')
  }
  const loss = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /packet loss/.test(line))
  const firstStderr = stderr.trim().split('\n')[0] ?? ''
  const reason = loss ?? (firstStderr !== '' ? firstStderr : errorMessage(error))
  return downResult(elapsedMs, reason !== '' ? reason : 'no icmp replies')
}

/** Postgres probe: connect, run the query, disconnect (SPEC §3). */
async function runPostgresCheck(config: PostgresMonitorConfig): Promise<CheckResult> {
  const startedAt = performance.now()
  const client = new PostgresClient({
    connectionString: config.connectionString,
    // node-postgres defaults would let a black-holed host hang forever.
    connectionTimeoutMillis: config.timeoutMs,
    query_timeout: config.timeoutMs,
  })
  try {
    await client.connect()
    const result = await client.query(config.query)
    return {
      status: 'up',
      latencyMs: Math.round(performance.now() - startedAt),
      responseSnippet: snippet(
        `${config.query} ok: ${result.rowCount ?? result.rows.length} row(s)`,
      ),
    }
  } catch (error) {
    return downResult(Math.round(performance.now() - startedAt), errorMessage(error))
  } finally {
    // Resolves immediately when the client never connected.
    await client.end().catch(() => undefined)
  }
}

/** MySQL probe: connect, run the query, disconnect (SPEC §3). */
async function runMysqlCheck(config: MysqlMonitorConfig): Promise<CheckResult> {
  const startedAt = performance.now()
  let connection: MysqlConnection | undefined
  try {
    connection = await createMysqlConnection({
      uri: config.connectionString,
      connectTimeout: config.timeoutMs,
    })
    const [rows] = await connection.query({ sql: config.query, timeout: config.timeoutMs })
    const rowCount = Array.isArray(rows) ? rows.length : 0
    return {
      status: 'up',
      latencyMs: Math.round(performance.now() - startedAt),
      responseSnippet: snippet(`${config.query} ok: ${rowCount} row(s)`),
    }
  } catch (error) {
    return downResult(Math.round(performance.now() - startedAt), errorMessage(error))
  } finally {
    if (connection !== undefined) await connection.end().catch(() => undefined)
  }
}

/** MSSQL probe: connect a pool, run the query, close it (SPEC §3). */
async function runMssqlCheck(config: MssqlMonitorConfig): Promise<CheckResult> {
  const startedAt = performance.now()
  const pool = new mssql.ConnectionPool(config.connectionString)
  // mssql surfaces some connection failures as 'error' events; the awaited calls report them.
  pool.on('error', () => undefined)
  // mssql defaults both timeouts to 15 s; the pool reads these keys per connection.
  pool.config.connectionTimeout = config.timeoutMs
  pool.config.requestTimeout = config.timeoutMs
  try {
    await pool.connect()
    const result = await pool.request().query(config.query)
    return {
      status: 'up',
      latencyMs: Math.round(performance.now() - startedAt),
      responseSnippet: snippet(`${config.query} ok: ${result.rowsAffected[0] ?? 0} row(s)`),
    }
  } catch (error) {
    return downResult(Math.round(performance.now() - startedAt), errorMessage(error))
  } finally {
    // Closing a pool that is still connecting rejects; one that never connected closes as a no-op.
    await pool.close().catch(() => undefined)
  }
}

/** MongoDB probe: connect, `ping` the admin database, close (SPEC §3). */
async function runMongodbCheck(config: MongodbMonitorConfig): Promise<CheckResult> {
  const startedAt = performance.now()
  const client = new MongoClient(config.connectionString, {
    // Driver defaults are 30 s (server selection) and 10 s (socket connect).
    serverSelectionTimeoutMS: config.timeoutMs,
    connectTimeoutMS: config.timeoutMs,
  })
  try {
    await client.connect()
    await client.db('admin').command({ ping: 1 })
    return {
      status: 'up',
      latencyMs: Math.round(performance.now() - startedAt),
      responseSnippet: 'ping ok',
    }
  } catch (error) {
    return downResult(Math.round(performance.now() - startedAt), errorMessage(error))
  } finally {
    // `close()` tolerates a client that never finished connecting.
    await client.close().catch(() => undefined)
  }
}

/** Redis probe: connect, send the configured command, quit (SPEC §3). */
async function runRedisCheck(config: RedisMonitorConfig): Promise<CheckResult> {
  const startedAt = performance.now()
  const client = createRedisClient({
    url: config.connectionString,
    socket: {
      // A probe neither retries nor waits past the configured timeout.
      connectTimeout: config.timeoutMs,
      reconnectStrategy: false,
    },
  })
  // node-redis emits socket failures as 'error' events; the awaited calls report them.
  client.on('error', () => undefined)
  try {
    await client.connect()
    const command = config.query.trim().split(/\s+/)
    const reply: unknown = await client.sendCommand(command)
    const text = typeof reply === 'string' ? reply : JSON.stringify(reply)
    const verb = command[0] ?? ''
    const latencyMs = Math.round(performance.now() - startedAt)
    if (verb.toUpperCase() === 'PING' && text !== 'PONG' && text !== 'OK') {
      return downResult(latencyMs, `unexpected PING reply: ${text}`)
    }
    return { status: 'up', latencyMs, responseSnippet: snippet(`${verb} → ${text}`) }
  } catch (error) {
    return downResult(Math.round(performance.now() - startedAt), errorMessage(error))
  } finally {
    if (client.isOpen) await client.quit().catch(() => undefined)
    else client.destroy()
  }
}

function downResult(latencyMs: number, reason: string): CheckResult {
  return { status: 'down', latencyMs, responseSnippet: snippet(reason) }
}

/** First 1024 bytes of `text`; `undefined` when there is nothing to capture. */
function snippet(text: string): string | undefined {
  if (text.length === 0) return undefined
  const bytes = Buffer.from(text, 'utf8')
  return bytes.byteLength <= SNIPPET_BYTES
    ? text
    : bytes.subarray(0, SNIPPET_BYTES).toString('utf8')
}

/** Message of an unknown driver error, unwrapping `AggregateError`. */
function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    const messages = Array.from(error.errors, (item) => errorMessage(item))
    return messages.length > 0 ? messages.join('; ') : error.name
  }
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  return String(error)
}
