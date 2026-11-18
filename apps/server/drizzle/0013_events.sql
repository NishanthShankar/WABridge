CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_jid` text NOT NULL,
	`name` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer,
	`secret` text NOT NULL,
	`ref` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_chat_idx` ON `events` (`chat_jid`);--> statement-breakpoint
CREATE TABLE `event_responses` (
	`event_id` text NOT NULL,
	`responder_jid` text NOT NULL,
	`responder_phone` text,
	`response` text NOT NULL,
	`extra_guests` integer DEFAULT 0 NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`event_id`, `responder_jid`)
);
