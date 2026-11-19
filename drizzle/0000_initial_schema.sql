CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`endpoint` text NOT NULL,
	`subscription` text NOT NULL,
	`revision` text NOT NULL,
	`enrolled_at` integer NOT NULL,
	`paused` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_user_id_endpoint_unique` ON `devices` (`user_id`,`endpoint`);--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`user_id` text NOT NULL,
	`event_id` text NOT NULL,
	`device_id` text NOT NULL,
	`revision` text NOT NULL,
	`attempt` text,
	PRIMARY KEY(`user_id`, `event_id`, `device_id`),
	FOREIGN KEY (`user_id`,`event_id`) REFERENCES `notification_events`(`user_id`,`event_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notification_events` (
	`user_id` text NOT NULL,
	`event_id` text NOT NULL,
	`attempt` text NOT NULL,
	`payload_digest` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `event_id`)
);
