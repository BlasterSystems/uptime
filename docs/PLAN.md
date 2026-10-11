# Implementation plan

Milestones are vertically sliced: each ships something usable. Effort is indicative
(single developer with LLM assistance).

## M0 — Repository & governance ✅ (delivered 2026-10-10)

- agentic-bootstrap scaffold (`--platform all`), git init.
- SPEC.md, research notes, this plan, initial ADRs.
- ADRs brought into `docs/adr/template.md` format and indexed; `.agentic/bin/validate` +
  docs-check green (2026-10-10).
- **Exit**: docs reviewed and agreed (expert plan review delivered; sign-off pending);
  ADRs accepted.

## M1 — Walking skeleton (≈1 week) — ✅ delivered

- pnpm workspace: `apps/server`, `apps/web`, `packages/core`, `packages/db`.
- Server: Express 5 + TS, `/healthz`, `/api/v1/push/:token` receiver, one `http` monitor
  type executed by the scheduler (interval + retries), heartbeats to SQLite (Drizzle,
  WAL), `GET /metrics` (uptime gauge only).
- Web: Vue 3 + Vite, dashboard with hardcoded-seed monitor cards, live updates skipped.
- Docker: multi-stage image, compose file, `/data` volume, healthcheck.
- **Exit**: `docker compose up` → add an HTTP monitor via seed → see heartbeat in UI.

## M2 — CRUD, auth, notifications (≈1.5 weeks) — ✅ delivered

- Argon2id auth, sessions, API keys (hashed, scoped), TOTP 2FA.
- Full monitor CRUD + form validation driven by `packages/core` schemas; tags.
- Notification channels (Telegram, Discord, Email, Ntfy, Webhook) + test-send +
  incident open/recover notifications + resend interval.
- Incident records; push monitor type with `/start` `/fail` and grace sweep.
- **Exit**: flip a monitor down → incident + notification within one retry window.

## M3 — Live UI, status pages, metrics (≈1.5 weeks) — ✅ delivered

- SSE hub (`/api/v1/events`: heartbeat/incident/maintenance events); dashboard live
  via SSE + polling.
- Status pages (public slug, groups, theme); prometheus `/metrics` full (latency
  histograms, cert expiry, per-tag gauges); heartbeat strip + uptime % + response chart.
- Maintenance windows (single/recurring/cron); tag filters.
- **Exit**: a public status page reflects a live incident on next load (the public
  page does not auto-refresh yet — admin views are SSE-live); metrics scrapeable.

## M4 — Database & container monitors (≈1 week) — ✅ delivered

- `postgres`/`mysql`/`redis`/`mongodb` monitors (connection + `SELECT 1`/`PING`),
  `docker` monitor via socket/TLS (`docker_hosts` CRUD), TCP/ICMP/DNS types.
- Group monitors with strategies (any-up/all-up/percentage) and group-down
  notification suppression; `parent_id` dependency suppression is deferred (SPEC §14) —
  probes for these types run via the agent.
- **Exit**: postgres monitor detects a stopped DB within one interval (via the agent);
  group-down suppresses member alerts.

## M5 — Agent image, multi-arch release (≈1 week) — ✅ delivered

- `agent` role: pulls assigned monitors and pulses results over the documented HTTP
  fallback (`GET /api/v1/agent/assigned`, `POST /pulse` with retry queue); the client
  attempts a WS link first — server-side WS hub is pending (SPEC §14).
- CI: buildx amd64/arm64 → GHCR on tags; SBOM; semver release workflow (agentic-bootstrap
  RELEASING convention).
- **Exit**: `arm64` box runs the agent image and reports as a vantage point.

## M6 — Power-user & polish (≈1 week) — ✅ delivered

- Config export/import (JSON) + `openapi-bootstrap` generator script (SPEC §9).
- Backup/restore (SQLite snapshot API), retention/rollup job, import from Uptime-Kuma
  (best-effort monitors+heartbeats mapping).
- **Exit**: Kuma import produces working monitors; export → fresh container reproduces
  configuration.

## Risks & mitigations

| Risk                             | Mitigation                                                                                                                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native modules on musl/arm64     | pin `better-sqlite3` ≥ 12 (tarball carries `prebuilds/linuxmusl-*.node`); approve build scripts (`pnpm onlyBuiltDependencies`); build+runtime on the same libc; M1 CI job builds the image on linux/amd64 + linux/arm64 (build-only, no publish/run) |
| WS through user proxies          | SSE is the primary (and only) transport — no WS dependency |
| Feature creep toward Kuma parity | M-milestones gate; non-goals in SPEC §1                                                                                                                                                                                          |
| Check storms on wide intervals   | global/per-host concurrency caps (SPEC §6)                                                                                                                                                                                       |
