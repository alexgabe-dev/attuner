use crate::{
    Control, Error, Limits, ManifestFile, Point, Result, Workspace,
    scan::BUFFER,
    workspace::{create_file, open_file},
};
use cap_std::fs::{Dir, File};
use std::io::{Read, Write};
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub files: usize,
    pub bytes: u64,
    pub verified: bool,
}
pub(crate) fn put(
    workspace: &Workspace,
    mut source: impl Read,
    entry: &ManifestFile,
    control: &Control,
    limits: &Limits,
) -> Result<()> {
    let objects = workspace.internal("state/objects")?;
    let name = format!("{}.zst", entry.hash);
    if objects.try_exists(&name)? {
        verify(workspace, entry, control, limits)?;
        control.event(Point::BackupReused, 0, &entry.path)?;
        return Ok(());
    }
    let temp = workspace.new_name("backup");
    let output = create_file(&objects, &temp)?;
    let encode_start = std::time::Instant::now();
    let mut encoder = zstd::stream::write::Encoder::new(output, 3)?;
    encoder.include_checksum(true)?;
    let mut hash = blake3::Hasher::new();
    let mut size = 0_u64;
    let mut buffer = [0; BUFFER];
    let result = (|| {
        loop {
            control.check()?;
            let n = source.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            size += n as u64;
            if size > entry.size || size > limits.max_file_bytes {
                return Err(Error::Integrity(entry.path.clone()));
            }
            hash.update(&buffer[..n]);
            encoder.write_all(&buffer[..n])?;
            control.event(Point::BackupChunk, 0, &entry.path)?;
        }
        if size != entry.size || hash.finalize().to_hex().as_str() != entry.hash {
            return Err(Error::Concurrent(entry.path.clone()));
        }
        Ok(())
    })();
    if let Err(error) = result {
        drop(encoder);
        let _ = objects.remove_file(&temp);
        return Err(error);
    }
    let output = encoder.finish()?;
    control.timed(Point::BackupEncode, 0, &entry.path, encode_start)?;
    let flush_start = std::time::Instant::now();
    output.sync_all()?;
    control.timed(Point::BackupFlush, 0, &entry.path, flush_start)?;
    drop(output);
    // Verify compressed bytes before exposing a content-addressed name.
    let verify_start = std::time::Instant::now();
    decode(&objects, &temp, entry, None, control, limits)?;
    control.timed(Point::BackupObjectVerify, 0, &entry.path, verify_start)?;
    // Private CAS promotion is serialized by the workspace lock. One rename avoids
    // a crash leaving a second hard link that would fail the strict object checks.
    objects.rename(&temp, &objects, &name)?;
    // The owning snapshot/apply batch must sync the object directory before publishing references.
    control.event(Point::BackupVerified, 0, &entry.path)?;
    Ok(())
}
pub(crate) fn decode(
    objects: &Dir,
    name: &str,
    entry: &ManifestFile,
    mut destination: Option<&mut dyn Write>,
    control: &Control,
    limits: &Limits,
) -> Result<u64> {
    if entry.size > limits.max_file_bytes {
        return Err(Error::Limit(entry.path.clone()));
    }
    let input = open_file(objects, name)?;
    let compressed_limit = entry
        .size
        .saturating_add(entry.size / 128)
        .saturating_add(1024 * 1024);
    if input.metadata()?.len() > compressed_limit {
        return Err(Error::Integrity("oversized compressed object".into()));
    }
    let checked = CheckedInput {
        file: input,
        control: control.clone(),
    };
    let mut decoder = zstd::stream::read::Decoder::new(checked.take(compressed_limit + 1))
        .map_err(|_| Error::Integrity(entry.path.clone()))?;
    decoder
        .window_log_max(23)
        .map_err(|_| Error::Integrity("Zstandard window".into()))?;
    let mut hasher = blake3::Hasher::new();
    let mut size = 0_u64;
    let mut buffer = [0; BUFFER];
    loop {
        control.check()?;
        let n = match decoder.read(&mut buffer) {
            Ok(n) => n,
            Err(_) => {
                control.check()?;
                return Err(Error::Integrity(entry.path.clone()));
            }
        };
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > entry.size {
            return Err(Error::Integrity(entry.path.clone()));
        }
        hasher.update(&buffer[..n]);
        if let Some(output) = destination.as_deref_mut() {
            output.write_all(&buffer[..n])?;
            control.event(Point::StageChunk, 0, &entry.path)?;
        }
    }
    if size != entry.size || hasher.finalize().to_hex().as_str() != entry.hash {
        return Err(Error::Integrity(entry.path.clone()));
    }
    Ok(size)
}
pub(crate) fn verify(
    workspace: &Workspace,
    entry: &ManifestFile,
    control: &Control,
    limits: &Limits,
) -> Result<()> {
    let objects = workspace.internal("state/objects")?;
    decode(
        &objects,
        &format!("{}.zst", entry.hash),
        entry,
        None,
        control,
        limits,
    )?;
    Ok(())
}
#[cfg(unix)]
pub(crate) fn stage(
    workspace: &Workspace,
    entry: &ManifestFile,
    directory: &Dir,
    name: &str,
    control: &Control,
    limits: &Limits,
) -> Result<()> {
    let objects = workspace.internal("state/objects")?;
    // A crash or short write must never expose a partial named restore file.
    // Unpublished private temporaries may remain as harmless recovery orphans.
    let temp = workspace.new_name("stage");
    let mut output = create_file(directory, &temp)?;
    let result = (|| {
        decode(
            &objects,
            &format!("{}.zst", entry.hash),
            entry,
            Some(&mut output),
            control,
            limits,
        )?;
        output.sync_all()?;
        control.check()?;
        Ok(())
    })();
    drop(output);
    if let Err(error) = result {
        let _ = directory.remove_file(&temp);
        return Err(error);
    }
    if directory.try_exists(name)? {
        return Err(Error::Integrity("staging destination occupied".into()));
    }
    directory.rename(&temp, directory, name)?;
    crate::workspace::sync_dir(directory)?;
    Ok(())
}

struct CheckedInput {
    file: File,
    control: Control,
}
impl Read for CheckedInput {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.control.check().is_err() {
            return Err(std::io::Error::other("local operation interrupted"));
        }
        self.file.read(buffer)
    }
}
