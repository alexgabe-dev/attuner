use crate::{
    Control, Error, Point, Result, Workspace,
    workspace::{open_dir, open_file},
};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
pub const PROFILE_ID: &str = "11111111-1111-4111-8111-111111111111";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Adapter {
    pub kind: String,
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    profile_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RootMapping {
    pub logical: String,
    pub directory: String,
}
impl Adapter {
    pub fn fixture(version: u32) -> Self {
        Self {
            kind: "attuner-synthetic".into(),
            version,
            profile_id: None,
        }
    }
    pub fn bound_fixture(version: u32, profile: &str) -> Result<Self> {
        let test = crate::Manifest {
            protocol_version: 1,
            profile_id: profile.into(),
            policy_version: 1,
            files: vec![],
        };
        test.validate().map_err(|_| Error::Coverage)?;
        Ok(Self {
            kind: "attuner-synthetic".into(),
            version,
            profile_id: Some(profile.into()),
        })
    }
    pub fn profile_id(&self) -> &str {
        self.profile_id.as_deref().unwrap_or(PROFILE_ID)
    }
    pub fn roots(&self) -> Result<Vec<RootMapping>> {
        if self.kind != "attuner-synthetic" {
            return Err(Error::Adapter);
        }
        crate::Manifest {
            protocol_version: 1,
            profile_id: self.profile_id().into(),
            policy_version: 1,
            files: vec![],
        }
        .validate()
        .map_err(|_| Error::Adapter)?;
        let dirs = match self.version {
            1 => ["ProfileData", "Extensions"],
            2 => ["Configuration", "Modules"],
            _ => return Err(Error::Adapter),
        };
        Ok(["account", "addons"]
            .into_iter()
            .zip(dirs)
            .map(|(logical, directory)| RootMapping {
                logical: logical.into(),
                directory: directory.into(),
            })
            .collect())
    }
    pub fn discover(workspace: &Workspace, control: &Control) -> Result<Self> {
        control.event(Point::Discover, 0, "")?;
        let installation = workspace.internal("installation")?;
        let file = open_file(&installation, "fixture-installation.json")?;
        if file.metadata()?.len() > 4096 {
            return Err(Error::Limit("adapter descriptor".into()));
        }
        let adapter: Self = serde_json::from_reader(file.take(4097))?;
        for root in adapter.roots()? {
            open_dir(&installation, &root.directory, false)?;
        }
        Ok(adapter)
    }
    pub(crate) fn seed(&self, workspace: &Workspace) -> Result<()> {
        let installation = workspace.internal("installation")?;
        let mut descriptor =
            super::workspace::create_file(&installation, "fixture-installation.json")?;
        descriptor.write_all(&serde_json::to_vec(self)?)?;
        descriptor.sync_all()?;
        let roots = self.roots()?;
        for root in &roots {
            installation.create_dir(&root.directory)?;
        }
        let account = open_dir(&installation, &roots[0].directory, false)?;
        account.create_dir("SavedVariables")?;
        let saved = open_dir(&account, "SavedVariables", false)?;
        let mut f = super::workspace::create_file(&saved, "WeakAuras.lua")?;
        f.write_all(b"-- inert synthetic fixture\r\nDemo = { size = 48, enabled = true }\r\n")?;
        f.sync_all()?;
        let mut f = super::workspace::create_file(&saved, "bindings.txt")?;
        f.write_all(b"ACTIONBUTTON1 = 1\nACTIONBUTTON2 = 2\n")?;
        f.sync_all()?;
        let addons = open_dir(&installation, &roots[1].directory, false)?;
        addons.create_dir("DemoAddon")?;
        let addon = open_dir(&addons, "DemoAddon", false)?;
        let mut f = super::workspace::create_file(&addon, "DemoAddon.toc")?;
        f.write_all(b"## Title: Attuner synthetic fixture\n## Version: 2.0\n")?;
        f.sync_all()?;
        super::workspace::sync_dir(&installation)?;
        Ok(())
    }
}
