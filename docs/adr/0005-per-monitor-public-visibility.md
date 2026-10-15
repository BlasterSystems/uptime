# ADR-0005: Per-monitor public visibility and the built-in public status overview

- **Status:** Accepted
- **Date:** 2026-10-15
- **Decision owners:** Not assigned
- **Scope:** Access control, public exposure of monitor data, monitors schema, public web surface
- **Tags:** security, status-pages, monitors, api, vue
- **Supersedes:** None
- **Superseded by:** None

## Context

The whole app is behind credentials: every `/api/v1` router carries `requireAuth`, and the
SPA redirects unauthenticated visitors to sign-in. Public visibility so far existed only as
full status pages (`/status/:slug`): an operator hand-builds a page, adds components, and
publishes it. Operators asked for a lighter model — pick individual services to make public
and get one easy-to-share page showing their status, without exposing targets or check
configuration.

## Decision drivers

- Exposure is security-sensitive: a public payload must never leak target URLs, connection
  strings, headers, or check configuration.
- The choice must be per service, reversible, and understandable without reading docs.
- Visitors need a single predictable URL (`/status`) that works signed-out, on the SPA.
- The existing status-page feature (branding, incidents, feeds, subscriptions) must keep
  working unchanged and stay the tool for curated multi-component pages.
- No new background jobs or sync processes.

## Considered options

### Option 1: `monitors.is_public` flag + built-in overview at `/status` (chosen)

A boolean column on `monitors`; one unauthenticated payload endpoint
(`GET /api/v1/public/status`) assembling name, heartbeat status, latency, 24 h uptime and
maintenance state for flagged monitors; a public SPA view renders it. A toggle in the
monitor form is the only control.

### Option 2: Auto-sync public monitors into a designated status page

Reuses the status-page renderer, but introduces a background sync process, ownership
questions (which page wins?), and surprising edits to hand-curated pages. Rejected.

### Option 3: Status pages only (no change)

No new schema, but operators must understand components/groups to publish one service, and
there is no single "all public services" URL. Rejected as too heavy for the stated need.

## Decision

Option 1. Visibility is a per-monitor `is_public` boolean (SQLite + PostgreSQL via the same
Drizzle schema, migration `0005_crazy_jazinda`). `parseMonitorBody` accepts `isPublic`
(create defaults to `false`), the admin monitor API returns it, and
`GET /api/v1/public/status` serves `buildPublicStatusPayload` — unauthenticated, cached
only by the client's 30 s poll. The public payload per service is limited to: `id`, `name`,
`type`, latest heartbeat `status`, `paused`, `inMaintenance`, `latencyMs`, `lastBeatAt`,
`uptimePct`. The overall ladder is outage > maintenance > unknown > operational; paused
services and down-during-maintenance never alarm. The SPA serves the overview at `/status`
(public route, works during first-run setup, polls every 30 s).

Status pages remain independent: a monitor flagged public is not automatically added to any
status page, and status pages are unaffected by the flag.

## Consequences

### Positive

- One-toggle publishing with a stable public URL; no background sync to reason about.
- The payload is minimal by construction; leaking new monitor fields requires an explicit
  code change to `buildPublicStatusPayload`.
- Works identically on SQLite and PostgreSQL (single schema, drizzle migration).

### Negative

- A second public surface exists next to status pages; operators can now expose a service
  without branding or incident history (by design, but worth documenting).
- `listMonitors()` feeds the payload, so very large fleets re-scan per request; acceptable
  at the intended scale (single-instance self-hosted), revisit with a dedicated query if
  needed.

### Risks and mitigations

- *Accidental exposure of an internal hostname*: the payload never includes target/config
  fields, and a test pins that `JSON.stringify(payload)` contains neither a private
  monitor's name nor its URL.
- *Stale status*: the client polls every 30 s; the data is read at request time from
  heartbeats and rollups, so there is no cache to invalidate.

## Implementation and validation

- Migration `packages/db/drizzle/0005_crazy_jazinda.sql`; `MonitorRow`/`NewMonitor`,
  `createMonitor`, `updateMonitor` handle the flag (`packages/db/src/index.ts`).
- `apps/server/src/public-status.ts` builds the payload; `apps/server/src/app.ts` wires
  `GET /api/v1/public/status`, the `isPublic` parser and the admin API field.
- `apps/web/src/views/PublicStatusView.vue` renders `/status`; the monitor form carries the
  toggle; cards/detail show a `public` chip.
- Tests: `packages/db/src/repo.test.ts` (persistence), `apps/server/src/public-status.test.ts`
  (no-auth access, redaction, paused/overall semantics, PATCH toggle, validation).

## Revisit triggers

- A request for per-service branding, incident narratives, or custom slugs on the overview —
  that is status pages; consider deep-linking the overview to them instead of growing it.
- Payload size or query cost becoming measurable at realistic fleet sizes.

## References

- [ADR-0002](0002-sqlite-first-storage-secrets-encryption.md) — storage and secrets baseline.
- `apps/server/src/status-pages.ts` — severity/status-page machinery the payload reuses
  (`uptime24h`, `maintenanceView`, `MaintenanceEngine`).
