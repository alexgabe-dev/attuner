CREATE TABLE `device_sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`device_id` text NOT NULL,
	`source_generation` integer NOT NULL,
	`state` text NOT NULL,
	`local_manifest` text NOT NULL,
	`local_manifest_hash` text NOT NULL,
	`baseline_snapshot_id` text,
	`remote_head` text,
	`published_head` text,
	`session_id` text,
	`candidate_manifest_hash` text,
	`payload_hash` text NOT NULL,
	`reason` text,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sync_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`,`baseline_snapshot_id`) REFERENCES `snapshots`(`profile_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "source_generation_safe" CHECK("device_sync_jobs"."source_generation">=1 AND "device_sync_jobs"."source_generation"<=9007199254740991),
	CONSTRAINT "reported_manifest_json" CHECK(json_valid("device_sync_jobs"."local_manifest"))
);
--> statement-breakpoint
CREATE TABLE `review_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`user_id` text NOT NULL,
	`source_generation` integer NOT NULL,
	`local_manifest_hash` text NOT NULL,
	`remote_head` text NOT NULL,
	`decisions` text NOT NULL,
	`candidate_manifest_hash` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `device_sync_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `web_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "proposal_state" CHECK("review_proposals"."state" IN ('pending','validated','withdrawn','superseded'))
);
--> statement-breakpoint
CREATE INDEX `job_proposals` ON `review_proposals` (`job_id`,`created_at`);--> statement-breakpoint
CREATE TRIGGER reported_job_identity_immutable BEFORE UPDATE OF id,profile_id,device_id ON device_sync_jobs BEGIN SELECT RAISE(ABORT,'Reported job identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER proposal_identity_immutable BEFORE UPDATE OF id,job_id,user_id,source_generation,local_manifest_hash,remote_head,decisions,candidate_manifest_hash,created_at ON review_proposals BEGIN SELECT RAISE(ABORT,'Review proposal identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER proposals_retained BEFORE DELETE ON review_proposals BEGIN SELECT RAISE(ABORT,'Review proposals are retained'); END;
--> statement-breakpoint
CREATE UNIQUE INDEX one_pending_proposal ON review_proposals(job_id) WHERE state='pending';
