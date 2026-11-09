import { Router } from 'express'
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { MonitorType } from '@uptime/core'
import type { Database } from '@uptime/db'

/** Everything the agent hub needs; `token` comes from `UPTIME_AGENT_TOKEN` (hub disabled when unset). */
export interface AgentHubDeps {
  db: Database
  token: string
  /**
   * Integration point for accepted pulses (heartbeat write + metrics + SSE +
   * incident engine at integration — see `agent/integrate.ts`). When absent,
   * the hub falls back to writing the heartbeat row only.
   */
  onPulse?: (result: AgentPulseResult) => void
}

/** Wire shape of one assigned monitor; kept in sync with `packages/agent`'s `AssignedMonitor`. */
export interface AssignedMonitorPayload {
  id: number
  type: MonitorType
  name: string
  intervalS: number
  retries: number
  retryIntervalS: number
  config: unknown
}

/** One validated pulse result (HTTP body entry or WS `pulse` item). */
export interface AgentPulseResult {
  id: number
  status: 'up' | 'down'
  latencyMs: number
  responseSnippet?: string
  time: Date
}

const pulseRequestSchema = z.object({ results: z.array(z.unknown()) })

export type ParsedPulse =
  | { ok: true; value: AgentPulseResult }
  | { ok: false; id: unknown; reason: string }

export function parsePulseResult(raw: unknown): ParsedPulse {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, id: undefined, reason: 'result must be an object' }
  }
  const id: unknown = 'id' in raw ? raw.id : undefined
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    return { ok: false, id, reason: 'invalid id' }
  }
  const status: unknown = 'status' in raw ? raw.status : undefined
  if (status !== 'up' && status !== 'down') {
    return { ok: false, id, reason: 'invalid status' }
  }
  const latencyMs: unknown = 'latencyMs' in raw ? raw.latencyMs : undefined
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0) {
    return { ok: false, id, reason: 'invalid latencyMs' }
  }
  const responseSnippet: unknown = 'responseSnippet' in raw ? raw.responseSnippet : undefined
  if (responseSnippet !== undefined && typeof responseSnippet !== 'string') {
    return { ok: false, id, reason: 'invalid responseSnippet' }
  }
  const rawTime: unknown = 'time' in raw ? raw.time : undefined
  if (typeof rawTime !== 'number' && typeof rawTime !== 'string') {
    return { ok: false, id, reason: 'invalid time' }
  }
  const time = new Date(rawTime)
  if (Number.isNaN(time.getTime())) {
    return { ok: false, id, reason: 'invalid time' }
  }
  return { ok: true, value: { id, status, latencyMs, responseSnippet, time } }
}

/**
 * Constant-time token check: both sides are hashed first, so the comparison is
 * independent of the presented length and an unset token disables the hub.
 * Shared by the HTTP router and the WS upgrade handler.
 */
export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (expected === '' || given === undefined) return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/** Assignment snapshot for the `default` vantage point: active, non-group monitors. */
export function assignedMonitors(db: Database): AssignedMonitorPayload[] {
  return db
    .listMonitors()
    .filter((row) => row.active && row.type !== 'group')
    .map((row) => ({
      id: row.id,
      // The API layer validates stored types against @uptime/core, so the cast holds.
      type: row.type as MonitorType,
      name: row.name,
      intervalS: row.intervalS,
      retries: row.retries,
      retryIntervalS: row.retryIntervalS,
      config: row.config,
    }))
}

/**
 * Agent hub, mounted at `/api/v1/agent` (ADR-0003):
 * - `GET /assigned` — assignment snapshot for the `default` vantage point: active,
 *   non-group monitors (groups are evaluated server-side).
 * - `POST /pulse` — heartbeat batch; valid ids are processed and acked, invalid/unknown
 *   ones are rejected with a reason.
 * - `GET /healthz` — link probe; 200 proves the presented token is accepted.
 *
 * Auth is the shared `x-agent-token` header for every route. Accepted pulses go
 * through `deps.onPulse` (the main server wires `createPulseIntegrator`, which
 * persists the beat and runs metrics/SSE/incident effects); without an
 * integrator the beat is written directly. The WS twin of this router lives in
 * `agent/ws.ts` and shares the parser and token check.
 */
export function createAgentRouter(deps: AgentHubDeps): Router {
  const router = Router()

  router.use((req, res, next) => {
    if (!tokenMatches(req.get('x-agent-token'), deps.token)) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    next()
  })

  router.get('/healthz', (_req, res) => {
    res.json({ ok: true })
  })

  router.get('/assigned', (_req, res) => {
    res.json({ agentId: 'default', monitors: assignedMonitors(deps.db) })
  })

  router.post('/pulse', (req, res) => {
    const body = pulseRequestSchema.safeParse(req.body)
    if (!body.success) {
      res.status(400).json({ error: 'results must be an array' })
      return
    }
    const acked: number[] = []
    const rejected: Array<{ id: unknown; reason: string }> = []
    for (const raw of body.data.results) {
      const parsed = parsePulseResult(raw)
      if (!parsed.ok) {
        rejected.push({ id: parsed.id, reason: parsed.reason })
        continue
      }
      if (deps.db.getMonitor(parsed.value.id) === null) {
        rejected.push({ id: parsed.value.id, reason: 'unknown monitor' })
        continue
      }
      if (deps.onPulse !== undefined) {
        deps.onPulse(parsed.value)
      } else {
        // Legacy fallback (no integrator wired): persist the beat only.
        deps.db.insertHeartbeat({
          monitorId: parsed.value.id,
          status: parsed.value.status,
          latencyMs: parsed.value.latencyMs,
          responseSnippet: parsed.value.responseSnippet,
          time: parsed.value.time,
        })
      }
      acked.push(parsed.value.id)
    }
    res.json({ acked, rejected })
  })

  return router
}
