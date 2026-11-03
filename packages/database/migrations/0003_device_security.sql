CREATE TABLE `credential_security` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`thumbprint` text NOT NULL,
	`family_id` text NOT NULL,
	`family_expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`credential_id`) REFERENCES `device_credentials`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "credential_kind" CHECK("credential_security"."kind" IN ('access','refresh'))
);
--> statement-breakpoint
CREATE INDEX `credential_family` ON `credential_security` (`family_id`);--> statement-breakpoint
CREATE TABLE `device_keys` (
	`device_id` text PRIMARY KEY NOT NULL,
	`thumbprint` text NOT NULL,
	`jwk` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_keys_thumbprint_unique` ON `device_keys` (`thumbprint`);--> statement-breakpoint
CREATE TABLE `enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`thumbprint` text NOT NULL,
	`jwk` text NOT NULL,
	`challenge` text NOT NULL,
	`client_state` text NOT NULL,
	`device_name` text NOT NULL,
	`os` text NOT NULL,
	`client_version` text NOT NULL,
	`state` text NOT NULL,
	`user_id` text,
	`profile_ids` text,
	`code_hash` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `web_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "enrollment_state" CHECK("enrollments"."state" IN ('pending','approved','denied','redeemed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enrollments_code_hash_unique` ON `enrollments` (`code_hash`);--> statement-breakpoint
CREATE TABLE `proof_nonces` (
	`hash` text PRIMARY KEY NOT NULL,
	`thumbprint` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nonce_key` ON `proof_nonces` (`thumbprint`);--> statement-breakpoint
CREATE TABLE `proof_replays` (
	`thumbprint` text NOT NULL,
	`jti` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`thumbprint`, `jti`)
);
--> statement-breakpoint
CREATE TABLE `token_deliveries` (
	`key` text PRIMARY KEY NOT NULL,
	`principal` text NOT NULL,
	`payload_hash` text NOT NULL,
	`family_id` text NOT NULL,
	`device_id` text NOT NULL,
	`ciphertext` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `user_security` (
	`user_id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`disabled_at` integer,
	`epoch` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `web_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "user_role" CHECK("user_security"."role" IN ('administrator','user'))
);
--> statement-breakpoint
CREATE TABLE `web_session_security` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`csrf_hash` text NOT NULL,
	`epoch` integer NOT NULL,
	`authenticated_at` integer NOT NULL,
	FOREIGN KEY (`token_hash`) REFERENCES `web_sessions`(`token_hash`) ON UPDATE no action ON DELETE no action
);
