import { describe, expect, it } from 'vitest'
import type { Response } from 'express'
import { EventHub } from './events.js'

/** Express `Response` with the SSE chunks recorded for assertions. */
type MockSseResponse = Response & { writes: string[] }

function mockRes(): MockSseResponse {
  const written: string[] = []
  return {
    writes: written,
    ended: false,
    writeHead: (_s: number, _h: Record<string, string>) => {},
    write: (chunk: string) => {
      written.push(chunk)
      return true
    },
    end: () => {},
  } as unknown as MockSseResponse
}

function mockReq() {
  return { on: (_ev: string, _cb: () => void) => {} }
}

describe('EventHub', () => {
  it('writes SSE headers and broadcasts to all clients', () => {
    const hub = new EventHub()
    const a = mockRes()
    const b = mockRes()
    hub.handle(mockReq(), a)
    hub.handle(mockReq(), b)
    expect(hub.clientCount).toBe(2)

    hub.broadcast({
      type: 'heartbeat',
      monitorId: 1,
      status: 'up',
      latencyMs: 5,
      time: '2026-01-01T00:00:00.000Z',
    })
    expect(a.writes.some((w) => w.includes('"type":"heartbeat"'))).toBe(true)
    expect(b.writes.some((w) => w.includes('"type":"heartbeat"'))).toBe(true)

    hub.stop()
    expect(hub.clientCount).toBe(0)
  })

  it('drops clients on close', () => {
    const hub = new EventHub()
    let closeCb: (() => void) | undefined
    const req = {
      on: (ev: string, cb: () => void) => {
        if (ev === 'close') closeCb = cb
      },
    }
    hub.handle(req, mockRes())
    expect(hub.clientCount).toBe(1)
    closeCb?.()
    expect(hub.clientCount).toBe(0)
  })
})
