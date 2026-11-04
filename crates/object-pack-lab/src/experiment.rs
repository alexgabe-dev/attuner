use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Read, Seek, SeekFrom, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub const BUFFER: usize = 65536;
const MAX_RAW: u64 = 128 * 1024 * 1024;
const MAX_PACK: u64 = MAX_RAW + 2 * 1024 * 1024;
const TARGET_PACK: u64 = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 2048;
const MAX_INDEX: u64 = 512 * 1024;
const MAX_FILES: usize = 20000;
type Manifest = BTreeMap<String, Object>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("I/O: {0}")]
    Io(#[from] io::Error),
    #[error("SQLite: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Integrity/limit violation: {0}")]
    Integrity(&'static str),
    #[error("Cancelled")]
    Cancelled,
    #[error("Injected short write / disk exhaustion")]
    DiskFull,
}
pub type Result<T> = std::result::Result<T, Error>;

/// Fault controls are confined to this laboratory crate. They do not change
/// production durability or expose arbitrary paths to a desktop command.
#[derive(Default, Clone)]
pub struct Control {
    pub cancelled: Arc<AtomicBool>,
    pub fail_after_bytes: Option<u64>,
    pub checkpoint: Option<fn(&str)>,
}
impl Control {
    fn check(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }
    fn point(&self, point: &str) -> Result<()> {
        self.check()?;
        if let Some(checkpoint) = self.checkpoint {
            checkpoint(point);
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug)]
pub enum Format {
    Legacy,
    Pack,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub snapshot: i64,
    pub files: usize,
    pub raw_bytes: u64,
    pub new_objects: usize,
    pub new_packs: usize,
    pub file_flushes: usize,
    pub directory_flushes: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Object {
    hash: String,
    size: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Frame {
    hash: String,
    offset: u64,
    length: u64,
    size: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Index {
    version: u8,
    pack: String,
    bytes: u64,
    frames: Vec<Frame>,
}

/// The only public constructor mints and owns a new temporary synthetic root.
pub struct Lab {
    root: PathBuf,
    _owner: Option<tempfile::TempDir>,
    db: Connection,
}
impl Lab {
    pub fn new() -> Result<Self> {
        let root = tempfile::Builder::new()
            .prefix("attuner-pack-lab-")
            .tempdir()?;
        fs::create_dir(root.path().join("source"))?;
        fs::create_dir(root.path().join("objects"))?;
        let db = Connection::open(root.path().join("catalog.sqlite"))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
            CREATE TABLE packs(hash TEXT PRIMARY KEY, index_hash TEXT NOT NULL, bytes INTEGER NOT NULL);
            CREATE TABLE objects(hash TEXT PRIMARY KEY, size INTEGER NOT NULL, pack TEXT REFERENCES packs(hash));
            CREATE TABLE snapshots(id INTEGER PRIMARY KEY);
            CREATE TABLE files(snapshot INTEGER REFERENCES snapshots(id), name TEXT NOT NULL, hash TEXT REFERENCES objects(hash), PRIMARY KEY(snapshot,name));")?;
        sync_dir(root.path())?;
        Ok(Self {
            root: root.path().to_owned(),
            _owner: Some(root),
            db,
        })
    }
    /// Generates original bytes using a deterministic PRNG; no external inputs.
    pub fn generate(
        &self,
        files: usize,
        small_bytes: u64,
        large_bytes: u64,
        entropy: bool,
    ) -> Result<()> {
        if files > MAX_FILES - 1 || small_bytes > MAX_RAW || large_bytes > MAX_RAW {
            return Err(Error::Integrity("fixture limits"));
        }
        for index in 0..files {
            self.write_synthetic(index, small_bytes, entropy, 0)?;
        }
        if large_bytes > 0 {
            self.write_synthetic(files, large_bytes, entropy, 0)?;
        }
        Ok(())
    }
    pub fn change(&self, index: usize, bytes: u64, entropy: bool, generation: u64) -> Result<()> {
        if index >= MAX_FILES || bytes > MAX_RAW {
            return Err(Error::Integrity("fixture limits"));
        }
        self.write_synthetic(index, bytes, entropy, generation)
    }
    fn write_synthetic(
        &self,
        index: usize,
        bytes: u64,
        entropy: bool,
        generation: u64,
    ) -> Result<()> {
        let path = self
            .root
            .as_path()
            .join("source")
            .join(format!("file-{index:05}.bin"));
        let mut output = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)?;
        let mut seed = 0x9e3779b97f4a7c15_u64
            ^ (index as u64 + 1).wrapping_mul(0x517cc1b727220a95)
            ^ generation.wrapping_mul(0x2545f4914f6cdd1d);
        let mut left = bytes;
        let mut buffer = [0_u8; BUFFER];
        while left > 0 {
            let count = left.min(BUFFER as u64) as usize;
            if entropy {
                for chunk in buffer[..count].chunks_mut(8) {
                    seed ^= seed << 13;
                    seed ^= seed >> 7;
                    seed ^= seed << 17;
                    chunk.copy_from_slice(&seed.to_le_bytes()[..chunk.len()]);
                }
            } else {
                buffer[..count].fill(b'x');
                let tag = ((index as u64) ^ generation.rotate_left(32)).to_le_bytes();
                let n = count.min(8);
                buffer[..n].copy_from_slice(&tag[..n]);
            }
            output.write_all(&buffer[..count])?;
            left -= count as u64;
        }
        output.sync_all()?;
        Ok(())
    }
    fn scan(&self, control: &Control) -> Result<Manifest> {
        let mut result = BTreeMap::new();
        for entry in fs::read_dir(self.root.as_path().join("source"))? {
            control.check()?;
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| Error::Integrity("fixture name"))?;
            if !name.starts_with("file-")
                || !name.ends_with(".bin")
                || name.len() != 14
                || !name[5..10].bytes().all(|b| b.is_ascii_digit())
            {
                return Err(Error::Integrity("fixture name"));
            }
            let mut file = open(&entry.path(), MAX_RAW)?;
            let before = file.metadata()?;
            let (hash, size) = digest(&mut file, MAX_RAW, control)?;
            let after = file.metadata()?;
            if (
                before.ino(),
                before.len(),
                before.mtime(),
                before.mtime_nsec(),
            ) != (after.ino(), after.len(), after.mtime(), after.mtime_nsec())
                || size != before.len()
            {
                return Err(Error::Integrity("source changed"));
            }
            result.insert(name, Object { hash, size });
            if result.len() > MAX_FILES {
                return Err(Error::Integrity("file count"));
            }
        }
        Ok(result)
    }
    pub fn capture(&mut self, format: Format, control: &Control) -> Result<Capture> {
        let first = self.scan(control)?;
        if first != self.scan(control)? {
            return Err(Error::Integrity("incomplete/unstable scan"));
        }
        let mut stats = Capture {
            files: first.len(),
            raw_bytes: first.values().map(|o| o.size).sum(),
            ..Capture::default()
        };
        let mut missing = BTreeMap::new();
        let mut verified = BTreeSet::new();
        let mut verified_packs = BTreeMap::new();
        for (name, object) in &first {
            let exists: bool = self.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM objects WHERE hash=? AND size=?)",
                params![object.hash, object.size as i64],
                |r| r.get(0),
            )?;
            if exists {
                if verified.insert(object.hash.clone()) {
                    self.verify_object(object, &mut verified_packs, control)?;
                }
            } else {
                missing
                    .entry(object.hash.clone())
                    .or_insert((name.clone(), object.clone()));
            }
        }
        control.point("scan-complete")?;
        let mut locations = Vec::new();
        let mut packs = Vec::new();
        let objects = self.root.as_path().join("objects");
        let mut pending = missing.values().peekable();
        while pending.peek().is_some() {
            let mut temp = tempfile::NamedTempFile::new_in(&objects)?;
            let mut frames = Vec::new();
            while let Some((_, next)) = pending.peek() {
                let position = temp.as_file_mut().stream_position()?;
                if !frames.is_empty()
                    && position + next.size + next.size / 128 + 1024 * 1024 > MAX_PACK
                {
                    break;
                }
                let (name, object) = pending.next().unwrap();
                let offset = temp.as_file_mut().stream_position()?;
                encode(
                    &self.root.as_path().join("source").join(name),
                    temp.as_file_mut(),
                    object,
                    control,
                )?;
                let length = temp.as_file_mut().stream_position()? - offset;
                frames.push(Frame {
                    hash: object.hash.clone(),
                    size: object.size,
                    offset,
                    length,
                });
                control.point("frame-written")?;
                decode(
                    temp.as_file_mut(),
                    frames.last().unwrap(),
                    &mut io::sink(),
                    control,
                )?;
                temp.as_file_mut().seek(SeekFrom::Start(offset + length))?;
                control.point("frame-verified")?;
                if matches!(format, Format::Legacy)
                    || frames.len() == MAX_ENTRIES
                    || offset + length >= TARGET_PACK
                {
                    break;
                }
            }
            let bytes = temp.as_file_mut().stream_position()?;
            if bytes > MAX_PACK {
                return Err(Error::Integrity("pack limit"));
            }
            temp.as_file_mut().sync_all()?;
            stats.file_flushes += 1;
            control.point("pack-flushed")?;
            temp.as_file_mut().rewind()?;
            let (pack, _) = digest(temp.as_file_mut(), MAX_PACK, control)?;
            match format {
                Format::Legacy => {
                    let frame = &frames[0];
                    publish(
                        temp,
                        &objects.join(format!("{}.zst", frame.hash)),
                        &pack,
                        bytes,
                        control,
                    )?;
                    locations.push((frame.hash.clone(), frame.size, None));
                    control.point("legacy-promoted")?;
                }
                Format::Pack => {
                    let index = Index {
                        version: 1,
                        pack: pack.clone(),
                        bytes,
                        frames,
                    };
                    let data = serde_json::to_vec(&index)?;
                    if data.len() > MAX_INDEX as usize {
                        return Err(Error::Integrity("index limit"));
                    }
                    let mut index_temp = tempfile::NamedTempFile::new_in(&objects)?;
                    index_temp.write_all(&data)?;
                    index_temp.as_file().sync_all()?;
                    stats.file_flushes += 1;
                    control.point("index-flushed")?;
                    let index_hash = blake3::hash(&data).to_hex().to_string();
                    publish(
                        temp,
                        &objects.join(format!("{pack}.pack")),
                        &pack,
                        bytes,
                        control,
                    )?;
                    control.point("pack-promoted")?;
                    publish(
                        index_temp,
                        &objects.join(format!("{pack}.index")),
                        &index_hash,
                        data.len() as u64,
                        control,
                    )?;
                    control.point("index-promoted")?;
                    locations.extend(
                        index
                            .frames
                            .iter()
                            .map(|f| (f.hash.clone(), f.size, Some(pack.clone()))),
                    );
                    packs.push((pack, index_hash, bytes));
                    stats.new_packs += 1;
                }
            }
        }
        if !locations.is_empty() {
            sync_dir(&objects)?;
            stats.directory_flushes += 1;
        }
        control.point("directory-flushed")?;
        stats.new_objects = locations.len();
        let transaction = self.db.transaction()?;
        for (pack, index, bytes) in packs {
            transaction.execute(
                "INSERT INTO packs VALUES(?,?,?)",
                params![pack, index, bytes as i64],
            )?;
        }
        for (hash, size, pack) in locations {
            transaction.execute(
                "INSERT INTO objects VALUES(?,?,?)",
                params![hash, size as i64, pack],
            )?;
        }
        transaction.execute("INSERT INTO snapshots DEFAULT VALUES", [])?;
        stats.snapshot = transaction.last_insert_rowid();
        for (name, object) in &first {
            transaction.execute(
                "INSERT INTO files VALUES(?,?,?)",
                params![stats.snapshot, name, object.hash],
            )?;
        }
        control.point("before-commit")?;
        transaction.commit()?;
        control.point("after-commit")?;
        Ok(stats)
    }
    fn load_index(&self, pack: &str, control: &Control) -> Result<Index> {
        validate_hash(pack)?;
        let (expected, bytes): (String, u64) = self.db.query_row(
            "SELECT index_hash,bytes FROM packs WHERE hash=?",
            [pack],
            |r| Ok((r.get(0)?, sql_u64(r, 1)?)),
        )?;
        let objects = self.root.as_path().join("objects");
        let file = open(&objects.join(format!("{pack}.index")), MAX_INDEX)?;
        let mut data = Vec::new();
        file.take(MAX_INDEX + 1).read_to_end(&mut data)?;
        if data.len() as u64 > MAX_INDEX {
            return Err(Error::Integrity("index grew"));
        }
        if blake3::hash(&data).to_hex().as_str() != expected {
            return Err(Error::Integrity("index hash"));
        }
        let index: Index = serde_json::from_slice(&data)?;
        if index.version != 1
            || index.pack != pack
            || index.bytes != bytes
            || bytes > MAX_PACK
            || index.frames.is_empty()
            || index.frames.len() > MAX_ENTRIES
        {
            return Err(Error::Integrity("index header"));
        }
        let mut end = 0;
        let mut hashes = BTreeSet::new();
        for frame in &index.frames {
            validate_hash(&frame.hash)?;
            if frame.offset != end
                || frame.length == 0
                || frame.size > MAX_RAW
                || !hashes.insert(&frame.hash)
            {
                return Err(Error::Integrity("index frame"));
            }
            end = frame
                .offset
                .checked_add(frame.length)
                .ok_or(Error::Integrity("index overflow"))?;
            if end > bytes {
                return Err(Error::Integrity("index bounds"));
            }
        }
        if end != bytes {
            return Err(Error::Integrity("index trailing bytes"));
        }
        let mut file = open(&objects.join(format!("{pack}.pack")), MAX_PACK)?;
        if digest(&mut file, MAX_PACK, control)? != (pack.to_owned(), bytes) {
            return Err(Error::Integrity("pack hash"));
        }
        Ok(index)
    }
    fn verify_object(
        &self,
        object: &Object,
        cache: &mut BTreeMap<String, Index>,
        control: &Control,
    ) -> Result<()> {
        self.read_object(object, cache, &mut io::sink(), control)
    }
    fn read_object(
        &self,
        object: &Object,
        cache: &mut BTreeMap<String, Index>,
        output: &mut dyn Write,
        control: &Control,
    ) -> Result<()> {
        validate_hash(&object.hash)?;
        let row: Option<(u64, Option<String>)> = self
            .db
            .query_row(
                "SELECT size,pack FROM objects WHERE hash=?",
                [&object.hash],
                |r| Ok((sql_u64(r, 0)?, r.get(1)?)),
            )
            .optional()?;
        let (size, pack) = row.ok_or(Error::Integrity("missing object"))?;
        if size != object.size || size > MAX_RAW {
            return Err(Error::Integrity("object size"));
        }
        let (path, frame) = if let Some(pack) = pack {
            if !cache.contains_key(&pack) {
                cache.insert(pack.clone(), self.load_index(&pack, control)?);
            }
            let frame = cache[&pack]
                .frames
                .iter()
                .find(|f| f.hash == object.hash)
                .ok_or(Error::Integrity("missing frame"))?
                .clone();
            if frame.size != object.size {
                return Err(Error::Integrity("frame size"));
            }
            (
                self.root
                    .as_path()
                    .join("objects")
                    .join(format!("{pack}.pack")),
                frame,
            )
        } else {
            let path = self
                .root
                .as_path()
                .join("objects")
                .join(format!("{}.zst", object.hash));
            let length = open(&path, MAX_PACK)?.metadata()?.len();
            (
                path,
                Frame {
                    hash: object.hash.clone(),
                    size,
                    offset: 0,
                    length,
                },
            )
        };
        let mut input = open(&path, MAX_PACK)?;
        decode(&mut input, &frame, output, control)
    }
    pub fn verify(&self, snapshot: i64, control: &Control) -> Result<usize> {
        let exists: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM snapshots WHERE id=?)",
            [snapshot],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(Error::Integrity("missing snapshot"));
        }
        let mut statement=self.db.prepare("SELECT o.hash,o.size FROM files f JOIN objects o ON o.hash=f.hash WHERE f.snapshot=? ORDER BY f.name")?;
        let rows = statement.query_map([snapshot], |r| {
            Ok(Object {
                hash: r.get(0)?,
                size: sql_u64(r, 1)?,
            })
        })?;
        let mut cache = BTreeMap::new();
        let mut count = 0;
        for row in rows {
            self.verify_object(&row?, &mut cache, control)?;
            count += 1;
        }
        Ok(count)
    }
    pub fn snapshot_count(&self) -> Result<u64> {
        Ok(self
            .db
            .query_row("SELECT COUNT(*) FROM snapshots", [], |r| sql_u64(r, 0))?)
    }
}
fn sql_u64(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    value
        .try_into()
        .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}
fn validate_hash(hash: &str) -> Result<()> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::Integrity("hash"));
    }
    Ok(())
}
fn open(path: &Path, max: u64) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.nlink() != 1 || meta.len() > max {
        return Err(Error::Integrity("file type/size/links"));
    }
    Ok(file)
}
fn sync_dir(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}
fn publish(
    temp: tempfile::NamedTempFile,
    destination: &Path,
    hash: &str,
    bytes: u64,
    control: &Control,
) -> Result<()> {
    match temp.persist_noclobber(destination) {
        Ok(_) => Ok(()),
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
            // A prior interrupted capture may have promoted this exact file.
            // Rebuild/verify all frames first; only then compare the existing
            // immutable bytes. Never overwrite/adopt an unchecked orphan.
            let mut existing = open(destination, MAX_PACK)?;
            if digest(&mut existing, MAX_PACK, control)? != (hash.to_owned(), bytes) {
                return Err(Error::Integrity("publication collision"));
            }
            Ok(())
        }
        Err(error) => Err(error.error.into()),
    }
}
fn digest(reader: &mut impl Read, max: u64, control: &Control) -> Result<(String, u64)> {
    let mut hash = blake3::Hasher::new();
    let mut size = 0;
    let mut buffer = [0; BUFFER];
    loop {
        control.check()?;
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > max {
            return Err(Error::Integrity("hash limit"));
        }
        hash.update(&buffer[..n]);
    }
    Ok((hash.finalize().to_hex().to_string(), size))
}
struct LimitedWriter<'a> {
    file: &'a mut File,
    start: u64,
    budget: u64,
}
impl Write for LimitedWriter<'_> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let used = self.file.stream_position()?.saturating_sub(self.start);
        let available = self.budget.saturating_sub(used);
        if available == 0 {
            return Err(io::Error::from_raw_os_error(libc::ENOSPC));
        }
        self.file.write(&data[..data.len().min(available as usize)])
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}
fn encode(source: &Path, output: &mut File, object: &Object, control: &Control) -> Result<()> {
    let start = output.stream_position()?;
    let budget = MAX_PACK
        .saturating_sub(start)
        .min(control.fail_after_bytes.unwrap_or(MAX_PACK));
    let writer = LimitedWriter {
        file: output,
        start,
        budget,
    };
    let mut encoder = zstd::stream::write::Encoder::new(writer, 3)?;
    encoder.include_checksum(true)?;
    let mut input = open(source, MAX_RAW)?;
    let mut hash = blake3::Hasher::new();
    let mut size = 0;
    let mut buffer = [0; BUFFER];
    loop {
        control.check()?;
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > object.size {
            return Err(Error::Integrity("source grew"));
        }
        hash.update(&buffer[..n]);
        encoder.write_all(&buffer[..n]).map_err(|e| {
            if e.raw_os_error() == Some(libc::ENOSPC) {
                Error::DiskFull
            } else {
                Error::Io(e)
            }
        })?;
    }
    if (hash.finalize().to_hex().as_str(), size) != (object.hash.as_str(), object.size) {
        return Err(Error::Integrity("source changed"));
    }
    encoder.finish().map_err(|e| {
        if e.raw_os_error() == Some(libc::ENOSPC) {
            Error::DiskFull
        } else {
            Error::Io(e)
        }
    })?;
    Ok(())
}
fn decode(
    input: &mut File,
    frame: &Frame,
    output: &mut dyn Write,
    control: &Control,
) -> Result<()> {
    input.seek(SeekFrom::Start(frame.offset))?;
    let bounded = input.take(frame.length);
    let mut decoder =
        zstd::stream::read::Decoder::with_buffer(BufReader::with_capacity(BUFFER, bounded))?
            .single_frame();
    decoder.window_log_max(23)?;
    let mut hash = blake3::Hasher::new();
    let mut size = 0;
    let mut buffer = [0; BUFFER];
    loop {
        control.check()?;
        let n = decoder.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > frame.size || size > MAX_RAW {
            return Err(Error::Integrity("decoded size"));
        }
        hash.update(&buffer[..n]);
        output.write_all(&buffer[..n])?;
    }
    let buffered = decoder.finish();
    if !buffered.buffer().is_empty() || buffered.into_inner().limit() != 0 {
        return Err(Error::Integrity("trailing/truncated frame"));
    }
    if (hash.finalize().to_hex().as_str(), size) != (frame.hash.as_str(), frame.size) {
        return Err(Error::Integrity("decoded hash/size"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };

    #[test]
    fn legacy_new_mixed_restore_preserves_original_bytes_and_reuses_content() -> Result<()> {
        let mut lab = Lab::new()?;
        let control = Control::default();
        lab.generate(12, 4096, 2 * 1024 * 1024, true)?;
        let old = lab.capture(Format::Legacy, &control)?;
        lab.change(0, 4096, true, 1)?;
        let mixed = lab.capture(Format::Pack, &control)?;
        assert_eq!(mixed.new_objects, 1);
        assert_eq!(mixed.new_packs, 1);
        assert_eq!(lab.verify(old.snapshot, &control)?, 13);
        assert_eq!(lab.verify(mixed.snapshot, &control)?, 13);
        let warm = lab.capture(Format::Pack, &control)?;
        assert_eq!(
            (warm.new_objects, warm.new_packs, warm.file_flushes),
            (0, 0, 0)
        );
        let mut cache = BTreeMap::new();
        for (name, object) in lab.scan(&control)? {
            let mut bytes = Vec::new();
            lab.read_object(&object, &mut cache, &mut bytes, &control)?;
            assert_eq!(bytes, fs::read(lab.root.join("source").join(name))?);
        }
        Ok(())
    }
    #[test]
    fn entry_bound_splits_packs_and_empty_files_are_verified() -> Result<()> {
        let mut lab = Lab::new()?;
        let control = Control::default();
        lab.generate(MAX_ENTRIES + 2, 16, 0, false)?;
        lab.change(MAX_ENTRIES + 2, 0, false, 0)?;
        let result = lab.capture(Format::Pack, &control)?;
        assert_eq!(result.new_packs, 2);
        assert_eq!(lab.verify(result.snapshot, &control)?, MAX_ENTRIES + 3);
        Ok(())
    }
    #[test]
    fn cancelled_short_writes_and_changed_source_publish_no_snapshot() -> Result<()> {
        let mut lab = Lab::new()?;
        lab.generate(2, 65536, 0, true)?;
        let control = Control {
            fail_after_bytes: Some(2),
            ..Control::default()
        };
        assert!(matches!(
            lab.capture(Format::Pack, &control),
            Err(Error::DiskFull)
        ));
        assert_eq!(lab.snapshot_count()?, 0);
        control.cancelled.store(true, Ordering::Release);
        assert!(matches!(
            lab.capture(Format::Pack, &control),
            Err(Error::Cancelled)
        ));
        assert_eq!(lab.snapshot_count()?, 0);
        let source = lab.root.join("source/file-00000.bin");
        let stale = lab.scan(&Control::default())?["file-00000.bin"].clone();
        lab.change(0, 65536, true, 8)?;
        let mut output = tempfile::tempfile()?;
        assert!(matches!(
            encode(&source, &mut output, &stale, &Control::default()),
            Err(Error::Integrity(_))
        ));
        assert_eq!(lab.snapshot_count()?, 0);
        Ok(())
    }
    fn pack(lab: &Lab) -> Result<String> {
        Ok(lab
            .db
            .query_row("SELECT hash FROM packs LIMIT 1", [], |r| r.get(0))?)
    }
    fn edit_index(lab: &Lab, edit: impl FnOnce(&mut Index)) -> Result<()> {
        let pack = pack(lab)?;
        let path = lab.root.join("objects").join(format!("{pack}.index"));
        let mut index: Index = serde_json::from_slice(&fs::read(&path)?)?;
        edit(&mut index);
        let bytes = serde_json::to_vec(&index)?;
        fs::write(path, &bytes)?;
        lab.db.execute(
            "UPDATE packs SET index_hash=? WHERE hash=?",
            params![blake3::hash(&bytes).to_hex().to_string(), pack],
        )?;
        Ok(())
    }
    #[test]
    fn corrupted_or_missing_frames_indexes_and_sql_metadata_fail_closed() -> Result<()> {
        for fault in 0..9 {
            let mut lab = Lab::new()?;
            let control = Control::default();
            lab.generate(3, 8192, 0, true)?;
            let snapshot = lab.capture(Format::Pack, &control)?.snapshot;
            let pack = pack(&lab)?;
            match fault {
                0 => {
                    let path = lab.root.join("objects").join(format!("{pack}.pack"));
                    let mut bytes = fs::read(&path)?;
                    bytes[10] ^= 1;
                    fs::write(path, bytes)?;
                }
                1 => {
                    fs::remove_file(lab.root.join("objects").join(format!("{pack}.index")))?;
                }
                2 => {
                    edit_index(&lab, |i| i.frames[0].offset = u64::MAX)?;
                }
                3 => {
                    edit_index(&lab, |i| i.frames[0].length = u64::MAX)?;
                }
                4 => {
                    edit_index(&lab, |i| i.frames[0].size += 1)?;
                }
                5 => {
                    edit_index(&lab, |i| i.frames[1].hash = i.frames[0].hash.clone())?;
                }
                6 => {
                    edit_index(&lab, |i| i.frames[0].hash = "../escape".to_owned())?;
                }
                7 => {
                    lab.db.execute("UPDATE objects SET size=-1", [])?;
                }
                _ => {
                    let path = lab.root.join("objects").join(format!("{pack}.pack"));
                    OpenOptions::new().write(true).open(path)?.set_len(2)?;
                }
            }
            assert!(lab.verify(snapshot, &control).is_err(), "fault {fault}");
            assert!(
                lab.capture(Format::Pack, &control).is_err(),
                "reuse must verify fault {fault}"
            );
            assert_eq!(lab.snapshot_count()?, 1);
        }
        Ok(())
    }
    #[test]
    fn exact_frame_boundary_rejects_concatenation_and_trailing_bytes() -> Result<()> {
        let lab = Lab::new()?;
        let control = Control::default();
        lab.generate(1, 4096, 0, false)?;
        let object = lab.scan(&control)?["file-00000.bin"].clone();
        for suffix in [b"garbage".to_vec(), zstd::encode_all(&b""[..], 3)?] {
            let mut file = tempfile::tempfile()?;
            encode(
                &lab.root.join("source/file-00000.bin"),
                &mut file,
                &object,
                &control,
            )?;
            file.write_all(&suffix)?;
            let frame = Frame {
                hash: object.hash.clone(),
                size: object.size,
                offset: 0,
                length: file.stream_position()?,
            };
            assert!(matches!(
                decode(&mut file, &frame, &mut io::sink(), &control),
                Err(Error::Integrity(_))
            ));
        }
        Ok(())
    }
    #[test]
    fn links_unsupported_entries_and_publication_collisions_are_refused() -> Result<()> {
        use std::os::unix::fs::symlink;
        let mut lab = Lab::new()?;
        let control = Control::default();
        lab.generate(2, 4096, 0, false)?;
        let path = lab.root.join("source/file-00000.bin");
        fs::hard_link(&path, lab.root.join("alias"))?;
        assert!(lab.capture(Format::Pack, &control).is_err());
        fs::remove_file(lab.root.join("alias"))?;
        fs::rename(&path, lab.root.join("held"))?;
        symlink(lab.root.join("held"), &path)?;
        assert!(lab.capture(Format::Pack, &control).is_err());
        fs::remove_file(&path)?;
        fs::rename(lab.root.join("held"), &path)?;
        let fifo_path = lab.root.join("source/file-00003.bin");
        use std::os::unix::ffi::OsStrExt;
        let fifo = std::ffi::CString::new(fifo_path.as_os_str().as_bytes()).unwrap();
        // SAFETY: NUL-terminated path inside this newly minted synthetic root.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(lab.capture(Format::Pack, &control).is_err());
        fs::remove_file(fifo_path)?;
        let mut temp = tempfile::NamedTempFile::new_in(lab.root.join("objects"))?;
        temp.write_all(b"expected")?;
        let destination = lab.root.join("objects/collision");
        fs::write(&destination, b"unrelated")?;
        assert!(matches!(
            publish(
                temp,
                &destination,
                blake3::hash(b"expected").to_hex().as_str(),
                8,
                &control
            ),
            Err(Error::Integrity(_))
        ));
        assert_eq!(fs::read(destination)?, b"unrelated");
        Ok(())
    }
    fn pause(point: &str) {
        if std::env::var("ATTUNER_PACK_POINT").ok().as_deref() == Some(point) {
            let marker = std::env::var_os("ATTUNER_PACK_MARKER").unwrap();
            fs::write(marker, point).unwrap();
            loop {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
    #[test]
    #[ignore = "entrypoint invoked only by synthetic interruption parent"]
    fn interruption_child() -> Result<()> {
        let root =
            PathBuf::from(std::env::var_os("ATTUNER_PACK_ROOT").expect("parent-owned laboratory"));
        assert!(
            root.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("attuner-pack-lab-")
        );
        let db = Connection::open(root.join("catalog.sqlite"))?;
        db.execute_batch("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")?;
        let mut lab = Lab {
            root,
            _owner: None,
            db,
        };
        lab.capture(
            Format::Pack,
            &Control {
                checkpoint: Some(pause),
                ..Control::default()
            },
        )?;
        panic!("parent must terminate child at the requested boundary");
    }
    #[test]
    fn killed_publication_recovers_legacy_and_retries_verified_orphans() -> Result<()> {
        let boundaries = [
            "scan-complete",
            "frame-written",
            "frame-verified",
            "pack-flushed",
            "index-flushed",
            "pack-promoted",
            "index-promoted",
            "directory-flushed",
            "before-commit",
            "after-commit",
        ];
        for boundary in boundaries {
            let mut lab = Lab::new()?;
            let control = Control::default();
            lab.generate(3, 4096, 0, true)?;
            let baseline = lab.capture(Format::Legacy, &control)?.snapshot;
            lab.change(0, 4096, true, 1)?;
            let marker = lab.root.join("child-ready");
            let mut child = Command::new(std::env::current_exe()?)
                .args([
                    "--exact",
                    "experiment::tests::interruption_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env("ATTUNER_PACK_ROOT", &lab.root)
                .env("ATTUNER_PACK_MARKER", &marker)
                .env("ATTUNER_PACK_POINT", boundary)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?;
            let deadline = Instant::now() + Duration::from_secs(20);
            while !marker.exists() {
                if child.try_wait()?.is_some() || Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("child did not reach {boundary}");
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            child.kill()?;
            assert!(!child.wait()?.success());
            assert_eq!(
                lab.snapshot_count()?,
                if boundary == "after-commit" { 2 } else { 1 }
            );
            assert_eq!(lab.verify(baseline, &control)?, 3);
            if boundary == "after-commit" {
                assert_eq!(lab.verify(2, &control)?, 3);
            }
            let retry = lab.capture(Format::Pack, &control)?;
            assert_eq!(lab.verify(retry.snapshot, &control)?, 3);
        }
        Ok(())
    }
}
