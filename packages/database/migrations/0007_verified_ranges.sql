CREATE TABLE `profile_blob_chunks` (
	`profile_id` text NOT NULL,
	`hash` text NOT NULL,
	`position` integer NOT NULL,
	`size` integer NOT NULL,
	`chunk_hash` text NOT NULL,
	PRIMARY KEY(`profile_id`, `hash`, `position`),
	FOREIGN KEY (`profile_id`,`hash`) REFERENCES `profile_blobs`(`profile_id`,`hash`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "verified_chunk_bounds" CHECK("profile_blob_chunks"."position">=0 AND "profile_blob_chunks"."position"<256 AND "profile_blob_chunks"."size">0 AND "profile_blob_chunks"."size"<=4194304),
	CONSTRAINT "verified_chunk_hash" CHECK(length("profile_blob_chunks"."chunk_hash")=64 AND "profile_blob_chunks"."chunk_hash" NOT GLOB '*[^a-f0-9]*')
);
--> statement-breakpoint
CREATE TRIGGER verified_ranges_bounds BEFORE INSERT ON profile_blob_chunks WHEN NOT EXISTS(SELECT 1 FROM profile_blobs b WHERE b.profile_id=NEW.profile_id AND b.hash=NEW.hash AND b.state='verified' AND NEW.position*4194304<b.size AND NEW.size=min(4194304,b.size-NEW.position*4194304)) BEGIN SELECT RAISE(ABORT,'Invalid verified range'); END;
--> statement-breakpoint
CREATE TRIGGER verified_ranges_no_update BEFORE UPDATE ON profile_blob_chunks BEGIN SELECT RAISE(ABORT,'Verified range identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER verified_ranges_no_delete BEFORE DELETE ON profile_blob_chunks BEGIN SELECT RAISE(ABORT,'Verified ranges are retained'); END;
