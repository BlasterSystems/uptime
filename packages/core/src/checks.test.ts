import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { runCheck } from './checks.js'
import type { MonitorType } from './types.js'

// These are integration tests against real sockets and processes; fake timers
// cannot drive the drivers, so short real timeouts keep the suite fast.

const servers: Array<Server | NetServer> = []
const sockets: Socket[] = []
const tempDirs: string[] = []

/** HTTP server on an ephemeral loopback port; returns the port. */
async function listenHttp(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<number> {
  const server = createHttpServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind an ephemeral TCP port')
  }
  return address.port
}

/** TCP server on an ephemeral loopback port; returns the port. */
async function listenNet(handler: (socket: Socket) => void): Promise<number> {
  const server = createNetServer((socket) => {
    sockets.push(socket)
    handler(socket)
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind an ephemeral TCP port')
  }
  return address.port
}

/** Bind an ephemeral port, then release it: connections to it are refused. */
async function closedPort(): Promise<number> {
  const server = createNetServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind an ephemeral TCP port')
  }
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('runCheck dispatch', () => {
  it('runs the http probe after parsing the config', async () => {
    const port = await listenHttp((_req, res) => {
      res.writeHead(200)
      res.end('healthy')
    })
    const result = await runCheck('http', { url: `http://127.0.0.1:${port}/healthz` })
    expect(result.status).toBe('up')
    expect(result.responseSnippet).toBe('healthy')
  })

  it('rejects push monitors', async () => {
    await expect(runCheck('push', { graceSeconds: 60 })).rejects.toThrowError(
      /push monitors are not probed/,
    )
  })

  it('rejects unsupported monitor types', async () => {
    await expect(runCheck('group' as unknown as MonitorType, {})).rejects.toThrowError(
      /unsupported monitor type/,
    )
  })

  it('rejects invalid configs with a ZodError', async () => {
    await expect(runCheck('tcp', { host: 'db.internal' })).rejects.toThrowError(ZodError)
  })
})

describe('runCheck tcp', () => {
  it('reports up once the connection is established', async () => {
    const port = await listenNet(() => undefined)
    const result = await runCheck('tcp', { host: '127.0.0.1', port, timeoutMs: 2000 })
    expect(result.status).toBe('up')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.responseSnippet).toBeUndefined()
  })

  it('writes the payload and matches the response', async () => {
    const port = await listenNet((socket) => {
      socket.on('data', (chunk) => socket.write(`pong:${chunk.toString()}`))
    })
    const result = await runCheck('tcp', {
      host: '127.0.0.1',
      port,
      timeoutMs: 2000,
      payload: 'PING',
      expectResponse: 'pong:PING',
    })
    expect(result.status).toBe('up')
    expect(result.responseSnippet).toBe('pong:PING')
  })

  it('reports down when the response does not match', async () => {
    const port = await listenNet((socket) => {
      socket.on('data', () => socket.write('pong'))
    })
    const result = await runCheck('tcp', {
      host: '127.0.0.1',
      port,
      timeoutMs: 2000,
      payload: 'PING',
      expectResponse: 'welcome',
    })
    expect(result.status).toBe('down')
    expect(result.responseSnippet).toContain('expected "welcome"')
    expect(result.responseSnippet).toContain('pong')
  })

  it('checks a greeting without sending a payload', async () => {
    const port = await listenNet((socket) => socket.write('220 ready\r\n'))
    const result = await runCheck('tcp', {
      host: '127.0.0.1',
      port,
      timeoutMs: 2000,
      expectResponse: 'ready',
    })
    expect(result.status).toBe('up')
    expect(result.responseSnippet).toBe('220 ready\r\n')
  })

  it('reports down when the connection is refused', async () => {
    const port = await closedPort()
    const result = await runCheck('tcp', { host: '127.0.0.1', port, timeoutMs: 1000 })
    expect(result.status).toBe('down')
    expect(result.responseSnippet).toMatch(/ECONNREFUSED/)
  })

  it('times out when the peer never responds', async () => {
    const port = await listenNet(() => undefined)
    const startedAt = Date.now()
    const result = await runCheck('tcp', {
      host: '127.0.0.1',
      port,
      timeoutMs: 250,
      payload: 'PING',
      expectResponse: 'PONG',
    })
    expect(result.status).toBe('down')
    expect(result.responseSnippet).toBe('timeout after 250ms')
    expect(Date.now() - startedAt).toBeLessThan(3000)
  })
})

describe('runCheck dns', () => {
  it('reports down when the configured resolver does not answer', async () => {
    const startedAt = Date.now()
    const result = await runCheck('dns', {
      host: 'example.com',
      recordType: 'A',
      resolver: '127.0.0.1:1',
      timeoutMs: 1000,
    })
    expect(result.status).toBe('down')
    expect(result.responseSnippet).toBeTruthy()
    expect(Date.now() - startedAt).toBeLessThan(4000)
  })
})

describe('runCheck icmp', () => {
  it('reports down with a capability or timeout reason in a sandbox', async () => {
    const startedAt = Date.now()
    // 192.0.2.0/24 is TEST-NET-1: echo requests are never answered.
    const result = await runCheck('icmp', {
      host: '192.0.2.1',
      timeoutMs: 300,
      packetCount: 1,
    })
    expect(result.status).toBe('down')
    expect(result.responseSnippet).toMatch(/timeout after 300ms|NET_RAW|ping binary not found/i)
    expect(Date.now() - startedAt).toBeLessThan(4000)
  })
})

describe('runCheck database probes', () => {
  // 127.0.0.1:1 is refused immediately; success paths need live servers.
  const failing: Array<[MonitorType, string]> = [
    ['postgres', 'postgres://user:pass@127.0.0.1:1/db'],
    ['mysql', 'mysql://user:pass@127.0.0.1:1/db'],
    [
      'mssql',
      'Server=127.0.0.1,1;Database=uptime;User Id=sa;Password=Passw0rd!;Encrypt=false;TrustServerCertificate=true',
    ],
    ['mongodb', 'mongodb://127.0.0.1:1/db'],
    ['redis', 'redis://127.0.0.1:1'],
  ]

  it.each(failing)(
    '%s reports down without hanging',
    async (type, connectionString) => {
      const startedAt = Date.now()
      const result = await runCheck(type, { connectionString, timeoutMs: 1000 })
      expect(result.status).toBe('down')
      expect(result.responseSnippet).toBeTruthy()
      expect(Date.now() - startedAt).toBeLessThan(5000)
    },
    15_000,
  )
})

describe('runCheck docker', () => {
  it('reports up when the container state matches', async () => {
    const requests: string[] = []
    const port = await listenHttp((req, res) => {
      requests.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ State: { Status: 'running' } }))
    })
    const result = await runCheck('docker', {
      hostUri: `tcp://127.0.0.1:${port}`,
      containerNameOrId: 'web',
      timeoutMs: 2000,
    })
    expect(result.status).toBe('up')
    expect(result.responseSnippet).toBe('state running')
    expect(result.details).toEqual({ state: 'running' })
    expect(requests).toEqual(['/containers/web/json'])
  })

  it('reports down when the state does not match', async () => {
    const port = await listenHttp((_req, res) => {
      res.writeHead(200)
      res.end(JSON.stringify({ State: { Status: 'exited' } }))
    })
    const result = await runCheck('docker', {
      hostUri: `tcp://127.0.0.1:${port}`,
      containerNameOrId: 'web',
      timeoutMs: 2000,
    })
    expect(result.status).toBe('down')
    expect(result.responseSnippet).toBe('container state "exited" != expected "running"')
  })

  it('reports down when the container is missing', async () => {
    const port = await listenHttp((_req, res) => {
      res.writeHead(404)
      res.end('no such container')
    })
    const result = await runCheck('docker', {
      hostUri: `tcp://127.0.0.1:${port}`,
      containerNameOrId: 'web',
      timeoutMs: 2000,
    })
    expect(result.status).toBe('down')
    expect(result.responseSnippet).toBe('container not found')
  })

  it('percent-encodes the container name in the inspect path', async () => {
    const requests: string[] = []
    const port = await listenHttp((req, res) => {
      requests.push(req.url ?? '')
      res.writeHead(200)
      res.end(JSON.stringify({ State: { Status: 'running' } }))
    })
    const result = await runCheck('docker', {
      hostUri: `tcp://127.0.0.1:${port}`,
      containerNameOrId: 'web api',
      timeoutMs: 2000,
    })
    expect(result.status).toBe('up')
    expect(requests).toEqual(['/containers/web%20api/json'])
  })

  it('reports down for an invalid docker payload', async () => {
    const port = await listenHttp((_req, res) => {
      res.writeHead(200)
      res.end('not json')
    })
    const result = await runCheck('docker', {
      hostUri: `tcp://127.0.0.1:${port}`,
      containerNameOrId: 'web',
      timeoutMs: 2000,
    })
    expect(result.status).toBe('down')
    expect(result.responseSnippet).toMatch(/invalid docker response/)
  })

  it('reports down when the docker host is unreachable', async () => {
    const port = await closedPort()
    const result = await runCheck('docker', {
      hostUri: `tcp://127.0.0.1:${port}`,
      containerNameOrId: 'web',
      timeoutMs: 1000,
    })
    expect(result.status).toBe('down')
    expect(result.responseSnippet).toMatch(/ECONNREFUSED/)
  })

  it('inspects over a unix socket when the platform allows it', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'uptime-docker-'))
    tempDirs.push(dir)
    const socketPath = join(dir, 'docker.sock')
    // macOS caps `sun_path` at ~104 bytes.
    if (socketPath.length > 100) return
    const server = createHttpServer((_req, res) => {
      res.writeHead(200)
      res.end(JSON.stringify({ State: { Status: 'paused' } }))
    })
    servers.push(server)
    server.listen(socketPath)
    await once(server, 'listening')

    const result = await runCheck('docker', {
      hostUri: `unix://${socketPath}`,
      containerNameOrId: 'db',
      expectedState: 'paused',
      timeoutMs: 2000,
    })
    expect(result.status).toBe('up')
    expect(result.details).toEqual({ state: 'paused' })
  })
})
