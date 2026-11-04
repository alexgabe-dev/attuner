//! Real NTFS tests, only newly minted synthetic workspaces. No privilege changes.
#![cfg(windows)]
use attuner_platform_windows::{Component, Error, PinnedFile, SyntheticWorkspace};
use std::{fs, io::Read, os::windows::fs::OpenOptionsExt, process::Command};

fn name(value: &str) -> Component {
    Component::new(value).unwrap()
}
fn contents(file: &mut PinnedFile) -> Vec<u8> {
    file.rewind().unwrap();
    let mut bytes = Vec::new();
    let mut buffer = [0; 64];
    loop {
        let count = file.read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    bytes
}

#[test]
fn relative_walk_flush_and_rename_preserve_bytes_and_identity() {
    let workspace = SyntheticWorkspace::create().unwrap();
    let root = workspace.root();
    let nested = root.create_dir(&name("Configuration")).unwrap();
    let stage = root.create_dir(&name("staging")).unwrap();
    let mut file = stage.create_file(&name("new.bin")).unwrap();
    let original = b"synthetic\0 bytes\r\nnever normalize";
    file.write_all(original).unwrap();
    file.flush_file().unwrap();
    let identity = file.identity();
    file.rename_new(&nested, &name("Addon.lua")).unwrap();
    assert_eq!(file.identity(), identity);
    assert_eq!(contents(&mut file), original);
    drop(file);
    let reopened = root.open_dir(&name("Configuration")).unwrap();
    let mut reopened = reopened.open_file(&name("Addon.lua")).unwrap();
    assert_eq!(reopened.identity(), identity);
    assert_eq!(contents(&mut reopened), original);
}

#[test]
fn no_clobber_preserves_source_and_unrelated_destination() {
    let workspace = SyntheticWorkspace::create().unwrap();
    let root = workspace.root();
    let mut source = root.create_file(&name("stage.bin")).unwrap();
    source.write_all(b"verified stage").unwrap();
    source.flush_file().unwrap();
    fs::write(
        workspace.fixture_path().join("installed.bin"),
        b"unrelated edit",
    )
    .unwrap();
    assert!(matches!(
        source.rename_new(&root, &name("installed.bin")),
        Err(Error::Exists)
    ));
    assert_eq!(contents(&mut source), b"verified stage");
    assert_eq!(
        fs::read(workspace.fixture_path().join("installed.bin")).unwrap(),
        b"unrelated edit"
    );
}

#[test]
fn pinned_parent_prevents_rename_and_keeps_descendant_alive() {
    let workspace = SyntheticWorkspace::create().unwrap();
    let root = workspace.root();
    let directory = root.create_dir(&name("parent")).unwrap();
    let mut child = directory.create_file(&name("child.bin")).unwrap();
    child.write_all(b"pinned ancestor").unwrap();
    drop(directory);
    assert!(
        fs::rename(
            workspace.fixture_path().join("parent"),
            workspace.fixture_path().join("moved")
        )
        .is_err()
    );
    assert_eq!(contents(&mut child), b"pinned ancestor");
}

#[test]
fn pinned_preimage_denies_write_delete_and_detects_new_hardlinks() {
    let workspace = SyntheticWorkspace::create().unwrap();
    let path = workspace.fixture_path().join("before.bin");
    fs::write(&path, b"verified preimage").unwrap();
    let mut before = workspace.root().open_file(&name("before.bin")).unwrap();
    assert!(fs::OpenOptions::new().write(true).open(&path).is_err());
    assert!(fs::remove_file(&path).is_err());
    assert_eq!(contents(&mut before), b"verified preimage");
    assert!(matches!(
        before.write_all(b"forbidden"),
        Err(Error::Unsafe(_))
    ));
    // NTFS permits a new hard link despite denied write/delete sharing. Do not
    // assume pinning prevents it: every operation must reject changed link count.
    fs::hard_link(&path, workspace.fixture_path().join("alias.bin")).unwrap();
    assert!(matches!(
        before.read(&mut [0; 64]),
        Err(Error::Unsafe("hard-linked file"))
    ));
    assert!(matches!(
        before.rename_new(&workspace.root(), &name("quarantine.bin")),
        Err(Error::Unsafe("hard-linked file"))
    ));
    assert_eq!(fs::read(&path).unwrap(), b"verified preimage");
    assert_eq!(
        fs::read(workspace.fixture_path().join("alias.bin")).unwrap(),
        b"verified preimage"
    );
}

#[test]
fn hardlinked_preimages_are_rejected() {
    let workspace = SyntheticWorkspace::create().unwrap();
    fs::write(workspace.fixture_path().join("before.bin"), b"original").unwrap();
    fs::hard_link(
        workspace.fixture_path().join("before.bin"),
        workspace.fixture_path().join("alias.bin"),
    )
    .unwrap();
    assert!(matches!(
        workspace.root().open_file(&name("before.bin")),
        Err(Error::Unsafe("hard-linked file"))
    ));
    assert_eq!(
        fs::read(workspace.fixture_path().join("alias.bin")).unwrap(),
        b"original"
    );
}

#[test]
fn exact_names_reject_case_aliases_and_create_new_cannot_replace() {
    let workspace = SyntheticWorkspace::create().unwrap();
    fs::write(
        workspace.fixture_path().join("Addon.lua"),
        b"exact spelling",
    )
    .unwrap();
    let root = workspace.root();
    assert!(matches!(
        root.open_file(&name("addon.lua")),
        Err(Error::Changed)
    ));
    assert!(matches!(
        root.create_file(&name("Addon.lua")),
        Err(Error::Exists)
    ));
    assert_eq!(
        fs::read(workspace.fixture_path().join("Addon.lua")).unwrap(),
        b"exact spelling"
    );
}

#[test]
fn locked_entries_fail_before_mutation_without_retry_or_permission_changes() {
    let workspace = SyntheticWorkspace::create().unwrap();
    let path = workspace.fixture_path().join("locked.bin");
    fs::write(&path, b"original").unwrap();
    let mut locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    assert!(matches!(
        workspace.root().open_file(&name("locked.bin")),
        Err(Error::Sharing(_))
    ));
    let mut bytes = Vec::new();
    locked.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"original");
    drop(locked);
    assert!(workspace.root().open_file(&name("locked.bin")).is_ok());
}

#[test]
fn readonly_preimage_is_preserved() {
    let workspace = SyntheticWorkspace::create().unwrap();
    let path = workspace.fixture_path().join("readonly.bin");
    fs::write(&path, b"read-only original").unwrap();
    let original_permissions = fs::metadata(&path).unwrap().permissions();
    let mut permissions = original_permissions.clone();
    permissions.set_readonly(true);
    fs::set_permissions(&path, permissions).unwrap();
    assert!(matches!(
        workspace.root().open_file(&name("readonly.bin")),
        Err(Error::Access(_))
    ));
    assert_eq!(fs::read(&path).unwrap(), b"read-only original");
    assert!(fs::metadata(&path).unwrap().permissions().readonly());
    // Restore only this synthetic test's own attribute for temporary cleanup.
    fs::set_permissions(&path, original_permissions).unwrap();
}

#[test]
fn directories_cannot_be_opened_as_regular_files() {
    let workspace = SyntheticWorkspace::create().unwrap();
    workspace.root().create_dir(&name("folder")).unwrap();
    assert!(workspace.root().open_file(&name("folder")).is_err());
    fs::write(workspace.fixture_path().join("regular.bin"), b"original").unwrap();
    assert!(matches!(
        workspace.root().open_dir(&name("regular.bin")),
        Err(Error::Unsafe("unexpected entry type"))
    ));
}

#[test]
fn junction_is_rejected_without_traversal() {
    let workspace = SyntheticWorkspace::create().unwrap();
    let target = SyntheticWorkspace::create().unwrap();
    fs::write(target.fixture_path().join("untouched.bin"), b"outside root").unwrap();
    let junction = workspace.fixture_path().join("junction");
    let output = Command::new("cmd")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(&junction)
        .arg(target.fixture_path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Cannot create synthetic junction for qualification"
    );
    assert!(matches!(
        workspace.root().open_dir(&name("junction")),
        Err(Error::Unsafe("reparse point"))
    ));
    fs::remove_dir(&junction).unwrap();
    assert_eq!(
        fs::read(target.fixture_path().join("untouched.bin")).unwrap(),
        b"outside root"
    );
}
