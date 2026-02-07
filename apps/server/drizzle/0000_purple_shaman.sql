CREATE TABLE `auth_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
