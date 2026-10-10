import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { parseMonitorConfig } from './config.js'
import { runHttpCheck } from './http.js'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

// These are integration tests against a real socket: the delays below exist to make the
// server genuinely slow relative to `AbortSignal.timeout` / `maxResponseMs`. Fake timers
// cannot drive undici's real network stack, so the platform clock is required here.
const servers: Server[] = []

/** Start an HTTP server on an ephemeral port and return its base URL. */
async function listen(handler: Handler): Promise<string> {
  const server = createServer((req, res) => {
    // Client aborts (timeout / caller-abort tests) must not crash the fixture.
    req.on('error', () => {})
    res.on('error', () => {})
    handler(req, res)
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind an ephemeral TCP port')
  }
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    }),
  )
})

describe('runHttpCheck', () => {
  it('reports up for an accepted status and captures the body', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello uptime')
    })

    const result = await runHttpCheck(parseMonitorConfig('http', { url, timeoutMs: 2000 }))

    expect(result.status).toBe('up')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.responseSnippet).toBe('hello uptime')
  })

  it('reports down for a status outside the accepted range', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(500)
      res.end('boom')
    })

    const result = await runHttpCheck(parseMonitorConfig('http', { url, timeoutMs: 2000 }))

    expect(result.status).toBe('down')
    expect(result.responseSnippet).toBe('status 500 not accepted (expected 200-299)')
  })

  it('honours a custom accepted range', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(404)
      res.end('not found')
    })

    const result = await runHttpCheck(
      parseMonitorConfig('http', { url, timeoutMs: 2000, acceptedStatus: [400, 499] }),
    )

    expect(result.status).toBe('up')
  })

  it('accepts any status when acceptedStatus is "any"', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(503)
      res.end('unavailable')
    })

    const result = await runHttpCheck(
      parseMonitorConfig('http', { url, timeoutMs: 2000, acceptedStatus: 'any' }),
    )

    expect(result.status).toBe('up')
  })

  it('sends the configured body for POST but never for GET', async () => {
    const url = await listen((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => res.end(`${req.method}:${Buffer.concat(chunks).toString('utf8')}`))
    })

    const post = await runHttpCheck(
      parseMonitorConfig('http', {
        url,
        timeoutMs: 2000,
        method: 'POST',
        body: 'ping',
        keyword: { value: 'POST:ping' },
      }),
    )
    expect(post.status).toBe('up')

    const get = await runHttpCheck(
      parseMonitorConfig('http', { url, timeoutMs: 2000, method: 'GET', body: 'ping' }),
    )
    expect(get.status).toBe('up')
    expect(get.responseSnippet).toBe('GET:')
  })

  it('fails when the keyword is missing and passes when it is present', async () => {
    const url = await listen((_req, res) => res.end('service is healthy'))

    const present = await runHttpCheck(
      parseMonitorConfig('http', { url, timeoutMs: 2000, keyword: { value: 'healthy' } }),
    )
    expect(present.status).toBe('up')

    const missing = await runHttpCheck(
      parseMonitorConfig('http', { url, timeoutMs: 2000, keyword: { value: 'degraded' } }),
    )
    expect(missing.status).toBe('down')
    expect(missing.responseSnippet).toBe('keyword "degraded" not found')
  })

  it('inverts the keyword expectation', async () => {
    const url = await listen((_req, res) => res.end('service is degraded'))

    const absent = await runHttpCheck(
      parseMonitorConfig('http', {
        url,
        timeoutMs: 2000,
        keyword: { value: 'healthy', inverse: true },
      }),
    )
    expect(absent.status).toBe('up')

    const present = await runHttpCheck(
      parseMonitorConfig('http', {
        url,
        timeoutMs: 2000,
        keyword: { value: 'degraded', inverse: true },
      }),
    )
    expect(present.status).toBe('down')
    expect(present.responseSnippet).toBe('keyword "degraded" found (inverse)')
  })

  it('cannot match a keyword on a HEAD response with no body', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('body here')
    })

    const result = await runHttpCheck(
      parseMonitorConfig('http', {
        url,
        timeoutMs: 2000,
        method: 'HEAD',
        keyword: { value: 'body' },
      }),
    )

    expect(result.status).toBe('down')
    expect(result.responseSnippet).toBe('keyword "body" not found')
  })

  it('reports down when the response exceeds maxResponseMs', async () => {
    const url = await listen((_req, res) => {
      setTimeout(() => res.end('slow'), 150)
    })

    const result = await runHttpCheck(
      parseMonitorConfig('http', { url, timeoutMs: 5000, maxResponseMs: 50 }),
    )

    expect(result.status).toBe('down')
    expect(result.responseSnippet).toMatch(/^latency \d+ms exceeded cap 50ms$/)
  })

  it('stays up when the response is within maxResponseMs', async () => {
    const url = await listen((_req, res) => res.end('quick'))

    const result = await runHttpCheck(
      parseMonitorConfig('http', { url, timeoutMs: 2000, maxResponseMs: 2000 }),
    )

    expect(result.status).toBe('up')
  })

  it('reports down when the request times out', async () => {
    const url = await listen((_req, res) => {
      setTimeout(() => res.end('late'), 400)
    })

    const result = await runHttpCheck(parseMonitorConfig('http', { url, timeoutMs: 100 }))

    expect(result.status).toBe('down')
    expect(result.responseSnippet).toBe('timeout after 100ms')
  })

  it('reports down when the caller aborts', async () => {
    const url = await listen((_req, res) => {
      setTimeout(() => res.end('late'), 400)
    })
    const controller = new AbortController()

    const pending = runHttpCheck(
      parseMonitorConfig('http', { url, timeoutMs: 5000 }),
      controller.signal,
    )
    controller.abort()

    const result = await pending
    expect(result.status).toBe('down')
    expect(result.responseSnippet).toBe('check aborted')
  })

  it('reports down when the connection fails', async () => {
    // Reserve an ephemeral port, then close it so connecting is refused.
    const server = createServer()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('server did not bind an ephemeral TCP port')
    }
    const url = `http://127.0.0.1:${address.port}/`
    server.close()
    await once(server, 'close')

    const result = await runHttpCheck(parseMonitorConfig('http', { url, timeoutMs: 2000 }))

    expect(result.status).toBe('down')
    expect(result.responseSnippet).toContain('ECONNREFUSED')
  })

  it('truncates the snippet to the first 1024 bytes', async () => {
    const body = 'é'.repeat(2000) // 4000 UTF-8 bytes
    const url = await listen((_req, res) => res.end(body))

    const result = await runHttpCheck(parseMonitorConfig('http', { url, timeoutMs: 2000 }))

    expect(result.status).toBe('up')
    expect(Buffer.byteLength(result.responseSnippet ?? '', 'utf8')).toBe(1024)
    expect(result.responseSnippet).toHaveLength(512)
  })
})
