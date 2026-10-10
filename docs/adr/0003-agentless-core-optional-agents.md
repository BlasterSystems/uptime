# ADR-0003: Agentless core, optional push/agent for vantage points

- **Status:** Accepted
- **Date:** 2026-10-10
- **Decision owners:** Not assigned
- **Scope:** Check execution topology and vantage points
- **Tags:** architecture, agent, scheduling, push
- **Supersedes:** None
- **Superseded by:** None

## Context

Uptime-Kuma and Gatus run all checks from the server process (agentless) — simplest
possible deployment, single network vantage. PulseMonitor/Healthchecks/Beszel introduce
agents: remote vantage points, dead-man's-switch pushes, and per-host metrics. The
agent/server split also enables "is my service down, or is the monitor's network down?"

## Decision drivers

- Default deployment stays one container (ADR-0004) — agentless is simplest.
- Remote vantage points and dead-man's-switch pushes are required capabilities.
- Multi-region checks and per-host metrics without running a second server.
- Disambiguate "service down" from "monitor's network down".
- Healthchecks push semantics and the PulseMonitor agent protocol are proven prior art.

## Considered options

### Option 1: Agentless server only (baseline)

Simplest deployment (Kuma/Gatus model): scheduler + checks in-process. Single network
vantage and no way to distinguish monitor-network failure from service failure.

### Option 2: Always-agent architecture (PulseMonitor/Beszel-like)

Remote vantage points and per-host metrics, but every deployment becomes multi-component
with a protocol to version; contradicts the one-command deploy goal (SPEC §1).

### Option 3: Agentless core + optional agent (chosen)

Server stays agentless by default; an optional `agent` image connects out over WebSocket,
receives assigned monitors, executes them locally, and pulses results back with retry
queue + ack and HTTP fallback.

### Option 4: Push-only (Healthchecks-like)

Dead-man's-switch monitoring without remote check execution; covers cron/backup
monitoring but not remote vantage points.

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

### Positive

- Default deployment stays one container (ADR-0004); agents are opt-in.
- "Monitor vs network down" disambiguation and multi-region checks without a second
  server.

### Negative

- A second image and a protocol to version; mitigated by the agent being a thin shell
  over the same `packages/core` check engine.
- ICMP/docker-socket checks need elevated caps on agents; documented per deployment.

### Risks and mitigations

- Risk: lost pulses on unstable agent links. Mitigation: retry queue + ack, with HTTP
  fallback.
- Risk: protocol drift between agent and server versions. Mitigation: one repository,
  shared `packages/core`, versioned protocol, agent released alongside server (M5).

## Implementation and validation

Push receivers ship in PLAN.md M2 (`/start`, `/fail`, grace sweep); the agent image and
WebSocket protocol ship in M5, whose exit criterion is "an arm64 box runs the agent image
and reports as a vantage point". Validation today is `.agentic/bin/validate` plus
`.agentic/bin/docs-check`; M5 acceptance covers multi-vantage aggregation and per-vantage
notification scoping.

## Revisit triggers

- Most deployments run agents, making the agentless default a minority path.
- Protocol versioning churn exceeds the "thin shell over `packages/core`" premise.
- Elevated agent capabilities (ICMP/docker socket) become a security concern for users.

## References

- [SPEC.md](../SPEC.md) — architecture overview, push semantics, non-goals.
- [PLAN.md](../PLAN.md) — M2 push monitors, M5 agent image.
- [research/oss-comparison.md](../../research/oss-comparison.md)
- [ADR-0004](0004-docker-first-packaging.md) — one Dockerfile, two roles.
