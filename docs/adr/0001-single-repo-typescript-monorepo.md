# ADR-0001: Single repository, TypeScript monorepo

- **Status:** Accepted
- **Date:** 2026-10-10
- **Decision owners:** Carrigo/infra
- **Scope:** Repository topology, runtime language, server framework, UI stack
- **Tags:** architecture, monorepo, typescript, express, vue
- **Supersedes:** None
- **Superseded by:** None

## Context

Inspiration points to two models: Uptime-Kuma/Gatus (one deployable, agentless) and
PulseMonitor (agent + server + status page across three repositories with a ClickHouse
dependency). The team's experience is TypeScript/Node (carrigo-api) with some Python and
Rust exposure; deployment target is Docker on a single VM.

## Decision drivers

- Team experience is TypeScript/Node (carrigo-api precedent): no new language to learn
  or hire for.
- Deployment target is Docker on a single VM (ADR-0004): one clone, one build, minimal
  operational surface.
- Shared types and schemas across server, web UI, agent, and check engine.
- M1 speed: first vertical slice should not wait on new infrastructure or framework
  evaluation (PLAN.md).
- Competitor evidence: Uptime-Kuma/Gatus succeed as single deployables; PulseMonitor's
  three-repository split shows operational overhead (its issue tracker).

## Considered options

### Option 1: Single pnpm/TypeScript monorepo (chosen)

One repository containing server, web UI, optional agent, shared check engine and schema
as a pnpm/TypeScript workspace. TypeScript end-to-end; the team is already productive in
Node.

### Option 2: TypeScript monorepo on Fastify

Fastify offers better schema validation and lower overhead than Express, but less
familiarity and less consistency with existing internal code.

### Option 3: Go monorepo (Gatus-like)

Faster binaries and leaner agents, worse team fit and a worse UI story for a
Vue-heavy product.

### Option 4: Python monorepo (Healthchecks-like)

Strong scheduler/ops tooling, weaker realtime and embedded check-engine story for the
Node worker model we want.

### Option 5: Three-repository split (PulseMonitor-like)

Independent release cycles per component, but cross-repo versioning, CI duplication and
agent/server protocol drift; operational overhead already proved by PulseMonitor's issue
tracker.

## Decision

One repository containing the server, web UI, optional agent, shared check engine and
schema as a pnpm/TypeScript workspace. Runtime: Node.js 24 LTS. Server framework:
**Express 5** (team familiarity; carrigo-api precedent). UI: **Vue 3 + Vite**. Shared
types/schemas in `packages/core`; storage in `packages/db`.

Express was chosen over Fastify for M1 speed and consistency with existing internal code;
the scheduler is bounded by global/per-host concurrency caps (SPEC §6) before framework
throughput becomes the bottleneck.

## Consequences

### Positive

- One clone builds everything; shared types end-to-end; PRs touch all layers atomically.
- Team velocity: no new language.

### Negative

- Express is not the fastest TS framework; Fastify was considered (better schema
  validation, lower overhead) and rejected for M1.
- Rust/Go agents would be leaner per-binary; mitigated by the agent being optional and
  Node's footprint being acceptable on the target VMs.

### Risks and mitigations

- Risk: the scheduler becomes hot and Express overhead starts to matter. Mitigation:
  revisit the framework then; SPEC §6 caps concurrency first.
- Risk: monorepo coupling slows independent releases. Mitigation: server and agent build
  from one Dockerfile with role dispatch (ADR-0004); the agent ships with server
  milestones.

## Implementation and validation

M0 established the repository, the pnpm workspace convention, and this record. The
physical workspace (`apps/server`, `apps/web`, `packages/core`, `packages/db`) is
implemented by PLAN.md M1 (pending). Validation today is the agentic-bootstrap checks,
`.agentic/bin/validate` and `.agentic/bin/docs-check` (AGENTS.md;
tasks/m1-walking-skeleton.md). The M1 exit criterion — `docker compose up`, add an HTTP
monitor, see a heartbeat in the UI — exercises the chosen stack end-to-end.

## Revisit triggers

- Scheduler/check throughput becomes the bottleneck after SPEC §6 caps are exhausted.
- Team language mix shifts materially toward Go or Rust.
- Repository scale or release coupling measurably slows delivery.

## References

- [SPEC.md](../SPEC.md) — goals, architecture overview, scheduler caps.
- [PLAN.md](../PLAN.md) — M1 walking skeleton.
- [research/oss-comparison.md](../../research/oss-comparison.md) — competitor landscape.
- [ARCHITECTURE.md](../ARCHITECTURE.md)
- [ADR-0004](0004-docker-first-packaging.md) — packaging builds on the monorepo.
