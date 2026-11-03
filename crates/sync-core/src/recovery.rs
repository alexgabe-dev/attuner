use crate::{
    Control, Engine, Error, Point, Result, backup, compare, scan,
    store::Step,
    workspace::{open_file, sync_dir},
};
use cap_fs_ext::MetadataExt;
impl Engine {
    pub fn recover(&mut self, id: i64, control: &Control) -> Result<()> {
        control.check()?;
        let _lock = self.workspace.lock()?;
        let operation = self.store.operation(id)?;
        if operation.state == "committed" || operation.state == "rolledBack" {
            return Ok(());
        }
        let target = self.store.snapshot(operation.target_snapshot)?;
        let before = self.store.before(id)?;
        let steps = self.store.steps(id)?;
        let expected = compare::changes(&before, &target.manifest, &target.coverage)?;
        if expected != steps.iter().map(|s| s.change.clone()).collect::<Vec<_>>() {
            return Err(Error::Integrity("journal change set".into()));
        }
        let stage = self.workspace.internal("state/stage")?;
        let quarantine = self.workspace.internal("state/quarantine")?;
        let needed = steps.iter().try_fold(self.limits.disk_reserve, |sum, s| {
            sum.checked_add(s.change.before.as_ref().map_or(0, |f| f.size))
                .ok_or_else(|| Error::Limit("recovery budget".into()))
        })?;
        self.check_space(needed, control)?;
        // Preflight every touched path and every backup before changing managed files.
        for (index, step) in steps.iter().enumerate() {
            validate_names(step)?;
            self.unlink_known_stage_alias(step, control)?;
            let current = scan::current_hash(
                &self.workspace,
                &self.adapter,
                &step.change.root,
                &step.change.path,
                control,
                &self.limits,
            )?;
            let before = step.change.before.as_ref().map(|f| f.hash.as_str());
            let after = step.change.after.as_ref().map(|f| f.hash.as_str());
            let status = self.store.step_status(id, index)?;
            let evacuated = current.is_none()
                && before.is_some()
                && matches!(status.as_str(), "intent" | "evacuated" | "rollbackIntent");
            if current.as_deref() != before && current.as_deref() != after && !evacuated {
                return Err(Error::Concurrent(step.change.path.clone()));
            }
            if current.is_none() && after.is_some() && before.is_some() && !evacuated {
                return Err(Error::Concurrent(step.change.path.clone()));
            }
            if let Some(entry) = &step.change.before {
                backup::verify(&self.workspace, entry, control, &self.limits)?;
                let restore = format!("{}.restore", step.stage);
                if stage.try_exists(&restore)? {
                    let (digest, _) = scan::hash(
                        open_file(&stage, &restore)?,
                        control,
                        self.limits.max_file_bytes,
                        &restore,
                    )?;
                    if digest != entry.hash {
                        return Err(Error::Integrity(restore));
                    }
                } else {
                    backup::stage(
                        &self.workspace,
                        entry,
                        &stage,
                        &restore,
                        control,
                        &self.limits,
                    )?;
                }
                // A previous crash may have published bytes before setting permissions.
                crate::apply::set_mode(&stage, &restore, step.mode)?;
            }
        }
        self.store.state(id, "recovering", None)?;
        for (index, step) in steps.iter().enumerate().rev() {
            self.unlink_known_stage_alias(step, control)?;
            let current = scan::current_hash(
                &self.workspace,
                &self.adapter,
                &step.change.root,
                &step.change.path,
                control,
                &self.limits,
            )?;
            let before = step.change.before.as_ref().map(|f| f.hash.as_str());
            if current.as_deref() == before {
                self.store.step_state(id, index, "rolledBack")?;
                continue;
            }
            self.store.step_state(id, index, "rollbackIntent")?;
            control.event(Point::RecoveryIntent, index, &step.change.path)?;
            // Recheck after the observer/progress boundary, immediately before evacuation.
            let fresh = scan::current_hash(
                &self.workspace,
                &self.adapter,
                &step.change.root,
                &step.change.path,
                control,
                &self.limits,
            )?;
            if fresh != current {
                return Err(Error::Concurrent(step.change.path.clone()));
            }
            let (parent, name) = scan::managed_parent(
                &self.workspace,
                &self.adapter,
                &step.change.root,
                &step.change.path,
                true,
            )?;
            if current.is_some() {
                let after_name = format!("{}.after", step.quarantine);
                if quarantine.try_exists(&after_name)? {
                    return Err(Error::Concurrent("recovery quarantine occupied".into()));
                }
                control.check()?;
                parent.rename(&name, &quarantine, &after_name)?;
                sync_dir(&parent)?;
                sync_dir(&quarantine)?;
            }
            control.event(Point::RecoveryEvacuated, index, &step.change.path)?;
            if step.change.before.is_some() {
                let restore = format!("{}.restore", step.stage);
                control.check()?;
                stage.hard_link(&restore, &parent, &name)?;
                control.event(Point::RecoveryInstalled, index, &step.change.path)?;
                stage.remove_file(&restore)?;
                sync_dir(&stage)?;
            }
            sync_dir(&parent)?;
            self.expect_hash(step, before, control)?;
            self.store.step_state(id, index, "rolledBack")?;
        }
        for step in &steps {
            self.expect_hash(
                step,
                step.change.before.as_ref().map(|f| f.hash.as_str()),
                control,
            )?;
        }
        control.check()?;
        self.store.state(id, "rolledBack", None)?;
        let _ = control.event(Point::Recovered, steps.len(), "");
        tracing::info!(
            operation = id,
            "local operation rolled back; baseline unchanged"
        );
        Ok(())
    }
    fn unlink_known_stage_alias(&self, step: &Step, control: &Control) -> Result<()> {
        control.check()?;
        let (parent, name) = scan::managed_parent(
            &self.workspace,
            &self.adapter,
            &step.change.root,
            &step.change.path,
            false,
        )?;
        let meta = match parent.symlink_metadata(&name) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        if meta.nlink() == 1 {
            return Ok(());
        }
        if !meta.is_file() || meta.nlink() != 2 {
            return Err(Error::UnsafePath(step.change.path.clone()));
        }
        let stage = self.workspace.internal("state/stage")?;
        for name in [step.stage.clone(), format!("{}.restore", step.stage)] {
            if let Ok(alias) = stage.symlink_metadata(&name)
                && alias.is_file()
                && (alias.dev(), alias.ino()) == (meta.dev(), meta.ino())
            {
                control.check()?;
                stage.remove_file(&name)?;
                sync_dir(&stage)?;
                return Ok(());
            }
        }
        Err(Error::UnsafePath(
            "unrecognized hard link during recovery".into(),
        ))
    }
}
fn validate_names(step: &Step) -> Result<()> {
    if step.mode.is_some_and(|mode| mode > 0o777) {
        return Err(Error::Integrity("unsafe journal permissions".into()));
    }
    for name in [&step.stage, &step.quarantine] {
        if !crate::portable_path(name) || name.contains('/') || !name.starts_with("apply-") {
            return Err(Error::Integrity("unsafe journal staging name".into()));
        }
    }
    Ok(())
}
