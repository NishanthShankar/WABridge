CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`participant_count` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `groups_name_idx` ON `groups` (`name`);
--> statement-breakpoint
-- Recreate scheduled_messages to make contact_id nullable and add group_id
-- SQLite does not support ALTER COLUMN, so we use the rename-and-recreate pattern.
ALTER TABLE `scheduled_messages` RENAME TO `_scheduled_messages_old`;
--> statement-breakpoint
CREATE TABLE `scheduled_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text,
	`group_id` text,
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
	`media_url` text,
	`media_type` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON DELETE CASCADE,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON DELETE CASCADE,
	FOREIGN KEY (`recurring_rule_id`) REFERENCES `recurring_rules`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `scheduled_messages`
	(`id`, `contact_id`, `recurring_rule_id`, `content`, `scheduled_at`, `status`,
	 `whatsapp_message_id`, `sent_at`, `delivered_at`, `failed_at`, `failure_reason`,
	 `attempts`, `media_url`, `media_type`, `created_at`, `updated_at`)
SELECT
	`id`, `contact_id`, `recurring_rule_id`, `content`, `scheduled_at`, `status`,
	`whatsapp_message_id`, `sent_at`, `delivered_at`, `failed_at`, `failure_reason`,
	`attempts`, `media_url`, `media_type`, `created_at`, `updated_at`
FROM `_scheduled_messages_old`;
--> statement-breakpoint
DROP TABLE `_scheduled_messages_old`;
--> statement-breakpoint
CREATE INDEX `sched_msg_contact_idx` ON `scheduled_messages` (`contact_id`);
--> statement-breakpoint
CREATE INDEX `sched_msg_group_idx` ON `scheduled_messages` (`group_id`);
--> statement-breakpoint
CREATE INDEX `sched_msg_status_idx` ON `scheduled_messages` (`status`);
--> statement-breakpoint
CREATE INDEX `sched_msg_scheduled_at_idx` ON `scheduled_messages` (`scheduled_at`);
--> statement-breakpoint
CREATE INDEX `sched_msg_wa_msg_id_idx` ON `scheduled_messages` (`whatsapp_message_id`);
