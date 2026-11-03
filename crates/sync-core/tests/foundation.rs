#![cfg(unix)]
use attuner_sync_core::*;
use std::{fs, path::PathBuf, sync::Arc};
struct Lab(PathBuf);
impl Lab {
    fn new(version: u32) -> (Self, Engine) {
        let engine = Engine::create_fixture(version, &Control::fixture()).unwrap();
        (Self(engine.path().to_owned()), engine)
    }
}
impl Drop for Lab {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn discovers_versioned_nonretail_layouts_and_scans_original_bytes() {
    for version in [1, 2] {
        let (_lab, mut e) = Lab::new(version);
        let scan = e.scan(&Control::fixture()).unwrap();
        assert_eq!(scan.files, 3);
        assert_eq!(scan.coverage().adapter_version, version);
        assert_eq!(
            scan.manifest().files,
            e.scan(&Control::fixture()).unwrap().manifest().files
        );
        assert_eq!(e.changes(&scan, &Control::fixture()).unwrap().len(), 3);
    }
}
#[test]
fn snapshots_persist_and_verified_zstandard_preserves_crlf() {
    let (lab, mut e) = Lab::new(1);
    let c = Control::fixture();
    let scan = e.scan(&c).unwrap();
    let s = e.capture_snapshot(&scan, "Initial fixture", &c).unwrap();
    assert!(e.verify_snapshot(s.id, &c).unwrap().verified);
    assert!(e.changes(&scan, &c).unwrap().is_empty());
    drop(e);
    let e = Engine::reopen(&lab.0, &c).unwrap();
    assert_eq!(e.snapshots(&c).unwrap().len(), 1);
    assert_eq!(e.baseline(&c).unwrap().unwrap().id, s.id);
    assert!(e.verify_snapshot(s.id, &c).unwrap().verified);
}
#[test]
fn running_uncertain_and_cancelled_fail_closed() {
    let (_lab, mut e) = Lab::new(1);
    for state in [GameState::Running, GameState::Unknown] {
        let c = Control::fixture();
        c.runtime.set(state);
        assert!(matches!(e.scan(&c), Err(Error::GameState)));
    }
    let c = Control::fixture();
    c.cancellation.cancel();
    assert!(matches!(e.scan(&c), Err(Error::Cancelled)));
}
#[test]
fn missing_root_cannot_become_deletions() {
    let (lab, mut e) = Lab::new(1);
    let c = Control::fixture();
    let s = e.scan(&c).unwrap();
    e.capture_snapshot(&s, "Baseline", &c).unwrap();
    fs::rename(
        lab.0.join("installation/ProfileData"),
        lab.0.join("installation/missing"),
    )
    .unwrap();
    assert!(e.scan(&c).is_err());
    assert_eq!(e.snapshots(&c).unwrap().len(), 1);
}
#[cfg(unix)]
#[test]
fn rejects_links_and_unsafe_unicode() {
    let (lab, mut e) = Lab::new(1);
    let c = Control::fixture();
    let path = lab.0.join("installation/ProfileData/link");
    std::os::unix::fs::symlink("/does-not-exist", &path).unwrap();
    assert!(e.scan(&c).is_err());
    fs::remove_file(&path).unwrap();
    fs::write(lab.0.join("installation/ProfileData/Cafe\u{301}.lua"), b"x").unwrap();
    assert!(matches!(e.scan(&c), Err(Error::UnsafePath(_))));
}
#[test]
fn detects_change_during_scan_even_if_size_and_mtime_restored() {
    let (lab, mut e) = Lab::new(1);
    let path = lab
        .0
        .join("installation/ProfileData/SavedVariables/bindings.txt");
    let time = fs::metadata(&path).unwrap().modified().unwrap();
    let c = Control::fixture().with_observer(move |event| {
        if event.point == Point::ScanValidated {
            let old = fs::read(&path)?;
            fs::write(&path, vec![b'x'; old.len()])?;
            fs::File::open(&path)?.set_modified(time)?;
        }
        Ok(())
    });
    assert!(matches!(e.scan(&c), Err(Error::Incomplete(_))));
}
#[test]
fn backup_corruption_is_detected_without_changing_fixture() {
    let (lab, mut e) = Lab::new(1);
    let c = Control::fixture();
    let scan = e.scan(&c).unwrap();
    let s = e.capture_snapshot(&scan, "Backup", &c).unwrap();
    let entry = &s.manifest().files[0];
    fs::write(
        lab.0.join(format!("state/objects/{}.zst", entry.hash)),
        b"corrupt",
    )
    .unwrap();
    assert!(matches!(
        e.verify_snapshot(s.id, &c),
        Err(Error::Integrity(_))
    ));
    assert_eq!(e.scan(&c).unwrap().manifest(), scan.manifest());
}
#[test]
fn three_way_preserves_modification_deletion_conflicts() {
    let (lab, mut e) = Lab::new(1);
    let c = Control::fixture();
    let base = e.scan(&c).unwrap();
    let mut remote = base.manifest().clone();
    let entry = remote
        .files
        .iter_mut()
        .find(|f| f.path.ends_with("bindings.txt"))
        .unwrap();
    entry.hash = "a".repeat(64);
    let p = lab
        .0
        .join("installation/ProfileData/SavedVariables/bindings.txt");
    fs::remove_file(p).unwrap();
    let local = e.scan(&c).unwrap();
    let merged = compare::three_way(base.manifest(), &local, &remote).unwrap();
    assert!(merged.merged.is_none());
    assert_eq!(merged.conflicts.len(), 1);
    assert!(merged.conflicts[0].change.after.is_none());
    assert!(merged.conflicts[0].remote.is_some());
}
#[cfg(unix)]
#[test]
fn rejects_hard_links_and_directory_symlink_escape() {
    let (lab, mut e) = Lab::new(1);
    let external = tempfile::tempdir().unwrap();
    fs::write(
        external.path().join("sentinel"),
        b"outside synthetic sentinel",
    )
    .unwrap();
    let p = lab.0.join("installation/ProfileData/alias");
    fs::hard_link(external.path().join("sentinel"), &p).unwrap();
    assert!(e.scan(&Control::fixture()).is_err());
    fs::remove_file(&p).unwrap();
    std::os::unix::fs::symlink(external.path(), &p).unwrap();
    assert!(e.scan(&Control::fixture()).is_err());
    assert_eq!(
        fs::read(external.path().join("sentinel")).unwrap(),
        b"outside synthetic sentinel"
    );
}
#[cfg(unix)]
#[test]
fn unsupported_fifo_is_rejected() {
    let (lab, mut e) = Lab::new(1);
    assert!(
        std::process::Command::new("mkfifo")
            .arg(lab.0.join("installation/ProfileData/pipe"))
            .status()
            .unwrap()
            .success()
    );
    assert!(matches!(
        e.scan(&Control::fixture()),
        Err(Error::UnsafePath(_))
    ));
}
#[test]
fn unknown_adapter_and_resource_limits_fail_closed() {
    let (lab, mut e) = Lab::new(1);
    e.limits.max_file_bytes = 1;
    assert!(matches!(e.scan(&Control::fixture()), Err(Error::Limit(_))));
    fs::write(
        lab.0.join("installation/fixture-installation.json"),
        br#"{"kind":"attuner-synthetic","version":99}"#,
    )
    .unwrap();
    let result = e.scan(&Control::fixture());
    assert!(matches!(result, Err(Error::Adapter)), "{result:?}");
}
#[test]
fn foreign_workspace_receipts_cannot_capture_or_apply() {
    let (_lab, mut e) = Lab::new(1);
    let (_other, mut other) = Lab::new(1);
    let scan = other.scan(&Control::fixture()).unwrap();
    assert!(matches!(
        e.capture_snapshot(&scan, "Foreign", &Control::fixture()),
        Err(Error::Coverage)
    ));
}
#[test]
fn parallel_engine_handles_are_serialized() {
    let (lab, mut e) = Lab::new(1);
    let another = Engine::reopen(&lab.0, &Control::fixture()).unwrap();
    let locked = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = locked.clone();
    let another = std::sync::Mutex::new(another);
    let control = Control::fixture().with_observer(move |event| {
        if event.point == Point::Discover
            && !observed.swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            assert!(matches!(
                another.lock().unwrap().scan(&Control::fixture()),
                Err(Error::Busy)
            ));
        }
        Ok(())
    });
    e.scan(&control).unwrap();
    assert!(locked.load(std::sync::atomic::Ordering::SeqCst));
}
#[test]
fn truncated_backups_and_zero_length_files_are_verified() {
    let (lab, mut e) = Lab::new(1);
    fs::write(lab.0.join("installation/ProfileData/empty.bin"), b"").unwrap();
    let c = Control::fixture();
    let scan = e.scan(&c).unwrap();
    let snapshot = e.capture_snapshot(&scan, "Zero length", &c).unwrap();
    e.verify_snapshot(snapshot.id, &c).unwrap();
    let entry = &snapshot.manifest().files[0];
    let path = lab.0.join(format!("state/objects/{}.zst", entry.hash));
    let mut compressed = fs::read(&path).unwrap();
    compressed.pop();
    fs::write(path, compressed).unwrap();
    assert!(matches!(
        e.verify_snapshot(snapshot.id, &c),
        Err(Error::Integrity(_))
    ));
}
#[test]
fn sqlite_snapshots_are_immutable() {
    let (lab, mut e) = Lab::new(1);
    let c = Control::fixture();
    let scan = e.scan(&c).unwrap();
    let snap = e.capture_snapshot(&scan, "Immutable", &c).unwrap();
    let connection = rusqlite::Connection::open(lab.0.join("state/local.sqlite")).unwrap();
    assert!(
        connection
            .execute(
                "UPDATE snapshots SET label='Changed' WHERE id=?1",
                [snap.id]
            )
            .is_err()
    );
    assert!(
        connection
            .execute("DELETE FROM snapshots WHERE id=?1", [snap.id])
            .is_err()
    );
    assert_eq!(e.snapshots(&c).unwrap()[0].label, "Immutable");
}
#[test]
fn additions_during_the_verification_hash_pass_are_incomplete() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (lab, mut e) = Lab::new(1);
    let chunks = Arc::new(AtomicUsize::new(0));
    let path = lab.0.join("installation/ProfileData/late.lua");
    let c = Control::fixture().with_observer(move |event| {
        if event.point == Point::HashChunk
            && event.path.ends_with("WeakAuras.lua")
            && chunks.fetch_add(1, Ordering::SeqCst) == 1
        {
            fs::write(&path, b"late synthetic addition")?;
        }
        Ok(())
    });
    assert!(matches!(e.scan(&c), Err(Error::Incomplete(_))));
    let complete = e.scan(&Control::fixture()).unwrap();
    assert_eq!(complete.files, 4);
}
