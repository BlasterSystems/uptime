import { z } from 'zod'

/**
 * Agent runtime configuration (ADR-0003): where to reach the server, the shared
 * `UPTIME_AGENT_TOKEN`, and the pulse/poll cadence.
 */
export const agentConfigSchema = z.object({
  /** Base URL of the server, e.g. `http://uptime.internal:3001`. */
  serverUrl: z.url(),
  /** Shared secret sent as `x-agent-token`; same value as the server's `UPTIME_AGENT_TOKEN`. */
  token: z.string().min(8, 'token must be at least 8 characters'),
  /** HTTP-fallback assignment poll cadence in whole seconds (used while the WS link is down). */
  pollIntervalS: z.int().positive().default(30),
  /** How often queued pulses are flushed to the server, in whole milliseconds. */
  pulseFlushMs: z.int().positive().default(2000),
  /** Maximum queued pulses before the oldest are dropped, in memory only. */
  maxQueue: z.int().positive().default(5000),
})

/** Validated agent configuration, defaults applied. */
export type AgentConfig = z.infer<typeof agentConfigSchema>

/** Validate raw config (env-derived or hand-built) and apply defaults. Throws `ZodError`. */
export function parseAgentConfig(raw: unknown): AgentConfig {
  return agentConfigSchema.parse(raw)
}
