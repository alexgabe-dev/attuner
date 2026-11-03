#![cfg(unix)]
use attuner_sync_core::{Control, Engine, Point};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
#[test]
fn unchanged_capture_reuses_content_with_one_fresh_complete_scan_and_metadata_only_space_budget() {
    let c = Control::fixture();
    let mut engine = Engine::create_fixture(1, &c).unwrap();
    let scan = engine.scan(&c).unwrap();
    engine.capture_snapshot(&scan, "Cold CAS", &c).unwrap();
    let encoded = Arc::new(AtomicUsize::new(0));
    let scans = Arc::new(AtomicUsize::new(0));
    let reuse = Arc::new(AtomicUsize::new(0));
    let (e, s, r) = (encoded.clone(), scans.clone(), reuse.clone());
    let mut warm = c.clone().with_observer(move |event| {
        match event.point {
            Point::BackupEncode => {
                e.fetch_add(1, Ordering::SeqCst);
            }
            Point::ScanValidated => {
                s.fetch_add(1, Ordering::SeqCst);
            }
            Point::BackupReused => {
                r.fetch_add(1, Ordering::SeqCst);
            }
            _ => {}
        }
        Ok(())
    });
    warm.disk_budget = Some(engine.limits.disk_reserve + 512 * 1024);
    engine
        .capture_snapshot(&scan, "Unchanged warm CAS", &warm)
        .unwrap();
    assert_eq!(encoded.load(Ordering::SeqCst), 0);
    assert_eq!(scans.load(Ordering::SeqCst), 1);
    assert_eq!(reuse.load(Ordering::SeqCst), scan.files);
    let path = engine.path().to_owned();
    drop(engine);
    std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn a_creation_during_reuse_prevents_snapshot_publication_and_preserves_the_new_file() {
    let c = Control::fixture();
    let mut engine = Engine::create_fixture(1, &c).unwrap();
    let scan = engine.scan(&c).unwrap();
    engine
        .capture_snapshot(&scan, "Before external edit", &c)
        .unwrap();
    let before = engine.snapshots(&c).unwrap().len();
    let path = engine.path().to_owned();
    let added = path.join("installation/ProfileData/SavedVariables/new-during-capture.lua");
    let added_from_hook = added.clone();
    let count = Arc::new(AtomicUsize::new(0));
    let changed = c.clone().with_observer(move |event| {
        if event.point == Point::BackupReused && count.fetch_add(1, Ordering::SeqCst) == 0 {
            std::fs::write(&added_from_hook, b"inert external synthetic creation")?;
        }
        Ok(())
    });
    assert!(
        engine
            .capture_snapshot(&scan, "Must not publish stale capture", &changed)
            .is_err()
    );
    assert_eq!(engine.snapshots(&c).unwrap().len(), before);
    assert_eq!(
        std::fs::read(added).unwrap(),
        b"inert external synthetic creation"
    );
    drop(engine);
    std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn changed_content_reserves_space_and_recompresses_only_the_changed_object() {
    let c = Control::fixture();
    let mut engine = Engine::create_fixture(1, &c).unwrap();
    let scan = engine.scan(&c).unwrap();
    engine.capture_snapshot(&scan, "Original CAS", &c).unwrap();
    let path = engine.path().to_owned();
    std::fs::write(
        path.join("installation/ProfileData/SavedVariables/WeakAuras.lua"),
        vec![b'Z'; 2 * 1024 * 1024],
    )
    .unwrap();
    let changed = engine.scan(&c).unwrap();
    let before = engine.snapshots(&c).unwrap().len();
    let mut small = c.clone();
    small.disk_budget = Some(engine.limits.disk_reserve + 512 * 1024);
    assert!(
        engine
            .capture_snapshot(&changed, "Insufficient new-object space", &small)
            .is_err()
    );
    assert_eq!(engine.snapshots(&c).unwrap().len(), before);
    let count = Arc::new(AtomicUsize::new(0));
    let encoded = count.clone();
    let measured = c.clone().with_observer(move |event| {
        if event.point == Point::BackupEncode {
            encoded.fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    });
    engine
        .capture_snapshot(&changed, "One changed object", &measured)
        .unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    drop(engine);
    std::fs::remove_dir_all(path).unwrap();
}
