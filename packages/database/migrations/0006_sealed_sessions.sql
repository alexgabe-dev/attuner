-- Candidate identity is immutable; only its state can progress.
CREATE TRIGGER session_candidate_immutable BEFORE UPDATE OF device_id,profile_id,expected_head,base_snapshot_id,candidate_manifest,policy_version,idempotency_key,expires_at,created_at ON sync_sessions BEGIN SELECT RAISE(ABORT,'Candidate session is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER committed_session_retained BEFORE UPDATE OF state ON sync_sessions WHEN OLD.state='committed' AND NEW.state!='committed' BEGIN SELECT RAISE(ABORT,'Published session is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER publication_identity_immutable BEFORE UPDATE OF session_id,expected_revision,expected_hash,manifest_hash,payload_hash ON publication_details BEGIN SELECT RAISE(ABORT,'Publication identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER publication_result_once BEFORE UPDATE OF committed_snapshot_id ON publication_details WHEN OLD.committed_snapshot_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM snapshots p JOIN sync_sessions s ON s.profile_id=p.profile_id WHERE s.id=NEW.session_id AND p.id=NEW.committed_snapshot_id AND p.manifest_hash=NEW.manifest_hash AND p.revision=NEW.expected_revision+1) BEGIN SELECT RAISE(ABORT,'Publication result must match immutable identity'); END;
--> statement-breakpoint
CREATE TRIGGER receipts_no_update BEFORE UPDATE ON request_receipts BEGIN SELECT RAISE(ABORT,'Idempotency receipts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER chunks_no_update BEFORE UPDATE ON upload_chunks BEGIN SELECT RAISE(ABORT,'Chunk receipts are immutable'); END;
