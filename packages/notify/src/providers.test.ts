import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { parseChannelConfig } from './config.js'
import {
  buildEmailMessage,
  buildResendMessage,
  sendDiscord,
  sendEmail,
  sendGotify,
  sendNtfy,
  sendResend,
  sendSlack,
  sendTelegram,
  sendWebhook,
} from './providers.js'
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

describe('telegram provider', () => {
  it('POSTs the message to {apiBaseUrl}/bot{token}/sendMessage', async () => {
    await withServer(async ({ base, requests }) => {
      const config = parseChannelConfig('telegram', {
        botToken: 'TOK',
        chatId: '42',
        apiBaseUrl: base,
      })
      await sendTelegram(config, payload)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toEqual({
        method: 'POST',
        url: '/botTOK/sendMessage',
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
        body: JSON.stringify({ chat_id: '42', text: 'Example is down\n\nConnection refused' }),
      })
    })
  })
})

describe('discord provider', () => {
  it('POSTs { content } to the webhook path on the apiBaseUrl host', async () => {
    await withServer(async ({ base, requests }) => {
      const config = parseChannelConfig('discord', {
        webhookUrl: 'https://discord.com/api/webhooks/1/abc',
        apiBaseUrl: base,
      })
      await sendDiscord(config, payload)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.method).toBe('POST')
      expect(requests[0]?.url).toBe('/api/webhooks/1/abc')
      expect(JSON.parse(requests[0]!.body)).toEqual({
        content: 'Example is down\n\nConnection refused',
      })
    })
  })
})

describe('slack provider', () => {
  it('POSTs { text } to the webhook path on the apiBaseUrl host', async () => {
    await withServer(async ({ base, requests }) => {
      const config = parseChannelConfig('slack', {
        webhookUrl: 'https://hooks.slack.com/services/T/B/X',
        apiBaseUrl: base,
      })
      await sendSlack(config, payload)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.method).toBe('POST')
      expect(requests[0]?.url).toBe('/services/T/B/X')
      expect(JSON.parse(requests[0]!.body)).toEqual({
        text: 'Example is down\n\nConnection refused',
      })
    })
  })
})

describe('ntfy provider', () => {
  it('POSTs { topic, title, body } to {server}/{topic}', async () => {
    await withServer(async ({ base, requests }) => {
      const config = parseChannelConfig('ntfy', { topic: 'alerts', server: base })
      await sendNtfy(config, payload)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.method).toBe('POST')
      expect(requests[0]?.url).toBe('/alerts')
      expect(requests[0]?.headers.authorization).toBeUndefined()
      expect(JSON.parse(requests[0]!.body)).toEqual({
        topic: 'alerts',
        title: 'Example is down',
        body: 'Connection refused',
      })
    })
  })

  it('sends the bearer token when configured', async () => {
    await withServer(async ({ base, requests }) => {
      const config = parseChannelConfig('ntfy', { topic: 'alerts', server: base, token: 'TK' })
      await sendNtfy(config, payload)
      expect(requests[0]?.headers.authorization).toBe('Bearer TK')
    })
  })
})

describe('gotify provider', () => {
  it('POSTs { title, message, priority } to /message with the token query', async () => {
    await withServer(async ({ base, requests }) => {
      const config = parseChannelConfig('gotify', {
        server: 'https://gotify.example.com',
        token: 'GT',
        apiBaseUrl: base,
      })
      await sendGotify(config, payload)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.method).toBe('POST')
      expect(requests[0]?.url).toBe('/message?token=GT')
      expect(JSON.parse(requests[0]!.body)).toEqual({
        title: 'Example is down',
        message: 'Connection refused',
        priority: 5,
      })
    })
  })
})

describe('webhook provider', () => {
  it('POSTs the default JSON body with custom headers', async () => {
    await withServer(async ({ base, requests }) => {
      const config = parseChannelConfig('webhook', {
        url: `${base}/hook`,
        headers: { 'x-token': 'abc' },
      })
      await sendWebhook(config, payload)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.method).toBe('POST')
      expect(requests[0]?.url).toBe('/hook')
      expect(requests[0]?.headers['x-token']).toBe('abc')
      expect(JSON.parse(requests[0]!.body)).toEqual({
        title: 'Example is down',
        body: 'Connection refused',
        monitor: 'Example',
        status: 'down',
        latencyMs: 42,
        downtimeMs: 252_000,
        tags: ['prod', 'api'],
      })
    })
  })

  it('PUTs the rendered template parsed as JSON', async () => {
    await withServer(async ({ base, requests }) => {
      const config = parseChannelConfig('webhook', {
        url: `${base}/hook`,
        method: 'PUT',
        template:
          '{"text":"{{monitor.name}} {{status}}","latency":"{{latency}}","down":"{{downtime}}","tags":"{{tags}}"}',
      })
      await sendWebhook(config, payload)
      expect(requests[0]?.method).toBe('PUT')
      expect(JSON.parse(requests[0]!.body)).toEqual({
        text: 'Example down',
        latency: '42 ms',
        down: '4m 12s',
        tags: 'prod, api',
      })
    })
  })

  it('rejects a template that does not render valid JSON without sending', async () => {
    await withServer(async ({ base, requests }) => {
      const config = parseChannelConfig('webhook', {
        url: `${base}/hook`,
        template: '{{monitor.name}} is down',
      })
      await expect(sendWebhook(config, payload)).rejects.toThrow(/invalid JSON/)
      expect(requests).toHaveLength(0)
    })
  })

  it('throws with the status and the first 200 characters on non-2xx', async () => {
    await withServer(
      async ({ base }) => {
        const config = parseChannelConfig('webhook', { url: `${base}/hook` })
        const error: unknown = await sendWebhook(config, payload).then(
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

describe('email provider', () => {
  it('sends through nodemailer jsonTransport', async () => {
    const config = parseChannelConfig('email', {
      smtpHost: 'smtp.example.com',
      from: 'uptime@example.com',
      to: 'ops@example.com',
      transport: 'json',
    })
    await expect(sendEmail(config, payload)).resolves.toBeUndefined()
  })

  it('builds the mail options from the payload', () => {
    const config = parseChannelConfig('email', {
      smtpHost: 'smtp.example.com',
      from: 'uptime@example.com',
      to: 'ops@example.com',
    })
    expect(buildEmailMessage(config, payload)).toEqual({
      from: 'uptime@example.com',
      to: 'ops@example.com',
      subject: 'Example is down',
      text: 'Connection refused',
    })
  })
})

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

  it('throws with the status and body snippet on non-2xx', async () => {
    await withServer(
      async ({ base }) => {
        const config = parseChannelConfig('resend', {
          apiKey: 're_123',
          from: 'uptime@example.com',
          to: 'ops@example.com',
          apiBaseUrl: base,
        })
        await expect(sendResend(config, payload)).rejects.toThrow(
          /resend responded with 422: validation failed/,
        )
      },
      { status: 422, responseBody: 'validation failed' },
    )
  })
})
