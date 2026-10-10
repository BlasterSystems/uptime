CREATE TABLE `docker_hosts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`uri` text NOT NULL,
	`tls_ca_enc` text,
	`tls_cert_enc` text,
	`tls_key_enc` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
