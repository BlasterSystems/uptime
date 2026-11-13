# ADR-0007: Reduce notification delivery to Resend email + status-page feeds

- **Status:** Accepted
- **Date:** 2026-11-13
- **Decision owners:** Bruno Pires
- **Scope:** Notification channels, delivery providers, data model, web UI
- **Tags:** notifications, email, resend, breaking-change, destructive-migration
- **Supersedes:** None
- **Superseded by:** None

## Context

The owner simplification sweep of 2026-11-11 selected "notify via Email (Resend)
and status-page RSS only" (research:
`tasks/research-notify-email-rss-simplification.md`, UP-17 gate). The core is
type-agnostic — `Notifier` routing, the incident engine, status-page
subscriptions and the test button all work with any channel type — but the
product ships eight concrete providers (`packages/notify/src/types.ts`):
telegram, discord, slack, email (SMTP via nodemailer), resend, ntfy, gotify and
webhook.

Both halves of the ask already exist: `sendResend` is a per-channel provider
(`packages/notify/src/providers.ts`), and every published status page exposes
RSS/Atom feeds (`/status/:slug/rss.xml`, `/atom.xml`, with autodiscovery and
footer links). A separate instance-level Resend mailer
(`apps/server/src/mailer.ts`, `mailer_settings`) serves password recovery and
its test send; it is untouched by this decision.

The breaking change rides the same major release as the docker cut (ADR-0008);
release preparation is owned by UP-20.

## Decision drivers

- No internal usage of the chat/push/webhook providers; the sweep's goal is the
  smallest feature set that keeps the product honest.
- The webhook provider is the largest single config surface
  (method/headers/JSON template) and the only SSRF-ish outbound sink in the
  product.
- SMTP email costs a runtime dependency (nodemailer) and a second email code
  path for a delivery nobody exercises; per-channel API keys repeat the
  instance's Resend key anyway.
- Encrypted channel configs are unrecoverable by design (ADR-0002), so rows of
  removed types can only fail inert at send time or be deleted.

## Considered options

### Option A: Resend only (chosen)

`CHANNEL_TYPES` collapses to `['resend']`; the seven other provider functions,
their zod schemas, their tests and the webhook-only `renderTemplate` templating
are deleted; nodemailer leaves `packages/notify`. A destructive migration
deletes `notification_channels` rows of every removed type plus orphaned
`monitor_notifications` and `status_subscriptions` rows.

- Benefits: smallest diff; exactly the ask; one provider to test; no
  nodemailer; removed types fail loudly (400 on create,
  `unsupported channel type` on send).
- Costs: breaking — chat/webhook integrations stop delivering; destructive —
  stored configs of removed types are deleted unrecoverably; vendor dependence
  (Resend cloud) in a self-hosted product.

### Option B: Keep SMTP email alongside Resend

Delete the six non-email providers, keep `email` (SMTP) + `resend`.

- Benefits: keeps the vendor-independent self-hosted path (SPEC goal 6).
- Costs: keeps nodemailer and two email code paths; the owner explicitly
  accepted the vendor-dependence tradeoff at the 2026-11-11 gate.

### Option C: Fold Resend into the instance mailer

Delete all channel providers; `mailer_settings` becomes the single Resend
credential; channels degrade to `{ type: 'email', to }` destinations.

- Benefits: one API key per instance, shared with password recovery; cleanest
  UX.
- Costs: schema migration on `notification_channels`, new channel semantics,
  per-channel from/keys lost; largest blast radius of the three. Revisit if a
  single-credential flow is wanted later.

## Decision

Option A. Notification delivery is Resend email (per-channel `resend` config)
plus the existing status-page RSS/Atom feeds — no new feed endpoints; feeds
stay scoped to published status pages (pull-based; email remains the push
path). SMTP email and the six chat/push/webhook providers are cut end-to-end.
Migration `0008` deletes every `notification_channels` row whose `type` is not
`resend` and the `monitor_notifications` / `status_subscriptions` rows that
pointed at them; the down path is a documented no-op because encrypted configs
cannot be restored.

## Consequences

### Positive

- `packages/notify` shrinks to one provider; the web channel form collapses to
  a single type; no nodemailer dependency ships in the image.
- Removed types fail loudly everywhere: `parseChannelConfig` throws
  `unsupported channel type` (400 on create/update), so no config can
  half-exist.

### Negative

- Breaking: `telegram`, `discord`, `slack`, `email`, `ntfy`, `gotify` and
  `webhook` are rejected by the API and their stored rows are deleted by
  migration `0008`. Users must re-create channels as Email (Resend).
- Destructive: channel configs are AES-256-GCM encrypted and unrecoverable
  after the migration (same delete-don't-inert policy as ADR-0008).

### Risks and mitigations

- Existing integrations silently stop delivering (failures only appear as
  `NotifyFailure` log entries). Mitigation: loud CHANGELOG breaking-change
  note with re-create guidance (UP-20); the migration itself is the forcing
  function.
- Vendor dependence: a Resend outage pauses notifications. Mitigation:
  password recovery already rides the same vendor; the revisit triggers below
  cover an SMTP re-add.

## Implementation and validation

- UP-19: notify/server/web cut, migration `0008` (next after
  `0007_free_ironclad`), regression test replaying `0000–0007` on a populated
  copy DB (legacy channels + orphans deleted, `resend` rows intact, fresh-DB
  path clean), explicit 400 test for removed types, e2e `channels.spec.ts`
  rewritten for Resend.
- UP-20: version bump + CHANGELOG breaking-change note; no tag without owner
  confirmation.
- `.agentic/bin/validate` and `.agentic/bin/docs-check` pass.

## Revisit triggers

- Chat-provider demand returns (Telegram/Slack/Discord) — re-add as a new
  provider module; the type-agnostic core needs no changes.
- Self-hosted SMTP demand returns — re-add the `email` provider and nodemailer
  (additive, non-destructive).
- A single-credential flow is wanted — pursue Option C as a follow-up.

## References

- UP-17 (epic), UP-18, UP-19, UP-20; research doc
  `tasks/research-notify-email-rss-simplification.md`.
- [ADR-0002](0002-sqlite-first-storage-secrets-encryption.md) — encrypted
  channel configs (why deletion is the only cleanup).
- [ADR-0008](0008-cut-docker-monitors-and-docker-hosts.md) — the sibling
  breaking cut this release rides; same migration and changelog policy.
