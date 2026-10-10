# Task: M1 — Walking skeleton

## Objective

Implement `docs/PLAN.md` milestone M1: a runnable end-to-end slice — pnpm workspace
(`apps/server`, `apps/web`, `packages/core`, `packages/db`), Express 5 server with
`/healthz`, `/api/v1/push/:token`, scheduler-driven `http` checks persisted to SQLite
(Drizzle, WAL), a Prometheus uptime gauge, a Vue 3 dashboard with seeded monitor cards,
and a multi-stage Dockerfile + compose.

## Acceptance criteria

- [ ] `docker compose up` builds and boots the server; `GET /healthz` returns ok.
- [ ] A seeded `http` monitor executes on its interval; heartbeats land in SQLite (WAL).
- [ ] Dashboard shows monitor cards with status/latency from the API.
- [ ] `GET /metrics` exposes per-monitor status/uptime gauge.
- [ ] Push receiver records an `up` heartbeat for a token-matched monitor (404 unknown).
- [ ] Typecheck, unit + integration tests pass; `.agentic/bin/validate` + docs-check pass.

## Scope

### Included

- Workspace tooling: pnpm, TypeScript strict, vitest, eslint + prettier.
- M1 DB tables only: `monitors`, `heartbeats`, `push_tokens`, `settings` (incremental
  migrations per milestone, Kuma-style — not the full §4 schema up front).
- `http` check: method, url, headers, body, timeout, `acceptedStatus` range/any,
  `keyword` (+inverse), `maxResponseMs`; snippet first 1 KB.
- Scheduler: drift-corrected `next = start + n*interval` with ±10 % jitter, probe at
  `retryIntervalS` after a failure, global (50) + per-host (5) concurrency caps.
- Server: monitors CRUD (unauthenticated in M1 — auth lands M2, noted as residual risk),
  push receiver (hash lookup → heartbeat), `/metrics` (prom-client `monitor_up` gauge),
  static serving of `apps/web/dist`.
- Web: dashboard cards + create form, 5 s polling (live updates skipped per plan).
- Docker: build + runtime on `node:24-alpine` (musl), non-root UID 1001, `VOLUME /data`,
  `HEALTHCHECK` via node fetch (no shell entrypoint — node arg dispatch).

### Excluded

- Auth/sessions/API keys/TOTP (M2), notifications (M2), push monitor type with
  `/start` `/fail` + grace sweep (M2), WS/SSE live updates (M3), Postgres dialect
  (per ADR-0002, later milestone), cert-expiry + latency histograms in `/metrics` (M3).

## Plan

- [x] Understand: SPEC §2/§3/§4/§6/§10, ADRs 0001–0004, PLAN M1, DEVELOPMENT_PROCESS.md
- [x] Confirm architecture impact
- [ ] Implement smallest complete change per component
- [ ] Add or update tests (db migration+repo on `:memory:`; core check against local
      HTTP server; server integration via supertest incl. push + 404 path)
- [ ] Update documentation (README status)
- [ ] Run validation

## Architecture impact

- **ADR required:** No — follows accepted ADR-0001/0002/0004.
- **Relevant ADRs:** 0001 (monorepo), 0002 (SQLite-first), 0004 (Docker-first).
- **Deviation found:** SPEC §10 says native deps build on `node:24-bookworm` then run on
  `node:24-alpine`. A glibc-built `better-sqlite3` binary does not load under musl; the
  Dockerfile must build and run on the same libc (alpine → alpine). Spec correction
  queued with the plan review.

## Validation evidence

- Configuration validation: `.agentic/bin/validate` → passed; `.agentic/bin/docs-check` → no gaps.
- Tests: 54 passing (`pnpm -r test`: core 34, db 12, server 8); `pnpm -r typecheck`, `pnpm -r build`, `pnpm lint` clean.
- Build: `docker compose build` → `uptime-monitoring:local`; container boots with `read_only: true`
  - tmpfs, runs as `uptime` (UID 1001); CI workflow (`.github/workflows/ci.yml`) builds amd64+arm64.
- Documentation check: README status/Development rewritten; SPEC §10 libc correction; PLAN M0
  status + native-module risk row corrected (plan review B1/J5).
- Live smoke: server boots with seeded monitor → immediate probe of example.com (up, 97 ms),
  `/metrics` `monitor_up{monitor_id="1"} 1`, SPA deep-link `/monitors/1` serves shell, unknown API
  → 404 JSON, POST monitor → scheduled + probed (up, 2 ms). Browser-verified: dashboard cards +
  Add-monitor form creates a monitor that flips to Up within one interval (screenshots in session).
  Compose smoke: `docker compose up` → healthz ok, seeded heartbeat, metrics, SPA served.

## Review

- Correctness: all slices contract-frozen before parallel implementation; 8 server integration
  tests cover CRUD/scheduling hooks/push 404/SPA fallback; drift-corrected scheduler tested with
  fake timers.
- Security: M1 API is intentionally unauthenticated (auth = M2, plan J10 — residual risk);
  push tokens stored as sha256; container non-root + read_only compatible; no shell in entrypoint
  (node arg dispatch, no `*` route per Express 5).
- Compatibility: Express 5 semantics verified (body parser explicit, terminator-middleware SPA
  fallback); pnpm 10 `deploy --legacy` required for image assembly (documented in Dockerfile).
- Residual risks: single `heartbeats` table — day-partitioning/rollup model is an open decision
  (review B3: adopt Kuma single-table + stat rollups, or amend SPEC §4/ADR-0002); Postgres
  dialect undecided (review B2); heartbeat inserts synchronous (fine at M1 volume, batching queue
  is SPEC §6 work for M3); mssql/Slack/Gotify milestone gaps (J1/J2) need plan edits.
