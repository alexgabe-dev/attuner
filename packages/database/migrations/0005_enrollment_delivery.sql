CREATE TABLE `enrollment_decisions` (
	`enrollment_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`ciphertext` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `web_users`(`id`) ON UPDATE no action ON DELETE no action
);
