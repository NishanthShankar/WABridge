CREATE TABLE `recurring_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`cron_expression` text NOT NULL,
	`interval_days` integer,
	`start_date` integer,
	`end_date` integer,
	`max_occurrences` integer,
	`occurrence_count` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_fired_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recurring_contact_idx` ON `recurring_rules` (`contact_id`);--> statement-breakpoint
CREATE INDEX `recurring_type_idx` ON `recurring_rules` (`type`);--> statement-breakpoint
CREATE TABLE `scheduled_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`recurring_rule_id` text,
	`content` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`whatsapp_message_id` text,
	`sent_at` integer,
	`delivered_at` integer,
	`failed_at` integer,
	`failure_reason` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recurring_rule_id`) REFERENCES `recurring_rules`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sched_msg_contact_idx` ON `scheduled_messages` (`contact_id`);--> statement-breakpoint
CREATE INDEX `sched_msg_status_idx` ON `scheduled_messages` (`status`);--> statement-breakpoint
CREATE INDEX `sched_msg_scheduled_at_idx` ON `scheduled_messages` (`scheduled_at`);--> statement-breakpoint
CREATE INDEX `sched_msg_wa_msg_id_idx` ON `scheduled_messages` (`whatsapp_message_id`);--> statement-breakpoint
ALTER TABLE `contacts` ADD `birthday` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `birthday_reminder_enabled` integer DEFAULT true;