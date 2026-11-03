use crate::{
    Adapter, Control, Error, Limits, Manifest, ManifestFile, Point, Result, Workspace,
    workspace::{check_meta, open_dir, open_file, parent},
};
use cap_fs_ext::MetadataExt;
use cap_std::fs::{Dir, File};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, io::Read};
pub(crate) const BUFFER: usize = 64 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub adapter_version: u32,
    pub roots: Vec<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteScan {
    pub(crate) manifest: Manifest,
    pub(crate) coverage: Coverage,
    pub(crate) workspace: String,
    pub files: usize,
    pub bytes: u64,
}
impl CompleteScan {
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }
    pub fn coverage(&self) -> &Coverage {
        &self.coverage
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    root: String,
    path: String,
    dir: bool,
    dev: u64,
    ino: u64,
    size: u64,
    modified: Option<cap_std::time::SystemTime>,
}
pub(crate) fn collision_key(s: &str) -> String {
    crate::namespace::key(s)
}
pub(crate) fn hash(
    mut file: File,
    control: &Control,
    limit: u64,
    path: &str,
) -> Result<(String, u64)> {
    let before = file.metadata()?;
    check_meta(&before, path, true)?;
    let mut hasher = blake3::Hasher::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; BUFFER];
    loop {
        control.check()?;
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        bytes = bytes
            .checked_add(n as u64)
            .ok_or_else(|| Error::Limit("hash byte count".into()))?;
        if bytes > limit {
            return Err(Error::Limit(path.into()));
        }
        hasher.update(&buffer[..n]);
        control.event(Point::HashChunk, 0, path)?;
    }
    let after = file.metadata()?;
    if bytes != before.len()
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || (before.dev(), before.ino()) != (after.dev(), after.ino())
    {
        return Err(Error::Incomplete(path.into()));
    }
    Ok((hasher.finalize().to_hex().to_string(), bytes))
}
fn inventory(
    dir: &Dir,
    root: &str,
    prefix: &str,
    depth: usize,
    out: &mut Vec<Entry>,
    seen: &mut BTreeSet<String>,
    context: (&Control, &Limits),
) -> Result<()> {
    let (control, limits) = context;
    if depth > limits.max_depth {
        return Err(Error::Limit("directory depth".into()));
    }
    for entry in dir.entries()? {
        control.event(Point::ScanEntry, out.len(), prefix)?;
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| Error::UnsafePath("non UTF-8 path".into()))?;
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if !crate::portable_path(&path)
            || !crate::namespace::assigned(&path)
            || !seen.insert(collision_key(&format!("{root}/{path}")))
        {
            return Err(Error::UnsafePath(path));
        }
        if out.len() >= limits.max_entries {
            return Err(Error::Limit("entry count".into()));
        }
        let meta = dir.symlink_metadata(&name)?;
        let is_dir = meta.is_dir();
        check_meta(&meta, &path, !is_dir)?;
        out.push(Entry {
            root: root.into(),
            path: path.clone(),
            dir: is_dir,
            dev: meta.dev(),
            ino: meta.ino(),
            size: if is_dir { 0 } else { meta.len() },
            modified: meta.modified().ok(),
        });
        if is_dir {
            let child = open_dir(dir, &name, false)?;
            inventory(&child, root, &path, depth + 1, out, seen, context)?;
        }
    }
    Ok(())
}
fn all_entries(
    workspace: &Workspace,
    adapter: &Adapter,
    control: &Control,
    limits: &Limits,
) -> Result<Vec<Entry>> {
    let installation = workspace.internal("installation")?;
    let mut entries = Vec::new();
    let mut seen = BTreeSet::new();
    for mapping in adapter.roots()? {
        let dir = open_dir(&installation, &mapping.directory, false)?;
        inventory(
            &dir,
            &mapping.logical,
            "",
            0,
            &mut entries,
            &mut seen,
            (control, limits),
        )?;
    }
    entries.sort_by(|a, b| (&a.root, &a.path).cmp(&(&b.root, &b.path)));
    Ok(entries)
}
pub(crate) fn scan(
    workspace: &Workspace,
    adapter: &Adapter,
    control: &Control,
    limits: &Limits,
) -> Result<CompleteScan> {
    control.check()?;
    let captured = Adapter::discover(workspace, control)?;
    if &captured != adapter {
        return Err(Error::Adapter);
    }
    let before = all_entries(workspace, adapter, control, limits)?;
    let mut manifest = Manifest {
        protocol_version: 1,
        profile_id: adapter.profile_id().into(),
        policy_version: 1,
        files: Vec::new(),
    };
    let mut bytes = 0_u64;
    for entry in before.iter().filter(|e| !e.dir) {
        let file = managed_file(workspace, adapter, &entry.root, &entry.path)?;
        let (hash, size) = hash(file, control, limits.max_file_bytes, &entry.path)?;
        bytes = bytes
            .checked_add(size)
            .ok_or_else(|| Error::Limit("scan byte count".into()))?;
        if bytes > limits.max_scan_bytes {
            return Err(Error::Limit("scan bytes".into()));
        }
        let group_key = if entry.root == "addons" {
            entry.path.split('/').next().unwrap_or(&entry.path)
        } else {
            &entry.path
        };
        let group = format!(
            "{}:{}",
            entry.root,
            &blake3::hash(group_key.as_bytes()).to_hex()[..24]
        );
        manifest.files.push(ManifestFile {
            root: entry.root.clone(),
            path: entry.path.clone(),
            hash,
            size,
            group,
        });
    }
    control.event(Point::ScanValidated, manifest.files.len(), "")?;
    if before != all_entries(workspace, adapter, control, limits)?
        || Adapter::discover(workspace, control)? != captured
    {
        return Err(Error::Incomplete("inventory changed".into()));
    }
    for entry in &manifest.files {
        let (digest, size) = hash(
            managed_file(workspace, adapter, &entry.root, &entry.path)?,
            control,
            limits.max_file_bytes,
            &entry.path,
        )?;
        if digest != entry.hash || size != entry.size {
            return Err(Error::Incomplete(entry.path.clone()));
        }
    }
    // The verification hash pass can also race a creation/deletion. Never issue
    // a complete receipt from an inventory that changed during that final pass.
    if before != all_entries(workspace, adapter, control, limits)?
        || Adapter::discover(workspace, control)? != captured
    {
        return Err(Error::Incomplete("verification inventory changed".into()));
    }
    manifest
        .validate()
        .map_err(|e| Error::UnsafePath(e.into()))?;
    Ok(CompleteScan {
        files: manifest.files.len(),
        bytes,
        manifest,
        coverage: Coverage {
            adapter_version: adapter.version,
            roots: adapter.roots()?.into_iter().map(|r| r.logical).collect(),
        },
        workspace: workspace.path().to_string_lossy().into_owned(),
    })
}
pub(crate) fn managed_parent(
    workspace: &Workspace,
    adapter: &Adapter,
    root: &str,
    path: &str,
    create: bool,
) -> Result<(Dir, String)> {
    let mapping = adapter
        .roots()?
        .into_iter()
        .find(|r| r.logical == root)
        .ok_or(Error::Coverage)?;
    let installation = workspace.internal("installation")?;
    let base = open_dir(&installation, &mapping.directory, false)?;
    parent(&base, path, create)
}
pub(crate) fn managed_file(
    workspace: &Workspace,
    adapter: &Adapter,
    root: &str,
    path: &str,
) -> Result<File> {
    let (dir, name) = managed_parent(workspace, adapter, root, path, false)?;
    open_file(&dir, &name)
}
#[cfg(unix)]
pub(crate) fn current_hash(
    workspace: &Workspace,
    adapter: &Adapter,
    root: &str,
    path: &str,
    control: &Control,
    limits: &Limits,
) -> Result<Option<String>> {
    let result = managed_file(workspace, adapter, root, path);
    match result {
        Ok(file) => Ok(Some(hash(file, control, limits.max_file_bytes, path)?.0)),
        Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn unicode_case_and_compatibility_collisions_are_conservative() {
        assert_eq!(
            super::collision_key("Straße.lua"),
            super::collision_key("STRASSE.LUA")
        );
        assert_eq!(
            super::collision_key("Ａ.lua"),
            super::collision_key("a.lua")
        );
        assert_eq!(
            super::collision_key("Café.lua"),
            super::collision_key("Cafe\u{301}.lua")
        );
    }
}
