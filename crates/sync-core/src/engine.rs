use crate::{
    Adapter, CompleteScan, Control, Error, Limits, Manifest, Operation, Result, Snapshot,
    Verification, Workspace, backup, compare, scan, store::Store,
};
use std::path::Path;
pub struct Engine {
    pub(crate) workspace: Workspace,
    pub(crate) adapter: Adapter,
    pub(crate) store: Store,
    pub limits: Limits,
}
impl Engine {
    pub fn create_fixture(version: u32, control: &Control) -> Result<Self> {
        Self::create_with_adapter(Adapter::fixture(version), control)
    }
    pub fn create_bound_fixture(version: u32, profile: &str, control: &Control) -> Result<Self> {
        Self::create_with_adapter(Adapter::bound_fixture(version, profile)?, control)
    }
    fn create_with_adapter(adapter: Adapter, control: &Control) -> Result<Self> {
        control.check()?;
        let workspace = Workspace::create()?;
        Self::from_new_workspace(workspace, adapter, control)
    }
    pub(crate) fn from_new_workspace(
        workspace: Workspace,
        adapter: Adapter,
        control: &Control,
    ) -> Result<Self> {
        control.check()?;
        adapter.seed(&workspace)?;
        let store = Store::open(&workspace, &adapter)?;
        tracing::info!(
            adapter_version = adapter.version,
            "created isolated synthetic workspace"
        );
        Ok(Self {
            workspace,
            adapter,
            store,
            limits: Limits::default(),
        })
    }
    pub fn reopen(path: &Path, control: &Control) -> Result<Self> {
        control.check()?;
        let workspace = Workspace::reopen(path)?;
        Self::from_reopened_workspace(workspace, control)
    }
    pub(crate) fn from_reopened_workspace(workspace: Workspace, control: &Control) -> Result<Self> {
        control.check()?;
        let _lock = workspace.lock()?;
        let adapter = Adapter::discover(&workspace, control)?;
        let store = Store::open(&workspace, &adapter)?;
        Ok(Self {
            workspace,
            adapter,
            store,
            limits: Limits::default(),
        })
    }
    pub fn path(&self) -> &Path {
        self.workspace.path()
    }
    pub fn adapter(&self) -> &Adapter {
        &self.adapter
    }
    pub fn sqlite_version(&self) -> &'static str {
        rusqlite::version()
    }
    pub(crate) fn ensure_idle(&self) -> Result<()> {
        if self.store.pending()? {
            Err(Error::PendingRecovery)
        } else {
            Ok(())
        }
    }
    pub(crate) fn validate_scan(&self, scan: &CompleteScan) -> Result<()> {
        if scan.workspace != self.path().to_string_lossy()
            || scan.coverage.adapter_version != self.adapter.version
        {
            return Err(Error::Coverage);
        }
        Ok(())
    }
    pub fn scan(&mut self, control: &Control) -> Result<CompleteScan> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        self.ensure_idle()?;
        let result = scan::scan(&self.workspace, &self.adapter, control, &self.limits)?;
        control.check()?;
        self.store.save_scan(&result)?;
        Ok(result)
    }
    pub fn changes(&self, scan: &CompleteScan, control: &Control) -> Result<Vec<compare::Change>> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        self.validate_scan(scan)?;
        self.ensure_idle()?;
        let base = self
            .store
            .baseline()?
            .map(|s| s.manifest)
            .unwrap_or_else(|| Manifest {
                files: vec![],
                ..scan.manifest.clone()
            });
        compare::detect_changes(&base, scan)
    }
    pub fn capture_snapshot(
        &mut self,
        scan: &CompleteScan,
        label: &str,
        control: &Control,
    ) -> Result<Snapshot> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        self.ensure_idle()?;
        self.validate_scan(scan)?;
        // The supplied receipt already proves a complete two-pass scan. Capture
        // each expected object, then require another complete two-pass scan before
        // publishing references. A third full pre-capture scan adds no stability proof.
        let objects = self.workspace.internal("state/objects")?;
        let mut seen = std::collections::BTreeMap::new();
        let mut needed = self.limits.disk_reserve;
        for entry in &scan.manifest.files {
            let metadata_bytes =
                (entry.path.len() + entry.root.len() + entry.group.len() + entry.hash.len() + 256)
                    as u64;
            needed = needed
                .checked_add(
                    metadata_bytes
                        .checked_mul(3)
                        .ok_or_else(|| Error::Limit("snapshot metadata budget".into()))?,
                )
                .ok_or_else(|| Error::Limit("snapshot space".into()))?;
            if let Some(size) = seen.insert(&entry.hash, entry.size) {
                if size != entry.size {
                    return Err(Error::Integrity("inconsistent content size".into()));
                }
                continue;
            }
            match objects.symlink_metadata(format!("{}.zst", entry.hash)) {
                Ok(metadata) => {
                    crate::workspace::check_meta(&metadata, "existing backup object", true)?
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let budget = entry
                        .size
                        .checked_add(4096)
                        .and_then(|n| n.checked_mul(2))
                        .ok_or_else(|| Error::Limit("new object budget".into()))?;
                    needed = needed
                        .checked_add(budget)
                        .ok_or_else(|| Error::Limit("backup space".into()))?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        self.check_space(needed, control)?;
        for entry in &scan.manifest.files {
            control.check()?;
            let file =
                scan::managed_file(&self.workspace, &self.adapter, &entry.root, &entry.path)?;
            backup::put(&self.workspace, file, entry, control, &self.limits)?;
        }
        let scan_start = std::time::Instant::now();
        let verified = scan::scan(&self.workspace, &self.adapter, control, &self.limits)?;
        control.timed(crate::Point::CaptureScan, 1, "", scan_start)?;
        if verified.manifest != scan.manifest {
            return Err(Error::Concurrent(
                "files changed while capturing snapshot".into(),
            ));
        }
        control.check()?;
        crate::workspace::sync_dir(&self.workspace.internal("state/objects")?)?;
        let database_start = std::time::Instant::now();
        let snapshot = self.store.capture(scan, label)?;
        let _ = control.timed(crate::Point::CaptureDatabase, 0, "", database_start);
        Ok(snapshot)
    }
    pub fn snapshots(&self, control: &Control) -> Result<Vec<Snapshot>> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        self.store.history()
    }
    pub fn baseline(&self, control: &Control) -> Result<Option<Snapshot>> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        self.store.baseline()
    }
    pub fn operations(&self, control: &Control) -> Result<Vec<Operation>> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        self.store.operations()
    }
    pub fn verify_snapshot(&self, id: i64, control: &Control) -> Result<Verification> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        let snapshot = self.store.snapshot(id)?;
        let mut bytes = 0;
        for entry in &snapshot.manifest.files {
            backup::verify(&self.workspace, entry, control, &self.limits)?;
            bytes += entry.size;
        }
        Ok(Verification {
            files: snapshot.manifest.files.len(),
            bytes,
            verified: true,
        })
    }
    pub(crate) fn check_space(&self, required: u64, control: &Control) -> Result<()> {
        control.check()?;
        let actual = fs2::available_space(self.path())?;
        let available = control
            .disk_budget
            .map_or(actual, |limit| actual.min(limit));
        if available < required {
            Err(Error::NoSpace {
                required,
                available,
            })
        } else {
            Ok(())
        }
    }
}

#[cfg(not(unix))]
impl Engine {
    pub fn apply_snapshot(
        &mut self,
        _target: i64,
        _expected: &CompleteScan,
        control: &Control,
    ) -> Result<i64> {
        control.check()?;
        Err(Error::Platform)
    }
    pub fn recover(&mut self, _id: i64, control: &Control) -> Result<()> {
        control.check()?;
        Err(Error::Platform)
    }
}
impl Engine {
    /// Export original bytes from an immutable verified backup, never from a remote path.
    pub fn export_snapshot_blob(
        &self,
        snapshot_id: i64,
        hash: &str,
        destination: &mut impl std::io::Write,
        control: &Control,
    ) -> Result<u64> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        self.ensure_idle()?;
        let snapshot = self.store.snapshot(snapshot_id)?;
        let entry = snapshot
            .manifest
            .files
            .iter()
            .find(|f| f.hash == hash)
            .ok_or(Error::NotFound)?;
        backup::decode(
            &self.workspace.internal("state/objects")?,
            &format!("{}.zst", entry.hash),
            entry,
            Some(destination),
            control,
            &self.limits,
        )
    }
    /// Validated remote identity and original bytes only. Does not touch the managed tree.
    pub fn import_blob(
        &mut self,
        entry: &crate::ManifestFile,
        source: impl std::io::Read,
        control: &Control,
    ) -> Result<()> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        self.ensure_idle()?;
        let roots = self
            .adapter
            .roots()?
            .into_iter()
            .map(|r| r.logical)
            .collect::<Vec<_>>();
        let manifest = Manifest {
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
                .ok_or_else(|| Error::Limit("remote backup space".into()))?,
            control,
        )?;
        backup::put(&self.workspace, source, entry, control, &self.limits)?;
        crate::workspace::sync_dir(&self.workspace.internal("state/objects")?)?;
        Ok(())
    }
    pub fn has_verified_blob(
        &self,
        entry: &crate::ManifestFile,
        control: &Control,
    ) -> Result<bool> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        self.ensure_idle()?;
        if entry.hash.len() != 64
            || !entry
                .hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::Integrity("blob identity".into()));
        }
        match backup::verify(&self.workspace, entry, control, &self.limits) {
            Ok(()) => Ok(true),
            Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }
    pub fn record_verified_remote_snapshot(
        &mut self,
        manifest: &Manifest,
        label: &str,
        control: &Control,
    ) -> Result<Snapshot> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        self.ensure_idle()?;
        let coverage = crate::Coverage {
            adapter_version: self.adapter.version,
            roots: self
                .adapter
                .roots()?
                .into_iter()
                .map(|r| r.logical)
                .collect(),
        };
        crate::remote::validate(manifest, self.adapter.profile_id(), &coverage.roots, 1)?;
        for entry in &manifest.files {
            backup::verify(&self.workspace, entry, control, &self.limits)?;
        }
        let mut canonical = manifest.clone();
        canonical
            .files
            .sort_by(|a, b| (&a.root, &a.path).cmp(&(&b.root, &b.path)));
        self.store
            .insert_snapshot(&canonical, &coverage, label, false)
    }
}
impl Engine {
    /// Historical review of a completed immutable capture. A fresh complete scan is
    /// still required at publication and local apply; this method performs no writes.
    pub fn compare_captured(
        &self,
        local_id: i64,
        baseline: &Manifest,
        remote: &Manifest,
        control: &Control,
    ) -> Result<compare::Merge> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        self.ensure_idle()?;
        let snapshot = self.store.snapshot(local_id)?;
        let receipt = CompleteScan {
            files: snapshot.manifest.files.len(),
            bytes: snapshot.manifest.files.iter().map(|f| f.size).sum(),
            manifest: snapshot.manifest,
            coverage: snapshot.coverage,
            workspace: self.path().to_string_lossy().into(),
        };
        compare::three_way(baseline, &receipt, remote)
    }
    pub fn resolve_captured(
        &self,
        local_id: i64,
        baseline: &Manifest,
        remote: &Manifest,
        decisions: &[crate::synchronization::Decision],
        control: &Control,
    ) -> Result<Manifest> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        self.ensure_idle()?;
        let snapshot = self.store.snapshot(local_id)?;
        let receipt = CompleteScan {
            files: snapshot.manifest.files.len(),
            bytes: snapshot.manifest.files.iter().map(|f| f.size).sum(),
            manifest: snapshot.manifest,
            coverage: snapshot.coverage,
            workspace: self.path().to_string_lossy().into(),
        };
        compare::resolve_three_way(baseline, &receipt, remote, decisions)
    }
}
