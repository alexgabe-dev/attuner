//! Explicit, foreground-only coordination. No timers, watcher or background apply exists.
use crate::{
    BlobIdentity, CandidateSession, DeviceClient, Error, RemoteHead, Result, TransferProgress,
};
use attuner_sync_core::{
    Cancellation, Control, Engine, Manifest, ManifestFile, remote,
    synchronization::{Binding, Decision, JobData, JobState, SyncJob},
};
use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BootstrapChoice {
    Local,
    Remote,
}
pub struct Coordinator<'a> {
    pub(crate) engine: &'a mut Engine,
    pub(crate) client: &'a mut DeviceClient,
    pub(crate) control: &'a Control,
    pub(crate) binding: Binding,
}
impl<'a> Coordinator<'a> {
    pub fn new(
        engine: &'a mut Engine,
        client: &'a mut DeviceClient,
        control: &'a Control,
    ) -> Result<Self> {
        control.check()?;
        let binding = engine.remote_binding(control)?.ok_or(Error::Protocol)?;
        if binding.server_id != client.connection.info.server_id
            || binding.origin != client.connection.origin()
            || binding.profile_id != engine.adapter().profile_id()
        {
            return Err(Error::Protocol);
        }
        Ok(Self {
            engine,
            client,
            control,
            binding,
        })
    }
    pub(crate) fn save(&mut self, job: &mut SyncJob) -> Result<()> {
        self.engine.save_sync_job(job, self.control)?;
        let _ = self.client.report_job(self.engine, job, self.control);
        Ok(())
    }
    pub(crate) fn fail(&mut self, job: &mut SyncJob, error: &Error) {
        let mut control = self.control.clone();
        control.cancellation = Cancellation::default();
        job.data.reason = Some(error.to_string().chars().take(4096).collect());
        if self.control.cancellation.is_cancelled() {
            job.state = JobState::Cancelled;
        } else if matches!(error, Error::Transport | Error::Rejected(429 | 503)) {
            job.data.resume_state = Some(job.state);
            job.state = JobState::Offline;
        } else if matches!(error, Error::Authentication) {
            job.state = JobState::Revoked;
        } else if matches!(
            error,
            Error::Cancelled | Error::Engine(attuner_sync_core::Error::Cancelled)
        ) {
            job.state = JobState::Cancelled;
        } else {
            job.state = JobState::Failed;
        }
        if self.engine.save_sync_job(job, &control).is_ok() {
            let _ = self.client.report_job(self.engine, job, &control);
        }
    }
    pub fn prepare(&mut self) -> Result<SyncJob> {
        if self
            .engine
            .sync_jobs(self.control)?
            .iter()
            .any(|j| !j.state.terminal())
        {
            return Err(Error::PendingJob);
        }
        let baseline = self.engine.remote_baseline(self.control)?;
        let mut job = SyncJob {
            state: JobState::Capturing,
            generation: 0,
            data: JobData {
                id: uuid::Uuid::new_v4().to_string(),
                local_snapshot: None,
                target_snapshot: None,
                baseline_snapshot: baseline.as_ref().map(|b| b.snapshot.id),
                baseline_head: baseline.map(|b| b.head),
                remote: None,
                remote_manifest: None,
                proposed: None,
                request_id: uuid::Uuid::new_v4().to_string(),
                session_id: None,
                approval_digest: None,
                published_head: None,
                decisions: vec![],
                validated_proposal_id: None,
                reason: None,
                resume_state: None,
            },
        };
        self.save(&mut job)?;
        if let Err(error) = self.capture_compare(&mut job) {
            self.fail(&mut job, &error);
            return Err(error);
        }
        Ok(job)
    }
    pub fn resume_comparison(&mut self, id: &str) -> Result<SyncJob> {
        let mut job = self.engine.sync_job(id, self.control)?;
        if !matches!(
            job.state,
            JobState::Capturing | JobState::Fetching | JobState::Comparing | JobState::Offline
        ) || job.data.session_id.is_some()
            || job.data.approval_digest.is_some()
        {
            return Err(Error::ReviewRequired);
        }
        if let Err(error) = self.capture_compare(&mut job) {
            self.fail(&mut job, &error);
            return Err(error);
        }
        Ok(job)
    }
    fn capture_compare(&mut self, job: &mut SyncJob) -> Result<()> {
        let scan = self.engine.scan(self.control)?;
        let previous = job
            .data
            .local_snapshot
            .map(|id| self.engine.snapshot(id, self.control))
            .transpose()?;
        if previous
            .as_ref()
            .is_none_or(|p| p.manifest() != scan.manifest())
        {
            let snapshot = self.engine.capture_snapshot(
                &scan,
                "Local synchronization capture",
                self.control,
            )?;
            job.data.local_snapshot = Some(snapshot.id);
        }
        job.state = JobState::Fetching;
        job.data.reason = None;
        job.data.resume_state = None;
        self.save(job)?;
        let policy = self.client.fetch_head(&self.binding.profile_id)?;
        self.engine.observe_remote(&policy.head, self.control)?;
        if policy.policy_version != self.binding.policy_version
            || policy.roots != self.binding.roots
        {
            return Err(Error::Protocol);
        }
        let snapshot = self
            .client
            .fetch_snapshot(&self.binding.profile_id, &policy)?;
        let manifest = snapshot.map(|s| s.manifest).unwrap_or_else(|| Manifest {
            protocol_version: 1,
            profile_id: self.binding.profile_id.clone(),
            policy_version: self.binding.policy_version,
            files: vec![],
        });
        job.data.remote = Some(policy);
        job.data.remote_manifest = Some(manifest);
        job.state = JobState::Comparing;
        self.save(job)?;
        self.require_fresh_local(job)?;
        if let Some(base) = job.data.baseline_snapshot {
            let baseline = self.engine.snapshot(base, self.control)?;
            let comparison = self.engine.compare_captured(
                job.data.local_snapshot.ok_or(Error::Protocol)?,
                baseline.manifest(),
                job.data.remote_manifest.as_ref().ok_or(Error::Protocol)?,
                self.control,
            )?;
            job.data.proposed = comparison.merged;
            job.state = if comparison.conflicts.is_empty() {
                JobState::AwaitingApproval
            } else {
                JobState::ConflictReview
            };
        } else {
            job.state = JobState::BootstrapReview;
        }
        self.save(job)
    }
    pub fn choose_bootstrap(&mut self, id: &str, choice: BootstrapChoice) -> Result<SyncJob> {
        let mut job = self.engine.sync_job(id, self.control)?;
        if job.state != JobState::BootstrapReview {
            return Err(Error::ReviewRequired);
        }
        job.data.proposed = Some(match choice {
            BootstrapChoice::Local => self
                .engine
                .snapshot(
                    job.data.local_snapshot.ok_or(Error::Protocol)?,
                    self.control,
                )?
                .manifest()
                .clone(),
            BootstrapChoice::Remote => job.data.remote_manifest.clone().ok_or(Error::Protocol)?,
        });
        job.state = JobState::AwaitingApproval;
        self.save(&mut job)?;
        Ok(job)
    }
    pub fn conflicts(&self, id: &str) -> Result<Vec<attuner_sync_core::compare::Conflict>> {
        let job = self.engine.sync_job(id, self.control)?;
        let baseline = self.engine.snapshot(
            job.data.baseline_snapshot.ok_or(Error::ReviewRequired)?,
            self.control,
        )?;
        Ok(self
            .engine
            .compare_captured(
                job.data.local_snapshot.ok_or(Error::Protocol)?,
                baseline.manifest(),
                job.data.remote_manifest.as_ref().ok_or(Error::Protocol)?,
                self.control,
            )?
            .conflicts)
    }
    pub fn resolve(&mut self, id: &str, decisions: Vec<Decision>) -> Result<SyncJob> {
        let mut job = self.engine.sync_job(id, self.control)?;
        if job.state != JobState::ConflictReview {
            return Err(Error::ReviewRequired);
        }
        let baseline = self.engine.snapshot(
            job.data.baseline_snapshot.ok_or(Error::Protocol)?,
            self.control,
        )?;
        job.data.proposed = Some(self.engine.resolve_captured(
            job.data.local_snapshot.ok_or(Error::Protocol)?,
            baseline.manifest(),
            job.data.remote_manifest.as_ref().ok_or(Error::Protocol)?,
            &decisions,
            self.control,
        )?);
        job.data.decisions = decisions;
        job.state = JobState::AwaitingApproval;
        self.save(&mut job)?;
        Ok(job)
    }
    pub fn approval_digest(&self, id: &str) -> Result<String> {
        let job = self.engine.sync_job(id, self.control)?;
        self.review_digest(&job)
    }
    fn review_digest(&self, job: &SyncJob) -> Result<String> {
        Ok(self.engine.sync_review_digest(&job.data.id, self.control)?)
    }
    pub(crate) fn require_fresh_local(&mut self, job: &SyncJob) -> Result<()> {
        let local = self.engine.snapshot(
            job.data.local_snapshot.ok_or(Error::Protocol)?,
            self.control,
        )?;
        if self.engine.scan(self.control)?.manifest() != local.manifest() {
            return Err(Error::StaleReview);
        }
        Ok(())
    }
    pub(crate) fn require_fresh_remote(&mut self, job: &SyncJob) -> Result<()> {
        let policy = self.client.fetch_head(&self.binding.profile_id)?;
        self.engine.observe_remote(&policy.head, self.control)?;
        if policy.head != job.data.remote.as_ref().ok_or(Error::Protocol)?.head
            || policy.policy_version != self.binding.policy_version
            || policy.roots != self.binding.roots
        {
            return Err(Error::HeadMoved);
        }
        Ok(())
    }
    pub fn publish_approved(
        &mut self,
        id: &str,
        digest: &str,
        mut progress: impl FnMut(&ManifestFile, TransferProgress),
    ) -> Result<SyncJob> {
        let mut job = self.engine.sync_job(id, self.control)?;
        if job.data.published_head.is_some() {
            return Err(Error::ReviewRequired);
        }
        if !matches!(
            job.state,
            JobState::AwaitingApproval
                | JobState::Transferring
                | JobState::Publishing
                | JobState::Offline
        ) {
            return Err(Error::ReviewRequired);
        }
        if (job
            .data
            .approval_digest
            .as_deref()
            .is_some_and(|old| old != digest))
            || self.review_digest(&job)? != digest
        {
            return Err(Error::StaleReview);
        }
        let result = self.publish(&mut job, digest, &mut progress);
        if let Err(error) = result {
            self.fail(&mut job, &error);
            return Err(error);
        }
        Ok(job)
    }
    fn publish(
        &mut self,
        job: &mut SyncJob,
        digest: &str,
        progress: &mut impl FnMut(&ManifestFile, TransferProgress),
    ) -> Result<()> {
        if job.state == JobState::Offline {
            job.state = job.data.resume_state.take().ok_or(Error::Protocol)?;
            job.data.reason = None;
            self.save(job)?;
        }
        let candidate = job.data.proposed.clone().ok_or(Error::ReviewRequired)?;
        let policy = job.data.remote.clone().ok_or(Error::Protocol)?;
        if job.state == JobState::Publishing {
            let session = job.data.session_id.as_ref().ok_or(Error::Protocol)?;
            let status = self.client.request(
                "GET",
                &format!(
                    "/api/v1/profiles/{}/sessions/{session}",
                    self.binding.profile_id
                ),
                None,
                None,
            )?;
            if status["state"] == "committed" {
                let head: RemoteHead = serde_json::from_value(status["result"].clone())
                    .map_err(|_| Error::Protocol)?;
                head.validate()?;
                if head.revision != policy.head.revision + 1
                    || head.manifest_hash.as_deref() != Some(remote::digest(&candidate)?.as_str())
                {
                    return Err(Error::Protocol);
                }
                self.engine.remember_publication(&head, self.control)?;
                job.data.published_head = Some(head);
                job.state = JobState::RemoteCommitted;
                return self.save(job);
            }
        }
        self.require_fresh_local(job)?;
        self.require_fresh_remote(job)?;
        if job.state == JobState::AwaitingApproval {
            job.data.approval_digest = Some(digest.into());
            job.state = JobState::Transferring;
            self.save(job)?;
        }
        if policy.head.revision > 0
            && policy.head.manifest_hash.as_deref() == Some(remote::digest(&candidate)?.as_str())
        {
            job.data.published_head = Some(policy.head);
            job.state = JobState::RemoteCommitted;
            return self.save(job);
        }
        if job.data.session_id.is_none() {
            let session = self.client.stage_snapshot(
                &candidate,
                &policy,
                job.data
                    .baseline_head
                    .as_ref()
                    .and_then(|h| h.snapshot_id.as_deref()),
                &job.data.request_id,
            )?;
            job.data.session_id = Some(session.session_id);
            self.save(job)?;
        }
        let session = job.data.session_id.clone().ok_or(Error::Protocol)?;
        if job.state != JobState::Publishing {
            let local = self.engine.snapshot(
                job.data.local_snapshot.ok_or(Error::Protocol)?,
                self.control,
            )?;
            let mut seen = std::collections::BTreeSet::new();
            for entry in &candidate.files {
                self.control.check()?;
                if !seen.insert(&entry.hash) {
                    continue;
                }
                let mut source = BackupReader {
                    engine: self.engine,
                    snapshot: local.id,
                    hash: &entry.hash,
                    control: self.control,
                    file: None,
                };
                self.client.upload_blob(
                    BlobIdentity {
                        profile_id: &self.binding.profile_id,
                        hash: &entry.hash,
                        size: entry.size,
                    },
                    &session,
                    &mut source,
                    self.control,
                    |p| progress(entry, p),
                )?;
            }
            self.require_fresh_local(job)?;
            self.require_fresh_remote(job)?;
            job.state = JobState::Publishing;
            self.save(job)?;
        }
        let session = CandidateSession {
            session_id: session,
            state: "open".into(),
            expires_at: 0,
        };
        let published = self
            .client
            .publish_reviewed(&candidate, &policy.head, &session)?;
        self.engine.remember_publication(&published, self.control)?;
        job.data.published_head = Some(published);
        job.state = JobState::RemoteCommitted;
        self.save(job)
    }
    pub fn cancel(&mut self, id: &str) -> Result<SyncJob> {
        let mut job = self.engine.sync_job(id, self.control)?;
        if job.state.terminal() {
            return Ok(job);
        }
        if job.data.resume_state == Some(JobState::AcknowledgementPending) {
            return Err(Error::ReviewRequired);
        }
        if matches!(
            job.state,
            JobState::Applying | JobState::RecoveryRequired | JobState::AcknowledgementPending
        ) {
            return Err(Error::ReviewRequired);
        }
        job.state = JobState::Cancelled;
        self.save(&mut job)?;
        Ok(job)
    }
}

struct BackupReader<'a> {
    engine: &'a Engine,
    snapshot: i64,
    hash: &'a str,
    control: &'a Control,
    file: Option<std::fs::File>,
}
impl Read for BackupReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.control.check().map_err(std::io::Error::other)?;
        if self.file.is_none() {
            let mut file = tempfile::tempfile()?;
            self.engine
                .export_snapshot_blob(self.snapshot, self.hash, &mut file, self.control)
                .map_err(std::io::Error::other)?;
            file.seek(SeekFrom::Start(0))?;
            self.file = Some(file);
        }
        self.file
            .as_mut()
            .ok_or_else(|| std::io::Error::other("backup reader unavailable"))?
            .read(buffer)
    }
}
