import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { parseChannelConfig } from './config.js'
import { buildResendMessage, sendResend } from './providers.js'
import type { NotifyPayload } from './types.js'

const payload: NotifyPayload = {
  title: 'Example is down',
  body: 'Connection refused',
  monitorName: 'Example',
  status: 'down',
  latencyMs: 42,
  downtimeMs: 252_000,
  tags: ['prod', 'api'],
}

interface CapturedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

interface TestServer {
  base: string
  requests: CapturedRequest[]
  close: () => Promise<void>
}

async function startServer(status = 200, responseBody = 'ok'): Promise<TestServer> {
  const requests: CapturedRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.statusCode = status
      res.end(responseBody)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      const closed = once(server, 'close')
      server.close()
      server.closeAllConnections()
      await closed
    },
  }
}

async function withServer(
  run: (server: TestServer) => Promise<void>,
  options: { status?: number; responseBody?: string } = {},
): Promise<void> {
  const server = await startServer(options.status, options.responseBody)
  try {
    await run(server)
  } finally {
    await server.close()
  }
}

describe('resend provider', () => {
  it('POSTs the message to {apiBaseUrl}/emails with a bearer token', async () => {
    await withServer(async ({ base, requests }) => {
      const config = parseChannelConfig('resend', {
        apiKey: 're_123',
        from: 'uptime@example.com',
        to: 'ops@example.com',
        apiBaseUrl: base,
      })
      await sendResend(config, payload)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.method).toBe('POST')
      expect(requests[0]?.url).toBe('/emails')
      expect(requests[0]?.headers.authorization).toBe('Bearer re_123')
      expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
        from: 'uptime@example.com',
        to: ['ops@example.com'],
        subject: 'Example is down',
        text: 'Connection refused',
      })
    })
  })

  it('builds the request body from the payload', () => {
    const config = parseChannelConfig('resend', {
      apiKey: 're_123',
      from: 'uptime@example.com',
      to: 'ops@example.com',
    })
    expect(buildResendMessage(config, payload)).toEqual({
      from: 'uptime@example.com',
      to: ['ops@example.com'],
      subject: 'Example is down',
      text: 'Connection refused',
    })
  })

  it('throws with the status and the first 200 characters on non-2xx', async () => {
    await withServer(
      async ({ base }) => {
        const config = parseChannelConfig('resend', {
          apiKey: 're_123',
          from: 'uptime@example.com',
          to: 'ops@example.com',
          apiBaseUrl: base,
        })
        const error: unknown = await sendResend(config, payload).then(
          () => null,
          (caught: unknown) => caught,
        )
        expect(error).toBeInstanceOf(Error)
        const message = (error as Error).message
        expect(message).toContain('500')
        expect(message).toContain('x'.repeat(200))
        expect(message).not.toContain('x'.repeat(201))
      },
      { status: 500, responseBody: 'x'.repeat(300) },
    )
  })
})
