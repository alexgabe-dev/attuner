//! Host-owned download staging. Only a complete, independently verified object is imported.
use crate::{
    Control, Engine, Error, ManifestFile, Result,
    workspace::{check_meta, create_file, open_dir, open_file, sync_dir},
};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, File, OpenOptions};
use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom, Write};
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    bytes: u64,
    prefix_hash: String,
}
pub struct DownloadStage {
    file: File,
    directory: Dir,
    name: String,
    receipt: String,
    workspace: String,
    entry: ManifestFile,
    control: Control,
    _lock: std::fs::File,
}
impl DownloadStage {
    pub fn len(&self) -> Result<u64> {
        self.control.check()?;
        Ok(self.file.metadata()?.len())
    }
    pub fn is_empty(&self) -> Result<bool> {
        Ok(self.len()? == 0)
    }
    pub fn checkpoint(&mut self, bytes: u64, prefix_hash: &str) -> Result<()> {
        self.control.check()?;
        if bytes != self.len()?
            || bytes > self.entry.size
            || prefix_hash.len() != 64
            || !prefix_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::Integrity("download receipt".into()));
        }
        self.file.sync_all()?;
        match open_file(&self.directory, &self.receipt) {
            Ok(_) => {}
            Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let temporary = format!("{}.{}", self.receipt, std::process::id());
        // An interrupted receipt is retained; a new private name avoids replacing it.
        let mut sequence = 0;
        let (mut output, temporary) = loop {
            let name = format!("{temporary}-{sequence}");
            match create_file(&self.directory, &name) {
                Ok(file) => break (file, name),
                Err(Error::Io(e))
                    if e.kind() == std::io::ErrorKind::AlreadyExists && sequence < 1024 =>
                {
                    sequence += 1
                }
                Err(e) => return Err(e),
            }
        };
        output.write_all(&serde_json::to_vec(&Receipt {
            bytes,
            prefix_hash: prefix_hash.into(),
        })?)?;
        output.sync_all()?;
        drop(output);
        self.directory
            .rename(&temporary, &self.directory, &self.receipt)?;
        sync_dir(&self.directory)
    }
}
impl Read for DownloadStage {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.control.check().map_err(std::io::Error::other)?;
        self.file.read(buffer)
    }
}
impl Write for DownloadStage {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.control.check().map_err(std::io::Error::other)?;
        self.file.write(buffer)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.control.check().map_err(std::io::Error::other)?;
        self.file.flush()
    }
}
impl Seek for DownloadStage {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.control.check().map_err(std::io::Error::other)?;
        self.file.seek(position)
    }
}
impl Engine {
    pub fn download_stage(&self, entry: &ManifestFile, control: &Control) -> Result<DownloadStage> {
        control.check()?;
        let lock = self.workspace.lock()?;
        self.ensure_idle()?;
        let roots = self
            .adapter
            .roots()?
            .into_iter()
            .map(|r| r.logical)
            .collect::<Vec<_>>();
        let manifest = crate::Manifest {
            protocol_version: 1,
            profile_id: self.adapter.profile_id().into(),
            policy_version: 1,
            files: vec![entry.clone()],
        };
        crate::remote::validate(&manifest, self.adapter.profile_id(), &roots, 1)?;
        self.check_space(
            entry
                .size
                .checked_mul(2)
                .and_then(|s| s.checked_add(self.limits.disk_reserve))
                .ok_or_else(|| Error::Limit("download space".into()))?,
            control,
        )?;
        let directory = open_dir(&self.workspace.dir, "state/transfers", true)?;
        let name = format!("{}.part", entry.hash);
        let receipt = format!("{}.receipt", entry.hash);
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        let mut file = match directory.open_with(&name, &options) {
            Ok(file) => {
                file.sync_all()?;
                sync_dir(&directory)?;
                file
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                options.create_new(false).create(false);
                directory.open_with(&name, &options)?
            }
            Err(e) => return Err(e.into()),
        };
        check_meta(&file.metadata()?, &name, true)?;
        if file.metadata()?.len() > entry.size {
            return Err(Error::Integrity("oversized download stage".into()));
        }
        let receipt = match open_file(&directory, &receipt) {
            Ok(file) => {
                if file.metadata()?.len() > 256 {
                    return Err(Error::Integrity("download receipt size".into()));
                }
                serde_json::from_reader::<_, Receipt>(file.take(257))?
            }
            Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => Receipt {
                bytes: 0,
                prefix_hash: blake3::hash(&[]).to_hex().to_string(),
            },
            Err(e) => return Err(e),
        };
        if receipt.bytes > file.metadata()?.len() || receipt.bytes > entry.size {
            return Err(Error::Integrity("download prefix length".into()));
        }
        let mut hash = blake3::Hasher::new();
        let mut remaining = receipt.bytes;
        let mut buffer = [0u8; 65536];
        while remaining > 0 {
            control.check()?;
            let n = remaining.min(buffer.len() as u64) as usize;
            file.read_exact(&mut buffer[..n])?;
            hash.update(&buffer[..n]);
            remaining -= n as u64;
        }
        if hash.finalize().to_hex().as_str() != receipt.prefix_hash {
            return Err(Error::Integrity(
                "download prefix hash; restart transfer explicitly".into(),
            ));
        }
        // Only unreceipted disposable transfer bytes are discarded. Managed files are untouched.
        file.set_len(receipt.bytes)?;
        file.sync_all()?;
        file.seek(SeekFrom::Start(receipt.bytes))?;
        Ok(DownloadStage {
            file,
            directory,
            name,
            receipt: format!("{}.receipt", entry.hash),
            workspace: self.path().to_string_lossy().into(),
            entry: entry.clone(),
            control: control.clone(),
            _lock: lock,
        })
    }
    pub fn import_download(&mut self, mut stage: DownloadStage, control: &Control) -> Result<()> {
        control.check()?;
        self.workspace.validate()?;
        self.ensure_idle()?;
        if stage.workspace != self.path().to_string_lossy() || stage.len()? != stage.entry.size {
            return Err(Error::Coverage);
        }
        stage.file.sync_all()?;
        stage.file.seek(SeekFrom::Start(0))?;
        crate::backup::put(
            &self.workspace,
            &mut stage.file,
            &stage.entry,
            control,
            &self.limits,
        )?;
        sync_dir(&self.workspace.internal("state/objects")?)?;
        stage.directory.remove_file(&stage.name)?;
        match stage.directory.remove_file(&stage.receipt) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        };
        sync_dir(&stage.directory)
    }
    pub fn restart_download(&self, entry: &ManifestFile, control: &Control) -> Result<()> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        self.ensure_idle()?;
        if entry.hash.len() != 64
            || !entry
                .hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::Coverage);
        }
        let directory = open_dir(&self.workspace.dir, "state/transfers", true)?;
        let quarantine = self.workspace.internal("state/quarantine")?;
        for suffix in ["part", "receipt"] {
            let name = format!("{}.{}", entry.hash, suffix);
            match open_file(&directory, &name) {
                Ok(_) => {
                    let target = self.workspace.new_name("discarded-transfer");
                    directory.rename(&name, &quarantine, &target)?;
                }
                Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        sync_dir(&quarantine)?;
        sync_dir(&directory)
    }
}
