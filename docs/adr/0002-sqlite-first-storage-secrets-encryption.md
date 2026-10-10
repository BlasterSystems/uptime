# ADR-0002: SQLite-first storage, Postgres as switch; secrets encrypted at rest

- **Status:** Accepted
- **Date:** 2026-10-10
- **Decision owners:** Not assigned
- **Scope:** Persistence engines, schema tooling, retention, secrets at rest
- **Tags:** storage, sqlite, postgres, encryption, security
- **Supersedes:** None
- **Superseded by:** None

## Context

Uptime-Kuma proves SQLite (better-sqlite3 + WAL) is sufficient for a self-hosted monitor
with thousands of heartbeats/day. Gatus supports Postgres natively. PulseMonitor chose
ClickHouse — heavy for the 95% case. Whatever we choose must survive `docker compose
down/up` with only a bind-mounted directory, and keep notification credentials safe.

## Decision drivers

- Zero-dependency default deployment: `docker compose down/up` with a bind-mounted
  directory must not lose data or require an external database.
- Notification channel configs, docker TLS material and TOTP secrets must be encrypted
  at rest; the DB file is a copyable artifact.
- SQLite (better-sqlite3 + WAL) is proven for this workload class (Uptime-Kuma).
- Users who already run Postgres (our carrigo dev VM) should be able to use it without a
  fork.
- Bounded retention and single-file backup are operational requirements.
- ClickHouse-class time-series storage is overkill for the 95% case.

## Considered options

### Option 1: SQLite (WAL) default, PostgreSQL as an env switch (chosen)

Single file under `/data/uptime.db`, day-partitioned heartbeat tables + hourly rollups
(Kuma pattern); `DATABASE_URL` selects PostgreSQL with the same Drizzle schema and
per-dialect migrations.

### Option 2: SQLite only

Simplest — one dialect, one migration path — but abandons users who already run Postgres
and forfeits the durability/scale path (Gatus supports Postgres natively).

### Option 3: PostgreSQL only

Durability and scale out of the box, but breaks the zero-dependency default deployment
for the 95% case.

### Option 4: ClickHouse (PulseMonitor-like)

Scales further for large heartbeat volumes, but is heavy for the 95% case and adds an
external dependency; deferred behind the `packages/db` interface until >10⁷ heartbeats
use cases appear (SPEC §13).

### Option 5: Plaintext secret storage

Simplest schema, but notification credentials and TOTP secrets would be readable in DB
backups and copied data directories; rejected.

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

### Positive

- Zero-dependency default deployment; backup = copy one file (+ snapshot API).
- Postgres path gives durability/scale for users who already run Postgres (our carrigo
  dev VM does).

### Negative

- Two dialects to test per migration; mitigated by Drizzle dialect matrices in CI.
- A time-series engine (ClickHouse) would scale further; deferred behind `packages/db`
  interface until >10⁷ heartbeats use cases appear (SPEC §13).
- `ENCRYPTION_KEY` loss = unrecoverable secrets; documented loudly.

### Risks and mitigations

- Risk: better-sqlite3 native builds break on arm64. Mitigation: prebuilt binaries exist;
  CI builds on both arches early (PLAN.md risks, M1).
- Risk: unbounded WAL/heartbeat growth on busy instances. Mitigation: hourly rollups and
  configurable retention bounds.
- Risk: key rotation corrupts or strands secrets. Mitigation: dedicated re-encrypt script
  documented and tested as part of the key-rotation runbook.

## Implementation and validation

Schema and migrations land with PLAN.md M1 (SQLite/WAL heartbeats via Drizzle) and extend
through M2 (incidents, notifications) and M6 (retention/rollup job, SQLite snapshot
backup/restore). Postgres dialect coverage is exercised by CI dialect matrices with the
M1 pipeline. Validation today is `.agentic/bin/validate` plus `.agentic/bin/docs-check`;
the M1 exit criterion (heartbeat visible in SQLite after `docker compose up`) exercises
the default storage path.

## Revisit triggers

- >10⁷-heartbeat use cases appear, making ClickHouse worth its operational cost.
- PostgreSQL becomes the dominant deployment, making dual-dialect maintenance wasteful.
- Key rotation or the encryption scheme proves operationally unsafe.

## References

- [SPEC.md](../SPEC.md) — data model (two dialects), explicitly deferred backends.
- [PLAN.md](../PLAN.md) — M1, M2, M6; native-build risks.
- [research/oss-comparison.md](../../research/oss-comparison.md)
- [ARCHITECTURE.md](../ARCHITECTURE.md)
- [ADR-0004](0004-docker-first-packaging.md) — bind-mounted `/data` contract.
