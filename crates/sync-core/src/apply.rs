use crate::{
    CompleteScan, Control, Engine, Error, Point, Result, backup, compare, scan,
    store::Step,
    workspace::{create_file, open_file, sync_dir},
};
use cap_std::fs::Dir;
use std::io::Write;
impl Engine {
    /// Explicit restoration of a verified local snapshot, never automatic synchronization.
    pub fn apply_snapshot(
        &mut self,
        target_id: i64,
        expected: &CompleteScan,
        control: &Control,
    ) -> Result<i64> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        self.ensure_idle()?;
        self.validate_scan(expected)?;
        let target = self.store.snapshot(target_id)?;
        if target.coverage != expected.coverage {
            return Err(Error::Coverage);
        }
        let actual = scan::scan(&self.workspace, &self.adapter, control, &self.limits)?;
        if actual.manifest != expected.manifest {
            return Err(Error::Concurrent("apply scan expired".into()));
        }
        let changes = compare::changes(&expected.manifest, &target.manifest, &expected.coverage)?;
        let needed = changes
            .iter()
            .try_fold(self.limits.disk_reserve, |sum, change| {
                let size = change
                    .before
                    .as_ref()
                    .map_or(0, |f| f.size)
                    .checked_mul(2)
                    .and_then(|b| {
                        change
                            .after
                            .as_ref()
                            .map_or(0, |f| f.size)
                            .checked_mul(2)
                            .and_then(|a| b.checked_add(a))
                    });
                size.and_then(|n| sum.checked_add(n))
                    .ok_or_else(|| Error::Limit("apply disk estimate".into()))
            })?;
        self.check_space(needed, control)?;
        // Structural file/directory transitions are deliberately rejected before staging.
        for change in &changes {
            let (dir, name) = scan::managed_parent(
                &self.workspace,
                &self.adapter,
                &change.root,
                &change.path,
                true,
            )?;
            if let Ok(meta) = dir.symlink_metadata(&name) {
                crate::workspace::check_meta(&meta, &change.path, true)?;
            }
        }
        let stage = self.workspace.internal("state/stage")?;
        let tag = self.workspace.new_name("apply");
        let mut steps = Vec::new();
        for (index, change) in changes.into_iter().enumerate() {
            let mut mode = None;
            if let Some(before) = &change.before {
                let file =
                    scan::managed_file(&self.workspace, &self.adapter, &change.root, &change.path)?;
                #[cfg(unix)]
                {
                    use cap_std::fs::MetadataExt;
                    mode = Some(file.metadata()?.mode() & 0o777);
                }
                backup::put(&self.workspace, file, before, control, &self.limits)?;
                backup::verify(&self.workspace, before, control, &self.limits)?;
            }
            let name = format!("{tag}-{index}.new");
            if let Some(after) = &change.after {
                backup::stage(&self.workspace, after, &stage, &name, control, &self.limits)?;
                set_mode(&stage, &name, mode)?;
            }
            steps.push(Step {
                change,
                mode,
                stage: name,
                quarantine: format!("{tag}-{index}.old"),
            });
        }
        if scan::scan(&self.workspace, &self.adapter, control, &self.limits)?.manifest
            != expected.manifest
        {
            return Err(Error::Concurrent("changed during staging".into()));
        }
        control.check()?;
        sync_dir(&self.workspace.internal("state/objects")?)?;
        let id = self.store.prepare(target_id, expected, &steps)?;
        let result = (|| {
            control.event(Point::Prepared, 0, "")?;
            self.store.state(id, "applying", None)?;
            let quarantine = self.workspace.internal("state/quarantine")?;
            for (index, step) in steps.iter().enumerate() {
                self.store.step_state(id, index, "intent")?;
                control.event(Point::Intent, index, &step.change.path)?;
                self.expect_hash(
                    step,
                    step.change.before.as_ref().map(|f| f.hash.as_str()),
                    control,
                )?;
                let (parent, name) = scan::managed_parent(
                    &self.workspace,
                    &self.adapter,
                    &step.change.root,
                    &step.change.path,
                    false,
                )?;
                if step.change.before.is_some() {
                    if quarantine.try_exists(&step.quarantine)? {
                        return Err(Error::Concurrent("quarantine occupied".into()));
                    }
                    control.check()?;
                    parent.rename(&name, &quarantine, &step.quarantine)?;
                    sync_dir(&parent)?;
                    sync_dir(&quarantine)?;
                    let (hash, _) = scan::hash(
                        open_file(&quarantine, &step.quarantine)?,
                        control,
                        self.limits.max_file_bytes,
                        &step.change.path,
                    )?;
                    if Some(hash.as_str()) != step.change.before.as_ref().map(|f| f.hash.as_str()) {
                        return Err(Error::Concurrent(
                            "evacuated preimage changed; preserved in quarantine".into(),
                        ));
                    }
                }
                self.store.step_state(id, index, "evacuated")?;
                control.event(Point::Evacuated, index, &step.change.path)?;
                if let Some(after) = &step.change.after {
                    // Atomic no-clobber publication; an external creation cannot be overwritten by rename.
                    let (digest, _) = scan::hash(
                        open_file(&stage, &step.stage)?,
                        control,
                        self.limits.max_file_bytes,
                        &step.change.path,
                    )?;
                    if digest != after.hash {
                        return Err(Error::Integrity("staged target".into()));
                    }
                    control.check()?;
                    stage.hard_link(&step.stage, &parent, &name)?;
                }
                control.event(Point::Installed, index, &step.change.path)?;
                if step.change.after.is_some() {
                    stage.remove_file(&step.stage)?;
                }
                sync_dir(&parent)?;
                sync_dir(&stage)?;
                self.store.step_state(id, index, "durable")?;
                control.event(Point::StepDurable, index, &step.change.path)?;
            }
            control.event(Point::BeforeVerification, steps.len(), "")?;
            if scan::scan(&self.workspace, &self.adapter, control, &self.limits)?.manifest
                != target.manifest
            {
                return Err(Error::Integrity("final applied tree".into()));
            }
            control.event(Point::BeforeCommit, steps.len(), "")?;
            if scan::scan(&self.workspace, &self.adapter, control, &self.limits)?.manifest
                != target.manifest
            {
                return Err(Error::Concurrent("changed before acknowledgement".into()));
            }
            control.check()?;
            self.store.commit(id, target_id)?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                let _ = control.event(Point::Committed, steps.len(), "");
                tracing::info!(
                    operation = id,
                    target_snapshot = target_id,
                    "local snapshot applied"
                );
                Ok(id)
            }
            Err(error) => {
                let reason = error.to_string();
                let _ = self.store.state(id, "recoveryRequired", Some(&reason));
                Err(Error::RecoveryRequired {
                    operation: id,
                    reason,
                })
            }
        }
    }
    pub(crate) fn expect_hash(
        &self,
        step: &Step,
        expected: Option<&str>,
        control: &Control,
    ) -> Result<()> {
        let actual = scan::current_hash(
            &self.workspace,
            &self.adapter,
            &step.change.root,
            &step.change.path,
            control,
            &self.limits,
        )?;
        if actual.as_deref() != expected {
            return Err(Error::Concurrent(step.change.path.clone()));
        }
        Ok(())
    }
}
pub(crate) fn set_mode(dir: &Dir, name: &str, mode: Option<u32>) -> Result<()> {
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        let permissions = cap_std::fs::Permissions::from_std(std::fs::Permissions::from_mode(mode));
        let file = open_file(dir, name)?;
        file.set_permissions(permissions)?;
        file.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = (dir, name, mode);
    }
    Ok(())
}
/// Synthetic fixture utility for benchmarks: bounded repeated bytes, no arbitrary ambient path.
pub fn write_synthetic_file(
    engine: &Engine,
    logical_root: &str,
    path: &str,
    bytes: u64,
    control: &Control,
) -> Result<()> {
    control.check()?;
    let _lock = engine.workspace.lock()?;
    engine.ensure_idle()?;
    let (dir, name) =
        scan::managed_parent(&engine.workspace, &engine.adapter, logical_root, path, true)?;
    let mut file = create_file(&dir, &name)?;
    let block = [b'x'; 64 * 1024];
    let mut remaining = bytes;
    while remaining > 0 {
        control.check()?;
        let count = remaining.min(block.len() as u64) as usize;
        file.write_all(&block[..count])?;
        remaining -= count as u64;
    }
    file.sync_all()?;
    sync_dir(&dir)?;
    Ok(())
}
