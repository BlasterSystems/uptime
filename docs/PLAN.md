# Implementation plan

Milestones are vertically sliced: each ships something usable. Effort is indicative
(single developer with LLM assistance).

## M0 — Repository & governance 🔄 (in review)
- agentic-bootstrap scaffold (`--platform all`), git init.
- SPEC.md, research notes, this plan, initial ADRs.
- ADRs brought into `docs/adr/template.md` format and indexed; `.agentic/bin/validate` +
  docs-check green (2026-10-10).
- **Exit**: docs reviewed and agreed (expert plan review delivered; sign-off pending);
  ADRs accepted.

## M1 — Walking skeleton (≈1 week)
- pnpm workspace: `apps/server`, `apps/web`, `packages/core`, `packages/db`.
- Server: Express 5 + TS, `/healthz`, `/api/v1/push/:token` receiver, one `http` monitor
  type executed by the scheduler (interval + retries), heartbeats to SQLite (Drizzle,
  WAL), `GET /metrics` (uptime gauge only).
- Web: Vue 3 + Vite, dashboard with hardcoded-seed monitor cards, live updates skipped.
- Docker: multi-stage image, compose file, `/data` volume, healthcheck.
- **Exit**: `docker compose up` → add an HTTP monitor via seed → see heartbeat in UI.

## M2 — CRUD, auth, notifications (≈1.5 weeks)
- Argon2id auth, sessions, API keys (hashed, scoped), TOTP 2FA.
- Full monitor CRUD + form validation driven by `packages/core` schemas; tags.
- Notification channels (Telegram, Discord, Email, Ntfy, Webhook) + test-send +
  incident open/recover notifications + resend interval.
- Incident records; push monitor type with `/start` `/fail` and grace sweep.
- **Exit**: flip a monitor down → incident + notification within one retry window.

## M3 — Live UI, status pages, metrics (≈1.5 weeks)
- WebSocket hub (heartbeat/uptime/incident events) + SSE fallback; dashboard live.
- Status pages (public slug, groups, theme); prometheus `/metrics` full (latency
  histograms, cert expiry, per-tag gauges); heartbeat strip + uptime % + response chart.
- Maintenance windows (single/recurring/cron); tag filters.
- **Exit**: public status page reflects a live incident in < 5 s; metrics scrapeable.

## M4 — Database & container monitors (≈1 week)
- `postgres`/`mysql`/`redis`/`mongodb` monitors (connection + `SELECT 1`/`PING`),
  `docker` monitor via socket/TLS (`docker_hosts` CRUD), TCP/ICMP/DNS types.
- Dependency suppression (`parent_id`), group monitors with strategies.
- **Exit**: postgres monitor detects a stopped DB within one interval; parent-down
  suppresses child alerts.

## M5 — Agent image, multi-arch release (≈1 week)
- `agent` role: WS link to server, pulls assigned monitors, pulses with retry queue +
  ack (PulseMonitor-style), HTTP fallback.
- CI: buildx amd64/arm64 → GHCR on tags; SBOM; semver release workflow (agentic-bootstrap
  RELEASING convention).
- **Exit**: `arm64` box runs the agent image and reports as a vantage point.

## M6 — Power-user & polish (≈1 week)
- Config export/import (TOML/JSON) + `openapi-bootstrap` generator script (SPEC §9).
- Backup/restore (SQLite snapshot API), retention/rollup job, import from Uptime-Kuma
  (best-effort monitors+heartbeats mapping).
- **Exit**: Kuma import produces working monitors; export → fresh container reproduces
  configuration.

## Risks & mitigations
| Risk | Mitigation |
|---|---|
| Native modules on musl/arm64 | pin `better-sqlite3` ≥ 12 (tarball carries `prebuilds/linuxmusl-*.node`); approve build scripts (`pnpm onlyBuiltDependencies`); build+runtime on the same libc; M1 CI job builds AND runs the image on linux/amd64 + linux/arm64 |
| WS through user proxies | SSE fallback endpoint (M3) |
| Feature creep toward Kuma parity | M-milestones gate; non-goals in SPEC §1 |
| Check storms on wide intervals | global/per-host concurrency caps (SPEC §6) |
