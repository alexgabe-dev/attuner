CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` text,
	`device_id` text,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_profile_cursor` ON `audit_events` (`profile_id`,`id`);--> statement-breakpoint
CREATE TABLE `blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "blob_hash" CHECK(length("blobs"."hash") = 64 AND "blobs"."hash" NOT GLOB '*[^a-f0-9]*'),
	CONSTRAINT "blob_size" CHECK("blobs"."size" >= 0),
	CONSTRAINT "blob_verified" CHECK("blobs"."state" = 'verified')
);
--> statement-breakpoint
CREATE TABLE `conflict_files` (
	`conflict_id` text NOT NULL,
	`root` text NOT NULL,
	`path` text NOT NULL,
	`base_hash` text,
	`local_hash` text,
	`remote_hash` text,
	PRIMARY KEY(`conflict_id`, `root`, `path`),
	FOREIGN KEY (`conflict_id`) REFERENCES `conflicts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`base_hash`) REFERENCES `blobs`(`hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`local_hash`) REFERENCES `blobs`(`hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`remote_hash`) REFERENCES `blobs`(`hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`session_id` text NOT NULL,
	`base_snapshot_id` text,
	`head_snapshot_id` text NOT NULL,
	`state` text NOT NULL,
	`resolution_snapshot_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sync_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`,`base_snapshot_id`) REFERENCES `snapshots`(`profile_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`,`head_snapshot_id`) REFERENCES `snapshots`(`profile_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`,`resolution_snapshot_id`) REFERENCES `snapshots`(`profile_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conflict_profile_state` ON `conflicts` (`profile_id`,`state`);--> statement-breakpoint
CREATE TABLE `device_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`scope` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_credentials_token_hash_unique` ON `device_credentials` (`token_hash`);--> statement-breakpoint
CREATE TABLE `device_heartbeats` (
	`device_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`engine_state` text NOT NULL,
	PRIMARY KEY(`device_id`, `received_at`),
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `device_profiles` (
	`device_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`acknowledged_snapshot_id` text,
	`policy_version` integer NOT NULL,
	`pending_changes` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	PRIMARY KEY(`device_id`, `profile_id`),
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`,`acknowledged_snapshot_id`) REFERENCES `snapshots`(`profile_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`os` text NOT NULL,
	`client_version` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `file_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`snapshot_id` text,
	`root` text NOT NULL,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`before_hash` text,
	`after_hash` text,
	FOREIGN KEY (`session_id`) REFERENCES `sync_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`before_hash`) REFERENCES `blobs`(`hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`after_hash`) REFERENCES `blobs`(`hash`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "valid_change" CHECK(("file_changes"."kind" = 'add' AND "file_changes"."before_hash" IS NULL AND "file_changes"."after_hash" IS NOT NULL) OR ("file_changes"."kind" = 'delete' AND "file_changes"."before_hash" IS NOT NULL AND "file_changes"."after_hash" IS NULL) OR ("file_changes"."kind" = 'modify' AND "file_changes"."before_hash" IS NOT NULL AND "file_changes"."after_hash" IS NOT NULL AND "file_changes"."before_hash" != "file_changes"."after_hash"))
);
--> statement-breakpoint
CREATE TABLE `pairing_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`device_name` text NOT NULL,
	`code_hash` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pairing_requests_code_hash_unique` ON `pairing_requests` (`code_hash`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`adapter` text NOT NULL,
	`policy_version` integer DEFAULT 1 NOT NULL,
	`head_snapshot_id` text,
	`next_revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`id`,`head_snapshot_id`) REFERENCES `snapshots`(`profile_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "positive_profile_revision" CHECK("profiles"."next_revision" > 0 AND "profiles"."policy_version" > 0)
);
--> statement-breakpoint
CREATE TABLE `restore_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`expected_head` text,
	`state` text NOT NULL,
	`scope` text NOT NULL,
	`resulting_snapshot_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`,`snapshot_id`) REFERENCES `snapshots`(`profile_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`,`expected_head`) REFERENCES `snapshots`(`profile_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`,`resulting_snapshot_id`) REFERENCES `snapshots`(`profile_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `session_blobs` (
	`session_id` text NOT NULL,
	`hash` text NOT NULL,
	PRIMARY KEY(`session_id`, `hash`),
	FOREIGN KEY (`session_id`) REFERENCES `sync_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hash`) REFERENCES `blobs`(`hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `snapshot_files` (
	`snapshot_id` text NOT NULL,
	`root` text NOT NULL,
	`path` text NOT NULL,
	`hash` text NOT NULL,
	`size` integer NOT NULL,
	`consistency_group` text NOT NULL,
	PRIMARY KEY(`snapshot_id`, `root`, `path`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hash`) REFERENCES `blobs`(`hash`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "snapshot_file_size" CHECK("snapshot_files"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`parent_id` text,
	`revision` integer NOT NULL,
	`source_device_id` text,
	`manifest_hash` text NOT NULL,
	`added` integer DEFAULT 0 NOT NULL,
	`modified` integer DEFAULT 0 NOT NULL,
	`removed` integer DEFAULT 0 NOT NULL,
	`transferred_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`,`parent_id`) REFERENCES `snapshots`(`profile_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "positive_revision" CHECK("snapshots"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `snapshot_revision` ON `snapshots` (`profile_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `snapshot_profile_id` ON `snapshots` (`profile_id`,`id`);--> statement-breakpoint
CREATE TABLE `sync_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`expected_head` text,
	`base_snapshot_id` text,
	`candidate_manifest` text,
	`policy_version` integer NOT NULL,
	`state` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`,`expected_head`) REFERENCES `snapshots`(`profile_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`,`base_snapshot_id`) REFERENCES `snapshots`(`profile_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_idempotency` ON `sync_sessions` (`device_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `web_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `web_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `web_users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `web_users_username_unique` ON `web_users` (`username`);