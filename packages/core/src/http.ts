import type { CheckResult, HttpMonitorConfig } from './types.js'

/** Results carry at most the first 1024 bytes of the body / failure reason (SPEC §4). */
const SNIPPET_BYTES = 1024

/**
 * Run one HTTP probe. Never rejects: transport failures (DNS, TLS, timeout,
 * caller abort) and unmet expectations all resolve to `status: 'down'` with the
 * reason recorded in `responseSnippet`.
 */
export async function runHttpCheck(
  config: HttpMonitorConfig,
  signal?: AbortSignal,
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
  const acceptedStatus = config.acceptedStatus
  if (acceptedStatus !== 'any') {
    const [min, max] = acceptedStatus
    if (response.status < min || response.status > max) {
      return downResult(
        latencyMs,
        `status ${response.status} not accepted (expected ${min}-${max})`,
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
      )
    }
  }

  const maxResponseMs = config.maxResponseMs
  if (maxResponseMs !== undefined && latencyMs > maxResponseMs) {
    return downResult(latencyMs, `latency ${latencyMs}ms exceeded cap ${maxResponseMs}ms`)
  }

  return { status: 'up', latencyMs, responseSnippet: snippet(body) }
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

/** Turn a transport failure into a diagnostic reason for `responseSnippet`. */
function describeFailure(
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
