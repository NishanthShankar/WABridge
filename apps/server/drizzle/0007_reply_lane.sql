ALTER TABLE `webhooks` ADD `all_events` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE `chat_activity` (
	`jid` text PRIMARY KEY NOT NULL,
	`last_inbound_at` integer NOT NULL
);
