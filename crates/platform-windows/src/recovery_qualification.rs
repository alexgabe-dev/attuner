//! One-file native recovery experiment, compiled into the test binary only.
//! This does not replace the engine's SQLite journal or enable Windows apply.
use crate::{Component, Directory, Error, Identity, PinnedFile, Result, SyntheticWorkspace};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};

const BEFORE: &[u8] = b"original synthetic bytes\0\r\n";
const AFTER: &[u8] = b"approved synthetic replacement\0\r\n";
const MAX_BYTES: usize = 1024 * 1024;

fn name(value: &str) -> Component {
    Component::new(value).unwrap()
}
fn absent(error: &Error) -> bool {
    matches!(error, Error::Io(e) if e.kind() == std::io::ErrorKind::NotFound)
}
fn maybe(root: &Directory, value: &str) -> Result<Option<PinnedFile>> {
    match root.open_file(&name(value)) {
        Ok(file) => Ok(Some(file)),
        Err(error) if absent(&error) => Ok(None),
        Err(error) => Err(error),
    }
}
fn digest(file: &mut PinnedFile) -> Result<String> {
    file.rewind()?;
    let mut buffer = [0; 64 * 1024];
    let mut hash = blake3::Hasher::new();
    let mut total = 0;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total += count;
        if total > MAX_BYTES {
            return Err(Error::Unsafe("qualification size limit"));
        }
        hash.update(&buffer[..count]);
    }
    Ok(hash.finalize().to_hex().to_string())
}
fn expected(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}
fn verify(file: &mut PinnedFile, hash: &str) -> Result<()> {
    if digest(file)? != hash {
        return Err(Error::Unsafe("content verification failed"));
    }
    Ok(())
}
fn copy_verified(
    root: &Directory,
    source: &mut PinnedFile,
    target: &str,
    hash: &str,
    fail_after: Option<usize>,
) -> Result<PinnedFile> {
    verify(source, hash)?;
    let mut destination = root.create_file(&name(target))?;
    source.rewind()?;
    let mut buffer = [0; 64 * 1024];
    let mut total = 0;
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        if fail_after.is_some_and(|limit| total + count > limit) {
            let allowed = fail_after.unwrap().saturating_sub(total);
            destination.write_all(&buffer[..allowed])?;
            return Err(Error::DiskFull);
        }
        destination.write_all(&buffer[..count])?;
        total += count;
    }
    destination.flush_file()?;
    verify(&mut destination, hash)?;
    Ok(destination)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    schema: u8,
    sequence: usize,
    previous: String,
    action: String,
    before: String,
    after: String,
}
const ACTIONS: [&str; 7] = [
    "prepared",
    "evacuate-intent",
    "install-intent",
    "rollback-intent",
    "restore-intent",
    "rolled-back",
    "committed",
];

struct Journal {
    sequence: usize,
    previous: String,
    actions: Vec<String>,
}
impl Journal {
    fn load(root: &Directory) -> Result<Self> {
        let mut result = Self {
            sequence: 0,
            previous: "0".repeat(64),
            actions: Vec::new(),
        };
        let mut gap = false;
        for sequence in 1..=16 {
            let Some(mut file) = maybe(root, &format!("record-{sequence:02}.json"))? else {
                gap = true;
                continue;
            };
            if gap {
                return Err(Error::Unsafe("journal gap"));
            }
            let mut bytes = Vec::new();
            let mut buffer = [0; 1024];
            loop {
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                if bytes.len() + count > 4096 {
                    return Err(Error::Unsafe("journal size limit"));
                }
                bytes.extend_from_slice(&buffer[..count]);
            }
            let record: Record =
                serde_json::from_slice(&bytes).map_err(|_| Error::Unsafe("corrupt journal"))?;
            if record.schema != 1
                || record.sequence != sequence
                || record.previous != result.previous
                || record.before != expected(BEFORE)
                || record.after != expected(AFTER)
                || !ACTIONS.contains(&record.action.as_str())
            {
                return Err(Error::Unsafe("journal integrity"));
            }
            let allowed = match result.actions.last().map(String::as_str) {
                None => record.action == "prepared",
                Some("prepared") => {
                    ["evacuate-intent", "rollback-intent"].contains(&record.action.as_str())
                }
                Some("evacuate-intent") => {
                    ["install-intent", "rollback-intent"].contains(&record.action.as_str())
                }
                Some("install-intent") => {
                    ["committed", "rollback-intent"].contains(&record.action.as_str())
                }
                Some("rollback-intent") => record.action == "restore-intent",
                Some("restore-intent") => record.action == "rolled-back",
                _ => false,
            };
            if !allowed {
                return Err(Error::Unsafe("journal transition"));
            }
            result.sequence = sequence;
            result.previous = expected(&bytes);
            result.actions.push(record.action);
        }
        Ok(result)
    }

    fn append(&mut self, root: &Directory, action: &str) -> Result<()> {
        if self.sequence >= 16 {
            return Err(Error::Unsafe("journal limit"));
        }
        let next = self.sequence + 1;
        let record = Record {
            schema: 1,
            sequence: next,
            previous: self.previous.clone(),
            action: action.into(),
            before: expected(BEFORE),
            after: expected(AFTER),
        };
        let bytes = serde_json::to_vec(&record).unwrap();
        let mut stage = None;
        for attempt in 1..=16 {
            match root.create_file(&name(&format!("record-stage-{next:02}-{attempt:02}.json"))) {
                Ok(file) => {
                    stage = Some(file);
                    break;
                }
                Err(Error::Exists) => continue,
                Err(error) => return Err(error),
            }
        }
        // Unreceipted partial record stages are retained, never adopted/deleted.
        let mut stage = stage.ok_or(Error::Unsafe("too many retained journal stages"))?;
        stage.write_all(&bytes)?;
        stage.flush_file()?;
        stage.rename_new(root, &name(&format!("record-{next:02}.json")))?;
        self.sequence = next;
        self.previous = expected(&bytes);
        self.actions.push(action.into());
        Ok(())
    }
}

fn boundary(value: &str) {
    if std::env::var("ATTUNER_KILL_BOUNDARY").as_deref() == Ok(value) {
        println!("ATTUNER_BOUNDARY:{value}");
        std::io::stdout().flush().unwrap();
        loop {
            std::thread::park();
        }
    }
}

fn apply(root: &Directory, fail_after: Option<usize>, failed_verification: bool) -> Result<()> {
    let mut original = root.open_file(&name("managed.bin"))?;
    verify(&mut original, &expected(BEFORE))?;
    let _backup = copy_verified(
        root,
        &mut original,
        "backup.bin",
        &expected(BEFORE),
        fail_after,
    )?;
    boundary("backup-flushed");
    let mut stage = root.create_file(&name("stage.bin"))?;
    stage.write_all(AFTER)?;
    stage.flush_file()?;
    let stage_hash = expected(if failed_verification { BEFORE } else { AFTER });
    verify(&mut stage, &stage_hash)?;
    let mut journal = Journal::load(root)?;
    journal.append(root, "prepared")?;
    boundary("prepared");
    verify(&mut original, &expected(BEFORE))?;
    journal.append(root, "evacuate-intent")?;
    boundary("evacuate-intent");
    original.rename_new(root, &name("preimage.bin"))?;
    boundary("evacuated");
    verify(&mut original, &expected(BEFORE))?;
    journal.append(root, "install-intent")?;
    boundary("install-intent");
    stage.rename_new(root, &name("managed.bin"))?;
    boundary("installed");
    verify(&mut stage, &expected(AFTER))?;
    journal.append(root, "committed")?;
    boundary("committed");
    Ok(())
}

fn recover(root: &Directory) -> Result<()> {
    let mut journal = Journal::load(root)?;
    if journal.sequence == 0 {
        return Ok(());
    }
    let mut backup = root.open_file(&name("backup.bin"))?;
    verify(&mut backup, &expected(BEFORE))?;
    let mut current = maybe(root, "managed.bin")?;
    let hash = current.as_mut().map(digest).transpose()?;
    if journal.actions.last().map(String::as_str) == Some("committed") {
        if hash.as_deref() != Some(&expected(AFTER)) {
            return Err(Error::Changed);
        }
        return Ok(());
    }
    if hash
        .as_deref()
        .is_some_and(|hash| hash != expected(BEFORE) && hash != expected(AFTER))
    {
        return Err(Error::Changed);
    }
    if journal.actions.last().map(String::as_str) == Some("rolled-back") {
        if hash.as_deref() != Some(&expected(BEFORE)) {
            return Err(Error::Changed);
        }
        return Ok(());
    }
    // Preflight all existing recovery artifacts before the first rollback mutation.
    for (path, expected_hash) in [
        ("preimage.bin", expected(BEFORE)),
        ("restore.bin", expected(BEFORE)),
        ("after-quarantine.bin", expected(AFTER)),
    ] {
        if let Some(mut file) = maybe(root, path)? {
            verify(&mut file, &expected_hash)?;
        }
    }
    let mut restore = match maybe(root, "restore.bin")? {
        Some(file) => Some(file),
        None if hash.as_deref() != Some(&expected(BEFORE)) => Some(copy_verified(
            root,
            &mut backup,
            "restore.bin",
            &expected(BEFORE),
            None,
        )?),
        None => None,
    };
    if !journal.actions.iter().any(|a| a == "rollback-intent") {
        journal.append(root, "rollback-intent")?;
    }
    boundary("rollback-intent");
    if hash.as_deref() == Some(&expected(AFTER)) {
        current
            .as_mut()
            .unwrap()
            .rename_new(root, &name("after-quarantine.bin"))?;
    }
    boundary("rollback-evacuated");
    if !journal.actions.iter().any(|a| a == "restore-intent") {
        journal.append(root, "restore-intent")?;
    }
    boundary("restore-intent");
    if hash.as_deref() != Some(&expected(BEFORE)) {
        let file = restore.as_mut().ok_or(Error::Changed)?;
        verify(file, &expected(BEFORE))?;
        file.rename_new(root, &name("managed.bin"))?;
        verify(file, &expected(BEFORE))?;
    }
    boundary("restored");
    journal.append(root, "rolled-back")?;
    Ok(())
}

fn setup() -> SyntheticWorkspace {
    let workspace = SyntheticWorkspace::create().unwrap();
    fs::write(workspace.fixture_path().join("managed.bin"), BEFORE).unwrap();
    workspace
}

fn identity_string(identity: Identity) -> String {
    format!(
        "{}:{}",
        identity.volume,
        identity.file_id.map(|byte| format!("{byte:02x}")).concat()
    )
}

#[test]
#[ignore = "child entry point; parent invokes it at each real process-termination boundary"]
fn recovery_child() {
    let path = std::env::var_os("ATTUNER_QUALIFICATION_ROOT").expect("parent handoff required");
    let identity = std::env::var("ATTUNER_QUALIFICATION_ID").unwrap();
    let (volume, bytes) = identity.split_once(':').unwrap();
    assert_eq!(bytes.len(), 32);
    let file_id =
        std::array::from_fn(|i| u8::from_str_radix(&bytes[i * 2..i * 2 + 2], 16).unwrap());
    let root = Directory::attach_test_root(
        std::path::Path::new(&path),
        Identity {
            volume: volume.parse().unwrap(),
            file_id,
        },
    )
    .unwrap();
    if std::env::var("ATTUNER_QUALIFICATION_OPERATION").as_deref() == Ok("recover") {
        recover(&root).unwrap();
    } else {
        apply(&root, None, false).unwrap();
    }
}

fn terminate(workspace: &SyntheticWorkspace, operation: &str, point: &str) {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "recovery_qualification::recovery_child",
            "--ignored",
            "--nocapture",
        ])
        .env("ATTUNER_QUALIFICATION_ROOT", workspace.fixture_path())
        .env(
            "ATTUNER_QUALIFICATION_ID",
            identity_string(workspace.root().identity()),
        )
        .env("ATTUNER_QUALIFICATION_OPERATION", operation)
        .env("ATTUNER_KILL_BOUNDARY", point)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    let expected = format!("ATTUNER_BOUNDARY:{point}");
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if line.is_ok_and(|line| line.ends_with(&expected)) {
                let _ = sender.send(());
                return;
            }
        }
    });
    let reached = receiver.recv_timeout(Duration::from_secs(30));
    // std::process::Child::kill uses TerminateProcess on Windows, without clean
    // Rust drops or app-level shutdown; it is not a retained-disk power-loss test.
    let killed = child.kill();
    let output = child.wait_with_output().unwrap();
    reader.join().unwrap();
    assert!(
        reached.is_ok(),
        "Boundary {point} not reached: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    killed.expect("terminate live paused child");
    assert!(!output.status.success());
}

#[test]
fn native_process_termination_matrix_preserves_verified_recovery_paths() {
    for point in [
        "backup-flushed",
        "prepared",
        "evacuate-intent",
        "evacuated",
        "install-intent",
        "installed",
        "committed",
    ] {
        let workspace = setup();
        terminate(&workspace, "apply", point);
        recover(&workspace.root()).unwrap();
        recover(&workspace.root()).unwrap();
        let bytes = fs::read(workspace.fixture_path().join("managed.bin")).unwrap();
        assert_eq!(
            bytes,
            if point == "committed" { AFTER } else { BEFORE },
            "{point}"
        );
    }
}

#[test]
fn rollback_can_be_terminated_and_resumed_at_every_boundary() {
    for point in [
        "rollback-intent",
        "rollback-evacuated",
        "restore-intent",
        "restored",
    ] {
        let workspace = setup();
        terminate(&workspace, "apply", "installed");
        terminate(&workspace, "recover", point);
        recover(&workspace.root()).unwrap();
        recover(&workspace.root()).unwrap();
        assert_eq!(
            fs::read(workspace.fixture_path().join("managed.bin")).unwrap(),
            BEFORE,
            "{point}"
        );
    }
}

#[test]
fn partial_backup_disk_full_and_failed_stage_verification_leave_original_untouched() {
    let workspace = setup();
    assert!(matches!(
        apply(&workspace.root(), Some(4), false),
        Err(Error::DiskFull)
    ));
    assert_eq!(
        fs::read(workspace.fixture_path().join("managed.bin")).unwrap(),
        BEFORE
    );
    assert_eq!(Journal::load(&workspace.root()).unwrap().sequence, 0);
    let workspace = setup();
    assert!(matches!(
        apply(&workspace.root(), None, true),
        Err(Error::Unsafe("content verification failed"))
    ));
    assert_eq!(
        fs::read(workspace.fixture_path().join("managed.bin")).unwrap(),
        BEFORE
    );
    assert_eq!(Journal::load(&workspace.root()).unwrap().sequence, 0);
}

#[test]
fn corrupt_missing_backup_and_corrupt_journal_fail_before_recovery_mutation() {
    for corruption in ["backup", "missing-backup", "journal"] {
        let workspace = setup();
        terminate(&workspace, "apply", "installed");
        if corruption == "backup" {
            fs::write(workspace.fixture_path().join("backup.bin"), b"corrupt").unwrap();
        } else if corruption == "missing-backup" {
            fs::rename(
                workspace.fixture_path().join("backup.bin"),
                workspace.fixture_path().join("missing.bin"),
            )
            .unwrap();
        } else {
            fs::write(workspace.fixture_path().join("record-01.json"), b"{}").unwrap();
        }
        assert!(recover(&workspace.root()).is_err());
        assert_eq!(
            fs::read(workspace.fixture_path().join("managed.bin")).unwrap(),
            AFTER
        );
        assert_eq!(
            fs::read(workspace.fixture_path().join("preimage.bin")).unwrap(),
            BEFORE
        );
    }
}

#[test]
fn recovery_preserves_concurrent_edits_and_unrelated_files() {
    let workspace = setup();
    terminate(&workspace, "apply", "installed");
    fs::write(
        workspace.fixture_path().join("managed.bin"),
        b"unrelated concurrent edit",
    )
    .unwrap();
    fs::write(workspace.fixture_path().join("unrelated.bin"), b"untouched").unwrap();
    assert!(matches!(recover(&workspace.root()), Err(Error::Changed)));
    assert_eq!(
        fs::read(workspace.fixture_path().join("managed.bin")).unwrap(),
        b"unrelated concurrent edit"
    );
    assert_eq!(
        fs::read(workspace.fixture_path().join("unrelated.bin")).unwrap(),
        b"untouched"
    );
    assert_eq!(
        fs::read(workspace.fixture_path().join("backup.bin")).unwrap(),
        BEFORE
    );
}

#[test]
fn partial_journal_stage_is_retained_and_not_adopted() {
    let workspace = setup();
    terminate(&workspace, "apply", "installed");
    // Sequence 4 has not been published: a short write here is disposable input,
    // not authority for the next filesystem transition.
    let partial = workspace.fixture_path().join("record-stage-04-01.json");
    fs::write(&partial, b"{\"schema\":").unwrap();
    recover(&workspace.root()).unwrap();
    assert_eq!(fs::read(&partial).unwrap(), b"{\"schema\":");
    assert_eq!(
        fs::read(workspace.fixture_path().join("managed.bin")).unwrap(),
        BEFORE
    );
}

#[test]
fn recovery_lock_interference_and_concurrent_creation_preserve_all_bytes() {
    use std::os::windows::fs::OpenOptionsExt;
    let workspace = setup();
    terminate(&workspace, "apply", "installed");
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(workspace.fixture_path().join("managed.bin"))
        .unwrap();
    assert!(matches!(recover(&workspace.root()), Err(Error::Sharing(_))));
    drop(locked);
    assert_eq!(
        fs::read(workspace.fixture_path().join("managed.bin")).unwrap(),
        AFTER
    );
    recover(&workspace.root()).unwrap();
    assert_eq!(
        fs::read(workspace.fixture_path().join("managed.bin")).unwrap(),
        BEFORE
    );

    let workspace = setup();
    terminate(&workspace, "apply", "evacuated");
    terminate(&workspace, "recover", "restore-intent");
    fs::write(
        workspace.fixture_path().join("managed.bin"),
        b"created during recovery",
    )
    .unwrap();
    assert!(matches!(recover(&workspace.root()), Err(Error::Changed)));
    assert_eq!(
        fs::read(workspace.fixture_path().join("managed.bin")).unwrap(),
        b"created during recovery"
    );
    assert_eq!(
        fs::read(workspace.fixture_path().join("restore.bin")).unwrap(),
        BEFORE
    );
    assert_eq!(
        fs::read(workspace.fixture_path().join("preimage.bin")).unwrap(),
        BEFORE
    );
}
