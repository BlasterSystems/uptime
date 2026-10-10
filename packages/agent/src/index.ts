/** Public API of `@uptime/agent`: config parsing, the vantage-point agent and its CLI. */
export { UptimeAgent } from './agent.js'
export type {
  AgentWs,
  AssignedMonitor,
  PulseResult,
  UptimeAgentOptions,
  WsFactory,
} from './agent.js'
export { agentConfigSchema, parseAgentConfig } from './config.js'
export type { AgentConfig } from './config.js'
export { agentConfigFromEnv, runAgentCli } from './cli.js'
