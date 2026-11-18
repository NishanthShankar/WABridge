CREATE TABLE `chat_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`color` integer,
	`predefined_id` text,
	`deleted` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_list_chats` (
	`list_id` text NOT NULL,
	`chat_jid` text NOT NULL,
	PRIMARY KEY(`list_id`, `chat_jid`)
);
