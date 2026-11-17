CREATE TABLE `poll_votes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`poll_id` text NOT NULL,
	`voter_jid` text NOT NULL,
	`voter_phone` text,
	`selected` text NOT NULL,
	`counted` integer NOT NULL,
	`note` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `poll_votes_poll_idx` ON `poll_votes` (`poll_id`);--> statement-breakpoint
CREATE TABLE `polls` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_jid` text NOT NULL,
	`name` text NOT NULL,
	`options` text NOT NULL,
	`selectable_count` integer NOT NULL,
	`mode` text NOT NULL,
	`react` text,
	`confirm_text` text,
	`secret` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `polls_chat_idx` ON `polls` (`chat_jid`);
