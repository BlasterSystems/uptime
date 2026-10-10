/**
 * Realtime transport for `GET /api/v1/events` (Server-Sent Events).
 *
 * One shared `EventSource` serves every subscriber: the stream opens on the
 * first `subscribeRealtime` call and closes with the last unsubscribe.
 * `EventSource` reconnects on its own; if two consecutive errors happen (or the
 * browser closes the stream outright), the client stops retrying and reports
 * `polling`, so views can fall back to their HTTP refresh cadence. A single
 * reconnect attempt is made every {@link RETRY_DELAY_MS} while in that state.
 */
import { reactive } from 'vue'
import type { HeartbeatStatus } from './api.js'

export type RealtimeStatus = 'connecting' | 'live' | 'polling'

export interface RealtimeHeartbeatEvent {
  type: 'heartbeat'
  monitorId: number
  status: HeartbeatStatus
  latencyMs: number | null
  time: string
}

export interface RealtimeIncidentEvent {
  type: 'incident'
  monitorId: number
  incidentId: number
  state: 'open' | 'resolved'
  title: string
  time: string
}

export interface RealtimeMaintenanceEvent {
  type: 'maintenance'
  monitorId: number
  under: boolean
  time: string
}

export type RealtimeEvent = RealtimeHeartbeatEvent | RealtimeIncidentEvent | RealtimeMaintenanceEvent

export type RealtimeHandler = (event: RealtimeEvent) => void

/** Consecutive `error` events tolerated before falling back to polling. */
const MAX_CONSECUTIVE_ERRORS = 2
/** Delay before a lone reconnect attempt while in the polling fallback. */
const RETRY_DELAY_MS = 60_000

/** Live transport state; reactive so views can adapt their polling cadence. */
export const realtimeState = reactive<{ status: RealtimeStatus }>({ status: 'connecting' })

const handlers = new Set<RealtimeHandler>()
let source: EventSource | null = null
let failures = 0
let retryTimer: number | null = null
let refCount = 0

function isRealtimeEvent(value: unknown): value is RealtimeEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false
  const type: unknown = value.type
  return type === 'heartbeat' || type === 'incident' || type === 'maintenance'
}

function handleMessage(message: MessageEvent<string>): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(message.data)
  } catch {
    return
  }
  if (!isRealtimeEvent(parsed)) return
  for (const handler of handlers) handler(parsed)
}

function closeSource(): void {
  source?.close()
  source = null
}

function clearRetryTimer(): void {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer)
    retryTimer = null
  }
}

function scheduleRetry(): void {
  if (retryTimer !== null || refCount === 0) return
  retryTimer = window.setTimeout(() => {
    retryTimer = null
    if (refCount > 0) connect()
  }, RETRY_DELAY_MS)
}

function connect(): void {
  if (refCount === 0) return
  if (typeof EventSource === 'undefined') {
    // No SSE support (older browsers): stay in polling mode for good.
    realtimeState.status = 'polling'
    return
  }

  closeSource()
  clearRetryTimer()
  failures = 0
  realtimeState.status = 'connecting'

  const stream = new EventSource('/api/v1/events', { withCredentials: true })
  source = stream

  stream.onopen = () => {
    if (source !== stream) return
    failures = 0
    realtimeState.status = 'live'
  }
  stream.onmessage = handleMessage
  stream.onerror = () => {
    // A retry may have replaced this stream already; ignore stale events.
    if (source !== stream) return
    failures += 1
    if (stream.readyState === EventSource.CLOSED || failures >= MAX_CONSECUTIVE_ERRORS) {
      closeSource()
      realtimeState.status = 'polling'
      scheduleRetry()
    } else {
      realtimeState.status = 'connecting'
    }
  }
}

/**
 * Subscribes to realtime events. Returns the unsubscribe function; the shared
 * stream is opened by the first subscriber and closed by the last one.
 */
export function subscribeRealtime(handler: RealtimeHandler): () => void {
  handlers.add(handler)
  refCount += 1
  if (refCount === 1) connect()

  let active = true
  return () => {
    if (!active) return
    active = false
    handlers.delete(handler)
    refCount -= 1
    if (refCount === 0) {
      closeSource()
      clearRetryTimer()
      failures = 0
      realtimeState.status = 'connecting'
    }
  }
}
