ALTER TABLE `polls` ADD `ref` text;--> statement-breakpoint
ALTER TABLE `polls` ADD `voted_at` integer;--> statement-breakpoint
ALTER TABLE `polls` ADD `delete_at` integer;--> statement-breakpoint
ALTER TABLE `polls` ADD `delete_reason` text;--> statement-breakpoint
ALTER TABLE `polls` ADD `delete_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `polls` ADD `delete_failed_at` integer;--> statement-breakpoint
CREATE INDEX `polls_ref_idx` ON `polls` (`ref`);--> statement-breakpoint
CREATE INDEX `polls_delete_at_idx` ON `polls` (`delete_at`);
