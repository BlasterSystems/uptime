#!/usr/bin/env node
/**
 * kuma-import — convert an Uptime-Kuma SQLite export into the JSON body of
 * `POST /api/v1/import/kuma` (SPEC §9, M6). Zero-dependency by convention:
 * only node builtins, SQLite via the built-in `node:sqlite` module
 * (Node ≥ 22.5; the repo targets Node 24).
 *
 * Usage:
 *   node scripts/kuma-import.mjs <kuma.db> [--out body.json] [--kuma-version 1.23.16]
 *                                 [--limit-per-monitor 2000]
 *
 *   # then POST it (admin API key):
 *   curl -s -X POST https://uptime.example.com/api/v1/import/kuma \
 *     -H 'Authorization: Bearer uk_…' -H 'Content-Type: application/json' \
 *     --data-binary @body.json
 *
 * Mapping (Kuma → uptime-monitoring):
 *   http   → http (url, method, timeoutMs, acceptedStatus, keyword)
 *   port   → tcp (host, port, timeoutMs)
 *   ping   → icmp (host, timeoutMs)
 *   dns    → dns (host, resolver, recordType, timeoutMs)
 *   push   → push (schedule only — the ping token is regenerated; repoint jobs)
 *   docker → skipped (docker monitors were cut from uptime-monitoring, ADR-0008)
 *   mysql / postgres / mssql / mongodb / redis → same-named engines
 *            (connectionString from database_connection_string)
 *
 * Behaviour:
 *   - Paused Kuma monitors are skipped (importing them would start probing
 *     something the operator had paused); unknown and incomplete types are
 *     skipped too — the summary on stderr reports the counts.
 *   - Heartbeat status 1→up, 0→down; pending/maintenance beats are skipped.
 *   - The server validates and de-duplicates: monitors match by type+name,
 *     heartbeats by monitor name + time, so re-running the import is a no-op.
 *   - Exit codes: 0 success, 2 usage/read errors.
 */
import { parseArgs } from 'node:util'
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const HELP = `kuma-import — convert an Uptime-Kuma SQLite export into the
POST /api/v1/import/kuma body.

Usage:
  node scripts/kuma-import.mjs <kuma.db> [options]

Options:
  --out <file>              Write the JSON body to a file instead of stdout.
  --kuma-version <version>  Optional kumaVersion string to embed in the body.
  --limit-per-monitor <n>   Newest heartbeats kept per monitor (default 2000).
  --help                    Show this text.`

function fail(message) {
  console.error(`kuma-import: ${message}`)
  process.exit(2)
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    'kuma-version': { type: 'string' },
    'limit-per-monitor': { type: 'string', default: '2000' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help || positionals.length !== 1) {
  console.log(HELP)
  process.exit(values.help ? 0 : 2)
}

const limitPerMonitor = Number.parseInt(values['limit-per-monitor'], 10)
if (!Number.isInteger(limitPerMonitor) || limitPerMonitor < 1) {
  fail('--limit-per-monitor must be a positive integer')
}

let kuma
try {
  kuma = new DatabaseSync(positionals[0], { readOnly: true })
} catch (error) {
  fail(`cannot open ${positionals[0]}: ${error instanceof Error ? error.message : error}`)
}

/** Kuma heartbeat status codes: 0 down, 1 up (2 pending, 3 maintenance are skipped). */
const KUMA_STATUS = { 0: 'down', 1: 'up' }

/** Kuma stores time as TEXT (`2024-06-01 12:34:56.789`, UTC). */
function toEpochMs(raw) {
  if (typeof raw !== 'string') return null
  const iso = raw.replace(' ', 'T')
  const withZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`
  const time = Date.parse(withZone)
  return Number.isNaN(time) ? null : time
}

function toPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

/** Kuma accepted_statuscodes: TEXT JSON array of `"lo-hi"` strings. */
function toAcceptedStatus(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  let list
  try {
    list = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!Array.isArray(list) || list.length === 0) return undefined
  if (list.length === 1 && list[0] === '200-299') return undefined // core default
  const ranges = []
  for (const entry of list) {
    const match = /^(\d{3})-(\d{3})$/.exec(String(entry))
    if (match !== null) ranges.push([Number(match[1]), Number(match[2])])
  }
  if (ranges.length === 0) return undefined
  return ranges.length === 1 ? ranges[0] : ranges
}

/** Kuma puts the host in `hostname`, or inside `url` for http-like probes. */
function hostOf(row) {
  if (typeof row.hostname === 'string' && row.hostname.trim() !== '') return row.hostname.trim()
  if (typeof row.url === 'string' && row.url.trim() !== '') {
    try {
      return new URL(row.url).hostname
    } catch {
      return null
    }
  }
  return null
}

function timeoutMsOf(row) {
  const seconds = Number(row.timeout)
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined
}

/**
 * Returns `{ type, config }` for a supported type, `'unsupported'` for types
 * with no mapping, or `'incomplete'` when required fields are missing.
 */
function convertMonitor(row) {
  const timeoutMs = timeoutMsOf(row)
  const config = {}
  switch (row.type) {
    case 'http': {
      if (typeof row.url !== 'string' || row.url.trim() === '') return 'incomplete'
      config.url = row.url.trim()
      if (typeof row.method === 'string' && row.method.trim() !== '' && row.method !== 'GET') {
        config.method = row.method.trim()
      }
      if (timeoutMs !== undefined) config.timeoutMs = timeoutMs
      const accepted = toAcceptedStatus(row.accepted_statuscodes)
      if (accepted !== undefined) config.acceptedStatus = accepted
      if (typeof row.keyword === 'string' && row.keyword.trim() !== '') {
        config.keyword = { value: row.keyword, inverse: Number(row.invert_keyword) === 1 }
      }
      return { type: 'http', config }
    }
    case 'port': {
      const host = hostOf(row)
      const port = toPort(row.port)
      if (host === null || port === null) return 'incomplete'
      config.host = host
      config.port = port
      if (timeoutMs !== undefined) config.timeoutMs = timeoutMs
      return { type: 'tcp', config }
    }
    case 'ping': {
      const host = hostOf(row)
      if (host === null) return 'incomplete'
      config.host = host
      if (timeoutMs !== undefined) config.timeoutMs = timeoutMs
      return { type: 'icmp', config }
    }
    case 'dns': {
      const host = hostOf(row)
      if (host === null) return 'incomplete'
      config.host = host
      if (typeof row.dns_resolve_server === 'string' && row.dns_resolve_server.trim() !== '') {
        config.resolver = row.dns_resolve_server.trim()
      }
      if (typeof row.dns_resolve_type === 'string' && row.dns_resolve_type.trim() !== '') {
        config.recordType = row.dns_resolve_type.trim()
      }
      if (timeoutMs !== undefined) config.timeoutMs = timeoutMs
      return { type: 'dns', config }
    }
    case 'push':
      // The Kuma ping token cannot be reused (different URL scheme); the
      // server generates a fresh pushUrl. Schedule fields still carry over.
      return { type: 'push', config }
    case 'docker':
      // Docker monitors were cut from uptime-monitoring (ADR-0008); the server
      // would reject the config, so skip them like any other unmapped type.
      return 'unsupported'
    case 'mysql':
    case 'postgres':
    case 'mssql':
    case 'mongodb':
    case 'redis': {
      if (
        typeof row.database_connection_string !== 'string' ||
        row.database_connection_string.trim() === ''
      ) {
        return 'incomplete'
      }
      config.connectionString = row.database_connection_string.trim()
      if (timeoutMs !== undefined) config.timeoutMs = timeoutMs
      return { type: row.type, config }
    }
    default:
      return 'unsupported'
  }
}

function scheduleFields(row) {
  const fields = {}
  const intervalS = Number(row.interval)
  if (Number.isFinite(intervalS) && intervalS >= 20) fields.intervalS = intervalS
  const retries = Number(row.maxretries)
  if (Number.isInteger(retries) && retries >= 0) fields.retries = retries
  const retryIntervalS = Number(row.retry_interval)
  if (Number.isFinite(retryIntervalS) && retryIntervalS > 0) fields.retryIntervalS = retryIntervalS
  return fields
}

let monitorRows
try {
  monitorRows = kuma.prepare('SELECT * FROM monitor ORDER BY id').all()
} catch (error) {
  fail(
    `cannot read the monitor table — is this a Kuma database? (${
      error instanceof Error ? error.message : error
    })`,
  )
}

const monitors = []
const skipped = { paused: 0, unsupported: 0, incomplete: 0 }
const importedIds = new Set()
for (const row of monitorRows) {
  if (Number(row.active) !== 1) {
    skipped.paused += 1
    continue
  }
  const converted = convertMonitor(row)
  if (typeof converted === 'string') {
    skipped[converted] += 1
    continue
  }
  importedIds.add(Number(row.id))
  monitors.push({
    type: converted.type,
    name: String(row.name ?? '').trim(),
    ...scheduleFields(row),
    config: converted.config,
  })
}

const heartbeats = []
if (importedIds.size > 0) {
  const placeholders = [...importedIds].map(() => '?').join(', ')
  const rows = kuma
    .prepare(
      `SELECT monitor_id, status, time, ping FROM heartbeat
       WHERE monitor_id IN (${placeholders})
       ORDER BY monitor_id, time DESC`,
    )
    .all(...importedIds)
  const nameById = new Map(
    kuma
      .prepare(`SELECT id, name FROM monitor WHERE id IN (${placeholders})`)
      .all(...importedIds)
      .map((row) => [row.id, String(row.name ?? '').trim()]),
  )
  const perMonitor = new Map()
  for (const row of rows) {
    const status = KUMA_STATUS[row.status]
    if (status === undefined) continue // pending / maintenance
    const time = toEpochMs(row.time)
    const name = nameById.get(row.monitor_id)
    if (time === null || name === undefined || name === '') continue
    const seen = perMonitor.get(row.monitor_id) ?? 0
    if (seen >= limitPerMonitor) continue
    perMonitor.set(row.monitor_id, seen + 1)
    const ping = Number(row.ping)
    heartbeats.push({
      monitorSlug: name,
      status,
      latencyMs: status === 'down' ? (ping > 0 ? Math.round(ping) : null) : ping > 0 ? Math.round(ping) : null,
      time,
    })
  }
}

const body = {}
if (values['kuma-version'] !== undefined) body.kumaVersion = values['kuma-version']
body.monitors = monitors
body.heartbeats = heartbeats

const json = `${JSON.stringify(body, null, 2)}\n`
if (values.out !== undefined) {
  writeFileSync(values.out, json)
} else {
  process.stdout.write(json)
}
console.error(
  `kuma-import: ${monitors.length} monitor(s), ${heartbeats.length} heartbeat(s)` +
    ` — skipped: ${skipped.paused} paused, ${skipped.unsupported} unsupported, ${skipped.incomplete} incomplete`,
)
