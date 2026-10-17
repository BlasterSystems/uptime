# Uptime Monitoring — Product & Technical Specification

Version: 1.0 · Status: **Implemented** (single-container scope; deviations tracked in [§14](#14-deviations-from-the-spec)) · Owner: Carrigo/infra
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
   - documented Postgres path cover durability; distributed setups use the optional
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
│   ├── server/        Express 5 + TS — REST /api/v1, SSE hub (/api/v1/events), check scheduler,
│   │                  push receiver, notification dispatcher, /metrics, /healthz
│   └── web/           Vue 3 + Vite SPA (embedded into the server image as static files)
├── packages/
│   ├── core/          Monitor/check engine, expected-conditions, templating, config schema
│   ├── db/            Drizzle schema + migrations (SQLite; Postgres dialect planned, §14)
│   ├── notify/        Notification providers (Telegram, Discord, Slack, email, Ntfy, Gotify, webhook)
│   └── agent/         Optional remote agent (same check engine; WS attempt + HTTP fallback)
├── docker/            Dockerfile (multi-stage, one image, subcommand entrypoint), compose
└── docs/              This spec, research, plan, ADRs
```

- **One image, two roles**: the Dockerfile entrypoint (`node dist/main.js`, `CMD ["server"]`)
  dispatches on argv — `docker run <image> agent` runs the agent role for remote vantage
  points. Both images are built from the same repo; the agent image currently keeps the
  web bundle (a stripped variant is a documented future optimization).
- **Check execution**: the server schedules `http` monitors on `setTimeout` schedules with
  jitter; push and group monitors run in their own engines (silence sweep / member
  evaluation); the remaining probe types (tcp/dns/icmp/db/docker) execute via the
  optional agent. I/O-bound checks never block the loop. CPU-bound work (none planned
  in v1) would use worker threads.
- **Live updates**: SSE hub (`GET /api/v1/events`, viewer auth) broadcasting heartbeat,
  incident and maintenance events; `EventSource` reconnects natively.
- **Vantage points**: server checks run from wherever the container runs (like
  Uptime-Kuma/Gatus). Agents (M5) allow remote regions; the server aggregates per
  vantage point like PulseMonitor.

## 3. Monitor types (v1.0)

| Type                                                 | Key options                                                                                 | Success criteria                                                                            | Inspired by                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `http`                                               | method (GET/POST/HEAD/PUT/DELETE), url, headers, body, timeout, `acceptedStatus: [200..299] | any`, `keyword: {value, inverse}`, `maxResponseMs`, `certExpiryDays`, `jsonPaths` (metrics) | 2xx (or accepted range) AND (keyword present/absent) AND latency ≤ cap; TLS cert valid ≥ N days | Kuma + Gatus |
| `tcp`                                                | host, port, timeout, `payload`, `expectResponse`                                            | connect (± round-trip) within timeout                                                       | Kuma/Pulse                                                                                      |
| `icmp`                                               | host, timeout, packetCount                                                                  | reply within timeout                                                                        | Kuma/Pulse (needs `NET_RAW`)                                                                    |
| `dns`                                                | host, resolver, port, recordType (A/AAAA/CNAME/MX/TXT/NS/SRV), expectedValue                | resolver answers; if `expectedValue`, match                                                 | Kuma                                                                                            |
| `push`                                               | token (path), graceSeconds, cron schedule (optional), `expectsBody`                         | heartbeat received within interval+grace; `/start`/`/fail` semantics                        | Healthchecks                                                                                    |
| `docker`                                             | docker host URI (socket/tcp + TLS), container name/id filter, `expectedState`               | container state == expected (state query on the monitor interval, via the agent)            | Kuma/Beszel                                                                                     |
| `postgres` / `mysql` / `mssql` / `mongodb` / `redis` | connection string, timeout, `query` (default `SELECT 1` / `PING`)                           | connection + query succeed                                                                  | PulseMonitor                                                                                    |
| `snmp` (v2c/v3)                                      | host, community/version/creds, oid, expectedValue                                           | query within timeout                                                                        | PulseMonitor (phase 2)                                                                          |
| `group`                                              | member monitor ids, strategy `any-up \| all-up \| percentage: N`                            | per strategy; **suppresses member notifications** when the group itself is down             | PulseMonitor groups                                                                             |

Every monitor: `name`, `interval` (min 20 s), `retries`, `retryInterval` (while down),
`resendNotificationInterval`, `maintenanceWindows[]`, `tags[]`, `notificationIds[]`,
`active`. Planned, not implemented (§14): `parentMonitorId` dependency suppression and
`upsideDownMode` invert semantics. Group monitors suppress member notifications while
the group itself is down.

### Push semantics (from Healthchecks)

`GET/POST /api/v1/push/<token>` → success. `/start` marks a run started (duration
tracking). `/fail` marks failure with optional `?body=` log capture (first 1 KB
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
         -- single table (SQLite, WAL); rollup tables kept fresh every 15 s:
         -- heartbeats_hourly / heartbeats_daily(monitor_id, bucket, up, down, maintenance, total_ms, count)
incidents(id, monitor_id, opened_at, resolved_at, title, body)
maintenance_windows(id, monitor_scope (all|ids|tags), strategy single|recurring-interval|
         recurring-weekday|cron, start_at, end_at, cron_tz, active)
status_pages(id, slug, title, logo, published, monitor_ids[], structure (component
             groups JSON), footer_text, password_hash, theme)
status_incidents(id, page_id, title, status investigating|identified|monitoring|resolved,
             impact none|minor|major|critical, component_ids[], source auto|manual,
             monitor_id, created_at, updated_at, resolved_at)
status_incident_updates(id, incident_id, status, body, created_at)
status_subscriptions(id, page_id, channel_id, component_ids[], events[], created_at)
docker_hosts(id, name, uri, tls_ca_enc, tls_cert_enc, tls_key_enc)  -- for docker monitors
password_reset_tokens(id, user_id→users, token_hash UNIQUE sha256, expires_at, used_at, created_at)
mailer_settings(id, provider 'resend', api_key_enc, from_address, enabled, updated_at)  -- singleton
settings(key, value)                                   -- instance-level (title, timezone)
push_tokens(id, monitor_id UNIQUE, token_hash, created_at)
```

- Retention: raw heartbeats default **180 days** (configurable), aggregates kept 2 years.
- Encryption: `ENCRYPTION_KEY` (32-byte) env; AES-256-GCM; documented rotation (ADR-0002).

## 5. HTTP API (`/api/v1`, JSON; auth below)

```
POST   /auth/setup | /auth/login | /auth/logout · GET /auth/me
POST   /auth/2fa/setup | /auth/2fa/verify | /auth/2fa/disable
POST   /auth/api-keys · GET /auth/api-keys · DELETE /auth/api-keys/:id   (admin)
CRUD   /monitors            (no per-check dry-run endpoint — §14)
GET    /monitors/:id/heartbeats?limit=1..1000 (default 100, newest first)
GET    /monitors/:id/uptime?hours=24|7|30|365
GET    /api/v1/push/:token[/start|/fail]      (no auth — token IS the secret)
CRUD   /notifications       (+ POST /notifications/:id/test)
CRUD   /maintenance-windows | /status-pages | /docker-hosts
POST   /status-incidents/:id/updates · PATCH /status-incidents/:id
CRUD   /status-pages/:id/subscriptions (admin) · POST /status-subscriptions/:id/test
GET    /tags (read-only; tags are created implicitly via monitor `tags` names)
GET    /incidents?active=1|0
GET    /metrics              (Prometheus — no auth by default, IP/allowlist option)
GET    /healthz              (liveness: process + db ping, no auth)
POST   /config/export | /config/import   (JSON snapshot — admin only)
GET    /api/v1/events        (SSE hub — the live transport; viewer auth)
```

Admin API for automation (used by the OpenAPI bootstrap script, §9): same CRUD with an
`api_key` bearer, `scopes: [read|write|admin]`.

## 6. Scheduler & check engine (packages/core)

- Each active **http** monitor gets a scheduler entry; drift-corrected (`next = start + n*interval`),
  ±10 % jitter to avoid thundering herds. Other engine types are not probe-scheduled
  server-side (§14): push runs in its silence sweep, group in its member evaluation,
  tcp/dns/icmp/db/docker execute via the agent.
- While down: probe at `retry_interval` (default 60 s) instead of `interval`; incident
  opens after `retries` consecutive failures; recovery closes it + sends notification.
- Push monitors: no scheduler — token receiver + expiry sweep every 30 s.
- Docker monitors: a single state query per probe, executed via the agent on the
  monitor interval; no event stream.
- All checks share a global concurrency cap (default 50) and per-host cap (5).
- Time: monotonic for latency, wall-clock for records; live checks write one
  heartbeat row synchronously per result (imports can batch via
  `insertHeartbeatsBatch`); rollup job runs every 15 s.

## 7. Notifications

Providers v1: Telegram, Discord, Slack (incoming webhook), Email (SMTP), Email
(Resend HTTP API), Ntfy, Gotify, generic Webhook (JSON template). Phase 2:
PagerDuty Events v2, Opsgenie, SMS (Twilio).

- Per-channel config stored **encrypted**; per-monitor routing; global defaults; test
  button; per-monitor `resendNotificationInterval`; templating with
  `{{monitor.name}} {{status}} {{downtime}} {{latency}} {{tags}}`; rate-limited to one
  message per monitor per `resendNotificationInterval`.

## 8. Security

- Argon2id password hashing; TOTP 2FA optional; session cookies `httpOnly` `SameSite=Lax`
  behind whatever TLS the user fronts (docs: NPM/Caddy/Traefik examples + compose labels).
- Self-service password recovery (`POST /auth/forgot-password` → single-use sha256-hashed
  token, 1 h, replaces outstanding tokens; reset revokes all sessions) — enumeration-safe
  (always 204, every attempt rate-counted per IP). The outbound email is sent through
  Resend; the API key is configured in Settings → General and encrypted at rest
  (`mailer_settings`, ADR-0002). With no mailer the flow is inert but still 204.
- API keys hashed (SHA-256), scoped, expirable; shown once.
- Secrets (notification configs, docker TLS, DB URLs) encrypted at rest (ADR-0002).
- Container: non-root UID 1001, `read_only: true` compatible (tmpfs `/tmp`), runtime
  stage on `node:24-alpine` (busybox shell present — there is no shell entrypoint or
  script in the image).
- No outbound telemetry. Updates are manual (Watchtower is the user's choice).
- CSRF: token-header pattern for cookie-authed mutations; API-key path is header-only.

## 9. OpenAPI integration (explicitly scoped)

**No automatic import** (research: none of Kuma/Gatus/PulseMonitor/Healthchecks supports
it). Instead:

1. The Admin API makes generation trivial: `scripts/openapi-bootstrap.mjs` (in-repo CLI,
   zero-dependency) reads an **OpenAPI 3 JSON** document (convert YAML first) and creates
   one `http` monitor per `GET` path with `acceptedStatus [200, 299]`, tagged
   `openapi:<title>`. Skips endpoints requiring auth unless a header map is provided;
   parameterised paths are skipped.
2. Per-endpoint **contract validation stays in CI** (Schemathesis/Dredd) — an uptime tool
   answers "is it up", not "does it match the spec".

## 10. Docker packaging (docker/)

- Multi-stage Dockerfile: `build` stage and `runtime` stage both on `node:24-alpine` —
  build and runtime must share the libc: a glibc-built `better-sqlite3` binary does not
  load under musl (`fcntl64: symbol not found`, verified on arm64). better-sqlite3 ≥ 12
  ships musl prebuilds in its tarball; the build stage also carries `python3/make/g++`
  so it can compile from source. Non-root, static web assets baked in.
- Same image, entrypoint subcommands: `server` (default) / `agent`.
- `VOLUME /data`; `ENV DATA_DIR=/data PORT=3001`; `HEALTHCHECK` hits `/healthz`.
- `docker-compose.yml` (root: server role) and `deploy/docker-compose.yml` (DEV VM
  variant); the agent role runs the same image with the `agent` subcommand — there is
  no separate agent compose file.
- CI: eslint, typecheck, vitest unit + integration (SQLite migrations + supertest),
  75 % coverage gate, and a multi-arch **build-only** image job (no publish, no e2e).
  Multi-arch buildx → GHCR runs on `v*` tags in `release.yml`.
- Resource envelope target: idle < 256 MB RSS, 100 monitors/30 s ≈ < 5 % of one core.

## 11. Web UI (apps/web, Vue 3 + Vite)

- Dashboard (Kuma-style cards: status color, latency, last check, tags filter).
- Monitor detail: heartbeat strip (90 days), uptime % (24h/7d/30d/365d), response-time
  chart, incidents, events; edit form is a hand-written per-type form whose fields mirror
  the packages/core schemas — server-side zod validation is authoritative (single source
  of truth in packages/core).
- Status pages: public, slug-based, component groups, live-reloading admin views,
  incident banner + archive, feeds + badge.
- Settings: profile, security (2FA), api keys, status pages, status incidents,
  subscriptions, maintenance windows, docker hosts, general (title/timezone plus the
  encrypted Resend email settings with a test send). Password recovery is self-service
  (login link → emailed single-use token → reset form). Notifications live on their own
  page. Backup/restore/retention/export are admin API endpoints (POST /backup,
  /restore, /retention/run, /config/export) without UI.

## 12. Roadmap

See [PLAN.md](PLAN.md). M1 (first slice of value: HTTP monitor + SQLite + dashboard
read-only) through M6 are delivered — milestone records live in `tasks/`. Remaining
scope is tracked in §14 below.

## 13. Explicitly deferred

Multi-user RBAC beyond admin/editor/viewer, LDAP/OIDC SSO, HA/clustering, distributed
TSDB backends, mobile push (via Ntfy/Telegram instead), k8s auto-discovery, synthetic
browser checks (Playwright), SNMP get-walks.

## 14. Deviations from the spec

Implemented reality as of 2026-10-11 — where sections above describe the original
design, this section is the contract:

- **Transport**: SSE only (`GET /api/v1/events`, viewer auth). No WebSocket hub, no
  `/socket` route.
- **Storage**: SQLite only. The Postgres dialect (ADR-0002 `DATABASE_URL` switch) is
  planned, not built.
- **Scheduling**: the server probe-schedules `http` monitors only. Push monitors run in
  their 30 s silence sweep, groups in member evaluation; tcp/dns/icmp/db/docker probes
  execute via the agent role.
- **Dependencies**: `parentId` is stored but has no runtime consumer and the API cannot
  set it; incident suppression is group-membership based. `upsideDown` is stored without
  semantics.
- **API deltas**: no `POST /monitors/:id/test`; heartbeats paginate with `?limit=`
  (no range/cursor); `GET /incidents` ignores `monitor_id`; config export/import is
  JSON (no TOML); API keys live under `/api/v1/auth/api-keys` (POST/GET/DELETE);
  push `/fail?body=` stores the first 1 KB.
- **Heartbeat storage**: one table + `heartbeats_hourly`/`heartbeats_daily` rollups
  (no day-partitioned tables); inserts are synchronous single-row writes (batching
  exists only for imports); the rollup job runs every 15 s, not hourly.
- **Packaging/CI**: entrypoint is `node dist/main.js` argv dispatch (no
  docker-entrypoint.sh, no stripped agent image); CI lints with eslint only (prettier
  is not enforced), and the image job builds without running (no compose e2e).
- **UI**: hand-written per-type monitor form (no JSON-schema-driven generation); no
  dashboard sparkline; no backup/retention/export UI (admin API only).
