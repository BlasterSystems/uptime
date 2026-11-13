# Changelog

All notable, user-visible changes are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (release process:
[docs/RELEASING.md](docs/RELEASING.md)).

## [Unreleased]

### Changed

- License switched from MIT to **Apache-2.0**.
- Test stack upgraded to vitest 4 (ast-aware coverage remapper; per-package
  coverage thresholds re-pinned to the vitest-4 baseline).
- Remaining transitive Dependabot alerts cleared via pinned overrides
  (`qs`, `minimatch`, `glob`, `esbuild`); the repository now has zero open
  Dependabot alerts.

### Removed

- **Docker monitors and docker hosts are cut end-to-end** (UP-21, ADR-0008).
  This is a breaking change riding the next major release:
  - `type: "docker"` monitors are no longer accepted — `POST /api/v1/monitors`
    with a docker config answers 400, and existing docker monitors are deleted by
    the `0007` migration together with their heartbeats, incidents, notification
    routing, tags and hourly/daily rollups. `docker_hosts` (including its stored
    TLS material) is dropped. Data is unrecoverable after the migration.
  - The `/api/v1/docker-hosts` endpoints are gone (404), along with the Settings →
    Docker hosts tab and the Docker monitor form. Watch container health with an
    `http` monitor against a healthcheck endpoint (or a reverse-proxied Docker
    API) instead.
  - Scheduling is `http`-only server-side; push/group engines and agent-executed
    types are unchanged.
  - The DEV/deploy compose no longer mounts the host Docker socket and no longer
    takes `DOCKER_GID` — **recreate the container** (`docker compose up -d`) after
    pulling this release; a plain restart keeps the stale mount.
- **Notification channels are pruned to Email (Resend)** (UP-17, ADR-0007). This
  is a breaking change riding the same major release:
  - The `telegram`, `discord`, `slack`, `email` (SMTP), `ntfy`, `gotify` and
    `webhook` channel types are removed. `POST`/`PATCH /api/v1/notifications`
    with a removed type answers 400 (`unsupported channel type`), and existing
    channels of those types are deleted by the `0008` migration together with
    their `monitor_notifications` routing and `status_subscriptions` rows —
    including rows left dangling under historical `PRAGMA foreign_keys = OFF`
    runs. Encrypted configs are unrecoverable after the migration:
    **re-create your channels as Email (Resend)**.
  - The `resend` channel config is unchanged (`apiKey`, `from`, `to`), and the
    optional instance mailer behind password recovery (`mailer_settings`) is
    untouched. The webhook-only notification templating is gone with the
    webhook provider.
  - Status-page RSS/Atom feeds are unchanged — still one feed per published
    status page (pull-based); email via Resend remains the push path.


## [1.0.0] — 2026-11-09

First public release.

### Added

- `TRUST_PROXY` environment variable (Express `trust proxy`): set it (usually
  `1`) when the container runs behind a reverse proxy, so `req.ip` — and with
  it every per-IP rate limit — and `req.secure` (Secure session cookies)
  reflect the real client and TLS termination.
- First-run admin setup (`POST /api/v1/auth/setup`) is now rate-limited like
  every other pre-auth endpoint (10 attempts/hour/IP) — an internet-exposed
  fresh volume can no longer be hammered while it waits for an admin.
- Heartbeat retention now runs daily by default (`RETENTION_DAYS`, 180-day
  default per SPEC §4; `RETENTION_DISABLE=1` opts out) instead of only on the
  manual `POST /api/v1/retention/run` endpoint, so unattended instances no
  longer grow raw heartbeats without bound.
- Maintenance-window bodies are validated server-side: unknown `strategy` or
  `scope` values, empty names and non-boolean `active` now answer 400 instead
  of persisting rows the engine silently ignores (SQLite text columns carry no
  CHECK constraint).
- Self-service password recovery: a "reset your password by email" link on the sign-in
  page emails a single-use token (1 h, replaces outstanding tokens); the reset signs
  every session out. The endpoint is enumeration-safe (always 204, per-IP rate
  limits on both steps).
- Outbound email via Resend: the API key and from-address are configured in
  Settings → General (stored AES-256-GCM encrypted, write-only, with a "send test
  email" check).
- `resend` notification channel (Resend HTTP API) alongside the SMTP email channel —
  incident open/recovery/resend notifications can now be delivered by email without a
  local SMTP relay.
- Response-time chart hover: moving the pointer over the chart pins a guide line to the
  nearest check and shows its latency and time as the pointer travels.
- Status pages advertise their incident feeds: RSS/Atom links in the page footer and
  `<link rel="alternate">` autodiscovery in the HTML shell.
- Per-monitor public visibility and a built-in public status overview: a monitor form
  toggle ("Show on the public status page") publishes a service to the unauthenticated
  `/status` page (`GET /api/v1/public/status`), which lists name, status, latency, 24 h
  uptime and maintenance windows — never target URLs or check config. Documented in
  ADR-0005. Status pages remain the tool for curated, branded pages.
- User management (Settings → Users, admin): create users, change roles, reset passwords
  and delete access via `GET/POST/PATCH/DELETE /api/v1/users`, with self-delete and
  last-admin guards; password resets sign the user out everywhere.
- Password change (Settings → Profile): `POST /api/v1/auth/change-password` verifies the
  current password and signs out every other session.
- Uptime-Kuma migration CLI: `node scripts/kuma-import.mjs <kuma.db>` converts a
  Kuma SQLite export into the `POST /api/v1/import/kuma` body (zero-dependency,
  uses the built-in `node:sqlite`; maps http/tcp/dns/icmp/push/docker and the
  database engines, skips paused and unknown monitors, reports the summary).
  Documented in the in-app `/docs` (Automation section).
- Reverse-proxy guide: `docs/deploy/proxy.md` — Caddy, Nginx Proxy Manager,
  Traefik (compose labels) and plain nginx snippets, SSE buffering/timeout
  notes, `METRICS_ALLOWLIST` advice and the `TRUST_PROXY` setting.
- The in-app `/docs` gained a **Remote agent** section (deploying the
  `uptime-agent` image, which monitor types execute only on an agent, token
  auth, retry-queue semantics), and the README agent compose example now passes
  `command: agent` (the image's default CMD is the server role).
- `docker` monitors are now actively scheduled (unix socket, tcp://, or TLS); the DEV
  compose mounts the host Docker socket read-only for them (`DOCKER_GID` in
  `deploy/.env`); the monitor form can pick a saved Docker host by name.

### Changed

- The demo seed is opt-in: a fresh instance starts with zero monitors unless
  `SEED=1` is set (`pnpm dev` and the root compose still pass it). Previously
  the flag was not consulted at all — every fresh instance was seeded.
- Adopted the BlasterSystems design system across the web UI: cool-grey paper /
  blue-black ink palette with the vermilion thread as the single accent, Fira
  Sans + DM Mono (self-hosted), square corners (2px controls, 4px panels),
  hairlines instead of shadows, DS thread-mark branding, shape-first status
  indicators (■ up / ◆ down / ○ pending, striped maintenance), mono uppercase
  labels/chips, and a thread response-time chart. Public status pages keep
  user-defined accent colours; all other chrome follows the design system.
- Uptime is now licensed under the Apache License, Version 2.0 (previously
  MIT).

### Fixed

- Public surfaces no longer display a latency value while a monitor is **down** —
  the failed check's elapsed time rendered as e.g. "10.00 s" next to a red
  status on dashboard cards, the monitor header, the public overview and
  status-page rows (they now show "—"). The dashboard's average latency now
  averages successful checks only.
- The monitor header's "Last check" label now ticks every second (it froze
  between 60 s polls) and can no longer render a future timestamp
  ("6s from now") on clock skew or a just-arrived SSE event.
- The status-page *Subscriptions* empty state now links to *Notifications*
  when the instance has no channels yet, instead of ending in a dead end.
- Agent-run monitor types (tcp, dns, icmp, postgres, mysql, mssql, mongodb, redis)
  execute again: the shared probe scheduler dropped every non-http/docker
  assignment, so these monitors were validated and stored but never probed
  anywhere (a regression from the docker-scheduling change). The agent now
  constructs its scheduler with the full type list.
- Agent pulses flow through the full result pipeline — incidents (open after
  `retries`, recovery, notifications), Prometheus gauges and the SSE hub —
  instead of only writing a heartbeat row. Agent-run monitors now alert.
- The agent's WS link actually works: the server ships the WS hub (ADR-0003),
  so agents stop cycling a failed WS attempt + timeout before every HTTP
  fallback. HTTP fallback stays as-is; pulses over both paths are integrated.

### Added

- Initial v1 implementation: http/push/group check engine, monitor CRUD, sessions
  (Argon2id + TOTP 2FA + scoped API keys), 8 notification providers, incidents,
  SSE live UI, status pages (components, managed incidents, RSS/Atom feeds, SVG
  badge, subscriptions, password pages), maintenance windows, Prometheus metrics,
  uptime rollups, optional agent (WS attempt + HTTP fallback), Docker packaging,
  config export/import, backups, retention, Uptime-Kuma import, and in-app
  integration docs (`/docs`).
