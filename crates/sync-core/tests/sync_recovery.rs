#![cfg(unix)]
use attuner_sync_core::{
    Control, Engine, ManifestFile, Point,
    synchronization::{Binding, JobData, JobState, ProfileHead, RemoteHead, SyncJob},
};
use std::{path::PathBuf, process::Command};
const PROFILE: &str = "22222222-2222-4222-8222-222222222222";
const JOB: &str = "44444444-4444-4444-8444-444444444444";
fn prepared() -> Engine {
    let c = Control::fixture();
    let mut engine = Engine::create_bound_fixture(1, PROFILE, &c).unwrap();
    let roots = vec!["account".into(), "addons".into()];
    engine
        .bind_remote(
            &Binding {
                server_id: "33333333-3333-4333-8333-333333333333".into(),
                origin: "https://synthetic.invalid".into(),
                profile_id: PROFILE.into(),
                policy_version: 1,
                roots: roots.clone(),
            },
            &c,
        )
        .unwrap();
    let scan = engine.scan(&c).unwrap();
    let local = engine
        .capture_snapshot(&scan, "Preimage before remote application", &c)
        .unwrap();
    let mut target = scan.manifest().clone();
    target
        .files
        .retain(|f| f.path != "SavedVariables/bindings.txt");
    let bytes = b"inert remote changed original bytes\r\n";
    let entry = target
        .files
        .iter_mut()
        .find(|f| f.path == "SavedVariables/WeakAuras.lua")
        .unwrap();
    entry.hash = blake3::hash(bytes).to_hex().to_string();
    entry.size = bytes.len() as u64;
    engine.import_blob(entry, bytes.as_slice(), &c).unwrap();
    let bytes = b"inert remote added original bytes\0";
    let entry = ManifestFile {
        root: "account".into(),
        path: "Incoming.lua".into(),
        hash: blake3::hash(bytes).to_hex().to_string(),
        size: bytes.len() as u64,
        group: format!("account:{}", &blake3::hash(b"Incoming.lua").to_hex()[..24]),
    };
    engine.import_blob(&entry, bytes.as_slice(), &c).unwrap();
    target.files.push(entry);
    let target = engine
        .record_verified_remote_snapshot(&target, "Verified remote test target", &c)
        .unwrap();
    let published = RemoteHead {
        snapshot_id: Some("66666666-6666-4666-8666-666666666666".into()),
        revision: 1,
        manifest_hash: Some(attuner_sync_core::remote::digest(target.manifest()).unwrap()),
    };
    let mut job = SyncJob {
        state: JobState::Capturing,
        generation: 0,
        data: JobData {
            id: JOB.into(),
            local_snapshot: Some(local.id),
            target_snapshot: Some(target.id),
            baseline_snapshot: None,
            baseline_head: None,
            remote: Some(ProfileHead {
                head: published.clone(),
                policy_version: 1,
                namespace_version: 1,
                roots,
            }),
            remote_manifest: Some(target.manifest().clone()),
            proposed: Some(target.manifest().clone()),
            request_id: "55555555-5555-4555-8555-555555555555".into(),
            session_id: None,
            approval_digest: None,
            published_head: None,
            decisions: vec![],
            reason: None,
            resume_state: None,
        },
    };
    engine.save_sync_job(&mut job, &c).unwrap();
    for state in [
        JobState::Fetching,
        JobState::Comparing,
        JobState::BootstrapReview,
        JobState::AwaitingApproval,
    ] {
        job.state = state;
        engine.save_sync_job(&mut job, &c).unwrap();
    }
    job.data.approval_digest = Some(engine.sync_review_digest(JOB, &c).unwrap());
    for state in [JobState::Transferring, JobState::Publishing] {
        job.state = state;
        engine.save_sync_job(&mut job, &c).unwrap();
    }
    engine.remember_publication(&published, &c).unwrap();
    job.data.published_head = Some(published);
    job.state = JobState::RemoteCommitted;
    engine.save_sync_job(&mut job, &c).unwrap();
    engine
}
#[test]
#[ignore = "child process harness invoked by sync_application_crash_matrix"]
fn sync_crash_child() {
    let path = PathBuf::from(std::env::var_os("ATTUNER_SYNC_CRASH_PATH").unwrap());
    let wanted = std::env::var("ATTUNER_SYNC_CRASH_POINT").unwrap();
    let mode = std::env::var("ATTUNER_SYNC_CRASH_MODE").unwrap();
    let c = Control::fixture().with_observer(move |event| {
        if format!("{:?}", event.point) == wanted {
            if mode == "kill" {
                unsafe { libc_kill_self() };
            }
            std::process::exit(88);
        }
        Ok(())
    });
    let mut engine = Engine::reopen(&path, &c).unwrap();
    let scan = engine.scan(&c).unwrap();
    engine.apply_sync_job(JOB, &scan, &c).unwrap();
    panic!("Crash point was not reached");
}
unsafe fn libc_kill_self() -> ! {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
        fn getpid() -> i32;
    }
    unsafe {
        assert_eq!(kill(getpid(), 9), 0);
    }
    loop {
        std::thread::park();
    }
}
#[test]
fn sync_application_crash_matrix() {
    for mode in ["exit", "kill"] {
        for point in [
            Point::Prepared,
            Point::Intent,
            Point::Evacuated,
            Point::Installed,
            Point::StepDurable,
            Point::BeforeVerification,
            Point::BeforeCommit,
            Point::Committed,
        ] {
            let c = Control::fixture();
            let engine = prepared();
            let local = engine
                .snapshot(
                    engine
                        .sync_job(JOB, &c)
                        .unwrap()
                        .data
                        .local_snapshot
                        .unwrap(),
                    &c,
                )
                .unwrap();
            let target = engine
                .snapshot(
                    engine
                        .sync_job(JOB, &c)
                        .unwrap()
                        .data
                        .target_snapshot
                        .unwrap(),
                    &c,
                )
                .unwrap();
            let path = engine.path().to_owned();
            drop(engine);
            let status = Command::new(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", "sync_crash_child"])
                .env("ATTUNER_SYNC_CRASH_PATH", &path)
                .env("ATTUNER_SYNC_CRASH_POINT", format!("{point:?}"))
                .env("ATTUNER_SYNC_CRASH_MODE", mode)
                .output()
                .unwrap()
                .status;
            if mode == "exit" {
                assert_eq!(status.code(), Some(88), "{point:?}");
            } else {
                use std::os::unix::process::ExitStatusExt;
                assert_eq!(status.signal(), Some(9), "{point:?} status={status:?}");
            }
            let mut engine = Engine::reopen(&path, &c).unwrap();
            if point == Point::Committed {
                let outbox = engine.pending_acknowledgements(&c).unwrap();
                assert_eq!(outbox.len(), 1);
                assert_eq!(
                    engine.remote_baseline(&c).unwrap().unwrap().head,
                    outbox[0].head
                );
                assert_eq!(
                    engine.sync_job(JOB, &c).unwrap().state,
                    JobState::AcknowledgementPending
                );
                assert_eq!(engine.scan(&c).unwrap().manifest(), target.manifest());
                engine.mark_acknowledged(JOB, &outbox[0].head, &c).unwrap();
                assert_eq!(engine.sync_job(JOB, &c).unwrap().state, JobState::Complete);
            } else {
                assert!(engine.remote_baseline(&c).unwrap().is_none());
                assert!(engine.pending_acknowledgements(&c).unwrap().is_empty());
                let operation = engine
                    .operations(&c)
                    .unwrap()
                    .into_iter()
                    .find(|o| o.state != "committed" && o.state != "rolledBack")
                    .unwrap();
                engine.recover(operation.id, &c).unwrap();
                assert_eq!(engine.scan(&c).unwrap().manifest(), local.manifest());
                assert!(engine.remote_baseline(&c).unwrap().is_none());
                assert!(engine.pending_acknowledgements(&c).unwrap().is_empty());
                assert_eq!(engine.sync_job(JOB, &c).unwrap().state, JobState::Failed);
            }
            drop(engine);
            std::fs::remove_dir_all(path).unwrap();
        }
    }
}
