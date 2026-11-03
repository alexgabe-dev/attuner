#![cfg(unix)]
use attuner_sync_core::*;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
struct Lab(PathBuf);
impl Drop for Lab {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn setup() -> (Lab, Engine, CompleteScan, Snapshot, Manifest) {
    let c = Control::fixture();
    let mut e = Engine::create_fixture(1, &c).unwrap();
    let lab = Lab(e.path().to_owned());
    let base = e.scan(&c).unwrap();
    let first = e.capture_snapshot(&base, "Before", &c).unwrap();
    let saved = lab.0.join("installation/ProfileData/SavedVariables");
    let old = fs::read(saved.join("WeakAuras.lua")).unwrap();
    let bindings = fs::read(saved.join("bindings.txt")).unwrap();
    fs::write(
        saved.join("WeakAuras.lua"),
        b"-- exact binary fixture\r\n\0\xffchanged\r\n",
    )
    .unwrap();
    fs::remove_file(saved.join("bindings.txt")).unwrap();
    fs::write(
        lab.0.join("installation/ProfileData/extras.lua"),
        b"new fixture\n",
    )
    .unwrap();
    let desired = e.scan(&c).unwrap();
    let target = e.capture_snapshot(&desired, "Desired", &c).unwrap();
    fs::write(saved.join("WeakAuras.lua"), old).unwrap();
    fs::write(saved.join("bindings.txt"), bindings).unwrap();
    fs::remove_file(lab.0.join("installation/ProfileData/extras.lua")).unwrap();
    let expected = e.scan(&c).unwrap();
    assert_eq!(expected.manifest(), first.manifest());
    (lab, e, expected, target, first.manifest().clone())
}
fn interrupted(
    e: &mut Engine,
    target: i64,
    expected: &CompleteScan,
    point: Point,
    index: usize,
) -> i64 {
    let once = Arc::new(AtomicBool::new(false));
    let c = Control::fixture().with_observer(move |event| {
        if event.point == point && event.index == index && !once.swap(true, Ordering::SeqCst) {
            return Err(Error::Io(std::io::Error::other(
                "deterministic interruption",
            )));
        }
        Ok(())
    });
    match e.apply_snapshot(target, expected, &c) {
        Err(Error::RecoveryRequired { operation, .. }) => operation,
        other => panic!("Expected recovery at {point:?}/{index}: {other:?}"),
    }
}
#[test]
fn applies_add_modify_delete_preserving_bytes_and_creates_new_restore_point() {
    let (lab, mut e, expected, target, _) = setup();
    let c = Control::fixture();
    let operation = e.apply_snapshot(target.id, &expected, &c).unwrap();
    assert_eq!(e.scan(&c).unwrap().manifest(), target.manifest());
    let baseline = e.baseline(&c).unwrap().unwrap();
    assert_eq!(baseline.manifest(), target.manifest());
    assert!(baseline.id > target.id);
    assert!(
        !lab.0
            .join("installation/ProfileData/SavedVariables/bindings.txt")
            .exists()
    );
    assert_eq!(
        fs::read(
            lab.0
                .join("installation/ProfileData/SavedVariables/WeakAuras.lua")
        )
        .unwrap(),
        b"-- exact binary fixture\r\n\0\xffchanged\r\n"
    );
    e.recover(operation, &c).unwrap();
    assert_eq!(e.scan(&c).unwrap().manifest(), target.manifest());
}
#[test]
fn recovers_every_step_and_journal_boundary_and_is_idempotent() {
    for (point, index) in [
        (Point::Prepared, 0),
        (Point::Intent, 0),
        (Point::Evacuated, 0),
        (Point::Installed, 0),
        (Point::StepDurable, 0),
        (Point::Intent, 1),
        (Point::Evacuated, 1),
        (Point::Installed, 1),
        (Point::StepDurable, 1),
        (Point::Intent, 2),
        (Point::Evacuated, 2),
        (Point::Installed, 2),
        (Point::StepDurable, 2),
        (Point::BeforeVerification, 3),
        (Point::BeforeCommit, 3),
    ] {
        let (lab, mut e, expected, target, before) = setup();
        let id = interrupted(&mut e, target.id, &expected, point, index);
        assert!(matches!(
            e.scan(&Control::fixture()),
            Err(Error::PendingRecovery)
        ));
        drop(e);
        let mut e = Engine::reopen(&lab.0, &Control::fixture()).unwrap();
        e.recover(id, &Control::fixture())
            .unwrap_or_else(|err| panic!("{point:?}/{index}: {err}"));
        e.recover(id, &Control::fixture()).unwrap();
        assert_eq!(e.scan(&Control::fixture()).unwrap().manifest(), &before);
        assert_eq!(
            e.baseline(&Control::fixture()).unwrap().unwrap().manifest(),
            &before
        );
    }
}
#[test]
fn refuses_stale_scan_before_any_mutation() {
    let (lab, mut e, expected, target, _) = setup();
    let path = lab
        .0
        .join("installation/ProfileData/SavedVariables/WeakAuras.lua");
    fs::write(&path, b"independent edit").unwrap();
    assert!(matches!(
        e.apply_snapshot(target.id, &expected, &Control::fixture()),
        Err(Error::Concurrent(_))
    ));
    assert_eq!(fs::read(path).unwrap(), b"independent edit");
    assert!(e.operations(&Control::fixture()).unwrap().is_empty());
}
#[test]
fn recovery_preserves_external_edits_and_does_not_partially_roll_back() {
    let (lab, mut e, expected, target, _) = setup();
    let id = interrupted(&mut e, target.id, &expected, Point::StepDurable, 2);
    let path = lab.0.join("installation/ProfileData/extras.lua");
    fs::write(&path, b"independent edit").unwrap();
    let modified = fs::read(
        lab.0
            .join("installation/ProfileData/SavedVariables/WeakAuras.lua"),
    )
    .unwrap();
    assert!(matches!(
        e.recover(id, &Control::fixture()),
        Err(Error::Concurrent(_))
    ));
    assert_eq!(fs::read(path).unwrap(), b"independent edit");
    assert_eq!(
        fs::read(
            lab.0
                .join("installation/ProfileData/SavedVariables/WeakAuras.lua")
        )
        .unwrap(),
        modified
    );
}
#[test]
fn verified_preimages_are_required_for_recovery() {
    let (lab, mut e, expected, target, before) = setup();
    let id = interrupted(&mut e, target.id, &expected, Point::StepDurable, 0);
    let entry = before
        .files
        .iter()
        .find(|f| f.path.ends_with("WeakAuras.lua"))
        .unwrap();
    fs::write(
        lab.0.join(format!("state/objects/{}.zst", entry.hash)),
        b"broken",
    )
    .unwrap();
    assert!(matches!(
        e.recover(id, &Control::fixture()),
        Err(Error::Integrity(_))
    ));
    assert!(
        !fs::read(
            lab.0
                .join("installation/ProfileData/SavedVariables/WeakAuras.lua")
        )
        .unwrap()
        .is_empty()
    );
}
#[test]
fn insufficient_space_and_cancellation_before_apply_do_not_mutate() {
    for cancel in [false, true] {
        let (_lab, mut e, expected, target, before) = setup();
        let mut c = Control::fixture();
        if cancel {
            c.cancellation.cancel();
        } else {
            c.disk_budget = Some(0);
        }
        assert!(e.apply_snapshot(target.id, &expected, &c).is_err());
        assert_eq!(e.scan(&Control::fixture()).unwrap().manifest(), &before);
        assert!(e.operations(&Control::fixture()).unwrap().is_empty());
    }
}
#[test]
fn partial_staging_write_has_no_managed_effect() {
    let (_lab, mut e, expected, target, before) = setup();
    let c = Control::fixture().with_observer(|event| {
        if event.point == Point::StageChunk {
            Err(Error::Io(std::io::Error::from(
                std::io::ErrorKind::StorageFull,
            )))
        } else {
            Ok(())
        }
    });
    assert!(e.apply_snapshot(target.id, &expected, &c).is_err());
    assert_eq!(e.scan(&Control::fixture()).unwrap().manifest(), &before);
    assert!(e.operations(&Control::fixture()).unwrap().is_empty());
}
#[test]
fn partial_recovery_staging_can_be_retried_after_reopen() {
    let (lab, mut e, expected, target, before) = setup();
    let id = interrupted(&mut e, target.id, &expected, Point::BeforeVerification, 3);
    let c = Control::fixture().with_observer(|event| {
        if event.point == Point::StageChunk {
            Err(Error::Io(std::io::Error::from(
                std::io::ErrorKind::StorageFull,
            )))
        } else {
            Ok(())
        }
    });
    assert!(e.recover(id, &c).is_err());
    drop(e);
    let mut e = Engine::reopen(&lab.0, &Control::fixture()).unwrap();
    e.recover(id, &Control::fixture()).unwrap();
    assert_eq!(e.scan(&Control::fixture()).unwrap().manifest(), &before);
}
#[test]
fn final_verification_failure_requires_recovery_and_preserves_unrelated_addition() {
    let (lab, mut e, expected, target, before) = setup();
    let new = lab.0.join("installation/ProfileData/unrelated.txt");
    let p = new.clone();
    let c = Control::fixture().with_observer(move |event| {
        if event.point == Point::BeforeVerification {
            fs::write(&p, b"independent addition")?;
        }
        Ok(())
    });
    let id = match e.apply_snapshot(target.id, &expected, &c) {
        Err(Error::RecoveryRequired { operation, .. }) => operation,
        other => panic!("{other:?}"),
    };
    e.recover(id, &Control::fixture()).unwrap();
    assert_eq!(fs::read(new).unwrap(), b"independent addition");
    assert_eq!(
        e.baseline(&Control::fixture()).unwrap().unwrap().manifest(),
        &before
    );
}
#[test]
fn cancellation_after_first_step_requires_explicit_recovery() {
    let (_lab, mut e, expected, target, before) = setup();
    let token = Cancellation::default();
    let t = token.clone();
    let mut c = Control::fixture().with_observer(move |event| {
        if event.point == Point::StepDurable {
            t.cancel();
        }
        Ok(())
    });
    c.cancellation = token;
    let id = match e.apply_snapshot(target.id, &expected, &c) {
        Err(Error::RecoveryRequired { operation, .. }) => operation,
        other => panic!("{other:?}"),
    };
    assert!(matches!(e.recover(id, &c), Err(Error::Cancelled)));
    e.recover(id, &Control::fixture()).unwrap();
    assert_eq!(e.scan(&Control::fixture()).unwrap().manifest(), &before);
}
#[test]
fn game_state_change_blocks_apply_and_recovery() {
    let (_lab, mut e, expected, target, before) = setup();
    let runtime = FixtureRuntime::closed();
    let state = runtime.clone();
    let mut c = Control::fixture().with_observer(move |event| {
        if event.point == Point::Intent {
            state.set(GameState::Running);
        }
        Ok(())
    });
    c.runtime = runtime;
    let id = match e.apply_snapshot(target.id, &expected, &c) {
        Err(Error::RecoveryRequired { operation, .. }) => operation,
        other => panic!("{other:?}"),
    };
    assert!(matches!(e.recover(id, &c), Err(Error::GameState)));
    e.recover(id, &Control::fixture()).unwrap();
    assert_eq!(e.scan(&Control::fixture()).unwrap().manifest(), &before);
}
#[test]
fn recovery_can_itself_be_interrupted_and_resumed() {
    for point in [
        Point::RecoveryIntent,
        Point::RecoveryEvacuated,
        Point::RecoveryInstalled,
    ] {
        let (lab, mut e, expected, target, before) = setup();
        let id = interrupted(&mut e, target.id, &expected, Point::BeforeVerification, 3);
        let c = Control::fixture().with_observer(move |ev| {
            if ev.point == point {
                Err(Error::Cancelled)
            } else {
                Ok(())
            }
        });
        assert!(e.recover(id, &c).is_err());
        drop(e);
        let mut e = Engine::reopen(&lab.0, &Control::fixture()).unwrap();
        e.recover(id, &Control::fixture()).unwrap();
        assert_eq!(e.scan(&Control::fixture()).unwrap().manifest(), &before);
    }
}
#[test]
fn concurrent_creation_at_install_is_not_overwritten() {
    let (lab, mut e, expected, target, _) = setup();
    let path = lab
        .0
        .join("installation/ProfileData/SavedVariables/WeakAuras.lua");
    let p = path.clone();
    let c = Control::fixture().with_observer(move |event| {
        if event.point == Point::Evacuated && event.index == 0 {
            fs::write(&p, b"racing creation")?;
        }
        Ok(())
    });
    let id = match e.apply_snapshot(target.id, &expected, &c) {
        Err(Error::RecoveryRequired { operation, .. }) => operation,
        other => panic!("{other:?}"),
    };
    assert_eq!(fs::read(&path).unwrap(), b"racing creation");
    assert!(matches!(
        e.recover(id, &Control::fixture()),
        Err(Error::Concurrent(_))
    ));
    assert_eq!(fs::read(path).unwrap(), b"racing creation");
}
#[test]
#[ignore = "subprocess crash harness; invoked by process_crash_boundary_matrix"]
fn crash_child() {
    let path = std::env::var("ATTUNER_CRASH_WORKSPACE").unwrap();
    let point = std::env::var("ATTUNER_CRASH_POINT").unwrap();
    let mut e = Engine::reopen(std::path::Path::new(&path), &Control::fixture()).unwrap();
    let expected = e.scan(&Control::fixture()).unwrap();
    let c = Control::fixture().with_observer(move |event| {
        if format!("{:?}", event.point) == point {
            std::process::exit(73);
        }
        Ok(())
    });
    e.apply_snapshot(2, &expected, &c).unwrap();
    panic!("crash hook not reached");
}
#[test]
fn process_crash_boundary_matrix() {
    for point in [
        "Prepared",
        "Intent",
        "Evacuated",
        "Installed",
        "StepDurable",
        "BeforeCommit",
        "Committed",
    ] {
        let (lab, e, _expected, target, before) = setup();
        drop(e);
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "crash_child", "--nocapture"])
            .env("ATTUNER_CRASH_WORKSPACE", &lab.0)
            .env("ATTUNER_CRASH_POINT", point)
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(73),
            "{point}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut reopened = Engine::reopen(&lab.0, &Control::fixture()).unwrap();
        let op = reopened.operations(&Control::fixture()).unwrap()[0].clone();
        if point == "Committed" {
            assert_eq!(op.state, "committed");
            assert_eq!(
                reopened.scan(&Control::fixture()).unwrap().manifest(),
                target.manifest()
            );
        } else {
            reopened.recover(op.id, &Control::fixture()).unwrap();
            assert_eq!(
                reopened.scan(&Control::fixture()).unwrap().manifest(),
                &before
            );
        }
    }
}
#[test]
#[ignore = "SIGKILL child harness; invoked by hard_kill_tests"]
fn kill_child() {
    use std::io::Write;
    let path = std::env::var("ATTUNER_CRASH_WORKSPACE").unwrap();
    let recovery = std::env::var("ATTUNER_KILL_RECOVERY").is_ok();
    let staging = std::env::var("ATTUNER_KILL_STAGING").is_ok();
    let mut e = Engine::reopen(std::path::Path::new(&path), &Control::fixture()).unwrap();
    let c = Control::fixture().with_observer(move |ev| {
        if ev.point
            == if staging {
                Point::StageChunk
            } else if recovery {
                Point::RecoveryEvacuated
            } else {
                Point::Installed
            }
        {
            println!("AT_KILL_BOUNDARY");
            std::io::stdout().flush().unwrap();
            loop {
                std::thread::park();
            }
        }
        Ok(())
    });
    if recovery {
        e.recover(1, &c).unwrap();
    } else {
        let scan = e.scan(&Control::fixture()).unwrap();
        e.apply_snapshot(2, &scan, &c).unwrap();
    }
    panic!("boundary missing");
}
#[test]
fn hard_kill_tests() {
    use std::io::{BufRead, BufReader};
    for (recovery, staging) in [(false, false), (true, false), (true, true)] {
        let (lab, mut engine, expected, target, before) = setup();
        if recovery {
            interrupted(
                &mut engine,
                target.id,
                &expected,
                Point::BeforeVerification,
                3,
            );
        }
        drop(engine);
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--ignored", "--exact", "kill_child", "--nocapture"])
            .env("ATTUNER_CRASH_WORKSPACE", &lab.0)
            .stdout(std::process::Stdio::piped());
        if recovery {
            command.env("ATTUNER_KILL_RECOVERY", "1");
        }
        if staging {
            command.env("ATTUNER_KILL_STAGING", "1");
        }
        let mut child = command.spawn().unwrap();
        let output = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                if line.unwrap_or_default().contains("AT_KILL_BOUNDARY") {
                    let _ = tx.send(());
                    break;
                }
            }
        });
        let ready = rx.recv_timeout(std::time::Duration::from_secs(15));
        child.kill().unwrap();
        let status = child.wait().unwrap();
        assert!(ready.is_ok(), "child did not reach durable boundary");
        assert!(!status.success());
        let mut reopened = Engine::reopen(&lab.0, &Control::fixture()).unwrap();
        reopened.recover(1, &Control::fixture()).unwrap();
        assert_eq!(
            reopened.scan(&Control::fixture()).unwrap().manifest(),
            &before
        );
    }
}
