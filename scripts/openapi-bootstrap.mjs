#!/usr/bin/env node
/**
 * openapi-bootstrap — create one uptime-monitoring `http` monitor per GET path
 * of an OpenAPI 3 document (SPEC §9).
 *
 * Plain .mjs on purpose: executed by Node directly (`node scripts/openapi-bootstrap.mjs`,
 * wired as `pnpm openapi-bootstrap`) with zero dependencies — only node builtins
 * (`node:util`, `node:fs`) and the global `fetch`.
 *
 * Usage:
 *   node scripts/openapi-bootstrap.mjs --server <uptime-url> --file openapi.json [options]
 *
 * Options:
 *   --server <url>        Base URL of the uptime-monitoring instance; monitors are
 *                         POSTed to `<url>/api/v1/monitors` (admin API, Bearer key).
 *                         Probe URLs come from the document's first `servers[].url`
 *                         (resolved against <url> when relative); documents without
 *                         `servers[]` fall back to <url> itself.
 *   --file <path>         OpenAPI 3 document in JSON (default: openapi.json).
 *                         YAML is not supported — converting would need a parser
 *                         dependency. Convert first, e.g.:
 *                           yq -o=json openapi.yaml > openapi.json
 *   --api-key <key>       Admin API key (scope admin). Falls back to the
 *                         UPTIME_ADMIN_API_KEY, then ADMIN_API_KEY environment variable.
 *   --header 'Name: val'  Header attached to every created monitor (e.g. an auth
 *                         header for protected paths). Repeat the flag for more.
 *   --tag-prefix <text>   Tag prefix, default `openapi:`; the tag is
 *                         `<prefix><info.title>`.
 *   --include-authed      Also create monitors for operations that declare
 *                         `security`; without this they are skipped.
 *   --dry-run             Print what would be created instead of POSTing.
 *   --help                Show this text.
 *
 * Behaviour:
 *   - Only GET operations with at least one 2xx response are considered.
 *   - Parameterised paths (`/users/{id}`) are skipped: a probe cannot fill
 *     placeholders; the summary reports how many paths were skipped and why.
 *   - A failing creation does not stop the run; the exit code is 1 when any
 *     POST fails (2 for usage errors).
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const HELP = `openapi-bootstrap — create one uptime-monitoring http monitor per GET path of an
OpenAPI 3 JSON document (SPEC §9).

Usage:
  node scripts/openapi-bootstrap.mjs --server <uptime-url> --file openapi.json [options]

Options:
  --server <url>        Uptime-monitoring base URL (admin API at <url>/api/v1/monitors).
  --file <path>         OpenAPI 3 JSON document (default: openapi.json; YAML must be
                        converted to JSON first, e.g. yq -o=json openapi.yaml > openapi.json).
  --api-key <key>       Admin API key; defaults to UPTIME_ADMIN_API_KEY or ADMIN_API_KEY.
  --header 'Name: val'  Header added to every created monitor (repeatable).
  --tag-prefix <text>   Tag prefix for <prefix><info.title> (default: openapi:).
  --include-authed      Also create monitors for operations with "security".
  --dry-run             Print the monitors instead of creating them.
  --help                Show this text.`

function fail(message) {
  console.error(`openapi-bootstrap: ${message}`)
  process.exit(2)
}

/** Turns `--header 'Name: value'` pairs into an object; exits on malformed input. */
function parseHeaderList(values) {
  const headers = {}
  for (const raw of values ?? []) {
    const colon = raw.indexOf(':')
    if (colon <= 0) fail(`--header must be 'Name: value', got: ${raw}`)
    const name = raw.slice(0, colon).trim()
    const value = raw.slice(colon + 1).trim()
    if (name.length === 0) fail(`--header has an empty name: ${raw}`)
    headers[name] = value
  }
  return headers
}

/** Normalizes a base URL (no trailing slash); `null` when not a valid URL. */
function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  try {
    const url = new URL(raw.trim())
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

/** Probe base: the document's first `servers[].url`, falling back to the uptime server. */
function resolveProbeBase(doc, server) {
  const candidate = Array.isArray(doc.servers) ? doc.servers[0]?.url : undefined
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    try {
      return new URL(candidate, `${server}/`).toString().replace(/\/+$/, '')
    } catch {
      return server
    }
  }
  return server
}

/** An operation is protected when its own `security` (or the document's) is non-empty. */
function requiresAuth(operation, doc) {
  const security = Array.isArray(operation.security) ? operation.security : doc.security
  return Array.isArray(security) && security.length > 0
}

function hasSuccessResponse(operation) {
  const responses = operation.responses
  if (typeof responses !== 'object' || responses === null) return false
  return Object.keys(responses).some((status) => /^2/.test(status))
}

let parsed
try {
  parsed = parseArgs({
    options: {
      server: { type: 'string' },
      file: { type: 'string', default: 'openapi.json' },
      'api-key': { type: 'string' },
      header: { type: 'string', multiple: true },
      'tag-prefix': { type: 'string', default: 'openapi:' },
      'include-authed': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
} catch (error) {
  fail(`${error.message} (see --help)`)
}
const values = parsed.values

if (values.help) {
  console.log(HELP)
  process.exit(0)
}

const server = normalizeBaseUrl(values.server)
if (server === null) fail('--server must be a valid URL, e.g. http://localhost:3001')
const dryRun = values['dry-run']
const apiKey = values['api-key'] ?? process.env.UPTIME_ADMIN_API_KEY ?? process.env.ADMIN_API_KEY
if (!dryRun && (typeof apiKey !== 'string' || apiKey.length === 0)) {
  fail('an admin API key is required: pass --api-key or set UPTIME_ADMIN_API_KEY')
}

let doc
try {
  doc = JSON.parse(readFileSync(values.file, 'utf8'))
} catch (error) {
  fail(`cannot read ${values.file}: ${error.message} (YAML input must be converted to JSON first)`)
}
if (doc === null || typeof doc !== 'object') fail(`${values.file} is not a JSON object`)
if (doc.swagger !== undefined) {
  fail('Swagger 2.0 documents are not supported; provide an OpenAPI 3 document')
}
if (typeof doc.paths !== 'object' || doc.paths === null)
  fail(`${values.file} has no "paths" object`)
if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3')) {
  console.warn('openapi-bootstrap: document does not declare OpenAPI 3; continuing best-effort')
}

const title =
  typeof doc.info?.title === 'string' && doc.info.title.trim().length > 0
    ? doc.info.title.trim()
    : 'untitled'
const tag = `${values['tag-prefix']}${title}`.slice(0, 100)
const headers = parseHeaderList(values.header)
const probeBase = resolveProbeBase(doc, server)

const planned = []
const skipped = { templated: [], authed: [], noSuccess: [], reference: [] }
for (const [path, item] of Object.entries(doc.paths)) {
  if (item === null || typeof item !== 'object') continue
  if (item.$ref !== undefined) {
    skipped.reference.push(path)
    continue
  }
  const operation = item.get
  if (operation === null || typeof operation !== 'object') continue
  if (path.includes('{')) {
    skipped.templated.push(path)
    continue
  }
  if (!hasSuccessResponse(operation)) {
    skipped.noSuccess.push(path)
    continue
  }
  if (!values['include-authed'] && requiresAuth(operation, doc)) {
    skipped.authed.push(path)
    continue
  }
  const config = {
    method: 'GET',
    url: `${probeBase}${path.startsWith('/') ? '' : '/'}${path}`,
    timeoutMs: 10_000,
    acceptedStatus: [200, 299],
  }
  if (Object.keys(headers).length > 0) config.headers = { ...headers }
  planned.push({ type: 'http', name: `${title} GET ${path}`.slice(0, 200), config, tags: [tag] })
}

function printSummary(createdCount, failedCount) {
  console.log('')
  console.log(`openapi-bootstrap: ${title}`)
  console.log(`  server:     ${server}`)
  console.log(`  probe base: ${probeBase}`)
  console.log(
    `  ${dryRun ? 'planned' : 'created'}:    ${createdCount}/${planned.length}` +
      (dryRun ? '' : ` (failed: ${failedCount})`),
  )
  console.log(
    `  skipped:    ${skipped.authed.length} requiring auth, ${skipped.templated.length} parameterised, ` +
      `${skipped.noSuccess.length} without a 2xx response, ${skipped.reference.length} $ref`,
  )
}

if (dryRun) {
  for (const monitor of planned) {
    const headerNames = Object.keys(monitor.config.headers ?? {})
    console.log(`GET ${monitor.config.url}`)
    console.log(`  name:    ${monitor.name}`)
    console.log(`  tags:    ${monitor.tags.join(', ')}`)
    console.log(`  headers: ${headerNames.length === 0 ? '(none)' : headerNames.join(', ')}`)
  }
  printSummary(planned.length, 0)
  process.exit(0)
}

let createdCount = 0
let failedCount = 0
for (const monitor of planned) {
  try {
    const response = await fetch(`${server}/api/v1/monitors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(monitor),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new Error(`${response.status} ${payload?.error ?? response.statusText}`)
    createdCount += 1
    console.log(`created monitor ${payload?.monitor?.id ?? '?'}: ${monitor.name}`)
  } catch (error) {
    failedCount += 1
    console.error(`failed ${monitor.config.url}: ${error.message}`)
  }
}
printSummary(createdCount, failedCount)
process.exit(failedCount > 0 ? 1 : 0)
