import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { z } from 'zod'
import { WebSocketServer, type WebSocket } from 'ws'
import { parsePulseResult, tokenMatches, type AgentPulseResult, type AssignedMonitorPayload } from './index.js'

export interface AgentWsHubDeps {
  token: string
  /** Fresh assignment snapshot; pushed on connect and after every `hello`. */
  assigned: () => AssignedMonitorPayload[]
  /**
   * Processes one accepted pulse (the integrator from `agent/integrate.ts`).
   * Every delivered `seq` is acked — invalid results are reported on the HTTP
   * path and dropped on the WS path, so the client must never resend them.
   */
  processPulse: (result: AgentPulseResult) => void
  log?: (message: string) => void
}

export interface AgentWsHub {
  /** Detaches the upgrade listener and closes every live socket. */
  close(): void
  clientCount(): number
}

/** The path the agent client connects to (`packages/agent` `UptimeAgent.connect`). */
export const AGENT_WS_PATH = '/api/v1/agent'

/** Envelope shared with `packages/agent`'s `wsMessageSchema` (`hello` + `pulse` in). */
const agentMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello') }),
  z.object({ type: z.literal('pulse'), results: z.array(z.unknown()) }),
])

/** The client's pulse items carry their queue `seq` alongside the result. */
const pulseItemSchema = z.looseObject({ seq: z.number() })

/**
 * Server side of the agent WS link (ADR-0003 / M5): pushes the assignment on
 * connect and after `hello`, accepts `{type:'pulse', results:[{seq, …}]}`
 * batches and answers `{type:'ack', seqs}`. Auth is the same shared
 * `x-agent-token` the HTTP router uses, checked on the upgrade request.
 */
export function attachAgentWsHub(server: HttpServer, deps: AgentWsHubDeps): AgentWsHub {
  const wss = new WebSocketServer({ noServer: true })
  const log = deps.log ?? (() => {})

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== AGENT_WS_PATH) {
      socket.destroy()
      return
    }
    const presented = req.headers['x-agent-token']
    const token = Array.isArray(presented) ? presented[0] : presented
    if (!tokenMatches(token, deps.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  }
  server.on('upgrade', upgrade)

  const pushAssigned = (ws: WebSocket): void => {
    ws.send(JSON.stringify({ type: 'assigned', agentId: 'default', monitors: deps.assigned() }))
  }

  wss.on('connection', (ws: WebSocket) => {
    pushAssigned(ws)
    ws.on('message', (raw) => {
      let payload: unknown
      try {
        payload = JSON.parse(String(raw))
      } catch {
        log('ignoring non-JSON agent message')
        return
      }
      const message = agentMessageSchema.safeParse(payload)
      if (!message.success) {
        log('ignoring unexpected agent message')
        return
      }
      if (message.data.type === 'hello') {
        pushAssigned(ws)
        return
      }
      const ackedSeqs: number[] = []
      for (const rawResult of message.data.results) {
        const seq = pulseItemSchema.safeParse(rawResult)
        const pulse = parsePulseResult(rawResult)
        if (pulse.ok) {
          deps.processPulse(pulse.value)
        } else {
          log(`agent pulse rejected: ${pulse.reason}`)
        }
        if (seq.success) ackedSeqs.push(seq.data.seq)
      }
      if (ackedSeqs.length > 0) ws.send(JSON.stringify({ type: 'ack', seqs: ackedSeqs }))
    })
  })

  return {
    close: () => {
      server.off('upgrade', upgrade)
      wss.close()
    },
    clientCount: () => wss.clients.size,
  }
}
