-- ADR-0008 / UP-23: cut docker monitors and docker hosts (breaking, destructive).
-- Mirrors the dependent-row cleanup that `Database#deleteMonitor` relies on
-- (FK `ON DELETE CASCADE` under `PRAGMA foreign_keys = ON`): every row tied to a
-- `type = 'docker'` monitor is deleted explicitly, so the cleanup does not depend
-- on the connection's pragma state while the migration runs. Docker monitor
-- configs, their heartbeats/incidents/rollups and the `docker_hosts` rows
-- (including stored TLS material) are unrecoverable after this migration.
DELETE FROM `heartbeats` WHERE `monitor_id` IN (SELECT `id` FROM `monitors` WHERE `type` = 'docker');--> statement-breakpoint
DELETE FROM `incidents` WHERE `monitor_id` IN (SELECT `id` FROM `monitors` WHERE `type` = 'docker');--> statement-breakpoint
DELETE FROM `monitor_notifications` WHERE `monitor_id` IN (SELECT `id` FROM `monitors` WHERE `type` = 'docker');--> statement-breakpoint
DELETE FROM `monitor_tags` WHERE `monitor_id` IN (SELECT `id` FROM `monitors` WHERE `type` = 'docker');--> statement-breakpoint
DELETE FROM `heartbeats_hourly` WHERE `monitor_id` IN (SELECT `id` FROM `monitors` WHERE `type` = 'docker');--> statement-breakpoint
DELETE FROM `heartbeats_daily` WHERE `monitor_id` IN (SELECT `id` FROM `monitors` WHERE `type` = 'docker');--> statement-breakpoint
DELETE FROM `monitors` WHERE `type` = 'docker';--> statement-breakpoint
DROP TABLE `docker_hosts`;
-- Down (documentation only — drizzle applies forward-only): recreate the empty
-- table; deleted monitor data cannot be restored.
-- CREATE TABLE `docker_hosts` (
-- 	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
-- 	`name` text NOT NULL,
-- 	`uri` text NOT NULL,
-- 	`tls_ca_enc` text,
-- 	`tls_cert_enc` text,
-- 	`tls_key_enc` text,
-- 	`created_at` integer NOT NULL,
-- 	`updated_at` integer NOT NULL
-- );
