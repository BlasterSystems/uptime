# Status pages — review and proposed feature set

Status: **proposal** · Reviewed: 2026-10-10 · Reference: [status.statuspage.me](https://status.statuspage.me)
· Related: SPEC §5/§11, PLAN M3, `docs/research/oss-comparison.md` (Kuma status pages)

## 1. What exists today (verified in the code)

| Area | Current state |
|---|---|
| Data | `status_pages(id, slug, title, logo, published, monitor_ids[], theme{accent,dark})`; no components/groups/ordering/descriptions |
| API | Admin CRUD `/api/v1/status-pages`; public `GET /api/v1/status/:slug` → flat monitor list (status, latency, uptimePct 24 h, tags) + open incidents |
| UI (public) | `/status/:slug`: themed shell (accent + light/dark/auto), red incident banner or green "All systems operational", flat component rows (name, tags, uptime 24 h, latency, status badge), open-incident list, footer |
| UI (admin) | Status page CRUD in Settings (slug/title/logo/published/monitor multi-select/accent/dark) |
| Already reusable | Monitor detail has **uptime chips (24 h/7 d/30 d/365 d), an inline-SVG response-time chart, a 90-day heartbeat strip, incidents table** (auth-only view today); `heartbeats_hourly/daily` rollups + `getUptime()`; maintenance windows engine; incident engine; SSE hub; 7 notification providers; UI kit |

Gap in one sentence: we render **monitors**, not a **status page** — no overall severity, no
component model, no managed incident communication, no history/archive, no subscriptions,
no feeds, no maintenance display, no per-component charts.

## 2. Reference analysis (status.statuspage.me, HTML inspected)

Feature inventory visible in the reference (an OSS, self-hosted status-page product):

- **Severity model**: operational / degraded / partial outage / major outage / maintenance /
  monitoring / unknown, with an overall badge ("All systems operational") and per-component pills.
- **Components**: cards with response-time charts (per-minute/hourly/yesterday series), downtime
  and maintenance annotations, availability metrics, incident markers.
- **Regions**: per-region history rows with 90-day day-ticks (multi-vantage product).
- **Incidents**: active banner + updates; an **incidents archive** page; maintenance page with
  styled active-maintenance cards.
- **Subscriptions**: "Subscribe" button (email/webhook), **RSS + Atom feeds**.
- **Distribution**: OG/Twitter meta + generated OG image, i18n strings, light/dark/system themes,
  layout variants (default/compact/spotlight/signal/minimal) and theme-token customization.
- **Extras**: dependency-provider boxes (upstream services), latency anomaly predictions
  (spike/degradation risk) annotated on charts.

Statuspage.io (the SaaS semantics people expect) adds: incident lifecycle statuses
(investigating → identified → monitoring → resolved), scheduled maintenance announcements,
subscriber notifications per update, component groups, private/password pages, custom domain,
and embeddable status badges.

## 3. Gap analysis and verdicts

| Feature | Reference | Ours | Verdict |
|---|---|---|---|
| Overall severity + banner | ✅ | binary banner only | **Adopt** (wave 1) |
| Component model (groups, labels, descriptions, order) | ✅ | flat monitor_ids | **Adopt** (wave 1) |
| Managed incidents with update timeline | ✅ | monitor-derived incidents only | **Adopt** (wave 1) |
| Incident archive page | ✅ | only open incidents | **Adopt** (wave 1) |
| Maintenance display (upcoming/active) | ✅ | engine exists, not shown publicly | **Adopt** (wave 1 — cheapest win) |
| 90-day uptime bars per component | ✅ | rollups exist; bars only in authed monitor detail | **Adopt** (wave 1) |
| Response-time chart per component | ✅ | SVG chart exists in monitor detail | **Adopt via component reuse** (wave 2) |
| RSS/Atom + JSON status + SVG badge | ✅ | JSON payload only | **Adopt** (wave 2) |
| Subscriptions (email/webhook per page, per component) | ✅ | notifier infra exists | **Adopt** (wave 2) |
| Customization: logo/footer/theme tokens/custom CSS | ✅ | logo/accent/dark | **Adopt** (wave 2, tokens not custom CSS) |
| Private/password pages | ✅ (SaaS) | published flag only | **Adopt** (wave 2, password) |
| OG meta + OG image | ✅ | none | **Adopt** (wave 2, meta + simple SVG/PNG render) |
| i18n | ✅ | en only | **Defer** (structure later; copy is small) |
| Per-region history | ✅ | agent exists, heartbeats not vantage-scoped | **Defer** → pairs with M5 WS hub + `heartbeats.agent_id` |
| Latency anomaly/prediction annotations | ✅ | none | **Defer** (stretch; z-score over rollups is feasible later) |
| Dependency providers section | ✅ | none | **Defer** (manual "linked status pages" list later) |
| Layout variants (spotlight/signal/…), custom CSS | ✅ | one layout | **Reject for now** (theme tokens + accent cover the 95 % case; revisit on request) |

## 4. Proposed feature set (3 waves)

### Wave 1 — "communicate trust" (core value, ~2 slices)
1. **Component model + overall status.**
   - `status_pages.structure` (JSON): `{ groups: [{ name, components: [{ monitorId, label, description, showUptime, showChart }] }] }`;
     migration-free (column add) + validation in `packages/core` (shared with the UI form).
   - Severity = worst-of components: `operational | degraded | partial_outage | major_outage | maintenance | unknown`;
     `degraded` when all up but any latency > its monitor's `maxResponseMs` (or page-level threshold);
     `maintenance` when all affected components are in a maintenance window.
   - Public payload + UI: overall banner ("All systems operational" / "Partial outage — 1 of 3 components"), grouped sections, per-component rows.
2. **Managed incidents + archive.**
   - New tables: `status_incidents(id, page_id, title, status investigating|identified|monitoring|resolved, impact none|minor|major|critical, component_ids[], created_at, resolved_at)` + `status_incident_updates(incident_id, status, body, created_at)`.
   - Auto-link: monitor incidents on page components auto-create a status incident update ("investigating") and resolve with it (`auto_publish` per page, default on); manual incidents ADR-free CRUD + UI editor (admin).
   - UI: active incident cards with update timeline on the public page; `/status/:slug/incidents` archive; admin tab for manual incidents.
3. **Maintenance + 90-day history (reuse).**
   - Public: upcoming/active maintenance from `maintenance_windows` scoped to page components (with the same scope resolver the engine uses — extract it).
   - Per-component 90-day uptime bars from `heartbeats_daily` (new `db.getDailyUptime(monitorId, days)`), down/maintenance days tinted, tooltip with date + pct; extracted into a shared `<UptimeBars>` component reused by monitor detail.

### Wave 2 — "distribution" (~2 slices)
4. **Charts + reuse extraction**: extract `MonitorDetailView`'s SVG response chart + heartbeat strip into `components/charts/` and render them on the public page (per component, configurable per `structure.showChart`). No chart deps.
5. **Feeds & badges**: `GET /status/:slug/rss.xml`, `/atom.xml`, `/status/:slug/badge.svg` (overall + `?component=`), `GET /api/v1/status/:slug` extended with severity/components/updates (JSON API stays unauthenticated but rate-limitable).
6. **Subscriptions**: `status_subscriptions(id, page_id, type email|webhook, target, component_ids[], token, verified_at, created_at)`; double opt-in email link; notify on incident open/update/resolve + maintenance start/end via the existing notifier (new `page` routing mode); unsubscribe with signed token; per-component filtering.
7. **Customization & access**: footer text + logo (URL), theme tokens (accent, mode — exist), **password-protected pages** (`password_hash` on the page, POST /status/:slug/unlock sets a short-lived cookie), OG meta + `/og/status/:slug.svg` render.

### Wave 3 — differentiators (defer, listed for shape)
8. Per-region history (needs `heartbeats.agent_id` + agent WS hub), latency-anomaly annotations from rollups, dependency-provider section, i18n.

## 5. Effort sketch and acceptance

| Slice | Scope | Acceptance |
|---|---|---|
| W1a | structure column + core schema/validation + severity computation + public payload + grouped UI | page with 3 components in 2 groups shows correct overall severity for up/down/maintenance/degraded states |
| W1b | status incidents + updates + auto-link + archive route | monitor goes down → status incident appears with timeline; resolve → archived with duration |
| W1c | maintenance display + daily uptime bars + shared `<UptimeBars>` | active maintenance window shows on the page; bars match `getUptime` for known fixtures |
| W2a | chart/strip extraction + public charts | monitor detail unchanged; public component shows 24 h chart |
| W2b | feeds + badge + extended JSON | RSS valid (W3C validator in CI smoke), badge SVG renders |
| W2c | subscriptions | email + webhook subscribers receive open/update/resolve; unsubscribe works |
| W2d | customization + password pages | wrong password → 401; correct → cookie; OG tags present |

Estimated: W1 ≈ 1 developer-week, W2 ≈ 1–1.5 weeks — mostly reusing existing engines
(rollups, maintenance resolver, notifier, incident engine) and UI kit; no new dependencies.

## 6. Decisions (resolved 2026-10-10, product owner)

1. **Auto-publish**: ON — every monitor incident on a page component is published automatically
   (the instance is internal-use; `structure.autoPublish` can still be flipped off per page).
2. **Severity inputs**: page-level `structure.degradedLatencyMs` with per-component
   `degradedLatencyMs` override; components aggregate MULTIPLE monitors (async processes —
   SQS/cron workers — share one tracked unit; their success pulses ride the existing `push`
   monitor type: ping `/api/v1/push/<token>` on success, `/fail?body=` on error, silence past
   interval+grace = down).
3. **Password pages**: optional, off by default (`status_pages.password_hash`).
4. **Subscriptions**: channel-based — reuse `notification_channels`, so Slack, Telegram,
   email, ntfy, gotify and webhooks are all supported; admin-managed per page with
   per-component + per-event filters (no public self-serve signup).

Waves 1–2 are the implementation scope; wave 3 stays deferred.
