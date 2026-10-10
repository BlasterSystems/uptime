# ADR-0003: Agentless core, optional push/agent for vantage points

- **Status**: Accepted
- **Date**: 2026-10-10

## Context

Uptime-Kuma and Gatus run all checks from the server process (agentless) — simplest
possible deployment, single network vantage. PulseMonitor/Healthchecks/Beszel introduce
agents: remote vantage points, dead-man's-switch pushes, and per-host metrics. The
agent/server split also enables "is my service down, or is the monitor's network down?"

## Decision

1. **The server is agentless by default**: scheduler + checks in-process; push
   receivers (`/api/v1/push/<token>`) are always available for dead-man's-switch
   monitoring (Healthchecks semantics).
2. **An optional `agent` image** (same repository, M5) connects out to the server over
   WebSocket, receives assigned monitor definitions, executes them locally, and pulses
   results back with a **retry queue + ack** (no lost pulses) and HTTP fallback — the
   PulseMonitor protocol, simplified to one repo.
3. The server aggregates results **per vantage point**; uptime percentages and
   notifications can be scoped per agent (e.g. only alert when the primary vantage fails).

## Consequences

- **+** Default deployment stays one container (ADR-0004); agents are opt-in.
- **+** "Monitor vs network down" disambiguation and multi-region checks without a second server.
- **−** A second image and a protocol to version; mitigated by the agent being a thin
  shell over the same `packages/core` check engine.
- **−** ICMP/docker-socket checks need elevated caps on agents; documented per deployment.
