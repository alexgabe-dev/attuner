//! Durable transport-independent synchronization metadata. This module performs no network I/O.
use crate::{Control, Engine, Error, Manifest, Result, Snapshot, remote};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
fn uuid(value: &str) -> bool {
    Manifest {
        protocol_version: 1,
        profile_id: value.into(),
        policy_version: 1,
        files: vec![],
    }
    .validate()
    .is_ok()
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteHead {
    pub snapshot_id: Option<String>,
    pub revision: u64,
    pub manifest_hash: Option<String>,
}
impl RemoteHead {
    pub fn empty() -> Self {
        Self {
            snapshot_id: None,
            revision: 0,
            manifest_hash: None,
        }
    }
    pub fn validate(&self) -> Result<()> {
        if self.revision > 9007199254740991
            || (self.revision == 0 && (self.snapshot_id.is_some() || self.manifest_hash.is_some()))
            || (self.revision > 0
                && (!self.snapshot_id.as_deref().is_some_and(uuid)
                    || !self.manifest_hash.as_deref().is_some_and(hash)))
        {
            return Err(Error::Integrity("remote head identity".into()));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileHead {
    pub head: RemoteHead,
    pub policy_version: u32,
    pub namespace_version: u32,
    pub roots: Vec<String>,
}
impl ProfileHead {
    pub fn validate(&self) -> Result<()> {
        self.head.validate()?;
        if self.policy_version == 0
            || self.namespace_version != 1
            || self.roots.is_empty()
            || self.roots.len() > 3
            || self.roots.iter().enumerate().any(|(i, r)| {
                !matches!(r.as_str(), "account" | "addons" | "character")
                    || self.roots[..i].contains(r)
            })
        {
            return Err(Error::Coverage);
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub server_id: String,
    pub origin: String,
    pub profile_id: String,
    pub policy_version: u32,
    pub roots: Vec<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Ready,
    Capturing,
    Fetching,
    Comparing,
    BootstrapReview,
    ConflictReview,
    Transferring,
    AwaitingApproval,
    Publishing,
    RemoteCommitted,
    Applying,
    RecoveryRequired,
    AcknowledgementPending,
    Complete,
    Cancelled,
    Offline,
    Revoked,
    Failed,
}
impl JobState {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Complete | Self::Cancelled | Self::Failed)
    }
    fn permits(self, next: Self) -> bool {
        use JobState::*;
        if self.terminal() {
            return false;
        }
        if self == next {
            return true;
        }
        if matches!(next, Cancelled | Failed) && !matches!(self, Applying | RecoveryRequired) {
            return true;
        }
        if matches!(next, Offline | Revoked)
            && matches!(
                self,
                Fetching | Transferring | Publishing | RemoteCommitted | AcknowledgementPending
            )
        {
            return true;
        }
        matches!(
            (self, next),
            (Ready, Capturing)
                | (Capturing, Fetching)
                | (Fetching, Comparing)
                | (
                    Comparing,
                    Fetching | BootstrapReview | ConflictReview | AwaitingApproval
                )
                | (BootstrapReview | ConflictReview, AwaitingApproval)
                | (AwaitingApproval, Transferring)
                | (Transferring, Publishing | RemoteCommitted)
                | (Publishing, RemoteCommitted)
                | (RemoteCommitted, Transferring | Applying)
                | (Applying, RecoveryRequired | AcknowledgementPending)
                | (AcknowledgementPending, Complete)
                | (
                    Offline,
                    Fetching | Transferring | Publishing | RemoteCommitted | AcknowledgementPending
                )
                | (Revoked, AcknowledgementPending)
        )
    }
    pub(crate) fn text(self) -> Result<String> {
        Ok(serde_json::to_value(self)?
            .as_str()
            .ok_or(Error::Coverage)?
            .into())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Choice {
    Local,
    Remote,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Decision {
    pub root: String,
    pub path: String,
    pub choice: Choice,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobData {
    pub id: String,
    pub local_snapshot: Option<i64>,
    #[serde(default)]
    pub target_snapshot: Option<i64>,
    pub baseline_snapshot: Option<i64>,
    pub baseline_head: Option<RemoteHead>,
    pub remote: Option<ProfileHead>,
    pub remote_manifest: Option<Manifest>,
    pub proposed: Option<Manifest>,
    pub request_id: String,
    pub session_id: Option<String>,
    pub approval_digest: Option<String>,
    pub published_head: Option<RemoteHead>,
    pub decisions: Vec<Decision>,
    #[serde(default)]
    pub validated_proposal_id: Option<String>,
    pub reason: Option<String>,
    pub resume_state: Option<JobState>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncJob {
    pub state: JobState,
    pub generation: u64,
    #[serde(flatten)]
    pub data: JobData,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBaseline {
    pub snapshot: Snapshot,
    pub head: RemoteHead,
}
impl Engine {
    pub fn bind_remote(&mut self, binding: &Binding, control: &Control) -> Result<()> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        self.ensure_idle()?;
        let roots: Vec<_> = self
            .adapter
            .roots()?
            .into_iter()
            .map(|r| r.logical)
            .collect();
        if !uuid(&binding.server_id)
            || binding.profile_id != self.adapter.profile_id()
            || binding.policy_version != 1
            || binding.roots != roots
            || !binding.origin.starts_with("https://")
            || binding.origin.len() <= 8
            || binding.origin.len() > 512
            || binding.origin[8..].contains(['/', '@', '?', '#', '\\'])
            || binding.origin.chars().any(char::is_control)
        {
            return Err(Error::Coverage);
        }
        if let Some(existing) = self.remote_binding_inner()? {
            if existing != *binding {
                return Err(Error::Coverage);
            }
            return Ok(());
        }
        self.store.connection.execute(
            "INSERT INTO remote_binding VALUES(1,?1,?2,?3,?4,?5,?6)",
            params![
                binding.server_id,
                binding.origin,
                binding.profile_id,
                binding.policy_version,
                serde_json::to_string(&binding.roots)?,
                serde_json::to_string(&RemoteHead::empty())?
            ],
        )?;
        Ok(())
    }
    fn remote_binding_inner(&self) -> Result<Option<Binding>> {
        let record=self.store.connection.query_row(
            "SELECT server_id,origin,profile_id,policy_version,roots FROM remote_binding WHERE id=1",[],
            |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,u32>(3)?,r.get::<_,String>(4)?)),
        ).optional()?;
        record
            .map(|(server_id, origin, profile_id, policy_version, roots)| {
                Ok(Binding {
                    server_id,
                    origin,
                    profile_id,
                    policy_version,
                    roots: serde_json::from_str(&roots)?,
                })
            })
            .transpose()
    }
    pub fn remote_binding(&self, control: &Control) -> Result<Option<Binding>> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        self.remote_binding_inner()
    }
    pub fn observe_remote(&mut self, head: &RemoteHead, control: &Control) -> Result<()> {
        self.record_observed(head, true, control)
    }
    pub fn remember_publication(&mut self, head: &RemoteHead, control: &Control) -> Result<()> {
        self.record_observed(head, false, control)
    }
    fn record_observed(
        &mut self,
        head: &RemoteHead,
        current: bool,
        control: &Control,
    ) -> Result<()> {
        control.check()?;
        head.validate()?;
        let _lock = self.workspace.lock()?;
        let old: String = self.store.connection.query_row(
            "SELECT observed_head FROM remote_binding WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        let old: RemoteHead = serde_json::from_str(&old)?;
        old.validate()?;
        if !current && head.revision < old.revision {
            return Ok(());
        }
        if head.revision < old.revision || (head.revision == old.revision && *head != old) {
            return Err(Error::Integrity(
                "remote revision regression or equivocation".into(),
            ));
        }
        self.store.connection.execute(
            "UPDATE remote_binding SET observed_head=?1 WHERE id=1",
            [serde_json::to_string(head)?],
        )?;
        Ok(())
    }
    pub fn remote_baseline(&self, control: &Control) -> Result<Option<RemoteBaseline>> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        let row = self
            .store
            .connection
            .query_row(
                "SELECT snapshot_id,head FROM remote_baseline WHERE id=1",
                [],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;
        row.map(|(id, head)| {
            let head: RemoteHead = serde_json::from_str(&head)?;
            head.validate()?;
            let snapshot = self.store.snapshot(id)?;
            if head.manifest_hash.as_deref() != Some(remote::digest(&snapshot.manifest)?.as_str()) {
                return Err(Error::Integrity("remote baseline manifest".into()));
            }
            Ok(RemoteBaseline { snapshot, head })
        })
        .transpose()
    }
    pub fn snapshot(&self, id: i64, control: &Control) -> Result<Snapshot> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        self.store.snapshot(id)
    }
    pub fn save_sync_job(&mut self, job: &mut SyncJob, control: &Control) -> Result<()> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        self.ensure_idle()?;
        let binding = self.remote_binding_inner()?.ok_or(Error::Coverage)?;
        if !uuid(&job.data.id)
            || !uuid(&job.data.request_id)
            || job
                .data
                .validated_proposal_id
                .as_deref()
                .is_some_and(|id| !uuid(id))
            || job.data.decisions.len() > 100000
            || job.data.reason.as_ref().is_some_and(|v| v.len() > 4096)
            || job.data.session_id.as_deref().is_some_and(|id| !uuid(id))
        {
            return Err(Error::Coverage);
        }
        for manifest in job
            .data
            .remote_manifest
            .iter()
            .chain(job.data.proposed.iter())
        {
            remote::validate(
                manifest,
                &binding.profile_id,
                &binding.roots,
                binding.policy_version,
            )?;
        }
        for head in job
            .data
            .baseline_head
            .iter()
            .chain(job.data.published_head.iter())
        {
            head.validate()?;
        }
        if let Some(remote) = &job.data.remote {
            remote.validate()?;
            if remote.policy_version != binding.policy_version || remote.roots != binding.roots {
                return Err(Error::Coverage);
            }
        }
        for id in job
            .data
            .local_snapshot
            .iter()
            .chain(job.data.baseline_snapshot.iter())
            .chain(job.data.target_snapshot.iter())
        {
            let snapshot = self.store.snapshot(*id)?;
            remote::validate(
                &snapshot.manifest,
                &binding.profile_id,
                &binding.roots,
                binding.policy_version,
            )?;
        }
        if let (Some(policy), Some(manifest)) = (&job.data.remote, &job.data.remote_manifest)
            && ((policy.head.revision == 0 && !manifest.files.is_empty())
                || (policy.head.revision > 0
                    && policy.head.manifest_hash.as_deref()
                        != Some(remote::digest(manifest)?.as_str())))
        {
            return Err(Error::Integrity("remote manifest identity".into()));
        }
        match (&job.data.baseline_snapshot, &job.data.baseline_head) {
            (Some(id), Some(head)) => {
                if head.manifest_hash.as_deref()
                    != Some(remote::digest(self.store.snapshot(*id)?.manifest())?.as_str())
                {
                    return Err(Error::Coverage);
                }
            }
            (None, None) => {}
            _ => return Err(Error::Coverage),
        }
        if let Some(head) = &job.data.published_head {
            let proposed = job.data.proposed.as_ref().ok_or(Error::Coverage)?;
            let previous = &job.data.remote.as_ref().ok_or(Error::Coverage)?.head;
            if head.revision == 0
                || head.manifest_hash.as_deref() != Some(remote::digest(proposed)?.as_str())
                || head.revision < previous.revision
                || head.revision > previous.revision.saturating_add(1)
                || (head.revision == previous.revision && head != previous)
            {
                return Err(Error::Coverage);
            }
        }
        if let Some(approval) = &job.data.approval_digest
            && (!hash(approval) || *approval != review_digest(&self.store, job)?)
        {
            return Err(Error::Integrity("stale synchronization approval".into()));
        }
        if job.generation == 0 && job.state != JobState::Capturing {
            return Err(Error::Coverage);
        }
        if job.generation > 0 {
            let old = load_job(&self.store.connection, &job.data.id)?;
            if !old.state.permits(job.state) {
                return Err(Error::Integrity(
                    "invalid synchronization transition".into(),
                ));
            }
        }
        let payload = serde_json::to_string(&job.data)?;
        if payload.len() > 64 * 1024 * 1024 {
            return Err(Error::Limit("synchronization job metadata".into()));
        }
        let digest = blake3::hash(payload.as_bytes()).to_hex().to_string();
        let state = job.state.text()?;
        if job.generation == 0 {
            self.store.connection.execute(
                "INSERT INTO sync_jobs(id,state,generation,payload,digest) VALUES(?1,?2,1,?3,?4)",
                params![job.data.id, state, payload, digest],
            )?;
            job.generation = 1;
        } else {
            if self.store.connection.execute("UPDATE sync_jobs SET state=?1,generation=generation+1,payload=?2,digest=?3,updated_at=unixepoch() WHERE id=?4 AND generation=?5",params![state,payload,digest,job.data.id,i64::try_from(job.generation).map_err(|_|Error::Limit("job generation".into()))?])?!=1{return Err(Error::Concurrent("synchronization job changed".into()));}
            job.generation += 1;
        }
        Ok(())
    }
    pub fn sync_job(&self, id: &str, control: &Control) -> Result<SyncJob> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        load_job(&self.store.connection, id)
    }
    /// Native hosts inspect the single active job without loading retained history payloads.
    pub fn active_sync_job(&self, control: &Control) -> Result<Option<SyncJob>> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        let id:Option<String>=self.store.connection.query_row("SELECT id FROM sync_jobs WHERE state NOT IN ('complete','failed','cancelled') LIMIT 1",[],|r|r.get(0)).optional()?;
        id.map(|id| load_job(&self.store.connection, &id))
            .transpose()
    }
    pub fn sync_jobs(&self, control: &Control) -> Result<Vec<SyncJob>> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        let mut query = self
            .store
            .connection
            .prepare("SELECT id FROM sync_jobs ORDER BY created_at DESC,id LIMIT 100")?;
        let ids = query
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|id| load_job(&self.store.connection, &id))
            .collect()
    }
}
pub(crate) fn load_job(connection: &rusqlite::Connection, id: &str) -> Result<SyncJob> {
    let (state, generation, payload, digest): (String, i64, String, String) = connection
        .query_row(
            "SELECT state,generation,payload,digest FROM sync_jobs WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
    if payload.len() > 64 * 1024 * 1024
        || blake3::hash(payload.as_bytes()).to_hex().as_str() != digest
    {
        return Err(Error::Integrity("sync job metadata".into()));
    }
    let data: JobData = serde_json::from_str(&payload)?;
    if data.id != id {
        return Err(Error::Integrity("sync job identity".into()));
    }
    Ok(SyncJob {
        state: serde_json::from_value(serde_json::Value::String(state))?,
        generation: u64::try_from(generation)
            .map_err(|_| Error::Integrity("job generation".into()))?,
        data,
    })
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Acknowledgement {
    pub job_id: String,
    pub snapshot_id: i64,
    pub head: RemoteHead,
}
pub(crate) fn review_digest(store: &crate::store::Store, job: &SyncJob) -> Result<String> {
    let local = store.snapshot(job.data.local_snapshot.ok_or(Error::Coverage)?)?;
    let candidate = job.data.proposed.as_ref().ok_or(Error::Coverage)?;
    let value = serde_json::json!({"jobId":job.data.id,"baseline":job.data.baseline_head,"local":remote::digest(local.manifest())?,"remote":job.data.remote.as_ref().ok_or(Error::Coverage)?.head,"candidate":remote::digest(candidate)?});
    Ok(blake3::hash(serde_json::to_string(&value)?.as_bytes())
        .to_hex()
        .to_string())
}
impl Engine {
    pub fn sync_review_digest(&self, id: &str, control: &Control) -> Result<String> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        review_digest(&self.store, &load_job(&self.store.connection, id)?)
    }
    pub fn pending_acknowledgements(&self, control: &Control) -> Result<Vec<Acknowledgement>> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        let mut query=self.store.connection.prepare("SELECT job_id,snapshot_id,head FROM sync_outbox WHERE state='pending' ORDER BY snapshot_id DESC LIMIT 100")?;
        let rows = query
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(job_id, snapshot_id, head)| {
                let head: RemoteHead = serde_json::from_str(&head)?;
                head.validate()?;
                let snapshot = self.store.snapshot(snapshot_id)?;
                if head.manifest_hash.as_deref()
                    != Some(remote::digest(snapshot.manifest())?.as_str())
                {
                    return Err(Error::Integrity("acknowledgement manifest".into()));
                }
                Ok(Acknowledgement {
                    job_id,
                    snapshot_id,
                    head,
                })
            })
            .collect()
    }
    pub fn mark_acknowledged(
        &mut self,
        id: &str,
        head: &RemoteHead,
        control: &Control,
    ) -> Result<()> {
        control.check()?;
        head.validate()?;
        let _lock = self.workspace.lock()?;
        let tx = self.store.connection.transaction()?;
        let saved: String =
            tx.query_row("SELECT head FROM sync_outbox WHERE job_id=?1", [id], |r| {
                r.get(0)
            })?;
        if serde_json::from_str::<RemoteHead>(&saved)? != *head {
            return Err(Error::Coverage);
        }
        tx.execute(
            "UPDATE sync_outbox SET state='delivered' WHERE job_id=?1",
            [id],
        )?;
        tx.execute("UPDATE sync_jobs SET state='complete',generation=generation+1,updated_at=unixepoch() WHERE id=?1",[id])?;
        tx.commit()?;
        Ok(())
    }
}
#[cfg(unix)]
impl Engine {
    pub fn apply_sync_job(
        &mut self,
        id: &str,
        expected: &crate::CompleteScan,
        control: &Control,
    ) -> Result<i64> {
        let job = self.sync_job(id, control)?;
        self.apply_snapshot_inner(
            job.data.target_snapshot.ok_or(Error::Coverage)?,
            expected,
            Some(id),
            control,
        )
    }
}
#[cfg(not(unix))]
impl Engine {
    pub fn apply_sync_job(
        &mut self,
        _id: &str,
        _expected: &crate::CompleteScan,
        control: &Control,
    ) -> Result<i64> {
        control.check()?;
        Err(Error::Platform)
    }
}
