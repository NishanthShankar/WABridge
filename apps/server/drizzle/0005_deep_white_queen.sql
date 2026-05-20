CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`phone` text NOT NULL,
	`url` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`secret` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhooks_phone_idx` ON `webhooks` (`phone`);
