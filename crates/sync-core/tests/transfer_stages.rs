#![cfg(unix)]
use attuner_sync_core::{Control, Engine, GameState, Manifest, ManifestFile};
use std::io::{Read, Seek, SeekFrom, Write};
const PROFILE: &str = "22222222-2222-4222-8222-222222222222";
fn entry(bytes: &[u8]) -> ManifestFile {
    ManifestFile {
        root: "account".into(),
        path: "Incoming.lua".into(),
        hash: blake3::hash(bytes).to_hex().to_string(),
        size: bytes.len() as u64,
        group: format!("account:{}", &blake3::hash(b"Incoming.lua").to_hex()[..24]),
    }
}
#[test]
fn durable_prefix_resume_discards_only_unreceipted_transfer_tail_and_import_preserves_bytes() {
    let c = Control::fixture();
    let mut engine = Engine::create_bound_fixture(1, PROFILE, &c).unwrap();
    let before = engine.scan(&c).unwrap().manifest().clone();
    let bytes = b"original incoming synthetic bytes\r\n\0";
    let e = entry(bytes);
    let mut stage = engine.download_stage(&e, &c).unwrap();
    stage.write_all(&bytes[..10]).unwrap();
    stage
        .checkpoint(10, blake3::hash(&bytes[..10]).to_hex().as_str())
        .unwrap();
    stage.write_all(b"unreceipted partial tail").unwrap();
    drop(stage);
    let path = engine.path().to_owned();
    drop(engine);
    let mut engine = Engine::reopen(&path, &c).unwrap();
    let mut stage = engine.download_stage(&e, &c).unwrap();
    assert_eq!(stage.len().unwrap(), 10);
    stage.write_all(&bytes[10..]).unwrap();
    stage.checkpoint(bytes.len() as u64, &e.hash).unwrap();
    engine.import_download(stage, &c).unwrap();
    assert!(engine.has_verified_blob(&e, &c).unwrap());
    let manifest = Manifest {
        protocol_version: 1,
        profile_id: PROFILE.into(),
        policy_version: 1,
        files: vec![e.clone()],
    };
    let snapshot = engine
        .record_verified_remote_snapshot(&manifest, "Verified imported bytes", &c)
        .unwrap();
    let mut exported = Vec::new();
    engine
        .export_snapshot_blob(snapshot.id, &e.hash, &mut exported, &c)
        .unwrap();
    assert_eq!(exported, bytes);
    assert_eq!(engine.scan(&c).unwrap().manifest(), &before);
    assert!(
        !path
            .join(format!("state/transfers/{}.part", e.hash))
            .exists()
    );
    drop(engine);
    std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn corrupt_prefix_is_preserved_until_explicit_quarantine_and_never_becomes_a_backup() {
    let c = Control::fixture();
    let mut engine = Engine::create_bound_fixture(1, PROFILE, &c).unwrap();
    let bytes = b"incoming fixture";
    let e = entry(bytes);
    let mut stage = engine.download_stage(&e, &c).unwrap();
    stage.write_all(&bytes[..5]).unwrap();
    stage
        .checkpoint(5, blake3::hash(&bytes[..5]).to_hex().as_str())
        .unwrap();
    drop(stage);
    let path = engine.path().to_owned();
    let part = path.join(format!("state/transfers/{}.part", e.hash));
    std::fs::write(&part, b"WRONG").unwrap();
    assert!(engine.download_stage(&e, &c).is_err());
    assert_eq!(std::fs::read(&part).unwrap(), b"WRONG");
    assert!(!engine.has_verified_blob(&e, &c).unwrap());
    engine.restart_download(&e, &c).unwrap();
    assert_eq!(
        std::fs::read_dir(path.join("state/quarantine"))
            .unwrap()
            .count(),
        2
    );
    let mut stage = engine.download_stage(&e, &c).unwrap();
    assert_eq!(stage.len().unwrap(), 0);
    stage.write_all(b"incorrect bytes!").unwrap();
    assert!(engine.import_download(stage, &c).is_err());
    assert!(!engine.has_verified_blob(&e, &c).unwrap());
    drop(engine);
    std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn staging_stops_on_uncertain_game_state_and_disk_budget_failure() {
    let c = Control::fixture();
    let mut engine = Engine::create_bound_fixture(1, PROFILE, &c).unwrap();
    let e = entry(b"synthetic bytes");
    let mut limited = c.clone();
    limited.disk_budget = Some(0);
    assert!(engine.download_stage(&e, &limited).is_err());
    let mut stage = engine.download_stage(&e, &c).unwrap();
    c.runtime.set(GameState::Unknown);
    assert!(stage.write_all(b"x").is_err());
    assert!(stage.seek(SeekFrom::Start(0)).is_err());
    let mut bytes = [0u8; 1];
    assert!(stage.read(&mut bytes).is_err());
    c.runtime.set(GameState::Closed);
    assert_eq!(stage.len().unwrap(), 0);
    drop(stage);
    let path = engine.path().to_owned();
    assert_eq!(engine.scan(&c).unwrap().files, 3);
    drop(engine);
    std::fs::remove_dir_all(path).unwrap();
}
