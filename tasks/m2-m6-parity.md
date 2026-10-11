# Task: M2–M6 — researched-repository feature parity

## Objective

Complete the v1 feature set of docs/SPEC.md (the union of Uptime-Kuma, Gatus,
PulseMonitor, Healthchecks capabilities selected in docs/research/oss-comparison.md):
auth + notifications + incidents + push monitors (M2), realtime/status pages/metrics/
maintenance (M3), all monitor types + groups + suppression (M4), the optional agent +
release engineering (M5), and lifecycle/interop (M6) — with a modern enterprise UI and
≥75% test coverage.

## Acceptance criteria

- [x] Auth: Argon2id sessions, TOTP 2FA + recovery codes, API keys (hashed, scoped),
      first-run setup, login rate limiting, CSRF token-header.
- [x] Notifications: 7 providers + templating + test-send + incident routing + group-down
      suppression.
- [x] All SPEC §3 monitor types with real probe implementations (http, push, tcp, dns,
      icmp, postgres, mysql, mssql, mongodb, redis, docker) + groups
      (any-up/all-up/percentage) + group-down notification suppression. Server-side
      probe scheduling is http-only — the other types execute via the agent
      (SPEC §14); `parent_id` dependency suppression is not implemented.
- [x] Realtime (SSE primary, polling fallback), status pages (CRUD + public page),
      Prometheus full (histogram, cert expiry, maintenance, per-tag), maintenance
      windows (single/recurring-interval/recurring-weekday/cron+tz), uptime API from
      hourly/daily rollups (plan-review B3 model).
- [x] Agent image role (WS client + retry queue + ack + HTTP fallback — server WS hub
      pending, agent runs via the documented HTTP fallback), release workflow
      (buildx amd64+arm64 → GHCR + SBOM).
- [x] Export/import, openapi-bootstrap, SQLite online backup, retention job,
      Uptime-Kuma import.
- [x] ≥75% line coverage enforced per package (notify 89 %, db 94 %, core 86 %,
      server 84 %) and gated in CI.

## Scope

### Included

Everything in SPEC v1 except explicitly deferred §13 items.

### Excluded

- Server-side WS hub for the agent (client protocol + HTTP fallback shipped; WS push
  assignment is a follow-up — the agent is fully functional via HTTP fallback).
- Password change UI (SPEC §11 does not list it; field is an honest disabled stub).
- Kuma import is JSON-body based (CLI converts the Kuma sqlite); YAML OpenAPI input.

## Validation evidence

- Tests: 278 passing (core 105, db 52, server 72, notify 35, agent 14).
- Coverage gate: `pnpm coverage` green with thresholds 75/75/75 (lines/functions/statements).
- Live smokes: M2 (setup→login→CSRF→push lifecycle→incidents), M3 (SSE events, incidents,
  maintenance heartbeats, public status payload, uptime API), M5 (agent pulses via HTTP
  fallback), all captured in session.
- Browser-verified: dashboard (summary strip, tag filters, type badges, live updates),
  monitor detail (uptime chips, SVG chart, 90-day strip, incidents), settings tabs
  (docker hosts, status pages, maintenance, general), public status page (incident
  banner, per-monitor rows, open incidents), login/setup.
- `.agentic/bin/validate` + docs-check green.

## Architecture impact

- No new ADRs: follows accepted ADR-0001..0004. Deviations from SPEC §10 (same-libc
  build) and §4 (single heartbeats table + rollups per review B3) were corrected in
  SPEC/PLAN during the review step (commit d5c07dc).

## Review

- Correctness: contract-frozen parallel slices; every slice carries its own test suite;
  integration points (app.ts, main.ts) covered by integration tests.
- Security: encrypted secrets at rest (AES-256-GCM), hashed tokens, CSRF, rate limiting,
  non-root read-only container. M1-era unauthenticated API fully replaced by the auth
  middleware (bearer API-key or session).
- Compatibility: Node 24, pnpm 10; Express 5 semantics respected throughout.
- Residual risks: server-side WS agent hub pending (HTTP fallback is the working path);
  `parent_id` dependency suppression unimplemented (group-down suppression is what
  ships — SPEC §14); password-change UI stubbed; Kuma import expects a converted JSON
  payload.
