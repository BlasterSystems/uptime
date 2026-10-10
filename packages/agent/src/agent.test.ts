import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import type { CheckResult } from '@uptime/core'
import {
  UptimeAgent,
  type AgentWs,
  type AssignedMonitor,
  type UptimeAgentOptions,
} from './agent.js'
import type { AgentConfig } from './config.js'
import { agentConfigFromEnv } from './cli.js'

const TOKEN = 'test-agent-token'
const UP: CheckResult = { status: 'up', latencyMs: 7 }
const DOWN: CheckResult = { status: 'down', latencyMs: 3, responseSnippet: 'boom' }

const pulseResultSchema = z.object({
  seq: z.number().optional(),
  id: z.number(),
  status: z.enum(['up', 'down']),
  latencyMs: z.number(),
  responseSnippet: z.string().optional(),
  time: z.string(),
})
const pulseMessageSchema = z.object({
  type: z.literal('pulse'),
  results: z.array(pulseResultSchema),
})
const pulseBodySchema = z.object({ results: z.array(pulseResultSchema) })
type ParsedPulseResult = z.infer<typeof pulseResultSchema>

/** vi.fn cannot express fetch's overloads; the single-signature stub is compatible at runtime. */
function asFetch(impl: (input: unknown, init?: RequestInit) => Promise<Response>): typeof fetch {
  return impl as unknown as typeof fetch
}

/** Parse a pulse request body at the test boundary (raw string or request init). */
function parsePulseBody(raw: unknown): ParsedPulseResult[] {
  return pulseBodySchema.parse(JSON.parse(String(raw))).results
}

function tokenOf(init?: RequestInit): string | null {
  return new Headers(init?.headers).get('x-agent-token')
}

function testConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    serverUrl: 'http://127.0.0.1:1',
    token: TOKEN,
    pollIntervalS: 30,
    pulseFlushMs: 100,
    maxQueue: 5,
    ...overrides,
  }
}

function assignment(overrides: Partial<AssignedMonitor> = {}): AssignedMonitor {
  return {
    id: 1,
    type: 'http',
    name: 'web',
    intervalS: 60,
    retries: 2,
    retryIntervalS: 5,
    config: { method: 'GET', url: 'http://example.test/', timeoutMs: 1000, acceptedStatus: 'any' },
    ...overrides,
  }
}

/** In-memory WebSocket stand-in: tests drive open/message/close by hand. */
class FakeWs implements AgentWs {
  readonly sent: string[] = []
  closed = false
  private readonly handlers = new Map<string, Array<(arg: unknown) => void>>()

  constructor(
    readonly url: string,
    readonly opts: { headers: Record<string, string> },
  ) {}

  send(data: string): void {
    if (this.closed) throw new Error('socket is closed')
    this.sent.push(data)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close', undefined)
  }

  on(event: string, listener: (arg: unknown) => void): void {
    const list = this.handlers.get(event) ?? []
    list.push(listener)
    this.handlers.set(event, list)
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of [...(this.handlers.get(event) ?? [])]) listener(arg)
  }

  messages(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)
  }
}

function makeWsTracker(): { sockets: FakeWs[]; wsImpl: NonNullable<UptimeAgentOptions['wsImpl']> } {
  const sockets: FakeWs[] = []
  return {
    sockets,
    wsImpl: (url, opts) => {
      const socket = new FakeWs(url, opts)
      sockets.push(socket)
      return socket
    },
  }
}

const created: UptimeAgent[] = []

function startAgent(options: UptimeAgentOptions): UptimeAgent {
  const agent = new UptimeAgent(options)
  created.push(agent)
  agent.start()
  return agent
}

afterEach(() => {
  for (const agent of created) agent.stop()
  created.length = 0
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('websocket link', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  it('sends hello, schedules assignments, pulses with a seq and clears on ack', async () => {
    const { sockets, wsImpl } = makeWsTracker()
    const check = vi.fn(async () => UP)
    const fetchImpl = vi.fn(async () => {
      throw new Error('HTTP must not be used while the link is up')
    })
    startAgent({
      config: testConfig(),
      check,
      fetchImpl: asFetch(fetchImpl),
      wsImpl,
      log: () => {},
    })

    expect(sockets).toHaveLength(1)
    expect(sockets[0]?.url).toBe('http://127.0.0.1:1/api/v1/agent')
    expect(sockets[0]?.opts).toEqual({ headers: { 'x-agent-token': TOKEN } })

    sockets[0]?.emit('open')
    expect(sockets[0]?.messages()).toEqual([{ type: 'hello' }])

    sockets[0]?.emit('message', JSON.stringify({ type: 'assigned', monitors: [assignment()] }))
    await vi.advanceTimersByTimeAsync(1)
    expect(check).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(99) // reach pulseFlushMs
    const pulse = pulseMessageSchema.parse(sockets[0]?.messages()[1])
    expect(pulse.results[0]).toMatchObject({ seq: 1, id: 1, status: 'up', latencyMs: 7 })
    expect(Number.isNaN(Date.parse(pulse.results[0]?.time ?? ''))).toBe(false)

    // Ack removes the queued pulse; nothing is re-sent and HTTP stays untouched.
    sockets[0]?.emit('message', JSON.stringify({ type: 'ack', seqs: [1] }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(sockets[0]?.messages()).toHaveLength(2)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('falls back to HTTP when a pulse ack times out', async () => {
    const { sockets, wsImpl } = makeWsTracker()
    const check = vi.fn(async () => UP)
    const pulseBodies: ParsedPulseResult[][] = []
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/api/v1/agent/pulse')) {
        const results = parsePulseBody(init?.body)
        pulseBodies.push(results)
        return Response.json({ acked: results.map((result) => result.id) })
      }
      return Response.json({ agentId: 'default', monitors: [] })
    })
    startAgent({
      config: testConfig(),
      check,
      fetchImpl: asFetch(fetchImpl),
      wsImpl,
      log: () => {},
    })

    sockets[0]?.emit('open')
    sockets[0]?.emit('message', JSON.stringify({ type: 'assigned', monitors: [assignment()] }))
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(99)
    expect(sockets[0]?.messages()).toHaveLength(2) // hello + pulse, unacked

    await vi.advanceTimersByTimeAsync(10_000) // ack timer fires
    expect(sockets[0]?.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(100) // next flush goes over HTTP
    expect(pulseBodies).toHaveLength(1)
    expect(pulseBodies[0]?.[0]).toMatchObject({ id: 1, status: 'up', latencyMs: 7 })
  })
})

describe('http fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  function stubFetch(initialFailures: number, monitors: AssignedMonitor[] = [assignment()]) {
    let failures = initialFailures
    const assignedTokens: Array<string | null> = []
    const pulseRequests: Array<{ token: string | null; results: ParsedPulseResult[] }> = []
    const impl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/agent/assigned')) {
        assignedTokens.push(tokenOf(init))
        return Response.json({ agentId: 'default', monitors })
      }
      const results = parsePulseBody(init?.body)
      pulseRequests.push({ token: tokenOf(init), results })
      if (failures > 0) {
        failures -= 1
        return new Response('boom', { status: 500 })
      }
      return Response.json({ acked: results.map((result) => result.id) })
    })
    return {
      impl,
      assignedTokens,
      pulseRequests,
      setFailures: (n: number) => {
        failures = n
      },
    }
  }

  it('polls assignments, retries failed pulses and drops acked ids', async () => {
    const stub = stubFetch(2)
    const check = vi.fn(async () => UP)
    startAgent({
      config: testConfig({ pollIntervalS: 1, pulseFlushMs: 20 }),
      check,
      fetchImpl: asFetch(stub.impl),
      wsImpl: () => {
        throw new Error('connection refused')
      },
      log: () => {},
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(check).toHaveBeenCalledTimes(1)
    // Two 500s, then the same queued pulse delivered once the endpoint recovers.
    expect(stub.pulseRequests).toHaveLength(3)
    expect(stub.pulseRequests[0]?.results[0]).toMatchObject({ id: 1, status: 'up', latencyMs: 7 })
    expect(stub.pulseRequests[2]?.results[0]).toMatchObject({ id: 1, status: 'up', latencyMs: 7 })
    expect(stub.assignedTokens).toHaveLength(1)
    expect(stub.pulseRequests[0]?.token).toBe(TOKEN)
    expect(stub.assignedTokens[0]).toBe(TOKEN)

    const settled = stub.pulseRequests.length
    await vi.advanceTimersByTimeAsync(1000) // next assignment poll
    expect(stub.pulseRequests).toHaveLength(settled) // acked → no resends
    expect(stub.assignedTokens.length).toBeGreaterThanOrEqual(2)
    expect(check).toHaveBeenCalledTimes(1) // identical polls don't re-probe
  })

  it('probes immediately, on the interval grid and at retry spacing', async () => {
    const stub = stubFetch(0)
    const results: CheckResult[] = [UP, DOWN, UP]
    const check = vi.fn(async () => results.shift() ?? UP)
    startAgent({
      config: testConfig({ pulseFlushMs: 50 }),
      check,
      fetchImpl: asFetch(stub.impl),
      wsImpl: () => {
        throw new Error('connection refused')
      },
      log: () => {},
    })

    await vi.advanceTimersByTimeAsync(1)
    expect(check).toHaveBeenCalledTimes(1) // immediate
    await vi.advanceTimersByTimeAsync(60_100)
    expect(check).toHaveBeenCalledTimes(2) // interval grid (60s)
    await vi.advanceTimersByTimeAsync(5_100)
    expect(check).toHaveBeenCalledTimes(3) // retry spacing after the failure (5s)
    await vi.advanceTimersByTimeAsync(60_100)
    expect(check).toHaveBeenCalledTimes(4) // back on the grid after recovery
    expect(stub.pulseRequests.length).toBeGreaterThanOrEqual(4)
    expect(stub.pulseRequests[0]?.results[0]).toMatchObject({ status: 'up', latencyMs: 7 })
  })

  it('caps the queue at maxQueue, dropping the oldest pulses', async () => {
    const stub = stubFetch(Number.POSITIVE_INFINITY, [assignment({ intervalS: 1 })])
    const logs: string[] = []
    const check = vi.fn(async () => UP)
    startAgent({
      config: testConfig({ pollIntervalS: 1, pulseFlushMs: 5, maxQueue: 2 }),
      check,
      fetchImpl: asFetch(stub.impl),
      wsImpl: () => {
        throw new Error('connection refused')
      },
      log: (message) => logs.push(message),
    })

    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(logs.some((line) => line.includes('pulse queue full'))).toBe(true)
    expect(logs.some((line) => line.includes('dropped oldest pulse'))).toBe(true)

    stub.setFailures(0)
    await vi.advanceTimersByTimeAsync(10)
    const delivered = stub.pulseRequests.at(-1)
    expect(delivered?.results).toHaveLength(2) // exactly the cap survives the outage
  })

  it('reconnects with jittered exponential backoff', async () => {
    const { sockets, wsImpl: connect } = makeWsTracker()
    const callTimes: number[] = []
    const wsImpl: NonNullable<UptimeAgentOptions['wsImpl']> = (url, opts) => {
      callTimes.push(Date.now())
      if (callTimes.length <= 3) throw new Error('connection refused')
      return connect(url, opts)
    }
    const fetchMock = vi.fn(async () => Response.json({ agentId: 'default', monitors: [] }))
    startAgent({
      config: testConfig(),
      check: vi.fn(async () => UP),
      fetchImpl: asFetch(fetchMock),
      wsImpl,
      log: () => {},
    })

    expect(callTimes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(750) // 1s base × jitter(0.5)
    expect(callTimes).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1500) // 2s base × jitter
    expect(callTimes).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(3000) // 4s base × jitter
    expect(callTimes).toHaveLength(4)
    expect((callTimes[3] ?? 0) - (callTimes[0] ?? 0)).toBe(750 + 1500 + 3000)

    expect(sockets).toHaveLength(1)
    sockets[0]?.emit('open')
    expect(sockets[0]?.messages()).toEqual([{ type: 'hello' }])
    expect(fetchMock).toHaveBeenCalled() // polling ran while the link was down
  })
})

// Real HTTP round trips cannot be driven by vitest fake timers (undici uses real socket
// I/O), so this integration test runs on the platform clock and awaits request arrivals
// instead of sleeping.
describe('http fallback against a live server', () => {
  let server: Server
  let baseUrl = ''
  let agent: UptimeAgent | undefined
  let failPulses = 0

  const assignedRequests: Array<{ url: string; token: string | undefined }> = []
  const pulseRequests: Array<{ token: string | undefined; results: ParsedPulseResult[] }> = []
  const arrivals: Array<() => void> = []

  function signalArrival(): void {
    for (const resolve of arrivals.splice(0)) resolve()
  }

  async function awaitCount(kind: 'assigned' | 'pulses', count: number): Promise<void> {
    const requests: unknown[] = kind === 'assigned' ? assignedRequests : pulseRequests
    while (requests.length < count) {
      const { promise, resolve } = Promise.withResolvers<void>()
      arrivals.push(resolve)
      await promise
    }
  }

  beforeEach(async () => {
    assignedRequests.length = 0
    pulseRequests.length = 0
    arrivals.length = 0
    failPulses = 0
    server = createServer((req, res) => {
      void (async () => {
        const rawToken = req.headers['x-agent-token']
        const token = typeof rawToken === 'string' ? rawToken : undefined
        if (req.method === 'GET' && req.url === '/api/v1/agent/assigned') {
          assignedRequests.push({ url: req.url, token })
          signalArrival()
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ agentId: 'default', monitors: [assignment()] }))
          return
        }
        if (req.method === 'POST' && req.url === '/api/v1/agent/pulse') {
          const raw = await new Promise<string>((resolve, reject) => {
            let data = ''
            req.on('data', (chunk: Buffer) => (data += chunk.toString()))
            req.on('end', () => resolve(data))
            req.on('error', reject)
          })
          const results = parsePulseBody(raw)
          pulseRequests.push({ token, results })
          signalArrival()
          if (failPulses > 0) {
            failPulses -= 1
            res.statusCode = 500
            res.end('boom')
            return
          }
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ acked: results.map((result) => result.id) }))
          return
        }
        res.statusCode = 404
        res.end()
      })().catch(() => {
        res.statusCode = 500
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    agent?.stop()
    agent = undefined
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('fetches assignments, retries failed pulses and drains the queue once acked', async () => {
    failPulses = 2
    const check = vi.fn(async () => UP)
    agent = startAgent({
      config: testConfig({
        serverUrl: baseUrl,
        pollIntervalS: 1,
        pulseFlushMs: 20,
        maxQueue: 10,
      }),
      check,
      wsImpl: () => {
        throw new Error('refused')
      },
      log: () => {},
    })

    await awaitCount('pulses', 3)
    expect(assignedRequests.length).toBeGreaterThanOrEqual(1)
    expect(assignedRequests[0]?.token).toBe(TOKEN)
    expect(assignedRequests[0]?.url).toBe('/api/v1/agent/assigned')

    const delivered = pulseRequests[2]
    expect(delivered?.token).toBe(TOKEN)
    expect(delivered?.results).toHaveLength(1)
    expect(delivered?.results[0]).toMatchObject({ id: 1, status: 'up', latencyMs: 7 })
    expect(Number.isNaN(Date.parse(delivered?.results[0]?.time ?? ''))).toBe(false)
    expect(check).toHaveBeenCalledTimes(1)

    // Drain check: had the ack not removed the queued pulse, the 20 ms flush loop would
    // have re-POSTed it many times before the next 1 s assignment poll arrives.
    const assignedSeen = assignedRequests.length
    await awaitCount('assigned', assignedSeen + 1)
    expect(pulseRequests).toHaveLength(3)
  })
})

describe('agentConfigFromEnv', () => {
  it('maps UPTIME_* variables and applies defaults', () => {
    const base = { UPTIME_SERVER_URL: 'http://uptime.test:3001', UPTIME_AGENT_TOKEN: TOKEN }
    expect(agentConfigFromEnv(base)).toEqual({
      serverUrl: 'http://uptime.test:3001',
      token: TOKEN,
      pollIntervalS: 30,
      pulseFlushMs: 2000,
      maxQueue: 5000,
    })
    expect(agentConfigFromEnv({ ...base, UPTIME_AGENT_POLL_S: '45' }).pollIntervalS).toBe(45)
    expect(agentConfigFromEnv({ ...base, UPTIME_AGENT_POLL_S: '' }).pollIntervalS).toBe(30)
  })

  it('rejects a missing token or server URL', () => {
    expect(() => agentConfigFromEnv({ UPTIME_SERVER_URL: 'http://uptime.test:3001' })).toThrow()
    expect(() => agentConfigFromEnv({ UPTIME_AGENT_TOKEN: TOKEN })).toThrow()
  })
})
