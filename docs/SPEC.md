# Uptime Monitoring — Product & Technical Specification

Version: 1.0-draft · Status: **Proposed** · Owner: Carrigo/infra
Related: [research/oss-comparison.md](research/oss-comparison.md) · [PLAN.md](PLAN.md) · [adr/](adr/)

A single-repository, Docker-first, self-hosted health monitoring service: one container
that probes your HTTP/TCP/ICMP/DNS/database endpoints (or accepts push heartbeats from
them), stores results in SQLite by default, serves an embedded real-time UI, sends
notifications, and exposes Prometheus metrics and status pages.

---

## 1. Goals

1. **One command to run**: `docker compose up` with a single image and a bind-mounted
   `/data` volume. No external database, no sidecars, no reverse proxy required.
2. **One repository**: server, web UI, optional agent, shared check engine and schema in
   a TypeScript monorepo. Two images (`server`, `agent`) build from one Dockerfile.
3. **Zero-config useful**: UI-first monitor editing; the container is useful with only a
   volume and a port.
4. **Low resource**: < 256 MB RSS idle; checks are I/O-bound and event-loop friendly.
5. **Multi-platform images**: `linux/amd64` + `linux/arm64` via GitHub Actions → GHCR.
6. **Honest single-node**: this is a self-hosted tool, not an HA cluster. Backup/restore
   + documented Postgres path cover durability; distributed setups use the optional
   agent (M5), not sharded servers.

### Non-goals (v1)

- Application-performance tracing, log aggregation, APM — complementary tools.
- Kubernetes operators/Helm charts (compose-first; charts can come later).
- Multi-tenant SaaS (single team instance; simple roles only).
- Time-series storage engines (ClickHouse/Timescale) — behind an interface, phase 3.
- Auto-discovery providers (k8s/docker watch) — phase 3 (Beszel/Gatus territory).

## 2. Architecture overview

```
uptime-monitoring/                 (one repository — pnpm workspaces)
├── apps/
│   ├── server/        Express 5 + TS — REST /api/v1, WebSocket hub, check scheduler,
│   │                  push receiver, notification dispatcher, /metrics, /healthz
│   ├── web/           Vue 3 + Vite SPA (embedded into the server image as static files)
│   └── agent/         Optional remote agent (same check engine; WS link to server)
├── packages/
│   ├── core/          Monitor/check engine, expected-conditions, templating, config schema
│   └── db/            Drizzle schema + migrations (better-sqlite3 & node-postgres dialects)
├── docker/            Dockerfile (multi-stage, one image, subcommand entrypoint), compose
└── docs/              This spec, research, plan, ADRs
```

- **One image, two roles**: the Dockerfile `ENTRYPOINT ["docker-entrypoint.sh"]` dispatches
  `server` (default) and `agent` subcommands — `docker run … uptime-agent` role for remote
  vantage points. Both images are built from the same repo; `agent` is just a tagged
  variant with the web bundle stripped.
- **Check execution**: the server process runs all monitors on `setTimeout` schedules
  with jitter; I/O-bound checks (net/dns/http/db) never block the loop. CPU-bound work
  (none planned in v1) would use worker threads.
- **Live updates**: WebSocket channel (`/socket`) broadcasting heartbeat, uptime and
  incident events; SSE fallback endpoint for restrictive proxies.
- **Vantage points**: server checks run from wherever the container runs (like
  Uptime-Kuma/Gatus). Agents (M5) allow remote regions; the server aggregates per
  vantage point like PulseMonitor.

## 3. Monitor types (v1.0)

| Type | Key options | Success criteria | Inspired by |
|---|---|---|---|
| `http` | method (GET/POST/HEAD/PUT/DELETE), url, headers, body, timeout, `acceptedStatus: [200..299] | any`, `keyword: {value, inverse}`, `maxResponseMs`, `certExpiryDays`, `jsonPaths` (metrics) | 2xx (or accepted range) AND (keyword present/absent) AND latency ≤ cap; TLS cert valid ≥ N days | Kuma + Gatus |
| `tcp` | host, port, timeout, `payload`, `expectResponse` | connect (± round-trip) within timeout | Kuma/Pulse |
| `icmp` | host, timeout, packetCount | reply within timeout | Kuma/Pulse (needs `NET_RAW`) |
| `dns` | host, resolver, port, recordType (A/AAAA/CNAME/MX/TXT/NS/SRV), expectedValue | resolver answers; if `expectedValue`, match | Kuma |
| `push` | token (path), graceSeconds, cron schedule (optional), `expectsBody` | heartbeat received within interval+grace; `/start`/`/fail` semantics | Healthchecks |
| `docker` | docker host URI (socket/tcp + TLS), container name/id filter, `expectedState` | container state == expected (event-driven + poll fallback) | Kuma/Beszel |
| `postgres` / `mysql` / `mssql` / `mongodb` / `redis` | connection string, timeout, `query` (default `SELECT 1` / `PING`) | connection + query succeed | PulseMonitor |
| `snmp` (v2c/v3) | host, community/version/creds, oid, expectedValue | query within timeout | PulseMonitor (phase 2) |
| `group` | member monitor ids, strategy `any-up \| all-up \| percentage: N` | per strategy; **suppresses member notifications** when the group itself is down | PulseMonitor groups |

Every monitor: `name`, `interval` (min 20 s), `retries`, `retryInterval` (while down),
`resendNotificationInterval`, `maintenanceWindows[]`, `tags[]`, `notificationIds[]`,
`parentMonitorId` (dependency: if the parent is down, child incidents are suppressed),
`active`, `upsideDownMode` (invert semantics).

### Push semantics (from Healthchecks)

`GET/POST /api/v1/push/<token>` → success. `/start` marks a run started (duration
tracking). `/fail` marks failure with optional `?body=` log capture (first 10 KB
stored). Missed interval+grace → down incident. Cron-scheduled pushes: `* * * * *`
plus timezone.

## 4. Data model (Drizzle, two dialects)

SQLite (default, WAL, `PRAGMA foreign_keys=on`, busy_timeout) and PostgreSQL
(`DATABASE_URL` switch — ADR-0002). Tables:

```
users(id, email UNIQUE, password_hash argon2id, totp_secret_enc, role admin|editor|viewer, created_at)
sessions(id, user_id, expires_at, ip, user_agent)
api_keys(id, name, key_hash, scopes[], created_by, last_used_at, expires_at)
monitors(id, type, name, active, interval_s, retries, retry_interval_s,
         resend_notification_s, upside_down, parent_id→monitors, config_json,
         created_at, updated_at)                       -- config_json validated per type by packages/core
tags(id, name, color); monitor_tags(monitor_id, tag_id)
notification_channels(id, type, config_enc AES-256-GCM, is_default, active)
monitor_notifications(monitor_id, channel_id)
heartbeats(id PK autoincrement, monitor_id, status up|down|pending|maintenance,
           latency_ms, response_snippet (first 1 KB), time)
         -- SQLite: partitioned by day tables `heartbeats_YYYYMMDD`; hourly rollup
         -- `heartbeats_hourly(monitor_id, hour_bucket, up_count, down_count, avg_ms, p95_ms)`
incidents(id, monitor_id, opened_at, resolved_at, title, body)
maintenance_windows(id, monitor_scope (all|ids|tags), strategy single|recurring-interval|
         recurring-weekday|cron, start_at, end_at, cron_tz, active)
status_pages(id, slug, title, logo, published, group_ids[], monitor_ids[], theme)
docker_hosts(id, name, uri, tls_ca_enc, tls_cert_enc, tls_key_enc)  -- for docker monitors
settings(key, value)                                   -- instance-level (title, timezone, retention)
push_tokens(id, monitor_id UNIQUE, token_hash, created_at)
```

- Retention: raw heartbeats default **180 days** (configurable), aggregates kept 2 years.
- Encryption: `ENCRYPTION_KEY` (32-byte) env; AES-256-GCM; documented rotation (ADR-0002).

## 5. HTTP API (`/api/v1`, JSON; auth below)

```
POST   /auth/login | /auth/logout | /auth/2fa | GET /auth/me
CRUD   /monitors            (+ POST /monitors/:id/test  — dry-run a check now)
GET    /monitors/:id/heartbeats?range=|cursor=
GET    /monitors/:id/uptime?hours=24|7|30|365
GET    /api/v1/push/:token[/start|/fail]      (no auth — token IS the secret)
CRUD   /notifications       (+ POST /notifications/:id/test)
CRUD   /maintenance-windows | /status-pages | /api-keys | /docker-hosts | /tags
GET    /incidents?active=1&monitor_id=
GET    /metrics              (Prometheus — no auth by default, IP/allowlist option)
GET    /healthz              (liveness: process + db ping, no auth)
POST   /config/export | /config/import   (TOML/JSON snapshot — Gatus-style, admin only)
GET    /socket               (WebSocket hub; SSE at /api/v1/events as fallback)
```

Admin API for automation (used by the OpenAPI bootstrap script, §9): same CRUD with an
`api_key` bearer, `scopes: [read|write|admin]`.

## 6. Scheduler & check engine (packages/core)

- Each active monitor gets a scheduler entry; drift-corrected (`next = start + n*interval`),
  ±10 % jitter to avoid thundering herds.
- While down: probe at `retry_interval` (default 60 s) instead of `interval`; incident
  opens after `retries` consecutive failures; recovery closes it + sends notification.
- Push monitors: no scheduler — token receiver + expiry sweep every 30 s.
- Docker monitors: event stream (if reachable) + 60 s poll fallback.
- All checks share a global concurrency cap (default 50) and per-host cap (5).
- Time: monotonic for latency, wall-clock for records; heartbeats written through a
  single-writer queue (SQLite WAL friendly), batched inserts (500 ms window).

## 7. Notifications

Providers v1: Telegram, Discord, Slack (incoming webhook), Email (SMTP), Ntfy, Gotify,
generic Webhook (JSON template). Phase 2: PagerDuty Events v2, Opsgenie, SMS (Twilio).

- Per-channel config stored **encrypted**; per-monitor routing; global defaults; test
  button; per-monitor `resendNotificationInterval`; templating with
  `{{monitor.name}} {{status}} {{downtime}} {{latency}} {{tags}}`; rate-limited to one
  message per monitor per `resendNotificationInterval`.

## 8. Security

- Argon2id password hashing; TOTP 2FA optional; session cookies `httpOnly` `SameSite=Lax`
  behind whatever TLS the user fronts (docs: NPM/Caddy/Traefik examples + compose labels).
- API keys hashed (SHA-256), scoped, expirable; shown once.
- Secrets (notification configs, docker TLS, DB URLs) encrypted at rest (ADR-0002).
- Container: non-root UID 1001, `read_only: true` compatible (tmpfs `/tmp`), no shell in
  final image, distroless-style node:24-alpine runtime stage.
- No outbound telemetry. Updates are manual (Watchtower is the user's choice).
- CSRF: token-header pattern for cookie-authed mutations; API-key path is header-only.

## 9. OpenAPI integration (explicitly scoped)

**No automatic import** (research: none of Kuma/Gatus/PulseMonitor/Healthchecks supports
it). Instead:
1. The Admin API makes generation trivial: `scripts/openapi-bootstrap.ts` (in-repo CLI)
   reads an OpenAPI 3 document and creates one `http` monitor per `GET` path with
   `acceptedStatus`, tagged `openapi:<title>`. Skips endpoints requiring auth unless a
   header map is provided.
2. Per-endpoint **contract validation stays in CI** (Schemathesis/Dredd) — an uptime tool
   answers "is it up", not "does it match the spec".

## 10. Docker packaging (docker/)

- Multi-stage Dockerfile: `build` stage (node:24-bookworm — native deps for
  better-sqlite3) → `runtime` (node:24-alpine, non-root, static web assets baked in).
- Same image, entrypoint subcommands: `server` (default) / `agent`.
- `VOLUME /data`; `ENV DATA_DIR=/data PORT=3001`; `HEALTHCHECK` hits `/healthz`.
- `docker-compose.yml`: service + volume + `env_file`; `docker-compose.agent.yml` example.
- CI: lint (eslint+prettier), typecheck, unit (vitest), integration (SQLite migrations +
  supertest), e2e (compose up → seeded probe → expect `/healthz` + a monitor flip),
  buildx multi-arch on `v*` tags → GHCR (`latest` + semver).
- Resource envelope target: idle < 256 MB RSS, 100 monitors/30 s ≈ < 5 % of one core.

## 11. Web UI (apps/web, Vue 3 + Vite)

- Dashboard (Kuma-style cards: status color, latency sparkline, last check, tags filter).
- Monitor detail: heartbeat strip (90 days), uptime % (24h/7d/30d/365d), response-time
  chart, incidents, events; edit form driven by the type's JSON schema (same schema the
  server validates — single source of truth in packages/core).
- Status pages: public, slug-based, group sections, live updates, incident banner.
- Settings: profile, 2FA, notification channels (+ test), api keys, appearance (light/
  dark/auto), backups (download SQLite snapshot), retention.

## 12. Roadmap

See [PLAN.md](PLAN.md). M1 first slice of value: HTTP monitor + SQLite + dashboard
read-only. M5 ships the agent image and multi-arch release.

## 13. Explicitly deferred

Multi-user RBAC beyond admin/editor/viewer, LDAP/OIDC SSO, HA/clustering, distributed
TSDB backends, mobile push (via Ntfy/Telegram instead), k8s auto-discovery, synthetic
browser checks (Playwright), SNMP get-walks.
