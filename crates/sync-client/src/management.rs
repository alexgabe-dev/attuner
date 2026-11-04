use crate::{Coordinator, DeviceClient, Error, RemoteHead, Result};
use attuner_sync_core::{
    Control, Engine, remote,
    synchronization::{Decision, JobState, SyncJob},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebProposal {
    pub id: String,
    pub job_id: String,
    pub username: String,
    pub source_generation: u64,
    pub local_manifest_hash: String,
    pub remote_head: RemoteHead,
    pub decisions: Vec<Decision>,
    pub candidate_manifest_hash: String,
    pub state: String,
    pub created_at: u64,
}
#[derive(Deserialize)]
struct Proposals {
    proposals: Vec<WebProposal>,
}
impl DeviceClient {
    pub fn report_job(&mut self, engine: &Engine, job: &SyncJob, control: &Control) -> Result<()> {
        if !self.connection.info.features.job_reporting {
            return Ok(());
        }
        let Some(local) = job.data.local_snapshot else {
            return Ok(());
        };
        let local = engine.snapshot(local, control)?;
        let hash = remote::digest(local.manifest())?;
        let mut body = json!({"sourceGeneration":job.generation,"state":job.state,"localManifest":if self.reported_local.get(&job.data.id)==Some(&hash){None}else{Some(local.manifest())},"localManifestHash":hash,"baselineSnapshotId":job.data.baseline_head.as_ref().and_then(|h|h.snapshot_id.as_ref()),"remoteHead":job.data.remote.as_ref().map(|r|&r.head),"publishedHead":job.data.published_head,"sessionId":job.data.session_id,"candidateManifestHash":job.data.proposed.as_ref().map(remote::digest).transpose()?,"validatedProposalId":job.data.validated_proposal_id,"reason":job.data.reason});
        let path = format!(
            "/api/v1/profiles/{}/jobs/{}",
            local.manifest().profile_id,
            job.data.id
        );
        let mut result = self.request("PUT", &path, Some(&body), None);
        if matches!(result, Err(Error::Rejected(428))) {
            body["localManifest"] =
                serde_json::to_value(local.manifest()).map_err(|_| Error::Protocol)?;
            result = self.request("PUT", &path, Some(&body), None);
        }
        let result = result?;
        if result["accepted"] != true || result["sourceGeneration"].as_u64() != Some(job.generation)
        {
            return Err(Error::Protocol);
        }
        if self.reported_local.len() >= 64 {
            self.reported_local.clear();
        }
        self.reported_local.insert(job.data.id.clone(), hash);
        Ok(())
    }
    pub fn pending_proposals(&mut self, profile: &str, job: &str) -> Result<Vec<WebProposal>> {
        if uuid::Uuid::parse_str(profile).is_err() || uuid::Uuid::parse_str(job).is_err() {
            return Err(Error::Protocol);
        }
        let result: Proposals = serde_json::from_value(self.request(
            "GET",
            &format!("/api/v1/profiles/{profile}/jobs/{job}/proposals"),
            None,
            None,
        )?)
        .map_err(|_| Error::Protocol)?;
        if result.proposals.len() > 1 {
            return Err(Error::Limit);
        }
        for proposal in &result.proposals {
            proposal.remote_head.validate()?;
            if uuid::Uuid::parse_str(&proposal.id).is_err()
                || proposal.job_id != job
                || proposal.decisions.len() > 100000
                || proposal.source_generation > 9007199254740991
                || proposal.state != "pending"
                || proposal.username.len() > 64
            {
                return Err(Error::Protocol);
            }
        }
        Ok(result.proposals)
    }
}
impl Coordinator<'_> {
    pub fn accept_web_proposal(&mut self, job_id: &str, proposal_id: &str) -> Result<SyncJob> {
        let mut job = self.engine.sync_job(job_id, self.control)?;
        if job.state != JobState::ConflictReview {
            return Err(Error::ReviewRequired);
        }
        let proposals = self
            .client
            .pending_proposals(&self.binding.profile_id, job_id)?;
        let proposal = proposals
            .into_iter()
            .find(|p| p.id == proposal_id)
            .ok_or(Error::ReviewRequired)?;
        let local = self.engine.snapshot(
            job.data.local_snapshot.ok_or(Error::Protocol)?,
            self.control,
        )?;
        if proposal.source_generation != job.generation
            || proposal.local_manifest_hash != remote::digest(local.manifest())?
            || job.data.remote.as_ref().map(|r| &r.head) != Some(&proposal.remote_head)
        {
            return Err(Error::StaleReview);
        }
        self.require_fresh_local(&job)?;
        self.require_fresh_remote(&job)?;
        let baseline = self.engine.snapshot(
            job.data.baseline_snapshot.ok_or(Error::Protocol)?,
            self.control,
        )?;
        let manifest = self.engine.resolve_captured(
            local.id,
            baseline.manifest(),
            job.data.remote_manifest.as_ref().ok_or(Error::Protocol)?,
            &proposal.decisions,
            self.control,
        )?;
        if remote::digest(&manifest)? != proposal.candidate_manifest_hash {
            return Err(Error::Protocol);
        }
        job.data.proposed = Some(manifest);
        job.data.decisions = proposal.decisions;
        job.data.validated_proposal_id = Some(proposal.id);
        job.state = JobState::AwaitingApproval;
        self.save(&mut job)?;
        Ok(job)
    }
}
