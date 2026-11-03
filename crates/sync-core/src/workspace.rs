use crate::{Error, Result, portable_path};
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, File, Metadata, OpenOptions},
};
#[cfg(unix)]
use std::io::Write;
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
static TEMP: AtomicU64 = AtomicU64::new(0);
const MARKER: &str = "attuner-synthetic-workspace-v1\n";
/// Can only be created as a fresh private directory under the OS temporary directory.
/// Reopening checks location and marker; no game root selection API exists.
pub struct Workspace {
    pub(crate) home: PathBuf,
    pub(crate) dir: Dir,
    pub(crate) registry: Option<crate::registry::RegistryIdentity>,
}
impl Workspace {
    #[cfg(unix)]
    pub fn create() -> Result<Self> {
        let temp = tempfile::Builder::new().prefix("attuner-lab-").tempdir()?;
        let path = temp.keep();
        let dir = Dir::open_ambient_dir(&path, ambient_authority())?;
        let mut marker = create_file(&dir, "workspace.marker")?;
        marker.write_all(MARKER.as_bytes())?;
        marker.sync_all()?;
        for name in [
            "installation",
            "state",
            "state/objects",
            "state/stage",
            "state/quarantine",
        ] {
            dir.create_dir_all(name)?;
        }
        sync_dir(&dir)?;
        Ok(Self {
            home: path.canonicalize()?,
            dir,
            registry: None,
        })
    }
    #[cfg(not(unix))]
    pub fn create() -> Result<Self> {
        Err(Error::Platform)
    }
    pub fn reopen(path: &Path) -> Result<Self> {
        let temporary = std::env::temp_dir().canonicalize()?;
        if path.parent() != Some(temporary.as_path())
            || !path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("attuner-lab-"))
        {
            return Err(Error::UnsafePath("not a minted temporary workspace".into()));
        }
        let parent = Dir::open_ambient_dir(temporary, ambient_authority())?;
        let dir = parent.open_dir_nofollow(path.file_name().ok_or(Error::Adapter)?)?;
        let mut marker = open_file(&dir, "workspace.marker")?;
        let mut bytes = String::new();
        std::io::Read::by_ref(&mut marker)
            .take(128)
            .read_to_string(&mut bytes)?;
        if bytes != MARKER {
            return Err(Error::Adapter);
        }
        Ok(Self {
            home: path.to_owned(),
            dir,
            registry: None,
        })
    }
    pub fn path(&self) -> &Path {
        &self.home
    }
    pub(crate) fn internal(&self, path: &str) -> Result<Dir> {
        open_dir(&self.dir, path, false)
    }
    pub(crate) fn validate(&self) -> Result<()> {
        let other = match &self.registry {
            Some(registry) => crate::registry::reopen_workspace(
                registry,
                self.home
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or(Error::Adapter)?,
            )?,
            None => Self::reopen(&self.home)?,
        };
        let a = self.dir.dir_metadata()?;
        let b = other.dir.dir_metadata()?;
        if (a.dev(), a.ino()) != (b.dev(), b.ino()) {
            return Err(Error::UnsafePath("workspace identity changed".into()));
        }
        for name in [
            "installation",
            "state",
            "state/objects",
            "state/stage",
            "state/quarantine",
        ] {
            self.internal(name)?;
        }
        Ok(())
    }
    pub(crate) fn lock(&self) -> Result<std::fs::File> {
        self.validate()?;
        let state = self.internal("state")?;
        let mut opts = OpenOptions::new();
        opts.read(true)
            .write(true)
            .create(true)
            .follow(FollowSymlinks::No);
        let file = state.open_with("operation.lock", &opts)?.into_std();
        if file.metadata()?.len() > 0 {
            return Err(Error::UnsafePath("invalid operation lock".into()));
        }
        for attempt in 0..10 {
            match file.try_lock() {
                Ok(()) => return Ok(file),
                Err(std::fs::TryLockError::WouldBlock) if attempt < 9 => {
                    std::thread::sleep(std::time::Duration::from_millis(1))
                }
                Err(std::fs::TryLockError::WouldBlock) => return Err(Error::Busy),
                Err(std::fs::TryLockError::Error(error)) => return Err(Error::Io(error)),
            }
        }
        Err(Error::Busy)
    }
    pub(crate) fn new_name(&self, prefix: &str) -> String {
        format!(
            "{prefix}-{}-{}",
            std::process::id(),
            TEMP.fetch_add(1, Ordering::Relaxed)
        )
    }
}
pub(crate) fn check_meta(meta: &Metadata, path: &str, file: bool) -> Result<()> {
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt as _;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(Error::UnsafePath(path.into()));
        }
    }
    if meta.file_type().is_symlink()
        || (file && (!meta.is_file() || meta.nlink() != 1))
        || (!file && !meta.is_dir())
    {
        return Err(Error::UnsafePath(path.into()));
    }
    Ok(())
}
pub(crate) fn open_dir(base: &Dir, path: &str, create: bool) -> Result<Dir> {
    if !portable_path(path) {
        return Err(Error::UnsafePath(path.into()));
    }
    let mut dir = base.try_clone()?;
    for part in path.split('/') {
        if create {
            match dir.create_dir(part) {
                Ok(()) => sync_dir(&dir)?,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.into()),
            }
        }
        let next = dir.open_dir_nofollow(part)?;
        let meta = next.dir_metadata()?;
        check_meta(&meta, part, false)?;
        if meta.dev() != base.dir_metadata()?.dev() {
            return Err(Error::UnsafePath("cross-device directory".into()));
        }
        dir = next;
    }
    Ok(dir)
}
pub(crate) fn parent(base: &Dir, path: &str, create: bool) -> Result<(Dir, String)> {
    if !portable_path(path) {
        return Err(Error::UnsafePath(path.into()));
    }
    match path.rsplit_once('/') {
        Some((p, n)) => Ok((open_dir(base, p, create)?, n.into())),
        None => Ok((base.try_clone()?, path.into())),
    }
}
pub(crate) fn open_file(dir: &Dir, name: &str) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let f = dir.open_with(name, &options)?;
    check_meta(&f.metadata()?, name, true)?;
    Ok(f)
}
pub(crate) fn create_file(dir: &Dir, name: &str) -> Result<File> {
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    Ok(dir.open_with(name, &options)?)
}
pub(crate) fn sync_dir(dir: &Dir) -> Result<()> {
    #[cfg(unix)]
    {
        dir.try_clone()?.into_std_file().sync_all()?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Err(Error::Platform)
    }
}
