# ADR-0008: Cut docker monitors and docker hosts

- **Status:** Accepted
- **Date:** 2026-11-11
- **Decision owners:** Bruno Pires
- **Scope:** Monitor types, check engine, data model, API surface, web UI, deployment mounts
- **Tags:** monitors, docker, scheduling, breaking-change, deployment
- **Supersedes:** None
- **Superseded by:** None

## Context

The owner simplification sweep of 2026-11-11 selected docker monitors and docker hosts
for end-to-end removal (research: `tasks/research-cut-docker-monitors.md`). Today:

- `docker` is one of only two server-probe-scheduled types
  (`packages/core/src/scheduler.ts` `SERVER_SCHEDULED_TYPES`, the startup filter in
  `apps/server/src/main.ts`); every engine type except `http`/`push`/`group` is meant
  to run on the optional agent (ADR-0003).
- The `docker_hosts` table, its CRUD (`packages/db`, `/api/v1/docker-hosts` in
  `apps/server`) and the Settings tab + reusable-host picker in the web UI exist
  solely to serve this one monitor type.
- The DEV VM compose mounts the host Docker socket into the container
  (`deploy/docker-compose.yml`, `DOCKER_GID`) purely for docker monitors — a live
  privilege surface (the socket is host-root-equivalent) for an unused feature.
- The breaking change rides the same major release as the notification-channel prune
  (UP-17); release preparation is owned by UP-20.

## Decision drivers

- No internal usage; container health is already observable via `http` monitors
  against a healthcheck endpoint.
- Every server-scheduled type fans out into four gates (`toScheduled`, the
  create/PATCH schedulable checks, the startup filter, `SERVER_SCHEDULED_TYPES`).
- The Docker socket mount is an attack surface with no compensating demand.
- The sweep's stated goal is the smallest feature set that keeps the product honest;
  the owner explicitly declined cutting the 8 agent-only types instead.

## Considered options

### Option 1: Cut end-to-end (chosen)

Remove the type/config/check from `packages/core`, the `docker_hosts` table + CRUD
from `packages/db`, the routes and scheduling gates from `apps/server`, the UI
surfaces from `apps/web`, and the socket mount + `DOCKER_GID` from the deploy files.
A destructive migration deletes existing docker monitors with the same dependent-row
cleanup as `deleteMonitor`, then drops `docker_hosts`.

- Benefits: removes a server-scheduled type and its four gates, one table, ~600 LOC
  of UI, and the socket mount; no configuration can half-exist afterwards.
- Costs: breaking; docker monitors, their history and docker host rows are
  unrecoverable after the migration.

### Option 2: Keep, gated behind a UI flag

Hide the `docker` type from the type picker but keep engine, table, routes and mount.

- Benefits: reversible for existing users.
- Costs: gate ≠ simplification — the socket mount and all four scheduler gates
  remain; the flag is one more thing to maintain and eventually cut anyway.

### Option 3: Move docker to the agent

Make `docker` an agent-executed type (like tcp/dns/icmp/db) and drop the server-side
scheduling gate.

- Benefits: keeps the check engine and config for users who run agents.
- Costs: agent-only types are already a documented dead-end on stock deploys
  (they stay `pending` without an agent); the socket mount would simply move into
  agent deployments; `docker_hosts` and the UI survive.

## Decision

Cut docker monitors and docker hosts entirely (Option 1). Scheduling narrows to
`http`-only. The migration mirrors `deleteMonitor`'s dependent-row cleanup
(heartbeats, incidents, monitor_notifications, monitor_tags, hourly/daily rollups)
for existing docker monitors before deleting the monitor rows and dropping
`docker_hosts`; the down path recreates the table but cannot restore data.
Container health is watched with an `http` monitor against a healthcheck endpoint
(or a reverse-proxied Docker API endpoint) instead.

## Consequences

### Positive

- The scheduler gate, `toScheduled`, the create/PATCH schedulable checks and the
  startup filter collapse to a single type.
- No deployment mounts the host Docker socket; `deploy/.env.example` loses
  `DOCKER_GID`.
- Lingering docker configs fail loudly: `parseMonitorConfig`'s default branch throws,
  so the API answers 400 instead of silently storing an unrunnable monitor.

### Negative

- Breaking: `type: 'docker'` is rejected (400) and `/api/v1/docker-hosts` answers
  404; the web UI loses the Docker optgroup, Docker-host settings tab and
  DockerHostForm.
- Destructive: docker monitors, their heartbeats/incidents/rollups and
  `docker_hosts` rows are deleted by the migration (same delete-don't-inert policy
  as the UP-17 channel prune).

### Risks and mitigations

- Users relying on container-state probes lose that signal. Mitigation: the
  changelog documents the `http`-monitor replacement (healthcheck endpoint or
  proxied Docker API).
- The migration runs on production databases. Mitigation: it reuses the exact
  dependent-row cleanup `deleteMonitor` relies on (FK cascades) and is verified on
  a populated copy database by a repo test.

## Implementation and validation

- UP-23: core/db/server cut plus migration `0007` (next after `0006_slim_cerise`).
  Acceptance: `POST /api/v1/monitors` with `type=docker` → 400, docker-hosts routes
  → 404, migration verified on a populated copy DB, package unit tests green.
- UP-24: web + deploy cut and final docs sweep. Acceptance: `pnpm build`, web
  typecheck, unit tests and e2e green; no docker feature references left in
  `apps/web/src` (build tooling excepted); deploy files socket-free.
- `.agentic/bin/validate` and `.agentic/bin/docs-check` pass.

## Revisit triggers

- Container-monitoring demand returns (a gap only `State.Status` answers) —
  reintroduce as an agent-executed engine, never as a server-scheduled type.
- A supported story for mounting the Docker socket reappears; it must clear the
  privilege-surface review that motivated this cut.

## References

- UP-21 (epic), UP-22, UP-23, UP-24; research doc `tasks/research-cut-docker-monitors.md`.
- [ADR-0003](0003-agentless-core-optional-agents.md) — agent-only engine types.
- [ADR-0002](0002-sqlite-first-storage-secrets-encryption.md) — the TLS columns being removed were encrypted under it.
- UP-17/UP-20 — the breaking-release vehicle this rides.
