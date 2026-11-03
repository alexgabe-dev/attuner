CREATE TABLE `audit_details` (
	`event_id` integer PRIMARY KEY NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`request_id` text NOT NULL,
	`job_id` text,
	`outcome` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `device_owners` (
	`device_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `web_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `profile_blobs` (
	`profile_id` text NOT NULL,
	`hash` text NOT NULL,
	`size` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`profile_id`, `hash`),
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hash`) REFERENCES `blobs`(`hash`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "profile_blob_size" CHECK("profile_blobs"."size">=0 AND "profile_blobs"."size"<=1073741824),
	CONSTRAINT "profile_blob_state" CHECK("profile_blobs"."state" IN ('verified','quarantined'))
);
--> statement-breakpoint
CREATE TABLE `profile_members` (
	`profile_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`profile_id`, `user_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `web_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "member_role" CHECK("profile_members"."role" IN ('owner','writer','reader'))
);
--> statement-breakpoint
CREATE TABLE `profile_policies` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`roots` text NOT NULL,
	`namespace_version` integer DEFAULT 1 NOT NULL,
	`quota_bytes` integer DEFAULT 10737418240 NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "namespace_v1" CHECK("profile_policies"."namespace_version"=1),
	CONSTRAINT "positive_quota" CHECK("profile_policies"."quota_bytes">0)
);
--> statement-breakpoint
CREATE TABLE `publication_details` (
	`session_id` text PRIMARY KEY NOT NULL,
	`expected_revision` integer NOT NULL,
	`expected_hash` text,
	`manifest_hash` text NOT NULL,
	`payload_hash` text NOT NULL,
	`committed_snapshot_id` text,
	FOREIGN KEY (`session_id`) REFERENCES `sync_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`committed_snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `request_receipts` (
	`principal` text NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`result` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`principal`, `scope`, `key`)
);
--> statement-breakpoint
CREATE TABLE `server_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `snapshot_seals` (
	`snapshot_id` text PRIMARY KEY NOT NULL,
	`file_count` integer NOT NULL,
	`bytes` integer NOT NULL,
	`namespace_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `upload_chunks` (
	`upload_id` text NOT NULL,
	`position` integer NOT NULL,
	`size` integer NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`upload_id`, `position`),
	FOREIGN KEY (`upload_id`) REFERENCES `upload_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chunk_bounds" CHECK("upload_chunks"."position">=0 AND "upload_chunks"."position"<256 AND "upload_chunks"."size">0 AND "upload_chunks"."size"<=4194304)
);
--> statement-breakpoint
CREATE TABLE `upload_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hash` text NOT NULL,
	`size` integer NOT NULL,
	`state` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sync_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "upload_size" CHECK("upload_sessions"."size">=0 AND "upload_sessions"."size"<=1073741824),
	CONSTRAINT "upload_hash" CHECK(length("upload_sessions"."hash")=64 AND "upload_sessions"."hash" NOT GLOB '*[^a-f0-9]*'),
	CONSTRAINT "upload_state" CHECK("upload_sessions"."state" IN ('open','verifying','verified','cancelled','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_upload_hash` ON `upload_sessions` (`session_id`,`hash`);--> statement-breakpoint
-- Preserve prior immutable history without inventing verified physical blob grants.
INSERT INTO snapshot_seals(snapshot_id,file_count,bytes,namespace_version,created_at)
SELECT s.id,count(f.path),coalesce(sum(f.size),0),1,s.created_at FROM snapshots s LEFT JOIN snapshot_files f ON f.snapshot_id=s.id GROUP BY s.id;
--> statement-breakpoint
CREATE TRIGGER snapshots_retained BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT,'Published snapshots are retained'); END;
--> statement-breakpoint
CREATE TRIGGER snapshot_files_retained BEFORE DELETE ON snapshot_files BEGIN SELECT RAISE(ABORT,'Snapshot files are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER sealed_files_no_insert BEFORE INSERT ON snapshot_files WHEN EXISTS(SELECT 1 FROM snapshot_seals WHERE snapshot_id=NEW.snapshot_id) BEGIN SELECT RAISE(ABORT,'Snapshot files are sealed'); END;
--> statement-breakpoint
CREATE TRIGGER scoped_snapshot_blobs BEFORE INSERT ON snapshot_files WHEN NOT EXISTS(SELECT 1 FROM snapshots s JOIN profile_blobs b ON b.profile_id=s.profile_id WHERE s.id=NEW.snapshot_id AND b.hash=NEW.hash AND b.size=NEW.size AND b.state='verified') BEGIN SELECT RAISE(ABORT,'FOREIGN KEY: verified profile blob required'); END;
--> statement-breakpoint
CREATE TRIGGER seal_content_check BEFORE INSERT ON snapshot_seals WHEN NEW.file_count!=(SELECT count(*) FROM snapshot_files WHERE snapshot_id=NEW.snapshot_id) OR NEW.bytes!=(SELECT coalesce(sum(size),0) FROM snapshot_files WHERE snapshot_id=NEW.snapshot_id) OR NEW.namespace_version!=1 BEGIN SELECT RAISE(ABORT,'Invalid snapshot seal'); END;
--> statement-breakpoint
CREATE TRIGGER seals_no_update BEFORE UPDATE ON snapshot_seals BEGIN SELECT RAISE(ABORT,'Snapshot seals are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER seals_no_delete BEFORE DELETE ON snapshot_seals BEGIN SELECT RAISE(ABORT,'Snapshot seals are retained'); END;
--> statement-breakpoint
CREATE TRIGGER head_requires_seal BEFORE UPDATE OF head_snapshot_id ON profiles WHEN NEW.head_snapshot_id IS NOT NULL AND EXISTS(SELECT 1 FROM snapshots WHERE id=NEW.head_snapshot_id AND profile_id=NEW.id) AND NOT EXISTS(SELECT 1 FROM snapshot_seals WHERE snapshot_id=NEW.head_snapshot_id) BEGIN SELECT RAISE(ABORT,'Unsealed head'); END;
--> statement-breakpoint
CREATE TRIGGER head_moves_forward BEFORE UPDATE OF head_snapshot_id ON profiles WHEN NEW.head_snapshot_id IS NOT OLD.head_snapshot_id AND (NEW.head_snapshot_id IS NULL OR (EXISTS(SELECT 1 FROM snapshots WHERE id=NEW.head_snapshot_id AND profile_id=NEW.id) AND ((SELECT revision FROM snapshots WHERE id=NEW.head_snapshot_id)<=coalesce((SELECT revision FROM snapshots WHERE id=OLD.head_snapshot_id),0) OR NEW.next_revision!=(SELECT revision+1 FROM snapshots WHERE id=NEW.head_snapshot_id)))) BEGIN SELECT RAISE(ABORT,'Head must advance monotonically'); END;
--> statement-breakpoint
CREATE TRIGGER safe_revisions_insert BEFORE INSERT ON snapshots WHEN NEW.revision>9007199254740991 BEGIN SELECT RAISE(ABORT,'Revision exhausted'); END;
--> statement-breakpoint
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER audit_details_no_update BEFORE UPDATE ON audit_details BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER audit_details_no_delete BEFORE DELETE ON audit_details BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;
