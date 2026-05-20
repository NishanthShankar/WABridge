PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`phone` text,
	`url` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`secret` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_webhooks`("id", "phone", "url", "enabled", "secret", "created_at", "updated_at") SELECT "id", "phone", "url", "enabled", "secret", "created_at", "updated_at" FROM `webhooks`;--> statement-breakpoint
DROP TABLE `webhooks`;--> statement-breakpoint
ALTER TABLE `__new_webhooks` RENAME TO `webhooks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `webhooks_phone_idx` ON `webhooks` (`phone`);
