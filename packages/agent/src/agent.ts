import { parseMonitorConfig, Scheduler } from '@uptime/core'
import type { CheckResult, MonitorType, ScheduledMonitor } from '@uptime/core'
import WebSocket from 'ws'
import { z } from 'zod'
import type { AgentConfig } from './config.js'

/**
 * Monitor assignment pushed by the server over the WS link, or fetched over HTTP
 * (`GET /api/v1/agent/assigned`) while the link is down.
 */
export interface AssignedMonitor {
  id: number
  type: MonitorType
  name: string
  intervalS: number
  retries: number
  retryIntervalS: number
  config: unknown
}

/** One probe result as sent to the server; the ISO `time` is when the check ran. */
export interface PulseResult {
  id: number
  status: 'up' | 'down'
  latencyMs: number
  responseSnippet?: string
  time: string
}

type QueuedPulse = { seq: number; result: PulseResult }

/** Minimal WebSocket surface the agent needs; tests substitute a fake implementation. */
export interface AgentWs {
  send(data: string): void
  close(): void
  on(event: 'open' | 'message' | 'close' | 'error', listener: (arg: unknown) => void): void
}

export type WsFactory = (url: string, opts: { headers: Record<string, string> }) => AgentWs

export interface UptimeAgentOptions {
  config: AgentConfig
  /** The shared check engine; `(m) => runCheck(m.type, m.config)` in production. */
  check: (monitor: AssignedMonitor) => Promise<CheckResult>
  fetchImpl?: typeof fetch
  wsImpl?: WsFactory
  log?: (message: string) => void
}

const WS_CONNECT_TIMEOUT_MS = 10_000
const WS_ACK_TIMEOUT_MS = 10_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const HTTP_TIMEOUT_MS = 10_000

const assignedMonitorSchema = z.object({
  id: z.int().positive(),
  type: z.string().min(1),
  name: z.string(),
  intervalS: z.number().positive(),
  retries: z.int().nonnegative(),
  retryIntervalS: z.number().positive(),
  config: z.record(z.string(), z.unknown()),
})

// Wire schemas: a malformed envelope is logged and ignored (the previous schedule and
// queue stay intact); per-monitor validation happens in `applyAssigned`.
const wsMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('assigned'), monitors: z.array(z.unknown()) }),
  z.object({ type: z.literal('ack'), seqs: z.array(z.unknown()) }),
])
const assignedResponseSchema = z.object({ monitors: z.array(z.unknown()) })
const pulseResponseSchema = z.object({
  acked: z.array(z.unknown()),
  // Older/partial hubs may omit the rejection list entirely.
  rejected: z.array(z.unknown()).default([]),
})

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** ws hands messages over as string, Buffer or ArrayBuffer depending on the transport. */
function messageText(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return new TextDecoder().decode(data)
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data))
  return String(data)
}

function defaultWsFactory(url: string, opts: { headers: Record<string, string> }): AgentWs {
  const socket = new WebSocket(url, { headers: opts.headers })
  return {
    send: (data) => socket.send(data),
    close: () => {
      try {
        socket.close()
      } catch {
        // Closing an already-closed socket throws; stopping must never fail.
      }
    },
    on: (event, listener) => {
      switch (event) {
        case 'open':
          socket.on('open', () => listener(undefined))
          break
        case 'message':
          socket.on('message', (data) => listener(data))
          break
        case 'close':
          socket.on('close', () => listener(undefined))
          break
        case 'error':
          socket.on('error', (error) => listener(error))
          break
      }
    },
  }
}

/**
 * Remote vantage point (ADR-0003, M5): connects out to the server, receives assigned
 * monitors, runs them with the shared check engine and pulses results back.
 *
 * - WS link (PulseMonitor-style): `hello` on open, server pushes `assigned`, pulses are
 *   sent with a monotonic `seq` and removed once the server `ack`s them.
 * - While the link is down the agent polls `GET /api/v1/agent/assigned` every
 *   `pollIntervalS` and flushes pulses over `POST /api/v1/agent/pulse`, removing the
 *   ids the server acks. Unacked pulses stay queued in memory (oldest dropped past
 *   `maxQueue`) and reconnect uses exponential backoff with jitter.
 * - No callback ever throws into the run loop; failures are logged and retried.
 */
export class UptimeAgent {
  private readonly config: AgentConfig
  private readonly check: (monitor: AssignedMonitor) => Promise<CheckResult>
  private readonly fetchImpl: typeof fetch
  private readonly wsImpl: WsFactory
  private readonly log: (message: string) => void
  private readonly scheduler: Scheduler

  private queue: QueuedPulse[] = []
  /** WS pulses sent but not yet acked; cleared when the link drops (HTTP resends them). */
  private readonly pendingSeqs = new Set<number>()
  private seq = 0
  private flushing = false
  private started = false
  private stopped = false

  private ws: AgentWs | null = null
  private wsOpen = false
  private wsConnectTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private flushTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private ackTimer: NodeJS.Timeout | null = null

  /** id → fingerprint of the last applied assignment, so identical polls don't re-probe. */
  private readonly assigned = new Map<number, string>()

  constructor(opts: UptimeAgentOptions) {
    this.config = opts.config
    this.check = opts.check
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.wsImpl = opts.wsImpl ?? defaultWsFactory
    this.log = opts.log ?? ((message) => console.log(message))
    this.scheduler = new Scheduler({
      check: (monitor) => this.check(monitor),
      onResult: (monitor, result, time) => this.enqueue(monitor, result, time),
    })
  }

  /** Start the scheduler, the pulse flusher and the server link. Safe to call once. */
  start(): void {
    if (this.started) return
    this.started = true
    this.stopped = false
    this.scheduler.start()
    this.flushTimer = setInterval(() => void this.flush(), this.config.pulseFlushMs)
    this.connect()
  }

  /** Stop every timer, close the link and freeze the queue (SIGINT/SIGTERM path). */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.scheduler.stop()
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    this.stopHttpPolling()
    this.clearAckTimer()
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.wsConnectTimer !== null) {
      clearTimeout(this.wsConnectTimer)
      this.wsConnectTimer = null
    }
    const socket = this.ws
    this.ws = null
    this.wsOpen = false
    if (socket !== null) {
      try {
        socket.close()
      } catch {
        // Closing must never throw out of stop().
      }
    }
  }

  private url(path: string): string {
    return `${this.config.serverUrl.replace(/\/+$/, '')}${path}`
  }

  private headers(): Record<string, string> {
    return { 'x-agent-token': this.config.token }
  }

  private connect(): void {
    if (this.stopped) return
    this.reconnectTimer = null
    let socket: AgentWs
    try {
      socket = this.wsImpl(this.url('/api/v1/agent'), { headers: this.headers() })
    } catch (error) {
      this.log(`websocket connect failed: ${errorMessage(error)}`)
      this.startHttpPolling()
      this.scheduleReconnect()
      return
    }
    this.ws = socket
    this.wsOpen = false
    this.wsConnectTimer = setTimeout(() => {
      if (this.ws === socket && !this.wsOpen) {
        this.log('websocket open timed out — falling back to HTTP')
        this.handleWsDown(socket)
      }
    }, WS_CONNECT_TIMEOUT_MS)

    socket.on('open', () => {
      if (this.ws !== socket || this.stopped) return
      this.clearConnectTimer()
      this.wsOpen = true
      this.reconnectAttempts = 0
      this.stopHttpPolling()
      this.log('agent link established')
      socket.send(JSON.stringify({ type: 'hello' }))
    })
    socket.on('message', (raw) => {
      if (this.ws === socket) this.onWsMessage(raw)
    })
    socket.on('close', () => {
      if (this.ws === socket) this.handleWsDown(socket)
    })
    socket.on('error', (error) => {
      if (this.ws !== socket) return
      this.log(`websocket error: ${errorMessage(error)}`)
      this.handleWsDown(socket)
    })
  }

  /** Tear down the current socket, fall back to HTTP and schedule a reconnect. */
  private handleWsDown(socket?: AgentWs): void {
    if (this.stopped) return
    if (socket !== undefined && this.ws !== socket) return
    this.clearConnectTimer()
    this.clearAckTimer()
    // Unacked WS pulses are still in the queue: HTTP fallback resends them.
    this.pendingSeqs.clear()
    const current = this.ws
    this.ws = null
    this.wsOpen = false
    if (current !== null) {
      try {
        current.close()
      } catch {
        // Already closed.
      }
    }
    this.log('agent link down — HTTP fallback active, reconnecting with backoff')
    this.startHttpPolling()
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts)
    this.reconnectAttempts += 1
    const delay = base / 2 + Math.random() * (base / 2)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private clearConnectTimer(): void {
    if (this.wsConnectTimer !== null) {
      clearTimeout(this.wsConnectTimer)
      this.wsConnectTimer = null
    }
  }

  private clearAckTimer(): void {
    if (this.ackTimer !== null) {
      clearTimeout(this.ackTimer)
      this.ackTimer = null
    }
  }

  private onWsMessage(raw: unknown): void {
    let payload: unknown
    try {
      payload = JSON.parse(messageText(raw))
    } catch {
      this.log('ignoring non-JSON websocket message')
      return
    }
    try {
      const message = wsMessageSchema.parse(payload)
      if (message.type === 'assigned') {
        this.applyAssigned(message.monitors)
        return
      }
      this.removeAcked(message.seqs.filter((seq): seq is number => typeof seq === 'number'))
    } catch (error) {
      this.log(`ignoring websocket message: ${errorMessage(error)}`)
    }
  }

  private applyAssigned(monitors: unknown[]): void {
    const seen = new Set<number>()
    for (const raw of monitors) {
      const parsed = assignedMonitorSchema.safeParse(raw)
      if (!parsed.success) {
        this.log('ignoring malformed monitor assignment')
        continue
      }
      const monitor = parsed.data
      seen.add(monitor.id)
      const fingerprint = JSON.stringify(monitor)
      if (this.assigned.get(monitor.id) === fingerprint) continue
      this.assigned.set(monitor.id, fingerprint)
      // The server stores core-validated types/configs, but re-validate so protocol drift
      // fails loudly here instead of as a repeating check error. Groups are filtered server-side.
      let config: ScheduledMonitor['config']
      try {
        config = parseMonitorConfig(monitor.type as MonitorType, monitor.config)
      } catch (error) {
        this.log(`ignoring monitor ${monitor.id}: ${errorMessage(error)}`)
        continue
      }
      this.scheduler.upsert({
        id: monitor.id,
        type: monitor.type as MonitorType,
        name: monitor.name,
        active: true,
        intervalS: monitor.intervalS,
        retries: monitor.retries,
        retryIntervalS: monitor.retryIntervalS,
        config,
      })
    }
    for (const id of [...this.assigned.keys()]) {
      if (seen.has(id)) continue
      this.assigned.delete(id)
      this.scheduler.remove(id)
    }
  }

  private enqueue(monitor: ScheduledMonitor, result: CheckResult, time: Date): void {
    while (this.queue.length >= this.config.maxQueue) {
      const dropped = this.queue.shift()
      this.log(
        `pulse queue full (${this.config.maxQueue}) — dropped oldest pulse for monitor ${dropped?.result.id}`,
      )
    }
    this.seq += 1
    this.queue.push({
      seq: this.seq,
      result: {
        id: monitor.id,
        status: result.status,
        latencyMs: result.latencyMs,
        responseSnippet: result.responseSnippet,
        time: time.toISOString(),
      },
    })
  }

  private removeAcked(seqs: number[]): void {
    const acked = new Set(seqs)
    this.queue = this.queue.filter((item) => !acked.has(item.seq))
    for (const seq of acked) this.pendingSeqs.delete(seq)
    // Only stop the fallback timer once nothing is in flight any more.
    if (this.pendingSeqs.size === 0) this.clearAckTimer()
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.stopped || this.queue.length === 0) return
    this.flushing = true
    try {
      if (this.wsOpen && this.ws !== null) {
        const batch = this.queue.filter((item) => !this.pendingSeqs.has(item.seq))
        if (batch.length > 0) {
          try {
            this.sendPulses(batch)
          } catch (error) {
            this.log(`websocket send failed: ${errorMessage(error)}`)
            this.handleWsDown()
          }
        }
        if (this.wsOpen) {
          // Pulses in flight without a pending timeout: arm the fallback (also covers a batch
          // sent while another batch's ack cleared the timer).
          if (this.pendingSeqs.size > 0) this.armAckTimer()
          return
        }
      }
      await this.flushOverHttp()
    } finally {
      this.flushing = false
    }
  }

  private sendPulses(batch: QueuedPulse[]): void {
    const socket = this.ws
    if (socket === null) throw new Error('websocket is not connected')
    socket.send(
      JSON.stringify({
        type: 'pulse',
        results: batch.map((item) => ({ seq: item.seq, ...item.result })),
      }),
    )
    for (const item of batch) this.pendingSeqs.add(item.seq)
    this.armAckTimer()
  }

  private armAckTimer(): void {
    if (this.ackTimer !== null) return
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null
      this.log('websocket ack timed out — falling back to HTTP')
      this.handleWsDown()
    }, WS_ACK_TIMEOUT_MS)
  }

  private async flushOverHttp(): Promise<void> {
    const batch = this.queue.slice()
    if (batch.length === 0) return
    try {
      const response = await this.fetchImpl(this.url('/api/v1/agent/pulse'), {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ results: batch.map((item) => item.result) }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      if (!response.ok) {
        this.log(
          `pulse flush failed: HTTP ${response.status} — ${this.queue.length} pulse(s) queued`,
        )
        return
      }
      const payload: unknown = await response.json()
      const body = pulseResponseSchema.parse(payload)
      const ackedIds = new Set(body.acked.filter((id): id is number => typeof id === 'number'))
      // The server rejects unknown/invalid ids (`{ id, reason }`); retrying them forever is pointless.
      const rejectedIds = new Set<number>()
      for (const entry of body.rejected) {
        if (typeof entry !== 'object' || entry === null || !('id' in entry)) continue
        const id: unknown = entry.id
        if (typeof id === 'number') rejectedIds.add(id)
      }
      if (rejectedIds.size > 0) this.log(`server rejected ${rejectedIds.size} pulse(s)`)
      this.queue = this.queue.filter(
        (item) => !ackedIds.has(item.result.id) && !rejectedIds.has(item.result.id),
      )
    } catch (error) {
      this.log(`pulse flush failed: ${errorMessage(error)} — ${this.queue.length} pulse(s) queued`)
    }
  }

  private startHttpPolling(): void {
    if (this.stopped || this.pollTimer !== null) return
    void this.pollAssigned()
    this.pollTimer = setInterval(() => void this.pollAssigned(), this.config.pollIntervalS * 1000)
  }

  private stopHttpPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async pollAssigned(): Promise<void> {
    if (this.stopped) return
    try {
      const response = await this.fetchImpl(this.url('/api/v1/agent/assigned'), {
        headers: this.headers(),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      if (!response.ok) {
        this.log(`assigned poll failed: HTTP ${response.status}`)
        return
      }
      const payload: unknown = await response.json()
      const body = assignedResponseSchema.parse(payload)
      this.applyAssigned(body.monitors)
    } catch (error) {
      this.log(`assigned poll failed: ${errorMessage(error)}`)
    }
  }
}
