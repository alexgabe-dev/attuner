//! App-owned fixture registry. Native hosts provide their fixed app-data directory;
//! renderers receive IDs only, never directory paths or ambient filesystem capability.
#[cfg(unix)]
use crate::workspace::{create_file, sync_dir};
use crate::{
    Adapter, Control, Engine, Error, Result, Workspace,
    workspace::{check_meta, open_file},
};
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::io::Write;
use std::{
    io::Read,
    path::{Path, PathBuf},
};
const MARKER: &str = "attuner-app-owned-fixtures-v1\n";
#[derive(Clone)]
pub(crate) struct RegistryIdentity {
    pub home: PathBuf,
    pub device: u64,
    pub inode: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisteredFixture {
    pub id: String,
    pub profile_id: String,
    pub adapter_version: u32,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalogue {
    version: u32,
    device: u64,
    inode: u64,
    fixtures: Vec<RegisteredFixture>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    catalogue: Catalogue,
    digest: String,
}
pub struct FixtureRegistry {
    identity: RegistryIdentity,
    directory: Dir,
}
impl FixtureRegistry {
    #[cfg(unix)]
    pub fn open(app_data: &Path, control: &Control) -> Result<Self> {
        use std::os::unix::fs::PermissionsExt;
        control.check()?;
        std::fs::create_dir_all(app_data)?;
        let meta = std::fs::symlink_metadata(app_data)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(Error::UnsafePath("app-data directory".into()));
        }
        let parent = Dir::open_ambient_dir(app_data, ambient_authority())?;
        let created = match parent.create_dir("synthetic-workspaces-v1") {
            Ok(()) => true,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(e) => return Err(e.into()),
        };
        let directory = parent.open_dir_nofollow("synthetic-workspaces-v1")?;
        check_meta(&directory.dir_metadata()?, "fixture registry", false)?;
        if created {
            directory.set_permissions(
                ".",
                cap_std::fs::Permissions::from_std(std::fs::Permissions::from_mode(0o700)),
            )?;
            let mut marker = create_file(&directory, "registry.marker")?;
            marker.write_all(MARKER.as_bytes())?;
            marker.sync_all()?;
            sync_dir(&directory)?;
            sync_dir(&parent)?;
        }
        verify_marker(&directory)?;
        let meta = directory.dir_metadata()?;
        let identity = RegistryIdentity {
            home: app_data.canonicalize()?.join("synthetic-workspaces-v1"),
            device: meta.dev(),
            inode: meta.ino(),
        };
        let registry = Self {
            identity,
            directory,
        };
        let _lock = registry.lock()?;
        if created {
            registry.save(Catalogue {
                version: 1,
                device: meta.dev(),
                inode: meta.ino(),
                fixtures: vec![],
            })?;
        } else {
            registry.catalogue()?;
        }
        Ok(registry)
    }
    #[cfg(not(unix))]
    pub fn open(_app_data: &Path, control: &Control) -> Result<Self> {
        control.check()?;
        Err(Error::Platform)
    }
    fn lock(&self) -> Result<std::fs::File> {
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create(true)
            .follow(FollowSymlinks::No);
        let file = self.directory.open_with("registry.lock", &options)?;
        check_meta(&file.metadata()?, "registry lock", true)?;
        if file.metadata()?.len() != 0 {
            return Err(Error::Integrity("registry lock".into()));
        }
        let file = file.into_std();
        file.try_lock().map_err(|_| Error::Busy)?;
        Ok(file)
    }
    fn catalogue(&self) -> Result<Catalogue> {
        load_catalogue(&self.directory, &self.identity)
    }
    #[cfg(unix)]
    fn save(&self, catalogue: Catalogue) -> Result<()> {
        let digest = blake3::hash(&serde_json::to_vec(&catalogue)?)
            .to_hex()
            .to_string();
        let name = format!("catalogue-{}.tmp", uuid::Uuid::new_v4());
        let bytes = serde_json::to_vec(&Envelope { catalogue, digest })?;
        if bytes.len() > 65536 {
            return Err(Error::Limit("fixture registry".into()));
        }
        let mut file = create_file(&self.directory, &name)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        match open_file(&self.directory, "catalogue.json") {
            Ok(_) => {}
            Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        self.directory
            .rename(&name, &self.directory, "catalogue.json")?;
        sync_dir(&self.directory)
    }
    pub fn list(&self, control: &Control) -> Result<Vec<RegisteredFixture>> {
        control.check()?;
        let _lock = self.lock()?;
        Ok(self.catalogue()?.fixtures)
    }
    #[cfg(unix)]
    pub fn create_fixture(
        &mut self,
        version: u32,
        profile: &str,
        control: &Control,
    ) -> Result<(RegisteredFixture, Engine)> {
        control.check()?;
        let adapter = Adapter::bound_fixture(version, profile)?;
        adapter.roots()?;
        let _lock = self.lock()?;
        let mut catalogue = self.catalogue()?;
        if catalogue.fixtures.len() >= 64 {
            return Err(Error::Limit("registered fixtures".into()));
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.directory.create_dir(&id)?;
        let dir = self.directory.open_dir_nofollow(&id)?;
        let mut marker = create_file(&dir, "workspace.marker")?;
        marker.write_all(b"attuner-synthetic-workspace-v1\n")?;
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
        sync_dir(&self.directory)?;
        let workspace = Workspace {
            home: self.identity.home.join(&id),
            dir,
            registry: Some(self.identity.clone()),
        };
        let engine = Engine::from_new_workspace(workspace, adapter, control)?;
        let entry = RegisteredFixture {
            id,
            profile_id: profile.into(),
            adapter_version: version,
        };
        catalogue.fixtures.push(entry.clone());
        self.save(catalogue)?;
        Ok((entry, engine))
    }
    #[cfg(not(unix))]
    pub fn create_fixture(
        &mut self,
        _version: u32,
        _profile: &str,
        control: &Control,
    ) -> Result<(RegisteredFixture, Engine)> {
        control.check()?;
        Err(Error::Platform)
    }
    pub fn reopen(&self, id: &str, control: &Control) -> Result<Engine> {
        control.check()?;
        let workspace = reopen_workspace(&self.identity, id)?;
        let catalogue = self.catalogue()?;
        let entry = catalogue
            .fixtures
            .iter()
            .find(|f| f.id == id)
            .ok_or(Error::NotFound)?;
        let engine = Engine::from_reopened_workspace(workspace, control)?;
        if engine.adapter().profile_id() != entry.profile_id
            || engine.adapter().version != entry.adapter_version
        {
            return Err(Error::Coverage);
        }
        Ok(engine)
    }
}
fn verify_marker(directory: &Dir) -> Result<()> {
    #[cfg(unix)]
    if cap_std::fs::MetadataExt::mode(&directory.dir_metadata()?) & 0o077 != 0 {
        return Err(Error::UnsafePath("fixture registry permissions".into()));
    }
    let marker = open_file(directory, "registry.marker")?;
    let mut text = String::new();
    marker.take(129).read_to_string(&mut text)?;
    if text != MARKER {
        return Err(Error::Integrity("unrecognized fixture registry".into()));
    }
    Ok(())
}
fn load_catalogue(directory: &Dir, identity: &RegistryIdentity) -> Result<Catalogue> {
    verify_marker(directory)?;
    let meta = directory.dir_metadata()?;
    if (meta.dev(), meta.ino()) != (identity.device, identity.inode) {
        return Err(Error::UnsafePath(
            "fixture registry identity changed".into(),
        ));
    }
    let file = open_file(directory, "catalogue.json")?;
    if file.metadata()?.len() > 65536 {
        return Err(Error::Limit("fixture catalogue".into()));
    }
    let envelope: Envelope = serde_json::from_reader(file.take(65537))?;
    let c = envelope.catalogue;
    if c.version != 1
        || c.device != meta.dev()
        || c.inode != meta.ino()
        || c.fixtures.len() > 64
        || envelope.digest != blake3::hash(&serde_json::to_vec(&c)?).to_hex().as_str()
    {
        return Err(Error::Integrity("fixture catalogue".into()));
    }
    let mut ids = std::collections::BTreeSet::new();
    for entry in &c.fixtures {
        if uuid::Uuid::parse_str(&entry.id).is_err() || !ids.insert(&entry.id) {
            return Err(Error::Coverage);
        }
        Adapter::bound_fixture(entry.adapter_version, &entry.profile_id)?.roots()?;
    }
    Ok(c)
}
pub(crate) fn reopen_workspace(identity: &RegistryIdentity, id: &str) -> Result<Workspace> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(Error::UnsafePath("registered fixture ID".into()));
    }
    let parent = identity.home.parent().ok_or(Error::Coverage)?;
    let parent = Dir::open_ambient_dir(parent, ambient_authority())?;
    let directory = parent.open_dir_nofollow("synthetic-workspaces-v1")?;
    let catalogue = load_catalogue(&directory, identity)?;
    if !catalogue.fixtures.iter().any(|f| f.id == id) {
        return Err(Error::NotFound);
    }
    let dir = directory.open_dir_nofollow(id)?;
    check_meta(&dir.dir_metadata()?, id, false)?;
    let marker = open_file(&dir, "workspace.marker")?;
    let mut bytes = String::new();
    marker.take(129).read_to_string(&mut bytes)?;
    if bytes != "attuner-synthetic-workspace-v1\n" {
        return Err(Error::Adapter);
    }
    Ok(Workspace {
        home: identity.home.join(id),
        dir,
        registry: Some(identity.clone()),
    })
}
