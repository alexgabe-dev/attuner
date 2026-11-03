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
        control.check()?;
        let workspace = Workspace::create()?;
        let adapter = Adapter::fixture(version);
        adapter.seed(&workspace)?;
        let store = Store::open(&workspace, &adapter)?;
        tracing::info!(
            adapter_version = version,
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
        let current = scan::scan(&self.workspace, &self.adapter, control, &self.limits)?;
        if current.manifest != scan.manifest {
            return Err(Error::Concurrent("snapshot scan expired".into()));
        }
        let needed = scan
            .bytes
            .checked_mul(2)
            .and_then(|n| n.checked_add(self.limits.disk_reserve))
            .ok_or_else(|| Error::Limit("backup budget".into()))?;
        self.check_space(needed, control)?;
        for entry in &scan.manifest.files {
            let file =
                scan::managed_file(&self.workspace, &self.adapter, &entry.root, &entry.path)?;
            backup::put(&self.workspace, file, entry, control, &self.limits)?;
        }
        let verified = scan::scan(&self.workspace, &self.adapter, control, &self.limits)?;
        if verified.manifest != scan.manifest {
            return Err(Error::Concurrent(
                "files changed while capturing snapshot".into(),
            ));
        }
        control.check()?;
        crate::workspace::sync_dir(&self.workspace.internal("state/objects")?)?;
        self.store.capture(scan, label)
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
