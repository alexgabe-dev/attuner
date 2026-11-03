use crate::{DeviceClient, Error, Result, device::Body};
use attuner_sync_core::Control;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{Read, Seek, SeekFrom, Write};
const CHUNK: usize = 4 * 1024 * 1024;
fn hash_valid(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn id_valid(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok()
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub completed_bytes: u64,
    pub total_bytes: u64,
    pub reused_bytes: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Upload {
    upload_id: Option<String>,
    verified: bool,
    hash: String,
}
#[derive(Deserialize)]
struct Chunk {
    position: usize,
    size: usize,
    hash: String,
}
#[derive(Deserialize)]
struct Status {
    chunks: Vec<Chunk>,
}
#[derive(Clone, Copy)]
pub struct BlobIdentity<'a> {
    pub profile_id: &'a str,
    pub hash: &'a str,
    pub size: u64,
}
impl DeviceClient {
    /// Reads immutable, verified backup content supplied by sync-core, never a remote path.
    /// Resume state is held by the server's durable session/chunk ledger.
    pub fn upload_blob(
        &mut self,
        blob: BlobIdentity<'_>,
        session: &str,
        input: &mut impl Read,
        control: &Control,
        mut progress: impl FnMut(TransferProgress),
    ) -> Result<()> {
        let BlobIdentity {
            profile_id: profile,
            hash,
            size,
        } = blob;
        control.check()?;
        if !id_valid(profile)
            || !id_valid(session)
            || !hash_valid(hash)
            || size > 1024 * 1024 * 1024
        {
            return Err(Error::Protocol);
        }
        let start = self.request(
            "POST",
            &format!("/api/v1/profiles/{profile}/sessions/{session}/uploads"),
            Some(&json!({"hash":hash,"size":size})),
            None,
        )?;
        let upload: Upload = serde_json::from_value(start).map_err(|_| Error::Protocol)?;
        if upload.hash != hash {
            return Err(Error::Protocol);
        }
        if upload.verified {
            progress(TransferProgress {
                completed_bytes: size,
                total_bytes: size,
                reused_bytes: size,
            });
            return Ok(());
        }
        let id = upload.upload_id.ok_or(Error::Protocol)?;
        if !id_valid(&id) {
            return Err(Error::Protocol);
        }
        let status: Status = serde_json::from_value(self.request(
            "GET",
            &format!("/api/v1/profiles/{profile}/uploads/{id}"),
            None,
            None,
        )?)
        .map_err(|_| Error::Protocol)?;
        if status.chunks.len() > 256
            || status.chunks.iter().enumerate().any(|(i, c)| {
                c.position >= 256
                    || c.size > CHUNK
                    || !hash_valid(&c.hash)
                    || status.chunks[..i].iter().any(|p| p.position == c.position)
            })
        {
            return Err(Error::Protocol);
        }
        let mut buffer = vec![0u8; CHUNK];
        let mut digest = blake3::Hasher::new();
        let mut offset = 0;
        let mut reused = 0;
        while offset < size {
            control.check()?;
            let length = std::cmp::min(CHUNK as u64, size - offset) as usize;
            input.read_exact(&mut buffer[..length])?;
            let bytes = &buffer[..length];
            digest.update(bytes);
            let position = (offset / CHUNK as u64) as usize;
            let chunk_hash = blake3::hash(bytes).to_hex().to_string();
            if let Some(existing) = status.chunks.iter().find(|c| c.position == position) {
                if existing.size != length || existing.hash != chunk_hash {
                    return Err(Error::Protocol);
                }
                reused += length as u64;
            } else {
                self.ready()?;
                let result = self.send_raw(
                    "PUT",
                    &format!("/api/v1/profiles/{profile}/uploads/{id}/chunks/{position}"),
                    Some(Body::Bytes(bytes)),
                    None,
                    true,
                    None,
                )?;
                let chunk: Chunk =
                    serde_json::from_slice(&result.bytes).map_err(|_| Error::Protocol)?;
                if chunk.position != position || chunk.size != length || chunk.hash != chunk_hash {
                    return Err(Error::Protocol);
                }
            }
            offset += length as u64;
            progress(TransferProgress {
                completed_bytes: offset,
                total_bytes: size,
                reused_bytes: reused,
            });
        }
        let mut extra = [0u8; 1];
        if input.read(&mut extra)? != 0 || digest.finalize().to_hex().as_str() != hash {
            return Err(Error::Protocol);
        }
        control.check()?;
        let value = self.request(
            "POST",
            &format!("/api/v1/profiles/{profile}/uploads/{id}/completion"),
            Some(&json!({})),
            None,
        )?;
        if value["verified"] != true
            || value["hash"] != hash
            || value["size"].as_u64() != Some(size)
        {
            return Err(Error::Protocol);
        }
        Ok(())
    }
    /// Destination is a host-owned staging stream. Partial bytes are never a verified CAS object.
    /// Existing prefix bytes are rehashed; successful return verifies the complete original object.
    pub fn download_blob(
        &mut self,
        blob: BlobIdentity<'_>,
        output: &mut (impl Read + Write + Seek),
        offset: u64,
        control: &Control,
        mut progress: impl FnMut(TransferProgress),
    ) -> Result<()> {
        let BlobIdentity {
            profile_id: profile,
            hash,
            size,
        } = blob;
        control.check()?;
        if !id_valid(profile) || !hash_valid(hash) || size > 1024 * 1024 * 1024 || offset > size {
            return Err(Error::Protocol);
        }
        if output.seek(SeekFrom::End(0))? != offset {
            return Err(Error::Protocol);
        }
        output.seek(SeekFrom::Start(0))?;
        let mut digest = blake3::Hasher::new();
        let mut buffer = vec![0u8; 65536];
        let mut read = 0;
        while read < offset {
            control.check()?;
            let n = std::cmp::min(buffer.len() as u64, offset - read) as usize;
            output.read_exact(&mut buffer[..n])?;
            digest.update(&buffer[..n]);
            read += n as u64;
        }
        let etag = format!("\"{hash}\"");
        let mut completed = offset;
        while completed < size || size == 0 && completed == 0 {
            control.check()?;
            self.ready()?;
            let length = std::cmp::min(CHUNK as u64, size - completed);
            let wire = self.send_raw(
                "GET",
                &format!(
                    "/api/v1/profiles/{profile}/blobs/{hash}?offset={completed}&length={length}"
                ),
                None,
                None,
                true,
                Some(&etag),
            )?;
            if wire.etag.as_deref() != Some(&etag)
                || wire.size != Some(size)
                || wire.offset != Some(completed)
                || wire.bytes.len() as u64 != length
            {
                return Err(Error::Protocol);
            }
            digest.update(&wire.bytes);
            output.write_all(&wire.bytes)?;
            completed += length;
            progress(TransferProgress {
                completed_bytes: completed,
                total_bytes: size,
                reused_bytes: offset,
            });
            if size == 0 {
                break;
            }
        }
        output.flush()?;
        control.check()?;
        if digest.finalize().to_hex().as_str() != hash {
            return Err(Error::Protocol);
        }
        Ok(())
    }
}
