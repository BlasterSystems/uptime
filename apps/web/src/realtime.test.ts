import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { realtimeState, subscribeRealtime, type RealtimeHandler } from './realtime.js'

class StubEventSource {
  static instances: StubEventSource[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2

  readyState = StubEventSource.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()

  constructor(public url: string) {
    StubEventSource.instances.push(this)
  }
}

function lastSource(): StubEventSource {
  return StubEventSource.instances.at(-1) as StubEventSource
}

beforeEach(() => {
  vi.useFakeTimers()
  StubEventSource.instances = []
  vi.stubGlobal('EventSource', StubEventSource)
  vi.stubGlobal('window', { ...window, clearTimeout: window.clearTimeout, setTimeout: window.setTimeout })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** Drives a subscribed stream through its lifecycle; returns the unsubscribe fn. */
function subscribe(handler: RealtimeHandler): () => void {
  const unsubscribe = subscribeRealtime(handler)
  return unsubscribe
}

describe('subscribeRealtime', () => {
  it('opens the shared SSE stream on the first subscriber and closes on the last', () => {
    const off1 = subscribe(vi.fn())
    expect(lastSource().url).toBe('/api/v1/events')

    const off2 = subscribe(vi.fn())
    off1()
    expect(lastSource().close).not.toHaveBeenCalled()

    off2()
    expect(lastSource().close).toHaveBeenCalledTimes(1)
    expect(realtimeState.status).toBe('connecting')
  })

  it('transitions to live on open and fans messages out to every handler', () => {
    const handlerA = vi.fn()
    const handlerB = vi.fn()
    const offA = subscribe(handlerA)
    const off = subscribe(handlerB)
    const stream = lastSource()

    stream.onopen!()
    expect(realtimeState.status).toBe('live')

    const beat = { type: 'heartbeat', monitorId: 1, status: 'up', latencyMs: 5, time: 't' }
    stream.onmessage!(new MessageEvent('message', { data: JSON.stringify(beat) }))
    expect(handlerA).toHaveBeenCalledWith(beat)
    expect(handlerB).toHaveBeenCalledWith(beat)

    // Malformed and unknown payloads are dropped silently.
    stream.onmessage!(new MessageEvent('message', { data: 'not json' }))
    stream.onmessage!(new MessageEvent('message', { data: JSON.stringify({ type: 'nope' }) }))
    expect(handlerA).toHaveBeenCalledTimes(1)

    off()
    offA()
  })

  it('falls back to polling after repeated errors and retries once after 60 s', () => {
    const off = subscribe(vi.fn())
    const stream = lastSource()

    stream.onerror!()
    expect(realtimeState.status).toBe('connecting')

    stream.onerror!()
    expect(realtimeState.status).toBe('polling')
    expect(lastSource().close).toHaveBeenCalled()

    const count = StubEventSource.instances.length
    vi.advanceTimersByTime(60_000)
    expect(StubEventSource.instances.length).toBe(count + 1)
    expect(realtimeState.status).toBe('connecting')
    off()
  })

  it('stays in polling permanently when EventSource is unavailable', () => {
    vi.stubGlobal('EventSource', undefined)
    subscribe(vi.fn())
    expect(realtimeState.status).toBe('polling')
  })
})
