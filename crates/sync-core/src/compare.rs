use crate::{CompleteScan, Coverage, Error, Manifest, ManifestFile, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub root: String,
    pub path: String,
    pub before: Option<ManifestFile>,
    pub after: Option<ManifestFile>,
}
impl Change {
    pub fn kind(&self) -> &'static str {
        if self.before.is_none() {
            "added"
        } else if self.after.is_none() {
            "deleted"
        } else {
            "modified"
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub change: Change,
    pub remote: Option<ManifestFile>,
    pub reason: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Merge {
    pub merged: Option<Manifest>,
    pub conflicts: Vec<Conflict>,
}
fn files(m: &Manifest) -> BTreeMap<(String, String), ManifestFile> {
    m.files
        .iter()
        .map(|f| ((f.root.clone(), f.path.clone()), f.clone()))
        .collect()
}
fn equal(a: Option<&ManifestFile>, b: Option<&ManifestFile>) -> bool {
    a.map(|f| (&f.hash, f.size)) == b.map(|f| (&f.hash, f.size))
}
pub(crate) fn compatible(a: &Manifest, b: &Manifest, coverage: &Coverage) -> Result<()> {
    for m in [a, b] {
        m.validate().map_err(|e| Error::UnsafePath(e.into()))?;
        let mut seen = BTreeMap::new();
        for f in &m.files {
            if !coverage.roots.contains(&f.root) {
                return Err(Error::Coverage);
            }
            let parts: Vec<_> = f.path.split('/').collect();
            for index in 1..=parts.len() {
                let spelling = format!("{}/{}", f.root, parts[..index].join("/"));
                let is_file = index == parts.len();
                let key = crate::scan::collision_key(&spelling);
                if let Some((original, was_file)) = seen.get(&key) {
                    if original != &spelling || *was_file || is_file {
                        return Err(Error::UnsafePath(f.path.clone()));
                    }
                } else {
                    seen.insert(key, (spelling, is_file));
                }
            }
        }
    }
    if a.profile_id != b.profile_id || a.policy_version != b.policy_version {
        return Err(Error::Coverage);
    }
    Ok(())
}
pub(crate) fn changes(a: &Manifest, b: &Manifest, coverage: &Coverage) -> Result<Vec<Change>> {
    compatible(a, b, coverage)?;
    let left = files(a);
    let right = files(b);
    let keys: BTreeSet<_> = left.keys().chain(right.keys()).cloned().collect();
    Ok(keys
        .into_iter()
        .filter_map(|(root, path)| {
            let key = (root.clone(), path.clone());
            let before = left.get(&key);
            let after = right.get(&key);
            if equal(before, after) {
                None
            } else {
                Some(Change {
                    root,
                    path,
                    before: before.cloned(),
                    after: after.cloned(),
                })
            }
        })
        .collect())
}
/// Coverage must originate in a successful scan; callers cannot construct partial scan receipts.
pub fn detect_changes(baseline: &Manifest, local: &CompleteScan) -> Result<Vec<Change>> {
    changes(baseline, &local.manifest, &local.coverage)
}
pub fn three_way(baseline: &Manifest, local: &CompleteScan, remote: &Manifest) -> Result<Merge> {
    compatible(baseline, &local.manifest, &local.coverage)?;
    compatible(baseline, remote, &local.coverage)?;
    let b = files(baseline);
    let l = files(&local.manifest);
    let r = files(remote);
    let keys: BTreeSet<_> = b.keys().chain(l.keys()).chain(r.keys()).cloned().collect();
    let local_changes = changes(baseline, &local.manifest, &local.coverage)?;
    let remote_changes = changes(baseline, remote, &local.coverage)?;
    let groups = |c: &[Change]| -> BTreeSet<String> {
        c.iter()
            .flat_map(|v| v.before.iter().chain(v.after.iter()))
            .filter(|f| f.root == "addons")
            .map(|f| f.group.clone())
            .collect()
    };
    let lg = groups(&local_changes);
    let rg = groups(&remote_changes);
    let contested: BTreeSet<_> = lg.intersection(&rg).cloned().collect();
    let mut merged = Vec::new();
    let mut conflicts = Vec::new();
    for (root, path) in keys {
        let key = (root.clone(), path.clone());
        let before = b.get(&key);
        let left = l.get(&key);
        let right = r.get(&key);
        let grouped = before
            .into_iter()
            .chain(left)
            .chain(right)
            .any(|f| contested.contains(&f.group))
            && !equal(left, right);
        let result = if equal(left, right) {
            left
        } else if grouped {
            None
        } else if equal(before, left) {
            right
        } else if equal(before, right) {
            left
        } else {
            None
        };
        if grouped || (!equal(left, right) && !equal(before, left) && !equal(before, right)) {
            conflicts.push(Conflict {
                change: Change {
                    root,
                    path,
                    before: before.cloned(),
                    after: left.cloned(),
                },
                remote: right.cloned(),
                reason: if grouped {
                    "Competing addon consistency group"
                } else {
                    "Competing modification or deletion"
                }
                .into(),
            });
        } else if let Some(f) = result {
            merged.push(f.clone());
        }
    }
    let merged = if conflicts.is_empty() {
        let mut m = baseline.clone();
        m.files = merged;
        compatible(&m, &m, &local.coverage)?;
        Some(m)
    } else {
        None
    };
    Ok(Merge { merged, conflicts })
}
/// Explicit byte-variant choices only. Addon consistency groups require one choice
/// across all contested members; no Lua is parsed or merged.
pub fn resolve_three_way(
    baseline: &Manifest,
    local: &CompleteScan,
    remote: &Manifest,
    decisions: &[crate::synchronization::Decision],
) -> Result<Manifest> {
    use crate::synchronization::Choice;
    let merge = three_way(baseline, local, remote)?;
    if let Some(merged) = merge.merged {
        if !decisions.is_empty() {
            return Err(Error::Coverage);
        }
        return Ok(merged);
    }
    let conflicts: BTreeMap<_, _> = merge
        .conflicts
        .iter()
        .map(|c| ((c.change.root.clone(), c.change.path.clone()), c))
        .collect();
    let mut choices = BTreeMap::new();
    let mut groups = BTreeMap::new();
    if decisions.len() != conflicts.len() {
        return Err(Error::Coverage);
    }
    for decision in decisions {
        let key = (decision.root.clone(), decision.path.clone());
        let conflict = conflicts.get(&key).ok_or(Error::Coverage)?;
        if choices.insert(key, decision.choice).is_some() {
            return Err(Error::Coverage);
        }
        if decision.root == "addons" {
            let group = conflict
                .change
                .before
                .iter()
                .chain(conflict.change.after.iter())
                .chain(conflict.remote.iter())
                .next()
                .ok_or(Error::Coverage)?
                .group
                .clone();
            if groups
                .insert(group, decision.choice)
                .is_some_and(|old| old != decision.choice)
            {
                return Err(Error::Coverage);
            }
        }
    }
    let b = files(baseline);
    let l = files(&local.manifest);
    let r = files(remote);
    let keys: BTreeSet<_> = b.keys().chain(l.keys()).chain(r.keys()).cloned().collect();
    let mut merged = baseline.clone();
    merged.files.clear();
    for key in keys {
        let before = b.get(&key);
        let left = l.get(&key);
        let right = r.get(&key);
        let selected = if let Some(choice) = choices.get(&key) {
            match choice {
                Choice::Local => left,
                Choice::Remote => right,
            }
        } else if equal(left, right) {
            left
        } else if equal(before, left) {
            right
        } else if equal(before, right) {
            left
        } else {
            return Err(Error::Coverage);
        };
        if let Some(file) = selected {
            merged.files.push(file.clone());
        }
    }
    compatible(&merged, &merged, &local.coverage)?;
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn manifest(hash: Option<char>) -> Manifest {
        Manifest {
            protocol_version: 1,
            profile_id: crate::adapter::PROFILE_ID.into(),
            policy_version: 1,
            files: hash
                .map(|h| {
                    vec![ManifestFile {
                        root: "account".into(),
                        path: "a.lua".into(),
                        hash: h.to_string().repeat(64),
                        size: 1,
                        group: "config".into(),
                    }]
                })
                .unwrap_or_default(),
        }
    }
    fn receipt(manifest: Manifest) -> CompleteScan {
        CompleteScan {
            files: manifest.files.len(),
            bytes: manifest.files.len() as u64,
            manifest,
            coverage: Coverage {
                adapter_version: 1,
                roots: vec!["account".into()],
            },
            workspace: "synthetic-unit-receipt".into(),
        }
    }
    #[test]
    fn shared_management_comparison_fixtures_match_typescript() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/protocol/comparisons.json"))
                .unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let baseline: Manifest = serde_json::from_value(fixture["baseline"].clone()).unwrap();
            let local: Manifest = serde_json::from_value(fixture["local"].clone()).unwrap();
            let remote: Manifest = serde_json::from_value(fixture["remote"].clone()).unwrap();
            let mut receipt = receipt(local);
            receipt.coverage.roots = vec!["account".into(), "addons".into()];
            let comparison = three_way(&baseline, &receipt, &remote).unwrap();
            let paths: Vec<_> = comparison
                .conflicts
                .iter()
                .map(|c| format!("{}/{}", c.change.root, c.change.path))
                .collect();
            assert_eq!(
                serde_json::to_value(paths).unwrap(),
                fixture["conflictPaths"],
                "{}",
                fixture["name"]
            );
            assert_eq!(
                serde_json::to_value(comparison.merged).unwrap(),
                fixture["merged"],
                "{}",
                fixture["name"]
            );
        }
    }
    #[test]
    fn explicit_modification_deletion_choices_preserve_selected_variants() {
        use crate::synchronization::{Choice, Decision};
        let base = manifest(Some('a'));
        let local = receipt(manifest(Some('b')));
        let remote = manifest(None);
        assert!(resolve_three_way(&base, &local, &remote, &[]).is_err());
        let choice = |choice| {
            vec![Decision {
                root: "account".into(),
                path: "a.lua".into(),
                choice,
            }]
        };
        assert_eq!(
            resolve_three_way(&base, &local, &remote, &choice(Choice::Local)).unwrap(),
            local.manifest
        );
        assert_eq!(
            resolve_three_way(&base, &local, &remote, &choice(Choice::Remote)).unwrap(),
            remote
        );
        let mut duplicate = choice(Choice::Local);
        duplicate.push(duplicate[0].clone());
        assert!(resolve_three_way(&base, &local, &remote, &duplicate).is_err());
    }
    #[test]
    fn conflicting_addon_members_cannot_select_inconsistent_sides() {
        use crate::synchronization::{Choice, Decision};
        let mut base = manifest(Some('a'));
        base.files[0].root = "addons".into();
        base.files[0].path = "Demo/a.lua".into();
        let mut second = base.files[0].clone();
        second.path = "Demo/b.lua".into();
        base.files.push(second);
        let mut left = base.clone();
        left.files[0].hash = "b".repeat(64);
        let mut right = base.clone();
        right.files[1].hash = "c".repeat(64);
        let mut local = receipt(left);
        local.coverage.roots = vec!["addons".into()];
        let mut decisions = vec![
            Decision {
                root: "addons".into(),
                path: "Demo/a.lua".into(),
                choice: Choice::Local,
            },
            Decision {
                root: "addons".into(),
                path: "Demo/b.lua".into(),
                choice: Choice::Remote,
            },
        ];
        assert!(resolve_three_way(&base, &local, &right, &decisions).is_err());
        decisions[1].choice = Choice::Local;
        assert_eq!(
            resolve_three_way(&base, &local, &right, &decisions).unwrap(),
            local.manifest
        );
    }
    #[test]
    fn exhaustive_three_way_modification_deletion_matrix() {
        for left in [Some('a'), Some('b'), None] {
            for right in [Some('a'), Some('c'), None] {
                let result = three_way(
                    &manifest(Some('a')),
                    &receipt(manifest(left)),
                    &manifest(right),
                )
                .unwrap();
                let conflict = left != Some('a') && right != Some('a') && left != right;
                assert_eq!(!result.conflicts.is_empty(), conflict, "{left:?} {right:?}");
                if conflict {
                    assert!(result.merged.is_none());
                }
            }
        }
    }
    #[test]
    fn exhaustive_three_way_addition_matrix() {
        for left in [None, Some('b')] {
            for right in [None, Some('b'), Some('c')] {
                let result =
                    three_way(&manifest(None), &receipt(manifest(left)), &manifest(right)).unwrap();
                assert_eq!(
                    !result.conflicts.is_empty(),
                    left.is_some() && right.is_some() && left != right
                );
            }
        }
    }
    #[test]
    fn independent_changes_to_one_addon_group_require_review() {
        let mut base = manifest(Some('a'));
        base.files[0].root = "addons".into();
        base.files[0].path = "Demo/a.lua".into();
        let mut second = base.files[0].clone();
        second.path = "Demo/b.lua".into();
        base.files.push(second);
        let mut local = base.clone();
        local.files[0].hash = "b".repeat(64);
        let mut remote = base.clone();
        remote.files[1].hash = "c".repeat(64);
        let mut local = receipt(local);
        local.coverage.roots = vec!["addons".into()];
        let result = three_way(&base, &local, &remote).unwrap();
        assert!(result.merged.is_none());
        assert_eq!(result.conflicts.len(), 2);
    }
    #[test]
    fn remote_virtual_directories_cannot_have_unicode_aliases() {
        for paths in [["Ａ/one.lua", "A/two.lua"], ["Ａ/one.lua", "A"]] {
            let base = manifest(None);
            let mut remote = manifest(Some('a'));
            remote.files[0].path = paths[0].into();
            let mut other = remote.files[0].clone();
            other.path = paths[1].into();
            remote.files.push(other);
            assert!(matches!(
                three_way(&base, &receipt(base.clone()), &remote),
                Err(Error::UnsafePath(_))
            ));
        }
    }
}
