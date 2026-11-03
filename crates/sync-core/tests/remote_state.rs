#![cfg(unix)]
use attuner_sync_core::{
    Control, Engine, Manifest,
    synchronization::{Binding, JobData, JobState, RemoteHead, SyncJob},
};
const PROFILE: &str = "22222222-2222-4222-8222-222222222222";
fn binding() -> Binding {
    Binding {
        server_id: "33333333-3333-4333-8333-333333333333".into(),
        origin: "https://synthetic.invalid".into(),
        profile_id: PROFILE.into(),
        policy_version: 1,
        roots: vec!["account".into(), "addons".into()],
    }
}
fn job() -> SyncJob {
    SyncJob {
        state: JobState::Capturing,
        generation: 0,
        data: JobData {
            id: "44444444-4444-4444-8444-444444444444".into(),
            local_snapshot: None,
            target_snapshot: None,
            baseline_snapshot: None,
            baseline_head: None,
            remote: None,
            remote_manifest: None,
            proposed: None,
            request_id: "55555555-5555-4555-8555-555555555555".into(),
            session_id: None,
            approval_digest: None,
            published_head: None,
            decisions: vec![],
            reason: None,
            resume_state: None,
        },
    }
}
#[test]
fn bound_synthetic_identity_is_persisted_without_rewriting_legacy_history() {
    let c = Control::fixture();
    let mut legacy = Engine::create_fixture(1, &c).unwrap();
    let old = legacy.scan(&c).unwrap();
    let snap = legacy
        .capture_snapshot(&old, "legacy untouched", &c)
        .unwrap();
    assert!(legacy.bind_remote(&binding(), &c).is_err());
    assert_eq!(
        legacy.snapshot(snap.id, &c).unwrap().manifest(),
        snap.manifest()
    );
    let legacy_path = legacy.path().to_owned();
    drop(legacy);
    let legacy = Engine::reopen(&legacy_path, &c).unwrap();
    assert_eq!(
        legacy.baseline(&c).unwrap().unwrap().manifest(),
        snap.manifest()
    );
    let mut bound = Engine::create_bound_fixture(2, PROFILE, &c).unwrap();
    bound.bind_remote(&binding(), &c).unwrap();
    assert_eq!(bound.scan(&c).unwrap().manifest().profile_id, PROFILE);
    let path = bound.path().to_owned();
    drop(bound);
    let mut reopened = Engine::reopen(&path, &c).unwrap();
    assert_eq!(reopened.remote_binding(&c).unwrap(), Some(binding()));
    let mut other = binding();
    other.origin = "https://another.invalid".into();
    assert!(reopened.bind_remote(&other, &c).is_err());
    drop(reopened);
    std::fs::remove_dir_all(path).unwrap();
    std::fs::remove_dir_all(legacy_path).unwrap();
}
#[test]
fn observed_heads_reject_rollback_and_equivocation_and_jobs_use_optimistic_generations() {
    let c = Control::fixture();
    let mut engine = Engine::create_bound_fixture(1, PROFILE, &c).unwrap();
    engine.bind_remote(&binding(), &c).unwrap();
    let head = RemoteHead {
        snapshot_id: Some("66666666-6666-4666-8666-666666666666".into()),
        revision: 3,
        manifest_hash: Some("a".repeat(64)),
    };
    engine.observe_remote(&head, &c).unwrap();
    assert!(engine.observe_remote(&RemoteHead::empty(), &c).is_err());
    let mut changed = head.clone();
    changed.manifest_hash = Some("b".repeat(64));
    assert!(engine.observe_remote(&changed, &c).is_err());
    engine.observe_remote(&head, &c).unwrap();
    let mut first = job();
    engine.save_sync_job(&mut first, &c).unwrap();
    let mut stale = first.clone();
    first.state = JobState::Fetching;
    engine.save_sync_job(&mut first, &c).unwrap();
    assert!(engine.save_sync_job(&mut stale, &c).is_err());
    let mut second = job();
    second.data.id = "77777777-7777-4777-8777-777777777777".into();
    assert!(engine.save_sync_job(&mut second, &c).is_err());
    let path = engine.path().to_owned();
    drop(engine);
    let mut engine = Engine::reopen(&path, &c).unwrap();
    let mut loaded = engine.sync_job(&first.data.id, &c).unwrap();
    assert_eq!(loaded.generation, 2);
    assert_eq!(loaded.state, JobState::Fetching);
    loaded.state = JobState::Cancelled;
    engine.save_sync_job(&mut loaded, &c).unwrap();
    engine.save_sync_job(&mut second, &c).unwrap();
    assert!(engine.remote_baseline(&c).unwrap().is_none());
    drop(engine);
    std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn fresh_profile_binding_requires_valid_policy_and_complete_roots() {
    let c = Control::fixture();
    let mut engine = Engine::create_bound_fixture(1, PROFILE, &c).unwrap();
    let mut invalid = binding();
    invalid.roots.pop();
    assert!(engine.bind_remote(&invalid, &c).is_err());
    let mut invalid = binding();
    invalid.origin = "https://user:password@synthetic.invalid".into();
    assert!(engine.bind_remote(&invalid, &c).is_err());
    let invalid = Manifest {
        protocol_version: 1,
        profile_id: "../outside".into(),
        policy_version: 1,
        files: vec![],
    };
    assert!(Engine::create_bound_fixture(1, &invalid.profile_id, &c).is_err());
    let path = engine.path().to_owned();
    drop(engine);
    std::fs::remove_dir_all(path).unwrap();
}
