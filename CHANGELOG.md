# Changelog

All notable, user-visible changes are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (release process:
[docs/RELEASING.md](docs/RELEASING.md)).

## [Unreleased]

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
