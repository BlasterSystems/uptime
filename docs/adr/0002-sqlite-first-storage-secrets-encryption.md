# ADR-0002: SQLite-first storage, Postgres as switch; secrets encrypted at rest

- **Status**: Accepted
- **Date**: 2026-10-10

## Context

Uptime-Kuma proves SQLite (better-sqlite3 + WAL) is sufficient for a self-hosted monitor
with thousands of heartbeats/day. Gatus supports Postgres natively. PulseMonitor chose
ClickHouse — heavy for the 95% case. Whatever we choose must survive `docker compose
down/up` with only a bind-mounted directory, and keep notification credentials safe.

## Decision

1. **SQLite (WAL) is the default and only required storage**: single file under
   `/data/uptime.db`, day-partitioned heartbeat tables + hourly rollups (Kuma pattern).
2. **PostgreSQL is an env switch** (`DATABASE_URL`) using the same Drizzle schema and
   per-dialect migrations — no feature is SQLite-only.
3. **Secrets at rest** (notification channel configs, docker TLS material, TOTP secrets)
   are AES-256-GCM encrypted with `ENCRYPTION_KEY`; key rotation documented (re-encrypt
   script). The key is deployment-level env, never stored in the DB.
4. Retention: raw heartbeats 180 days default, rollups 2 years, configurable.

## Consequences

- **+** Zero-dependency default deployment; backup = copy one file (+ snapshot API).
- **+** Postgres path gives durability/scale for users who already run Postgres (our carrigo dev VM does).
- **−** Two dialects to test per migration; mitigated by Drizzle dialect matrices in CI.
- **−** A time-series engine (ClickHouse) would scale further; deferred behind `packages/db`
  interface until >10⁷ heartbeats use cases appear (SPEC §13).
- **−** `ENCRYPTION_KEY` loss = unrecoverable secrets; documented loudly.
