use crate::{DeviceClient, Error, Result};
pub use attuner_sync_core::synchronization::{ProfileHead, RemoteHead};
use attuner_sync_core::{Manifest, remote};
use serde::{Deserialize, Serialize};
use serde_json::json;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteSnapshot {
    pub snapshot_id: String,
    pub revision: u64,
    pub manifest_hash: String,
    pub manifest: Manifest,
}
impl RemoteSnapshot {
    pub fn head(&self) -> RemoteHead {
        RemoteHead {
            snapshot_id: Some(self.snapshot_id.clone()),
            revision: self.revision,
            manifest_hash: Some(self.manifest_hash.clone()),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidateSession {
    pub session_id: String,
    pub state: String,
    pub expires_at: u64,
}
impl DeviceClient {
    pub fn fetch_head(&mut self, profile: &str) -> Result<ProfileHead> {
        self.connection.revalidate()?;
        if uuid::Uuid::parse_str(profile).is_err() {
            return Err(Error::Protocol);
        }
        let head: ProfileHead = serde_json::from_value(self.request(
            "GET",
            &format!("/api/v1/profiles/{profile}/head"),
            None,
            None,
        )?)
        .map_err(|_| Error::Protocol)?;
        head.validate()?;
        Ok(head)
    }
    pub fn fetch_snapshot(
        &mut self,
        profile: &str,
        policy: &ProfileHead,
    ) -> Result<Option<RemoteSnapshot>> {
        policy.validate()?;
        let Some(id) = &policy.head.snapshot_id else {
            return Ok(None);
        };
        if uuid::Uuid::parse_str(profile).is_err() {
            return Err(Error::Protocol);
        }
        let snapshot: RemoteSnapshot = serde_json::from_value(self.request(
            "GET",
            &format!("/api/v1/profiles/{profile}/snapshots/{id}"),
            None,
            None,
        )?)
        .map_err(|_| Error::Protocol)?;
        if snapshot.head() != policy.head
            || remote::digest(&snapshot.manifest)? != snapshot.manifest_hash
        {
            return Err(Error::Protocol);
        }
        remote::validate(
            &snapshot.manifest,
            profile,
            &policy.roots,
            policy.policy_version,
        )?;
        Ok(Some(snapshot))
    }
    pub fn stage_snapshot(
        &mut self,
        manifest: &Manifest,
        policy: &ProfileHead,
        baseline: Option<&str>,
        request_id: &str,
    ) -> Result<CandidateSession> {
        policy.validate()?;
        remote::validate(
            manifest,
            &manifest.profile_id,
            &policy.roots,
            policy.policy_version,
        )?;
        if uuid::Uuid::parse_str(request_id).is_err()
            || baseline.is_some_and(|v| uuid::Uuid::parse_str(v).is_err())
        {
            return Err(Error::Protocol);
        }
        let body = json!({"publicationVersion":1,"namespaceVersion":1,"expectedHead":policy.head,"baseSnapshotId":baseline,"coveredRoots":policy.roots,"manifest":manifest,"manifestHash":remote::digest(manifest)?});
        let session: CandidateSession = serde_json::from_value(self.request(
            "POST",
            &format!("/api/v1/profiles/{}/sessions", manifest.profile_id),
            Some(&body),
            Some(request_id),
        )?)
        .map_err(|_| Error::Protocol)?;
        if uuid::Uuid::parse_str(&session.session_id).is_err() || session.state != "open" {
            return Err(Error::Protocol);
        }
        Ok(session)
    }
    /// Caller must bind explicit user approval to this exact manifest and expected head.
    /// This method never performs a local filesystem operation.
    pub fn publish_reviewed(
        &mut self,
        manifest: &Manifest,
        expected: &RemoteHead,
        session: &CandidateSession,
    ) -> Result<RemoteHead> {
        expected.validate()?;
        let digest = remote::digest(manifest)?;
        if uuid::Uuid::parse_str(&session.session_id).is_err() {
            return Err(Error::Protocol);
        }
        let head: RemoteHead = serde_json::from_value(self.request(
            "POST",
            &format!(
                "/api/v1/profiles/{}/sessions/{}/commit",
                manifest.profile_id, session.session_id
            ),
            Some(&json!({"approve":true})),
            None,
        )?)
        .map_err(|_| Error::Protocol)?;
        head.validate()?;
        if head.revision != expected.revision.checked_add(1).ok_or(Error::Protocol)?
            || head.manifest_hash.as_deref() != Some(digest.as_str())
        {
            return Err(Error::Protocol);
        }
        Ok(head)
    }
    pub fn acknowledge(&mut self, profile: &str, head: &RemoteHead) -> Result<()> {
        head.validate()?;
        if uuid::Uuid::parse_str(profile).is_err() || head.snapshot_id.is_none() {
            return Err(Error::Protocol);
        }
        let result = self.request(
            "POST",
            &format!("/api/v1/profiles/{profile}/acknowledgements"),
            Some(&json!({"snapshotId":head.snapshot_id,"manifestHash":head.manifest_hash})),
            None,
        )?;
        if result["acknowledged"] != true
            || result["revision"].as_u64() != Some(head.revision)
            || result["snapshotId"].as_str() != head.snapshot_id.as_deref()
            || result["manifestHash"].as_str() != head.manifest_hash.as_deref()
        {
            return Err(Error::Protocol);
        }
        Ok(())
    }
}
