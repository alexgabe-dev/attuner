//! Remote manifests remain untrusted until all local policy and namespace checks pass.
use crate::{Error, Manifest, Result, compare, scan::Coverage};
pub const MAX_MANIFEST_BYTES: usize = 16 * 1024 * 1024;
pub fn validate(manifest: &Manifest, profile: &str, roots: &[String], policy: u32) -> Result<()> {
    canonical(manifest)?;
    if manifest.profile_id != profile || manifest.policy_version != policy {
        return Err(Error::Coverage);
    }
    compare::compatible(
        manifest,
        manifest,
        &Coverage {
            adapter_version: 1,
            roots: roots.to_vec(),
        },
    )?;
    let mut bytes = 0u64;
    for file in &manifest.files {
        if !crate::namespace::assigned(&file.path)
            || file.path.split('/').count() > 64
            || file.size > 1024 * 1024 * 1024
        {
            return Err(Error::Limit("remote file".into()));
        }
        bytes = bytes
            .checked_add(file.size)
            .ok_or_else(|| Error::Limit("remote bytes".into()))?;
        if bytes > 4 * 1024 * 1024 * 1024 {
            return Err(Error::Limit("remote bytes".into()));
        }
        let path = if file.root == "addons" {
            file.path.split('/').next().unwrap_or("")
        } else {
            &file.path
        };
        let group = format!(
            "{}:{}",
            file.root,
            &blake3::hash(path.as_bytes()).to_hex()[..24]
        );
        if file.group != group {
            return Err(Error::Coverage);
        }
    }
    Ok(())
}
pub fn canonical(manifest: &Manifest) -> Result<String> {
    manifest
        .validate()
        .map_err(|e| Error::UnsafePath(e.into()))?;
    let mut bytes = 0_u64;
    for file in &manifest.files {
        if !crate::namespace::assigned(&file.path)
            || file.path.split('/').count() > 64
            || file.size > 1024 * 1024 * 1024
        {
            return Err(Error::Limit("remote file".into()));
        }
        bytes = bytes
            .checked_add(file.size)
            .ok_or_else(|| Error::Limit("remote bytes".into()))?;
        if bytes > 4 * 1024 * 1024 * 1024 {
            return Err(Error::Limit("remote bytes".into()));
        }
    }
    compare::compatible(
        manifest,
        manifest,
        &Coverage {
            adapter_version: 1,
            roots: vec!["account".into(), "character".into(), "addons".into()],
        },
    )?;
    #[derive(serde::Serialize)]
    struct File<'a> {
        group: &'a str,
        hash: &'a str,
        path: &'a str,
        root: &'a str,
        size: u64,
    }
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Canonical<'a> {
        files: Vec<File<'a>>,
        policy_version: u32,
        profile_id: &'a str,
        protocol_version: u32,
    }
    let mut entries = manifest.files.iter().collect::<Vec<_>>();
    entries.sort_by(|a, b| (&a.root, &a.path).cmp(&(&b.root, &b.path)));
    let files = entries
        .into_iter()
        .map(|f| File {
            group: &f.group,
            hash: &f.hash,
            path: &f.path,
            root: &f.root,
            size: f.size,
        })
        .collect();
    let value = serde_json::to_string(&Canonical {
        files,
        policy_version: manifest.policy_version,
        profile_id: &manifest.profile_id,
        protocol_version: manifest.protocol_version,
    })?;
    if value.len() > MAX_MANIFEST_BYTES {
        return Err(Error::Limit("remote manifest".into()));
    }
    Ok(value)
}
pub fn digest(manifest: &Manifest) -> Result<String> {
    Ok(blake3::hash(canonical(manifest)?.as_bytes())
        .to_hex()
        .to_string())
}
