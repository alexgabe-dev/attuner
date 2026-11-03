use crate::{Adapter, CompleteScan, Coverage, Error, Manifest, Result, Workspace};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: i64,
    pub label: String,
    pub created_at: i64,
    pub(crate) manifest: Manifest,
    pub(crate) coverage: Coverage,
}
impl Snapshot {
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }
}
#[cfg(unix)]
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Step {
    pub change: crate::compare::Change,
    pub mode: Option<u32>,
    pub stage: String,
    pub quarantine: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: i64,
    pub target_snapshot: i64,
    pub state: String,
    pub error: Option<String>,
}
pub(crate) struct Store {
    pub connection: Connection,
}
impl Store {
    pub fn open(workspace: &Workspace, adapter: &Adapter) -> Result<Self> {
        let state = workspace.internal("state")?;
        for path in ["local.sqlite", "local.sqlite-wal", "local.sqlite-shm"] {
            match state.symlink_metadata(path) {
                Ok(meta) => crate::workspace::check_meta(&meta, path, true)?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
            | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let mut connection =
            Connection::open_with_flags(workspace.path().join("state/local.sqlite"), flags)?;
        if rusqlite::version_number() < 3_051_003 {
            return Err(Error::Integrity("unpatched SQLite runtime".into()));
        }
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
        )?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version > 2 {
            return Err(Error::Integrity("unknown metadata schema".into()));
        }
        if version == 0 {
            let tx = connection.transaction()?;
            tx.execute_batch(include_str!("../migrations/0001_local.sql"))?;
            tx.commit()?;
        }
        if version < 2 {
            let tx = connection.transaction()?;
            tx.execute_batch(include_str!("../migrations/0002_remote_state.sql"))?;
            tx.commit()?;
        }
        let adapter_json = serde_json::to_string(adapter)?;
        connection.execute(
            "INSERT OR IGNORE INTO installation(id,adapter,mappings) VALUES(1,?1,?2)",
            params![adapter_json, serde_json::to_string(&adapter.roots()?)?],
        )?;
        let saved: String =
            connection.query_row("SELECT adapter FROM installation WHERE id=1", [], |r| {
                r.get(0)
            })?;
        if saved != adapter_json {
            return Err(Error::Adapter);
        }
        Ok(Self { connection })
    }
    pub fn save_scan(&self, scan: &CompleteScan) -> Result<()> {
        self.connection.execute(
            "INSERT INTO scans(manifest,coverage) VALUES(?1,?2)",
            params![
                serde_json::to_string(&scan.manifest)?,
                serde_json::to_string(&scan.coverage)?
            ],
        )?;
        Ok(())
    }
    pub fn capture(&mut self, scan: &CompleteScan, label: &str) -> Result<Snapshot> {
        self.insert_snapshot(&scan.manifest, &scan.coverage, label, true)
    }
    pub(crate) fn insert_snapshot(
        &mut self,
        manifest: &Manifest,
        coverage: &Coverage,
        label: &str,
        initial_baseline: bool,
    ) -> Result<Snapshot> {
        if label.is_empty() || label.len() > 128 {
            return Err(Error::Limit("snapshot label".into()));
        }
        let manifest = serde_json::to_string(manifest)?;
        let coverage = serde_json::to_string(coverage)?;
        let digest = blake3::hash(manifest.as_bytes()).to_hex().to_string();
        let tx = self.connection.transaction()?;
        tx.execute(
            "INSERT INTO snapshots(label,manifest,coverage,digest) VALUES(?1,?2,?3,?4)",
            params![label, manifest, coverage, digest],
        )?;
        let id = tx.last_insert_rowid();
        if initial_baseline {
            tx.execute(
                "INSERT OR IGNORE INTO baseline(id,snapshot_id) VALUES(1,?1)",
                [id],
            )?;
        }
        tx.commit()?;
        self.snapshot(id)
    }
    pub fn snapshot(&self, id: i64) -> Result<Snapshot> {
        let row = self
            .connection
            .query_row(
                "SELECT label,manifest,coverage,digest,created_at FROM snapshots WHERE id=?1",
                [id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        if blake3::hash(row.1.as_bytes()).to_hex().as_str() != row.3 {
            return Err(Error::Integrity("snapshot metadata digest".into()));
        }
        let manifest: Manifest = serde_json::from_str(&row.1)?;
        manifest
            .validate()
            .map_err(|e| Error::Integrity(e.into()))?;
        Ok(Snapshot {
            id,
            label: row.0,
            manifest,
            coverage: serde_json::from_str(&row.2)?,
            created_at: row.4,
        })
    }
    pub fn history(&self) -> Result<Vec<Snapshot>> {
        let mut statement = self
            .connection
            .prepare("SELECT id FROM snapshots ORDER BY id DESC LIMIT 100")?;
        let ids = statement
            .query_map([], |r| r.get::<_, i64>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ids.into_iter().map(|id| self.snapshot(id)).collect()
    }
    pub fn baseline(&self) -> Result<Option<Snapshot>> {
        let id = self
            .connection
            .query_row("SELECT snapshot_id FROM baseline WHERE id=1", [], |r| {
                r.get(0)
            })
            .optional()?;
        id.map(|id| self.snapshot(id)).transpose()
    }
    pub fn operations(&self) -> Result<Vec<Operation>> {
        let mut stmt = self
            .connection
            .prepare("SELECT id,target_snapshot,state,error FROM operations ORDER BY id DESC")?;
        Ok(stmt
            .query_map([], |r| {
                Ok(Operation {
                    id: r.get(0)?,
                    target_snapshot: r.get(1)?,
                    state: r.get(2)?,
                    error: r.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }
    pub fn pending(&self) -> Result<bool> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM operations WHERE state NOT IN ('committed','rolledBack'))",
            [],
            |r| r.get(0),
        )?)
    }
    #[cfg(unix)]
    pub fn prepare(
        &mut self,
        target: i64,
        before: &CompleteScan,
        steps: &[Step],
        sync_job: Option<&str>,
    ) -> Result<i64> {
        let tx = self.connection.transaction()?;
        tx.execute("INSERT INTO operations(target_snapshot,state,before_manifest) VALUES(?1,'prepared',?2)",params![target,serde_json::to_string(&before.manifest)?])?;
        let id = tx.last_insert_rowid();
        if let Some(job) = sync_job {
            if tx.execute("UPDATE sync_jobs SET state='applying',generation=generation+1,updated_at=unixepoch() WHERE id=?1 AND state='remoteCommitted'",[job])?!=1{return Err(Error::Concurrent("sync apply state".into()));}
            tx.execute(
                "INSERT INTO sync_applications VALUES(?1,?2)",
                params![id, job],
            )?;
        }
        for (index, step) in steps.iter().enumerate() {
            tx.execute("INSERT INTO operation_steps(operation_id,position,step,state) VALUES(?1,?2,?3,'prepared')",params![id,index as i64,serde_json::to_string(step)?])?;
        }
        tx.commit()?;
        Ok(id)
    }
    #[cfg(unix)]
    pub fn steps(&self, id: i64) -> Result<Vec<Step>> {
        let mut stmt = self
            .connection
            .prepare("SELECT step FROM operation_steps WHERE operation_id=?1 ORDER BY position")?;
        let rows = stmt
            .query_map([id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|s| Ok(serde_json::from_str(&s)?))
            .collect()
    }
    #[cfg(unix)]
    pub fn before(&self, id: i64) -> Result<Manifest> {
        let json: String = self.connection.query_row(
            "SELECT before_manifest FROM operations WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        Ok(serde_json::from_str(&json)?)
    }
    #[cfg(unix)]
    pub fn step_status(&self, id: i64, index: usize) -> Result<String> {
        Ok(self.connection.query_row(
            "SELECT state FROM operation_steps WHERE operation_id=?1 AND position=?2",
            params![id, index as i64],
            |r| r.get(0),
        )?)
    }
    #[cfg(unix)]
    pub fn operation(&self, id: i64) -> Result<Operation> {
        self.operations()?
            .into_iter()
            .find(|op| op.id == id)
            .ok_or(Error::NotFound)
    }
    #[cfg(unix)]
    pub fn step_state(&self, id: i64, index: usize, state: &str) -> Result<()> {
        self.connection.execute(
            "UPDATE operation_steps SET state=?3 WHERE operation_id=?1 AND position=?2",
            params![id, index as i64, state],
        )?;
        Ok(())
    }
    #[cfg(unix)]
    pub fn state(&self, id: i64, state: &str, error: Option<&str>) -> Result<()> {
        let tx = self.connection.unchecked_transaction()?;
        tx.execute(
            "UPDATE operations SET state=?2,error=?3 WHERE id=?1",
            params![id, state, error],
        )?;
        let next = match state {
            "recoveryRequired" => Some("recoveryRequired"),
            "rolledBack" => Some("failed"),
            _ => None,
        };
        if let Some(next) = next {
            tx.execute("UPDATE sync_jobs SET state=?2,generation=generation+1,updated_at=unixepoch() WHERE id=(SELECT job_id FROM sync_applications WHERE operation_id=?1)",params![id,next])?;
        }
        tx.commit()?;
        Ok(())
    }
    #[cfg(unix)]
    pub fn commit(&mut self, id: i64, target: i64) -> Result<()> {
        let tx = self.connection.transaction()?;
        tx.execute("INSERT INTO snapshots(label,manifest,coverage,digest) SELECT 'Applied snapshot #' || id,manifest,coverage,digest FROM snapshots WHERE id=?1",[target])?;
        let applied = tx.last_insert_rowid();
        tx.execute("UPDATE baseline SET snapshot_id=?1 WHERE id=1", [applied])?;
        tx.execute("UPDATE operations SET state='committed' WHERE id=?1", [id])?;
        let job_id: Option<String> = tx
            .query_row(
                "SELECT job_id FROM sync_applications WHERE operation_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(job_id) = job_id {
            let job = crate::synchronization::load_job(&tx, &job_id)?;
            let head = job.data.published_head.ok_or(Error::Coverage)?;
            tx.execute("INSERT INTO remote_baseline VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET snapshot_id=excluded.snapshot_id,head=excluded.head",params![applied,serde_json::to_string(&head)?])?;
            tx.execute(
                "INSERT INTO sync_outbox VALUES(?1,?2,?3,'pending')",
                params![job_id, applied, serde_json::to_string(&head)?],
            )?;
            tx.execute("UPDATE sync_jobs SET state='acknowledgementPending',generation=generation+1,updated_at=unixepoch() WHERE id=?1",[job_id])?;
        }

        tx.commit()?;
        Ok(())
    }
}
