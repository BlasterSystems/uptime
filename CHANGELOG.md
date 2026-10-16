# Changelog

All notable, user-visible changes are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (release process:
[docs/RELEASING.md](docs/RELEASING.md)).

## [Unreleased]

### Added

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
- `docker` monitors are now actively scheduled (unix socket, tcp://, or TLS); the DEV
  compose mounts the host Docker socket read-only for them (`DOCKER_GID` in
  `deploy/.env`); the monitor form can pick a saved Docker host by name.

### Changed

- Adopted the BlasterSystems design system across the web UI: cool-grey paper /
  blue-black ink palette with the vermilion thread as the single accent, Fira
  Sans + DM Mono (self-hosted), square corners (2px controls, 4px panels),
  hairlines instead of shadows, DS thread-mark branding, shape-first status
  indicators (■ up / ◆ down / ○ pending, striped maintenance), mono uppercase
  labels/chips, and a thread response-time chart. Public status pages keep
  user-defined accent colours; all other chrome follows the design system.

### Added

- Initial v1 implementation: http/push/group check engine, monitor CRUD, sessions
  (Argon2id + TOTP 2FA + scoped API keys), 7 notification providers, incidents,
  SSE live UI, status pages (components, managed incidents, RSS/Atom feeds, SVG
  badge, subscriptions, password pages), maintenance windows, Prometheus metrics,
  uptime rollups, optional agent (WS attempt + HTTP fallback), Docker packaging,
  config export/import, backups, retention, Uptime-Kuma import, and in-app
  integration docs (`/docs`).
