# Architecture

Authoritative detail: [SPEC.md](SPEC.md). This page maps components to deployment.

## Component map

```
┌──────────────────────────── one Docker image (role: server) ───────────────────────────┐
│  apps/web (Vue 3 SPA, static)      apps/server (Express 5 + TS)                        │
│      │  served as static files         │  REST /api/v1  · /api/v1/events (SSE) · /api/v1/push │
│      └──────────────►──────────────────┤  /metrics · /healthz                          │
│                                        │  scheduler + check engine (packages/core)     │
│                                        │  notification dispatcher                      │
│  packages/db (Drizzle) ── SQLite /data/uptime.db (WAL) ── or Postgres via DATABASE_URL  │
└────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ probes: HTTP/TCP/ICMP/DNS/DB/docker         ▲ push: /api/v1/push/<token>

┌──────────── one Docker image (role: agent, optional, M5) ────────────┐
│  packages/agent — WS attempt + HTTP fallback: pulls assigned         │
│  monitors from /api/v1/agent, pulses results back                    │
└──────────────────────────────────────────────────────────────────────┘
```

## Process model

- **Single process** for the server role: HTTP listener + scheduler + notifier. All v1
  monitors are I/O-bound; the event loop handles hundreds of concurrent probes without
  threads. Concurrency caps global (50) and per-host (5) protect flaky targets.
- **Synchronous single-row inserts** for heartbeats (SQLite WAL); the rollup job runs
  every 15 s (SPEC §4 retention model). Batching exists only for bulk imports.
- The agent role is the same check engine with an HTTP control plane
  (`/api/v1/agent/*`) instead of the full HTTP API + UI; it holds no database. The
  agent client attempts a WS link first and falls back to HTTP polling.

## Data flow (down incident)

```
scheduler → check engine (http) → N fails ≥ retries
  → incident opened (db) → notification dispatcher (channels, per-monitor routing)
  → SSE broadcast {heartbeat, incident} → UI live update
  → prometheus gauges updated → /metrics scrape
```

## Storage

SQLite (WAL) only today; the Drizzle dialect switch to Postgres is planned, not built
(SPEC §14). Rationale and rejected options in
[ADR-0002](adr/0002-sqlite-first-storage-secrets-encryption.md).

## Deployment

Compose-first; single image for the server role, same repo builds the agent image
(ADR-0004). TLS is delegated to the user's existing reverse proxy (documented NPM/
Caddy/Traefik examples) — the container itself speaks plain HTTP on 3001.
