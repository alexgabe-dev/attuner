#![cfg(unix)]
use attuner_sync_core::{Control, Engine, FixtureRegistry};
#[test]
fn registered_fixtures_survive_reopen_and_accept_only_catalogued_ids() {
    let root = tempfile::Builder::new()
        .prefix("attuner-host-test-")
        .tempdir()
        .unwrap();
    let c = Control::fixture();
    let mut registry = FixtureRegistry::open(root.path(), &c).unwrap();
    let profile = "22222222-2222-4222-8222-222222222222";
    let (entry, mut engine) = registry.create_fixture(2, profile, &c).unwrap();
    let scan = engine.scan(&c).unwrap();
    let snapshot = engine
        .capture_snapshot(&scan, "Persistent fixture capture", &c)
        .unwrap();
    let path = engine.path().to_owned();
    assert!(Engine::reopen(&path, &c).is_err());
    drop(engine);
    drop(registry);
    let registry = FixtureRegistry::open(root.path(), &c).unwrap();
    assert_eq!(registry.list(&c).unwrap()[0].id, entry.id);
    let mut engine = registry.reopen(&entry.id, &c).unwrap();
    assert_eq!(engine.scan(&c).unwrap().manifest().profile_id, profile);
    assert_eq!(
        engine.snapshot(snapshot.id, &c).unwrap().manifest(),
        snapshot.manifest()
    );
    assert!(registry.reopen("../outside", &c).is_err());
    assert!(
        registry
            .reopen("33333333-3333-4333-8333-333333333333", &c)
            .is_err()
    );
    drop(engine);
}
#[test]
fn registry_rejects_links_replacement_and_checksum_tampering() {
    use std::os::unix::fs::symlink;
    let root = tempfile::Builder::new()
        .prefix("attuner-host-test-")
        .tempdir()
        .unwrap();
    let c = Control::fixture();
    let mut registry = FixtureRegistry::open(root.path(), &c).unwrap();
    let (entry, engine) = registry
        .create_fixture(1, "22222222-2222-4222-8222-222222222222", &c)
        .unwrap();
    let path = engine.path().to_owned();
    drop(engine);
    let moved = path.with_file_name("retained-fixture");
    std::fs::rename(&path, &moved).unwrap();
    symlink(&moved, &path).unwrap();
    assert!(registry.reopen(&entry.id, &c).is_err());
    std::fs::remove_file(&path).unwrap();
    std::fs::rename(&moved, &path).unwrap();
    let catalogue = root.path().join("synthetic-workspaces-v1/catalogue.json");
    let original = std::fs::read(&catalogue).unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&original).unwrap();
    value["catalogue"]["fixtures"][0]["id"] = "33333333-3333-4333-8333-333333333333".into();
    std::fs::write(&catalogue, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(registry.list(&c).is_err());
    std::fs::write(catalogue, original).unwrap();
    assert!(registry.reopen(&entry.id, &c).is_ok());
    drop(registry);
    let registry_root = root.path().join("synthetic-workspaces-v1");
    let old = root.path().join("retained-registry");
    std::fs::rename(&registry_root, &old).unwrap();
    std::fs::create_dir(&registry_root).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&registry_root, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::copy(
        old.join("registry.marker"),
        registry_root.join("registry.marker"),
    )
    .unwrap();
    std::fs::copy(
        old.join("catalogue.json"),
        registry_root.join("catalogue.json"),
    )
    .unwrap();
    assert!(FixtureRegistry::open(root.path(), &c).is_err());
}
