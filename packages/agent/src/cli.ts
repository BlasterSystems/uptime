import { runCheck } from '@uptime/core'
import { UptimeAgent } from './agent.js'
import { parseAgentConfig, type AgentConfig } from './config.js'

/** Env-driven agent configuration; a missing/empty poll var falls back to the default. */
export function agentConfigFromEnv(env: NodeJS.ProcessEnv): AgentConfig {
  const pollRaw = env.UPTIME_AGENT_POLL_S
  return parseAgentConfig({
    serverUrl: env.UPTIME_SERVER_URL,
    token: env.UPTIME_AGENT_TOKEN,
    pollIntervalS: pollRaw === undefined || pollRaw === '' ? undefined : Number(pollRaw),
  })
}

/**
 * Container entrypoint for the `agent` role (ADR-0004): run until SIGINT/SIGTERM,
 * then stop cleanly and exit 0. Logs `agent started` once the loop is armed.
 */
export async function runAgentCli(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = agentConfigFromEnv(env)
  const agent = new UptimeAgent({
    config,
    check: (monitor) => runCheck(monitor.type, monitor.config),
    log: (message) => console.log(message),
  })
  const shutdown = () => {
    agent.stop()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  agent.start()
  console.log('agent started')
  await new Promise<never>(() => {})
}
