CREATE TABLE installation(id INTEGER PRIMARY KEY CHECK(id=1), adapter TEXT NOT NULL, mappings TEXT NOT NULL);
CREATE TABLE scans(id INTEGER PRIMARY KEY AUTOINCREMENT, manifest TEXT NOT NULL, coverage TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE TABLE snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, manifest TEXT NOT NULL, coverage TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE TRIGGER snapshots_immutable BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT,'immutable snapshot'); END;
CREATE TRIGGER snapshots_retained BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT,'snapshot retention is not enabled'); END;
CREATE TABLE baseline(id INTEGER PRIMARY KEY CHECK(id=1), snapshot_id INTEGER NOT NULL REFERENCES snapshots(id));
CREATE TABLE operations(id INTEGER PRIMARY KEY AUTOINCREMENT, target_snapshot INTEGER NOT NULL REFERENCES snapshots(id), before_manifest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','applying','recoveryRequired','recovering','committed','rolledBack')), error TEXT, created_at INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE TABLE operation_steps(operation_id INTEGER NOT NULL REFERENCES operations(id), position INTEGER NOT NULL, step TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(operation_id,position));
PRAGMA user_version=1;
