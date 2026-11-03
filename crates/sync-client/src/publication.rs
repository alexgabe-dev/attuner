use crate::{DeviceClient, Error, Result};
use attuner_sync_core::{Manifest, remote};
use serde::{Deserialize, Serialize};
use serde_json::json;
const MAX_REVISION: u64 = 9007199254740991;
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
    pub fn validate(&self) -> Result<()> {
        if self.revision > MAX_REVISION {
            return Err(Error::Protocol);
        }
        if self.revision == 0 {
            if self.snapshot_id.is_some() || self.manifest_hash.is_some() {
                return Err(Error::Protocol);
            }
        } else if !self
            .snapshot_id
            .as_deref()
            .is_some_and(|v| uuid::Uuid::parse_str(v).is_ok())
            || !self.manifest_hash.as_deref().is_some_and(hash)
        {
            return Err(Error::Protocol);
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
    fn validate(&self) -> Result<()> {
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
            return Err(Error::Protocol);
        }
        Ok(())
    }
}
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
