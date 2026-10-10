import { getCertExpiryDays } from './cert.js'
import type { CheckResult, HttpMonitorConfig } from './types.js'

/** Results carry at most the first 1024 bytes of the body / failure reason (SPEC §4). */
const SNIPPET_BYTES = 1024

/** Injectable seams for {@link runHttpCheck}, used by tests. */
export interface RunHttpCheckOptions {
  /** TLS certificate probe override; defaults to {@link getCertExpiryDays}. */
  certProbe?: typeof getCertExpiryDays
}

/**
 * Run one HTTP probe. Never rejects: transport failures (DNS, TLS, timeout,
 * caller abort) and unmet expectations all resolve to `status: 'down'` with the
 * reason recorded in `responseSnippet`.
 *
 * With `certExpiryDays` configured, an https URL additionally fails when the
 * TLS certificate expires in fewer days than the threshold; an unreadable
 * certificate (`certProbe` resolving `null`) never fails the check on its own.
 */
export async function runHttpCheck(
  config: HttpMonitorConfig,
  signal?: AbortSignal,
  opts?: RunHttpCheckOptions,
): Promise<CheckResult> {
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs)
  const combined = AbortSignal.any(signal === undefined ? [timeoutSignal] : [timeoutSignal, signal])
  const startedAt = performance.now()

  let response: Response
  try {
    response = await fetch(config.url, {
      method: config.method,
      headers: config.headers,
      // fetch rejects a body on GET/HEAD, so a configured body is dropped there.
      body: config.method === 'GET' || config.method === 'HEAD' ? undefined : config.body,
      signal: combined,
    })
  } catch (error) {
    return downResult(
      Math.round(performance.now() - startedAt),
      describeFailure(error, timeoutSignal, signal, config.timeoutMs),
    )
  }

  let body: string
  try {
    // The combined signal covers the body read too, so a stalled body is a timeout.
    body = await response.text()
  } catch (error) {
    return downResult(
      Math.round(performance.now() - startedAt),
      describeFailure(error, timeoutSignal, signal, config.timeoutMs),
    )
  }

  const latencyMs = Math.round(performance.now() - startedAt)
  const details = extractJsonPaths(body, config.jsonPaths, response.ok)
  const acceptedStatus = config.acceptedStatus
  if (acceptedStatus !== 'any') {
    const [min, max] = acceptedStatus
    if (response.status < min || response.status > max) {
      return downResult(
        latencyMs,
        `status ${response.status} not accepted (expected ${min}-${max})`,
        details,
      )
    }
  }

  const keyword = config.keyword
  if (keyword !== undefined) {
    const found = body.includes(keyword.value)
    if (keyword.inverse === true ? found : !found) {
      return downResult(
        latencyMs,
        keyword.inverse === true
          ? `keyword "${keyword.value}" found (inverse)`
          : `keyword "${keyword.value}" not found`,
        details,
      )
    }
  }

  const maxResponseMs = config.maxResponseMs
  if (maxResponseMs !== undefined && latencyMs > maxResponseMs) {
    return downResult(latencyMs, `latency ${latencyMs}ms exceeded cap ${maxResponseMs}ms`, details)
  }

  const certExpiryDays = config.certExpiryDays
  const httpsUrl = URL.canParse(config.url) && new URL(config.url).protocol === 'https:'
  if (certExpiryDays !== undefined && httpsUrl) {
    const certProbe = opts?.certProbe ?? getCertExpiryDays
    const days = await certProbe(config.url, config.timeoutMs)
    // An unreadable certificate is not a failure; only a known imminent expiry is.
    if (days !== null && days < certExpiryDays) {
      return downResult(
        latencyMs,
        `certificate expires in ${days} days (min ${certExpiryDays})`,
        details,
      )
    }
  }

  const result: CheckResult = { status: 'up', latencyMs, responseSnippet: snippet(body) }
  if (details !== undefined) result.details = details
  return result
}

function downResult(
  latencyMs: number,
  reason: string,
  details?: CheckResult['details'],
): CheckResult {
  const result: CheckResult = { status: 'down', latencyMs, responseSnippet: snippet(reason) }
  if (details !== undefined) result.details = details
  return result
}

/** First 1024 bytes of `text`; `undefined` when there is nothing to capture. */
function snippet(text: string): string | undefined {
  if (text.length === 0) return undefined
  const bytes = Buffer.from(text, 'utf8')
  return bytes.byteLength <= SNIPPET_BYTES
    ? text
    : bytes.subarray(0, SNIPPET_BYTES).toString('utf8')
}

/**
 * Extract the configured `jsonPaths` metrics from a successful response body
 * (SPEC §3 `jsonPaths`). Only 2xx responses whose body parses as JSON are
 * inspected; a parse failure, a path that cannot be resolved or a `null` leaf
 * skips just that metric — extraction never fails the check. Numbers, strings
 * and booleans pass through untouched; structured values (objects, arrays) are
 * JSON-stringified. Returns `undefined` when nothing was extracted so
 * `details` stays absent from the result.
 */
function extractJsonPaths(
  body: string,
  jsonPaths: Record<string, string> | undefined,
  ok: boolean,
): Record<string, number | string | boolean> | undefined {
  if (!ok || jsonPaths === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  const details: Record<string, number | string | boolean> = {}
  for (const [name, path] of Object.entries(jsonPaths)) {
    const value = resolveJsonPath(parsed, path)
    if (value === undefined || value === null) continue
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      details[name] = value
    } else {
      details[name] = JSON.stringify(value)
    }
  }
  return Object.keys(details).length > 0 ? details : undefined
}

/** One path segment: a key plus optional `[n]` index steps (`items[0][1]`). */
const JSON_PATH_SEGMENT = /^([^[\]]+)((?:\[\d+\])*)$/

/** Walk a `a.b[0].c` path; `undefined` for anything the path cannot address. */
function resolveJsonPath(root: unknown, path: string): unknown {
  let current: unknown = root
  for (const segment of path.split('.')) {
    // Config validation guarantees the shape; a malformed segment resolves to nothing.
    const match = JSON_PATH_SEGMENT.exec(segment)
    const key = match?.[1]
    const indices = match?.[2]
    if (key === undefined || indices === undefined) return undefined
    current = step(current, key)
    if (current === undefined) return undefined
    for (const index of indices.matchAll(/\[(\d+)\]/g)) {
      const position = index[1]
      if (position === undefined) return undefined
      current = step(current, position)
      if (current === undefined) return undefined
    }
  }
  return current
}

/** One lookup: array element by numeric index, otherwise an object property. */
function step(current: unknown, key: string): unknown {
  if (Array.isArray(current)) {
    const index = Number(key)
    return Number.isInteger(index) && index >= 0 && index < current.length
      ? current[index]
      : undefined
  }
  if (typeof current === 'object' && current !== null) {
    return (current as Record<string, unknown>)[key]
  }
  return undefined
}

/**
 * Turn a transport failure into a diagnostic reason for `responseSnippet`;
 * shared with the non-HTTP probes in `checks.ts`.
 */
export function describeFailure(
  error: unknown,
  timeoutSignal: AbortSignal,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): string {
  if (signal?.aborted === true) return 'check aborted'
  if (timeoutSignal.aborted) return `timeout after ${timeoutMs}ms`
  if (error instanceof AggregateError) {
    const messages = Array.from(error.errors, (item) =>
      item instanceof Error ? item.message : String(item),
    )
    return messages.length > 0 ? messages.join('; ') : error.message
  }
  if (error instanceof Error) {
    const cause = error.cause
    if (cause instanceof Error && cause.message !== '' && cause.message !== error.message) {
      return `${error.message}: ${cause.message}`
    }
    return error.message === '' ? error.name : error.message
  }
  return String(error)
}
