import type { Response } from 'express'

export type ServerEvent =
  | { type: 'heartbeat'; monitorId: number; status: string; latencyMs: number | null; time: string }
  | {
      type: 'incident'
      monitorId: number
      incidentId: number
      state: 'open' | 'resolved'
      title: string
      time: string
    }
  | { type: 'maintenance'; monitorId: number; under: boolean; time: string }

/** SSE hub at /api/v1/events — primary live transport (review J7: SSE reconnects natively). */
export class EventHub {
  private readonly clients = new Set<Response>()
  private ping: NodeJS.Timeout | null = null

  /** Adopts a request/response pair as an SSE stream. Call from a route handler. */
  handle(req: { on: (ev: string, cb: () => void) => unknown }, res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': connected\n\n')
    this.clients.add(res)
    req.on('close', () => {
      this.clients.delete(res)
    })
    if (!this.ping) {
      this.ping = setInterval(() => {
        for (const client of this.clients) client.write(': ping\n\n')
      }, 25_000)
      this.ping.unref?.()
    }
  }

  broadcast(event: ServerEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`
    for (const client of this.clients) client.write(payload)
  }

  get clientCount(): number {
    return this.clients.size
  }

  stop(): void {
    if (this.ping) {
      clearInterval(this.ping)
      this.ping = null
    }
    for (const client of this.clients) client.end()
    this.clients.clear()
  }
}
