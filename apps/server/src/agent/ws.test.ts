import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { WebSocket } from 'ws'
import { Database } from '@uptime/db'
import { attachAgentWsHub, AGENT_WS_PATH, type AgentWsHub } from './ws.js'

const TOKEN = 'agent-shared-token'

interface Harness {
  hub: AgentWsHub
  server: Server
  port: number
  processPulse: ReturnType<typeof vi.fn>
}

interface Connection {
  ws: WebSocket
  /** Resolves with the first message — subscribed from construction, so the assignment push cannot race it. */
  firstMessage: Promise<unknown>
  nextMessage(): Promise<unknown>
}

const active: Harness[] = []

/**
 * Promise.withResolvers is ES2024; the repo compiles with lib ES2023, so tests
 * use this equivalent helper. (Bump `tsconfig.base.json` lib and drop this.)
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function listen(server: Server): Promise<number> {
  const { promise, resolve } = deferred<void>()
  server.listen(0, '127.0.0.1', () => resolve())
  return promise.then(() => {
    const address = server.address()
    return typeof address === 'object' && address !== null ? address.port : 0
  })
}

async function startHub(token = TOKEN): Promise<Harness & { url: string }> {
  const server = createServer()
  const processPulse = vi.fn()
  const hub = attachAgentWsHub(server, {
    token,
    assigned: () => [
      {
        id: 7,
        type: 'tcp',
        name: 'db',
        intervalS: 60,
        retries: 1,
        retryIntervalS: 30,
        config: { host: 'db.internal', port: 5432 },
      },
    ],
    processPulse,
  })
  const port = await listen(server)
  const harness: Harness = { hub, server, port, processPulse }
  active.push(harness)
  return { ...harness, url: `ws://127.0.0.1:${port}${AGENT_WS_PATH}` }
}

function connect(url: string, token: string): Promise<Connection> {
  const ws = new WebSocket(url, { headers: { 'x-agent-token': token } })
  const opened = deferred<void>()
  const firstMessage = deferred<unknown>()
  ws.on('open', () => opened.resolve())
  ws.on('error', (error) => opened.reject(error))
  ws.on('message', (raw) => firstMessage.resolve(JSON.parse(String(raw))))
  return opened.promise.then(() => ({
    ws,
    firstMessage: firstMessage.promise,
    nextMessage: () => {
      const { promise, resolve, reject } = deferred<unknown>()
      ws.once('message', (raw) => {
        try {
          resolve(JSON.parse(String(raw)))
        } catch (error) {
          reject(error)
        }
      })
      return promise
    },
  }))
}

afterEach(() => {
  for (const harness of active.splice(0)) {
    harness.hub.close()
    harness.server.close()
  }
})

describe('agent WS hub', () => {
  it('pushes the assignment snapshot on connect', async () => {
    const { url } = await startHub()
    const connection = await connect(url, TOKEN)

    await expect(connection.firstMessage).resolves.toMatchObject({
      type: 'assigned',
      agentId: 'default',
      monitors: [{ id: 7, type: 'tcp', name: 'db' }],
    })
    connection.ws.close()
  })

  it('answers hello with a fresh assignment and acks processed pulse seqs', async () => {
    const { url, processPulse } = await startHub()
    const connection = await connect(url, TOKEN)
    await expect(connection.firstMessage).resolves.toMatchObject({ type: 'assigned' })

    // Create the reply promise before triggering the message that answers it.
    const helloReply = connection.nextMessage()
    connection.ws.send(JSON.stringify({ type: 'hello' }))
    await expect(helloReply).resolves.toMatchObject({ type: 'assigned' })

    const ackReply = connection.nextMessage()
    const time = new Date('2026-10-10T10:00:00.000Z')
    connection.ws.send(
      JSON.stringify({
        type: 'pulse',
        results: [
          { seq: 1, id: 7, status: 'up', latencyMs: 9, time: time.toISOString() },
          { seq: 2, id: 7, status: 'nope', latencyMs: 1, time: time.toISOString() },
        ],
      }),
    )

    await expect(ackReply).resolves.toEqual({ type: 'ack', seqs: [1, 2] })
    // Valid result processed; invalid one dropped (acked so it is not resent).
    expect(processPulse).toHaveBeenCalledTimes(1)
    expect(processPulse).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, status: 'up', latencyMs: 9 }),
    )
    connection.ws.close()
  })

  it('rejects a wrong token at upgrade time', async () => {
    const { url } = await startHub()
    await expect(connect(url, 'wrong-token')).rejects.toMatchObject({
      message: expect.stringContaining('401'),
    })
  })

  it('ignores upgrade attempts on foreign paths', async () => {
    const server = createServer()
    const processPulse = vi.fn()
    const hub = attachAgentWsHub(server, { token: TOKEN, assigned: () => [], processPulse })
    const port = await listen(server)
    active.push({ hub, server, port, processPulse })
    await expect(connect(`ws://127.0.0.1:${port}/api/v1/other`, TOKEN)).rejects.toBeTruthy()
  })

  it('end-to-end: pulses persist via the integrator over the live link', async () => {
    const server = createServer()
    const db = Database.open({ file: ':memory:' })
    const row = db.createMonitor({
      type: 'tcp',
      name: 'db',
      intervalS: 60,
      retries: 1,
      retryIntervalS: 30,
      config: { host: 'db.internal', port: 5432 },
    })
    const processPulse = vi.fn()
    const hub = attachAgentWsHub(server, {
      token: TOKEN,
      assigned: () => [],
      processPulse: (result) => {
        db.insertHeartbeat({
          monitorId: result.id,
          status: result.status,
          latencyMs: result.latencyMs,
          responseSnippet: result.responseSnippet,
          time: result.time,
        })
      },
    })
    const port = await listen(server)
    active.push({ hub, server, port, processPulse })

    const connection = await connect(`ws://127.0.0.1:${port}${AGENT_WS_PATH}`, TOKEN)
    await expect(connection.firstMessage).resolves.toMatchObject({ type: 'assigned' })
    const ackReply = connection.nextMessage()
    connection.ws.send(
      JSON.stringify({
        type: 'pulse',
        results: [
          { seq: 1, id: row.id, status: 'up', latencyMs: 4, time: '2026-10-10T10:00:00.000Z' },
        ],
      }),
    )
    await expect(ackReply).resolves.toEqual({ type: 'ack', seqs: [1] })
    expect(db.listHeartbeats(row.id)).toHaveLength(1)
    connection.ws.close()
    db.close()
  })
})
