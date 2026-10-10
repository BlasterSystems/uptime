# ADR-0001: Single repository, TypeScript monorepo

- **Status**: Accepted
- **Date**: 2026-10-10
- **Deciders**: Carrigo/infra

## Context

Inspiration points to two models: Uptime-Kuma/Gatus (one deployable, agentless) and
PulseMonitor (agent + server + status page across three repositories with a ClickHouse
dependency). The team's experience is TypeScript/Node (carrigo-api) with some Python and
Rust exposure; deployment target is Docker on a single VM.

## Decision

One repository containing the server, web UI, optional agent, shared check engine and
schema as a pnpm/TypeScript workspace. Runtime: Node.js 24 LTS. Server framework:
**Express 5** (team familiarity; carrigo-api precedent). UI: **Vue 3 + Vite**. Shared
types/schemas in `packages/core`; storage in `packages/db`.

## Consequences

- **+** One clone builds everything; shared types end-to-end; PRs touch all layers atomically.
- **+** Team velocity: no new language.
- **−** Rust/Go agents would be leaner per-binary; mitigated by the agent being optional
  and Node's footprint being acceptable on the target VMs.
- **−** Express is not the fastest TS framework; Fastify was considered (better schema
  validation, lower overhead). Rejected for M1 speed and consistency with existing
  internal code; revisit if the scheduler becomes hot (SPEC §6 caps concurrency first).
- Alternatives rejected: Go monorepo (Gatus-like — faster, worse team fit and UI story),
  Python (Healthcheck-like — weaker realtime/embedded story), 3-repo split (PulseMonitor
  — operational overhead proved by their issue tracker).
