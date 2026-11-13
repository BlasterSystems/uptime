-- ADR-0007 / UP-19: prune notification channels to `resend` (breaking, destructive).
-- Channels of every removed provider (telegram, discord, slack, email/SMTP, ntfy,
-- gotify, webhook) are deleted; their AES-256-GCM-encrypted configs are
-- unrecoverable. Monitor routing rows and status-page subscriptions that pointed
-- at them are removed with them — including rows left dangling by historical
-- `PRAGMA foreign_keys` states, which the `NOT IN` sweeps handle regardless of
-- cascade behavior. Re-create channels as Email (Resend).
DELETE FROM `notification_channels` WHERE `type` <> 'resend';--> statement-breakpoint
DELETE FROM `monitor_notifications` WHERE `channel_id` NOT IN (SELECT `id` FROM `notification_channels`);--> statement-breakpoint
DELETE FROM `status_subscriptions` WHERE `channel_id` NOT IN (SELECT `id` FROM `notification_channels`);
-- Down (documentation only — drizzle applies forward-only): no-op. Deleted channel
-- configs cannot be restored; re-create channels as Email (Resend) in the UI.
