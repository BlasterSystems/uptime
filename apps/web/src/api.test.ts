import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  NETWORK_ERROR,
  errorMessage,
  fetchMonitors,
  fetchPublicOverview,
  formatRetry,
  setCsrfToken,
  setUnauthorizedHandler,
  updateSettings,
} from './api.js'

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

beforeEach(() => {
  setCsrfToken('csrf-1')
})

afterEach(() => {
  setCsrfToken(null)
  setUnauthorizedHandler(null)
  vi.unstubAllGlobals()
})

describe('request', () => {
  it('injects the CSRF token on mutations and JSON content type for bodies', async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, { ok: true }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await updateSettings({ title: 'x' } as never)

    const [, init] = fetchMock.mock.calls[0]!
    const headers = new Headers(init?.headers)
    expect(headers.get('x-csrf-token')).toBe('csrf-1')
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('omits the CSRF token from GET requests', async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(200, { services: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await fetchPublicOverview()

    const [, init] = fetchMock.mock.calls[0]!
    expect(new Headers(init?.headers).get('x-csrf-token')).toBeNull()
  })

  it('returns null for 204 and non-JSON success responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    expect(await updateSettings({} as never)).toBeNull()

    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))
    expect(await updateSettings({} as never)).toBeNull()
  })

  it('wraps connection failures in a NETWORK_ERROR ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('down') }))
    const error = await fetchPublicOverview().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe(NETWORK_ERROR)
    expect(errorMessage(error, 'fallback')).toBe('Cannot reach the server.')
  })

  it('parses the error body into the ApiError code and calls the 401 handler', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: 'unauthenticated' })),
    )

    const error = await fetchMonitors().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(401)
    expect((error as ApiError).code).toBe('unauthenticated')
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('does not call the 401 handler for allowed-unauthenticated endpoints', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: 'unauthenticated' })),
    )

    await expect(fetchPublicOverview()).rejects.toBeInstanceOf(ApiError)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})

describe('errorMessage', () => {
  it('falls back for non-ApiError values and unknown snake_case codes', () => {
    expect(errorMessage(new Error('boom'), 'fallback')).toBe('fallback')
    expect(errorMessage(new ApiError(500, 'some_snake_code'), 'fallback')).toBe('fallback')
  })

  it('passes server sentences through and maps known codes', () => {
    expect(errorMessage(new ApiError(400, 'retries must be an integer in [0, 100]'), 'fallback')).toBe(
      'retries must be an integer in [0, 100]',
    )
    expect(errorMessage(new ApiError(401, 'csrf'), 'fallback')).toBe(
      'Your session token is no longer valid. Sign in again.',
    )
  })

  it('renders the retry delay for rate limiting', () => {
    expect(errorMessage(new ApiError(429, 'too_many_attempts', 29_000), 'fallback')).toBe(
      'Too many attempts. Try again in 29s.',
    )
    expect(errorMessage(new ApiError(429, 'too_many_attempts', 29_500), 'fallback')).toBe(
      'Too many attempts. Try again in 30s.',
    )
  })
})

describe('formatRetry', () => {
  it('rounds up to seconds and minutes', () => {
    expect(formatRetry(1000)).toBe('1s')
    expect(formatRetry(29_500)).toBe('30s')
    expect(formatRetry(90_000)).toBe('2m')
  })
})
