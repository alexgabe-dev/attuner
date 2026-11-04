//! Local application remains an explicit second action, with no network inside its journal.
use crate::{BlobIdentity, Coordinator, Error, Result, TransferProgress};
use attuner_sync_core::{
    ManifestFile,
    synchronization::{JobState, SyncJob},
};
impl Coordinator<'_> {
    fn current_publication(&mut self, job: &SyncJob) -> Result<()> {
        let current = self.client.fetch_head(&self.binding.profile_id)?;
        self.engine.observe_remote(&current.head, self.control)?;
        if Some(&current.head) != job.data.published_head.as_ref()
            || current.policy_version != self.binding.policy_version
            || current.roots != self.binding.roots
        {
            return Err(Error::HeadMoved);
        }
        Ok(())
    }
    pub fn apply_approved(
        &mut self,
        id: &str,
        digest: &str,
        mut progress: impl FnMut(&ManifestFile, TransferProgress),
    ) -> Result<SyncJob> {
        let mut job = self.engine.sync_job(id, self.control)?;
        if job.data.published_head.is_none()
            || job.data.approval_digest.as_deref() != Some(digest)
            || self.engine.sync_review_digest(id, self.control)? != digest
            || !matches!(
                job.state,
                JobState::RemoteCommitted | JobState::Transferring | JobState::Offline
            )
        {
            return Err(Error::ReviewRequired);
        }
        let result = self.apply(&mut job, &mut progress);
        if let Err(error) = result {
            self.fail(&mut job, &error);
            return Err(error);
        }
        let current = self.engine.sync_job(id, self.control)?;
        let _ = self.client.report_job(self.engine, &current, self.control);
        Ok(current)
    }
    fn apply(
        &mut self,
        job: &mut SyncJob,
        progress: &mut impl FnMut(&ManifestFile, TransferProgress),
    ) -> Result<()> {
        if job.state == JobState::Offline {
            if !matches!(
                job.data.resume_state,
                Some(JobState::Transferring | JobState::RemoteCommitted)
            ) {
                return Err(Error::ReviewRequired);
            }
            job.data.resume_state = None;
            job.data.reason = None;
        }
        self.require_fresh_local(job)?;
        self.current_publication(job)?;
        job.state = JobState::Transferring;
        self.save(job)?;
        let manifest = job.data.proposed.clone().ok_or(Error::Protocol)?;
        let mut seen = std::collections::BTreeSet::new();
        for entry in &manifest.files {
            self.control.check()?;
            if !seen.insert(&entry.hash) {
                continue;
            }
            if self.engine.has_verified_blob(entry, self.control)? {
                progress(
                    entry,
                    TransferProgress {
                        completed_bytes: entry.size,
                        total_bytes: entry.size,
                        reused_bytes: entry.size,
                    },
                );
                continue;
            }
            let mut stage = self.engine.download_stage(entry, self.control)?;
            let offset = stage.len()?;
            self.client.download_blob_durable(
                BlobIdentity {
                    profile_id: &self.binding.profile_id,
                    hash: &entry.hash,
                    size: entry.size,
                },
                &mut stage,
                offset,
                self.control,
                |p| progress(entry, p),
                |stage, bytes, hash| Ok(stage.checkpoint(bytes, hash)?),
            )?;
            self.engine.import_download(stage, self.control)?;
        }
        self.require_fresh_local(job)?;
        self.current_publication(job)?;
        job.state = JobState::RemoteCommitted;
        self.save(job)?;
        let target = self.engine.record_verified_remote_snapshot(
            &manifest,
            "Verified synchronization candidate",
            self.control,
        )?;
        job.data.target_snapshot = Some(target.id);
        self.save(job)?;
        let expected = self.engine.scan(self.control)?;
        self.engine
            .apply_sync_job(&job.data.id, &expected, self.control)?;
        Ok(())
    }
    /// Foreground retry only. Acknowledgements report a durable past local commit;
    /// they do not assert that no user edits have happened since that commit.
    pub fn acknowledge_pending(&mut self) -> Result<usize> {
        let outbox = self.engine.pending_acknowledgements(self.control)?;
        let mut delivered = 0;
        for acknowledgement in outbox {
            let mut job = self
                .engine
                .sync_job(&acknowledgement.job_id, self.control)?;
            if job.state == JobState::Offline
                && job.data.resume_state == Some(JobState::AcknowledgementPending)
            {
                job.state = JobState::AcknowledgementPending;
                job.data.resume_state = None;
                job.data.reason = None;
                self.save(&mut job)?;
            }
            match self
                .client
                .acknowledge(&self.binding.profile_id, &acknowledgement.head)
            {
                Ok(()) => {
                    self.engine.mark_acknowledged(
                        &acknowledgement.job_id,
                        &acknowledgement.head,
                        self.control,
                    )?;
                    if let Ok(current) = self.engine.sync_job(&acknowledgement.job_id, self.control)
                    {
                        let _ = self.client.report_job(self.engine, &current, self.control);
                    }
                    delivered += 1;
                }
                Err(error) => {
                    self.fail(&mut job, &error);
                    return Err(error);
                }
            }
        }
        Ok(delivered)
    }
}
