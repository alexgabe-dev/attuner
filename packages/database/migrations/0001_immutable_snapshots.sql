-- Published snapshot content cannot be edited in place.
-- Retention deletion is a separately authorized future maintenance operation.
CREATE TRIGGER snapshots_immutable BEFORE UPDATE ON snapshots
BEGIN SELECT RAISE(ABORT, 'Snapshots are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER snapshot_files_immutable BEFORE UPDATE ON snapshot_files
BEGIN SELECT RAISE(ABORT, 'Snapshot files are immutable'); END;
