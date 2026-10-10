CREATE TABLE `heartbeats_daily` (
	`monitor_id` integer NOT NULL,
	`day_bucket` integer NOT NULL,
	`up` integer DEFAULT 0 NOT NULL,
	`down` integer DEFAULT 0 NOT NULL,
	`maintenance` integer DEFAULT 0 NOT NULL,
	`total_ms` integer DEFAULT 0 NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`monitor_id`, `day_bucket`),
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `heartbeats_hourly` (
	`monitor_id` integer NOT NULL,
	`hour_bucket` integer NOT NULL,
	`up` integer DEFAULT 0 NOT NULL,
	`down` integer DEFAULT 0 NOT NULL,
	`maintenance` integer DEFAULT 0 NOT NULL,
	`total_ms` integer DEFAULT 0 NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`monitor_id`, `hour_bucket`),
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `maintenance_windows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`monitor_ids` text DEFAULT '[]' NOT NULL,
	`tag_ids` text DEFAULT '[]' NOT NULL,
	`strategy` text NOT NULL,
	`start_at` integer,
	`end_at` integer,
	`interval_s` integer,
	`weekdays` text,
	`start_time` text,
	`end_time` text,
	`cron_expr` text,
	`cron_tz` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `status_pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`logo` text,
	`published` integer DEFAULT false NOT NULL,
	`monitor_ids` text DEFAULT '[]' NOT NULL,
	`theme` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `status_pages_slug_unique` ON `status_pages` (`slug`);