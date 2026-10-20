CREATE TABLE `accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`settings` text NOT NULL,
	`mood` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`context_floor` integer DEFAULT 0 NOT NULL,
	`last_user_at` real NOT NULL,
	`last_idle_at` real DEFAULT 0 NOT NULL,
	`updated_at` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`category` text NOT NULL,
	`slot` text NOT NULL,
	`content` text NOT NULL,
	`source_id` integer,
	`evidence` text DEFAULT '' NOT NULL,
	`origin` text NOT NULL,
	`created_at` real NOT NULL,
	`updated_at` real NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memories_slot` ON `memories` (`user_id`,`category`,`slot`);--> statement-breakpoint
CREATE INDEX `memories_user` ON `memories` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`kind` text DEFAULT 'chat' NOT NULL,
	`event_key` text NOT NULL,
	`created_at` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_user_id` ON `messages` (`user_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_event` ON `messages` (`user_id`,`event_key`);--> statement-breakpoint
CREATE TABLE `mutation_guards` (
	`operation` text PRIMARY KEY NOT NULL,
	`expected` integer NOT NULL,
	`actual` integer NOT NULL,
	CONSTRAINT "current_revision" CHECK("mutation_guards"."expected" = "mutation_guards"."actual")
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`body_hash` text NOT NULL,
	`reply` text NOT NULL,
	`created_at` real NOT NULL,
	PRIMARY KEY(`user_id`, `token`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`due_at` real NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` real NOT NULL,
	`delivered_at` real,
	`message_id` integer,
	`error` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasks_user` ON `tasks` (`user_id`,`due_at`);