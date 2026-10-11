CREATE TABLE `status_incident_updates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`incident_id` integer NOT NULL,
	`status` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`incident_id`) REFERENCES `status_incidents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `status_incident_updates_incident_idx` ON `status_incident_updates` (`incident_id`);--> statement-breakpoint
CREATE TABLE `status_incidents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`page_id` integer NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'investigating' NOT NULL,
	`impact` text DEFAULT 'major' NOT NULL,
	`component_ids` text DEFAULT '[]' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`monitor_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`page_id`) REFERENCES `status_pages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `status_incidents_page_monitor_idx` ON `status_incidents` (`page_id`,`monitor_id`);--> statement-breakpoint
CREATE INDEX `status_incidents_page_resolved_idx` ON `status_incidents` (`page_id`,`resolved_at`);--> statement-breakpoint
CREATE TABLE `status_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`page_id` integer NOT NULL,
	`channel_id` integer NOT NULL,
	`component_ids` text DEFAULT '[]' NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`page_id`) REFERENCES `status_pages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `notification_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `status_subscriptions_page_channel_idx` ON `status_subscriptions` (`page_id`,`channel_id`);--> statement-breakpoint
ALTER TABLE `status_pages` ADD `structure` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `status_pages` ADD `footer_text` text;--> statement-breakpoint
ALTER TABLE `status_pages` ADD `password_hash` text;