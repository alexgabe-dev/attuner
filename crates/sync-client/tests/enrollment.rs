use attuner_sync_client::{CredentialStore, DeviceClient, Error, Result, ServerConnection};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::Duration,
};
use zeroize::Zeroizing;
#[derive(Default)]
struct Memory {
    values: Mutex<BTreeMap<String, Zeroizing<Vec<u8>>>>,
    writes: AtomicUsize,
    fail_at: AtomicUsize,
}
impl CredentialStore for Memory {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
        Ok(self
            .values
            .lock()
            .unwrap()
            .get(account)
            .map(|v| Zeroizing::new(v.to_vec())))
    }
    fn write(&self, account: &str, value: &[u8]) -> Result<()> {
        let n = self.writes.fetch_add(1, Ordering::SeqCst) + 1;
        if n == self.fail_at.load(Ordering::SeqCst) {
            return Err(Error::Credentials);
        }
        self.values
            .lock()
            .unwrap()
            .insert(account.into(), Zeroizing::new(value.to_vec()));
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<()> {
        self.values.lock().unwrap().remove(account);
        Ok(())
    }
}
impl Memory {
    fn fail_after(&self, n: usize) {
        self.fail_at
            .store(self.writes.load(Ordering::SeqCst) + n, Ordering::SeqCst);
    }
}
struct Fixture {
    child: Child,
    input: Option<ChildStdin>,
    output: mpsc::Receiver<String>,
    origin: String,
    ca: String,
    profile_id: String,
}
impl Fixture {
    fn start() -> Self {
        Self::with_blobs(false)
    }
    fn with_blobs(blobs: bool) -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut child = Command::new("node")
            .arg(root.join("apps/api/src/testing/native-fixture.ts"))
            .current_dir(root)
            .env("ATTUNER_TEST_FIXTURE", "1")
            .env("ATTUNER_TEST_BLOBS", if blobs { "1" } else { "0" })
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("Node 24 and installed project dependencies are required");
        let input = child.stdin.take();
        let reader = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(reader).lines() {
                if let Ok(line) = line {
                    if tx.send(line).is_err() {
                        break;
                    }
                } else {
                    break;
                }
            }
        });
        let mut f = Self {
            child,
            input,
            output: rx,
            origin: String::new(),
            ca: String::new(),
            profile_id: String::new(),
        };
        let ready = f.read();
        f.origin = ready["origin"]
            .as_str()
            .expect("public fixture origin")
            .into();
        f.profile_id = ready["profileId"].as_str().unwrap().into();
        f.ca = ready["ca"].as_str().expect("public fixture CA").into();
        assert!(uuid::Uuid::parse_str(&f.profile_id).is_ok());
        f
    }
    fn read(&mut self) -> Value {
        let line = self
            .output
            .recv_timeout(Duration::from_secs(30))
            .expect("synthetic TLS fixture response");
        serde_json::from_str(&line).expect("fixture JSON response")
    }
    fn command(&mut self, value: Value) -> Value {
        writeln!(self.input.as_mut().unwrap(), "{value}").unwrap();
        self.input.as_mut().unwrap().flush().unwrap();
        self.read()
    }
    fn connection(&self) -> ServerConnection {
        ServerConnection::connect(&self.origin, Some(&self.ca))
            .expect("verified synthetic HTTPS connection")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(mut input) = self.input.take() {
            let _ = writeln!(input, "{{\"kind\":\"stop\"}}");
            drop(input);
        }
        for _ in 0..50 {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[test]
fn native_crypto_tls_enrollment_and_secure_store_recovery() {
    let mut fixture = Fixture::start();
    assert!(ServerConnection::connect("http://127.0.0.1:4317", None).is_err());
    assert!(ServerConnection::connect(&fixture.origin, None).is_err());
    let store = Arc::new(Memory::default());
    let mut client = DeviceClient::open(fixture.connection(), store.clone()).unwrap();
    let enrollment = client
        .begin_enrollment("Rust synthetic client", "macos", "0.1.0")
        .unwrap();
    let repeat = client
        .begin_enrollment("Rust synthetic client", "macos", "0.1.0")
        .unwrap();
    assert_eq!(enrollment.enrollment_id, repeat.enrollment_id);
    let approval =
        fixture.command(json!({"kind":"approve","enrollmentId":enrollment.enrollment_id}));
    assert_eq!(approval["status"], 200);
    let callback = approval["redirectUri"].as_str().unwrap();
    assert!(
        client
            .accept_callback(
                "app.attuner.desktop:/enrollment?code=x&state=wrong&enrollmentId=wrong"
            )
            .is_err()
    );
    store.fail_after(1);
    assert!(matches!(
        client.accept_callback(callback),
        Err(Error::Credentials)
    ));
    assert_eq!(fixture.command(json!({"kind":"counts"}))["devices"], 0);
    drop(client);
    let mut client = DeviceClient::open(fixture.connection(), store.clone()).unwrap();
    let status = client.accept_callback(callback).unwrap();
    assert!(status.enrolled);
    assert_eq!(fixture.command(json!({"kind":"counts"}))["devices"], 1);
    assert!(
        client
            .request("GET", "/api/v1/profiles", None, None)
            .is_ok()
    );
    // Fail the credential write after successful remote rotation. The durable pending
    // request survives restart and recovers the same encrypted server delivery.
    store.fail_after(2);
    assert!(matches!(client.refresh(), Err(Error::Credentials)));
    drop(client);
    let mut client = DeviceClient::open(fixture.connection(), store).unwrap();
    assert!(
        client
            .request("GET", "/api/v1/profiles", None, None)
            .is_ok()
    );
    let counts = fixture.command(json!({"kind":"counts"}));
    assert_eq!(counts["devices"], 1);
    assert_eq!(counts["credentials"], 4);
    assert!(
        client
            .request("GET", "/api/v1/../../health", None, None)
            .is_err()
    );
    let revoked = fixture.command(json!({"kind":"revoke","deviceId":status.device_id}));
    assert_eq!(revoked["status"], 200);
    assert!(matches!(
        client.request("GET", "/api/v1/profiles", None, None),
        Err(Error::Authentication)
    ));
}
#[cfg(unix)]
#[test]
fn native_streaming_transfer_resumes_and_reuses_verified_content() {
    use attuner_sync_client::BlobIdentity;
    use attuner_sync_core::{Control, Manifest, ManifestFile};
    use std::io::Cursor;
    let mut fixture = Fixture::with_blobs(true);
    let mut client = DeviceClient::open(fixture.connection(), Arc::new(Memory::default())).unwrap();
    let enrollment = client
        .begin_enrollment("Native transfer", "macos", "0.1.0")
        .unwrap();
    let approval =
        fixture.command(json!({"kind":"approve","enrollmentId":enrollment.enrollment_id}));
    client
        .accept_callback(approval["redirectUri"].as_str().unwrap())
        .unwrap();
    let profile = fixture.profile_id.clone();
    let bytes = vec![0x57u8; 4 * 1024 * 1024 + 19];
    let hash = blake3::hash(&bytes).to_hex().to_string();
    let manifest = Manifest {
        protocol_version: 1,
        profile_id: profile.clone(),
        policy_version: 1,
        files: vec![ManifestFile {
            root: "account".into(),
            path: "Synthetic.lua".into(),
            hash: hash.clone(),
            size: bytes.len() as u64,
            group: format!("account:{}", &blake3::hash(b"Synthetic.lua").to_hex()[..24]),
        }],
    };
    let body = json!({"publicationVersion":1,"namespaceVersion":1,"expectedHead":{"snapshotId":null,"revision":0,"manifestHash":null},"baseSnapshotId":null,"coveredRoots":["account","addons"],"manifestHash":attuner_sync_core::remote::digest(&manifest).unwrap(),"manifest":manifest});
    let session = client
        .request(
            "POST",
            &format!("/api/v1/profiles/{profile}/sessions"),
            Some(&body),
            Some(&uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
    let session = session["sessionId"].as_str().unwrap();
    let blob = BlobIdentity {
        profile_id: &profile,
        hash: &hash,
        size: bytes.len() as u64,
    };
    let control = Control::fixture();
    let cancellation = control.cancellation.clone();
    assert!(
        client
            .upload_blob(blob, session, &mut Cursor::new(&bytes), &control, |_| {
                cancellation.cancel()
            })
            .is_err()
    );
    let mut reused = 0;
    client
        .upload_blob(
            blob,
            session,
            &mut Cursor::new(&bytes),
            &Control::fixture(),
            |p| reused = p.reused_bytes,
        )
        .unwrap();
    assert_eq!(reused, 4 * 1024 * 1024);
    // A verified object is reused without even reading/recompressing the source.
    client
        .upload_blob(
            blob,
            session,
            &mut std::io::empty(),
            &Control::fixture(),
            |p| assert_eq!(p.reused_bytes, bytes.len() as u64),
        )
        .unwrap();
    let control = Control::fixture();
    let cancellation = control.cancellation.clone();
    let mut output = Cursor::new(Vec::new());
    assert!(
        client
            .download_blob(blob, &mut output, 0, &control, |_| cancellation.cancel())
            .is_err()
    );
    let offset = output.get_ref().len() as u64;
    assert_eq!(offset, 4 * 1024 * 1024);
    client
        .download_blob(blob, &mut output, offset, &Control::fixture(), |_| {})
        .unwrap();
    assert!(output.get_ref() == &bytes);
    let mut corrupt = Cursor::new(vec![0u8; offset as usize]);
    assert!(
        client
            .download_blob(blob, &mut corrupt, offset, &Control::fixture(), |_| {})
            .is_err()
    );
}
#[cfg(unix)]
#[test]
fn three_native_devices_publish_immutable_heads_with_one_cas_winner() {
    use attuner_sync_client::BlobIdentity;
    use attuner_sync_core::{Control, Manifest, ManifestFile};
    use std::io::Cursor;
    let mut fixture = Fixture::with_blobs(true);
    let profile = fixture.profile_id.clone();
    let mut clients = Vec::new();
    for name in ["Synthetic North", "Synthetic West", "Synthetic East"] {
        let mut client =
            DeviceClient::open(fixture.connection(), Arc::new(Memory::default())).unwrap();
        let enrollment = client.begin_enrollment(name, "macos", "0.1.0").unwrap();
        let approval =
            fixture.command(json!({"kind":"approve","enrollmentId":enrollment.enrollment_id}));
        client
            .accept_callback(approval["redirectUri"].as_str().unwrap())
            .unwrap();
        clients.push(client);
    }
    let policy = clients[0].fetch_head(&profile).unwrap();
    assert_eq!(policy.head.revision, 0);
    let mut candidates = Vec::new();
    for (index, client) in clients.iter_mut().take(2).enumerate() {
        let bytes = format!("synthetic concurrent content {index}").into_bytes();
        let hash = blake3::hash(&bytes).to_hex().to_string();
        let manifest = Manifest {
            protocol_version: 1,
            profile_id: profile.clone(),
            policy_version: 1,
            files: vec![ManifestFile {
                root: "account".into(),
                path: "Concurrent.lua".into(),
                hash: hash.clone(),
                size: bytes.len() as u64,
                group: format!(
                    "account:{}",
                    &blake3::hash(b"Concurrent.lua").to_hex()[..24]
                ),
            }],
        };
        let session = client
            .stage_snapshot(&manifest, &policy, None, &uuid::Uuid::new_v4().to_string())
            .unwrap();
        client
            .upload_blob(
                BlobIdentity {
                    profile_id: &profile,
                    hash: &hash,
                    size: bytes.len() as u64,
                },
                &session.session_id,
                &mut Cursor::new(bytes),
                &Control::fixture(),
                |_| {},
            )
            .unwrap();
        candidates.push((manifest, session));
    }
    let mut observer = clients.pop().unwrap();
    let handles: Vec<_> = clients
        .into_iter()
        .zip(candidates)
        .map(|(mut client, (manifest, session))| {
            let expected = policy.head.clone();
            std::thread::spawn(move || client.publish_reviewed(&manifest, &expected, &session))
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(Error::HeadMoved)))
            .count(),
        1
    );
    let policy = observer.fetch_head(&profile).unwrap();
    assert_eq!(policy.head.revision, 1);
    let snapshot = observer.fetch_snapshot(&profile, &policy).unwrap().unwrap();
    assert_eq!(snapshot.head(), policy.head);
    observer.acknowledge(&profile, &policy.head).unwrap();
}
#[cfg(unix)]
#[test]
fn coordinator_persists_offline_capture_requires_review_and_never_auto_applies() {
    use attuner_sync_client::{BootstrapChoice, Coordinator};
    use attuner_sync_core::{
        Control, Engine,
        synchronization::{Binding, JobState},
    };
    let mut fixture = Fixture::with_blobs(true);
    let connection = fixture.connection();
    let server = connection.info.server_id.clone();
    let mut client = DeviceClient::open(connection, Arc::new(Memory::default())).unwrap();
    let enrollment = client
        .begin_enrollment("Coordinator fixture", "macos", "0.1.0")
        .unwrap();
    let approval =
        fixture.command(json!({"kind":"approve","enrollmentId":enrollment.enrollment_id}));
    client
        .accept_callback(approval["redirectUri"].as_str().unwrap())
        .unwrap();
    let control = Control::fixture();
    let mut engine = Engine::create_bound_fixture(1, &fixture.profile_id, &control).unwrap();
    engine
        .bind_remote(
            &Binding {
                server_id: server,
                origin: fixture.origin.clone(),
                profile_id: fixture.profile_id.clone(),
                policy_version: 1,
                roots: vec!["account".into(), "addons".into()],
            },
            &control,
        )
        .unwrap();
    assert_eq!(fixture.command(json!({"kind":"pause"}))["paused"], true);
    assert!(
        Coordinator::new(&mut engine, &mut client, &control)
            .unwrap()
            .prepare()
            .is_err()
    );
    let offline = engine.sync_jobs(&control).unwrap().remove(0);
    assert_eq!(offline.state, JobState::Offline);
    assert!(offline.data.local_snapshot.is_some());
    let path = engine.path().to_owned();
    drop(engine);
    let mut engine = Engine::reopen(&path, &control).unwrap();
    assert_eq!(fixture.command(json!({"kind":"resume"}))["resumed"], true);
    let mut coordinator = Coordinator::new(&mut engine, &mut client, &control).unwrap();
    let review = coordinator.resume_comparison(&offline.data.id).unwrap();
    assert_eq!(review.state, JobState::BootstrapReview);
    let selected = coordinator
        .choose_bootstrap(&review.data.id, BootstrapChoice::Local)
        .unwrap();
    let digest = coordinator.approval_digest(&selected.data.id).unwrap();
    drop(coordinator);
    let edited = path.join("installation/ProfileData/SavedVariables/bindings.txt");
    std::fs::write(&edited, b"offline and concurrent synthetic edit").unwrap();
    assert!(matches!(
        Coordinator::new(&mut engine, &mut client, &control)
            .unwrap()
            .publish_approved(&selected.data.id, &digest, |_, _| {}),
        Err(Error::StaleReview)
    ));
    assert_eq!(
        client
            .fetch_head(&fixture.profile_id)
            .unwrap()
            .head
            .revision,
        0
    );
    assert!(engine.remote_baseline(&control).unwrap().is_none());
    let mut coordinator = Coordinator::new(&mut engine, &mut client, &control).unwrap();
    let next = coordinator.prepare().unwrap();
    coordinator
        .choose_bootstrap(&next.data.id, BootstrapChoice::Local)
        .unwrap();
    let digest = coordinator.approval_digest(&next.data.id).unwrap();
    let published = coordinator
        .publish_approved(&next.data.id, &digest, |_, _| {})
        .unwrap();
    assert_eq!(published.state, JobState::RemoteCommitted);
    drop(coordinator);
    assert!(engine.remote_baseline(&control).unwrap().is_none());
    assert_eq!(
        std::fs::read(&edited).unwrap(),
        b"offline and concurrent synthetic edit"
    );
    let id = published.data.id;
    drop(engine);
    let mut engine = Engine::reopen(&path, &control).unwrap();
    assert_eq!(
        engine.sync_job(&id, &control).unwrap().state,
        JobState::RemoteCommitted
    );
    let applied = Coordinator::new(&mut engine, &mut client, &control)
        .unwrap()
        .apply_approved(&id, &digest, |_, _| {})
        .unwrap();
    assert_eq!(applied.state, JobState::AcknowledgementPending);
    assert_eq!(engine.pending_acknowledgements(&control).unwrap().len(), 1);
    assert_eq!(
        engine
            .remote_baseline(&control)
            .unwrap()
            .unwrap()
            .head
            .revision,
        1
    );
    assert_eq!(fixture.command(json!({"kind":"pause"}))["paused"], true);
    assert!(
        Coordinator::new(&mut engine, &mut client, &control)
            .unwrap()
            .acknowledge_pending()
            .is_err()
    );
    drop(engine);
    let mut engine = Engine::reopen(&path, &control).unwrap();
    assert_eq!(engine.pending_acknowledgements(&control).unwrap().len(), 1);
    assert_eq!(fixture.command(json!({"kind":"resume"}))["resumed"], true);
    assert_eq!(
        Coordinator::new(&mut engine, &mut client, &control)
            .unwrap()
            .acknowledge_pending()
            .unwrap(),
        1
    );
    assert_eq!(
        engine.sync_job(&id, &control).unwrap().state,
        JobState::Complete
    );
    assert!(
        engine
            .pending_acknowledgements(&control)
            .unwrap()
            .is_empty()
    );
    drop(engine);
    std::fs::remove_dir_all(path).unwrap();
}
#[cfg(unix)]
impl Fixture {
    fn enrolled_client(&mut self, name: &str) -> DeviceClient {
        let mut client =
            DeviceClient::open(self.connection(), Arc::new(Memory::default())).unwrap();
        let enrollment = client.begin_enrollment(name, "macos", "0.1.0").unwrap();
        let approval =
            self.command(json!({"kind":"approve","enrollmentId":enrollment.enrollment_id}));
        client
            .accept_callback(approval["redirectUri"].as_str().unwrap())
            .unwrap();
        client
    }
    fn bound_engine(&self) -> attuner_sync_core::Engine {
        use attuner_sync_core::{Control, Engine, synchronization::Binding};
        let mut engine =
            Engine::create_bound_fixture(1, &self.profile_id, &Control::fixture()).unwrap();
        engine
            .bind_remote(
                &Binding {
                    server_id: self.connection().info.server_id,
                    origin: self.origin.clone(),
                    profile_id: self.profile_id.clone(),
                    policy_version: 1,
                    roots: vec!["account".into(), "addons".into()],
                },
                &Control::fixture(),
            )
            .unwrap();
        engine
    }
}
#[cfg(unix)]
fn explicit_sync(
    engine: &mut attuner_sync_core::Engine,
    client: &mut DeviceClient,
    bootstrap: attuner_sync_client::BootstrapChoice,
) {
    use attuner_sync_client::Coordinator;
    use attuner_sync_core::{Control, synchronization::JobState};
    let control = Control::fixture();
    let mut coordinator = Coordinator::new(engine, client, &control).unwrap();
    let job = coordinator.prepare().unwrap();
    if job.state == JobState::BootstrapReview {
        coordinator
            .choose_bootstrap(&job.data.id, bootstrap)
            .unwrap();
    } else {
        assert_eq!(job.state, JobState::AwaitingApproval);
    }
    let digest = coordinator.approval_digest(&job.data.id).unwrap();
    coordinator
        .publish_approved(&job.data.id, &digest, |_, _| {})
        .unwrap();
    coordinator
        .apply_approved(&job.data.id, &digest, |_, _| {})
        .unwrap();
    assert_eq!(coordinator.acknowledge_pending().unwrap(), 1);
}
#[cfg(unix)]
#[test]
fn three_isolated_engines_reconcile_conflicts_offline_edits_corruption_and_failed_apply() {
    use attuner_sync_client::{BootstrapChoice, Coordinator};
    use attuner_sync_core::{
        Control, Point,
        synchronization::{Choice, Decision, JobState},
    };
    let mut fixture = Fixture::with_blobs(true);
    let mut a = fixture.enrolled_client("North synthetic desktop");
    let mut b = fixture.enrolled_client("West synthetic desktop");
    let mut c = fixture.enrolled_client("East synthetic desktop");
    let mut ea = fixture.bound_engine();
    let mut eb = fixture.bound_engine();
    let mut ec = fixture.bound_engine();
    let control = Control::fixture();
    explicit_sync(&mut ea, &mut a, BootstrapChoice::Local);
    explicit_sync(&mut eb, &mut b, BootstrapChoice::Remote);
    explicit_sync(&mut ec, &mut c, BootstrapChoice::Remote);
    let ap = ea.path().to_owned();
    let bp = eb.path().to_owned();
    let cp = ec.path().to_owned();
    let weak = "installation/ProfileData/SavedVariables/WeakAuras.lua";
    let bindings = "installation/ProfileData/SavedVariables/bindings.txt";
    std::fs::write(ap.join(weak), b"North concurrent original bytes\r\n").unwrap();
    std::fs::write(bp.join(weak), b"West concurrent original bytes\r\n").unwrap();
    std::fs::remove_file(cp.join(weak)).unwrap();
    let mut ca = Coordinator::new(&mut ea, &mut a, &control).unwrap();
    let ja = ca.prepare().unwrap();
    let da = ca.approval_digest(&ja.data.id).unwrap();
    drop(ca);
    let mut cb = Coordinator::new(&mut eb, &mut b, &control).unwrap();
    let jb = cb.prepare().unwrap();
    let db = cb.approval_digest(&jb.data.id).unwrap();
    drop(cb);
    let mut ca = Coordinator::new(&mut ea, &mut a, &control).unwrap();
    ca.publish_approved(&ja.data.id, &da, |_, _| {}).unwrap();
    ca.apply_approved(&ja.data.id, &da, |_, _| {}).unwrap();
    ca.acknowledge_pending().unwrap();
    drop(ca);
    assert!(matches!(
        Coordinator::new(&mut eb, &mut b, &control)
            .unwrap()
            .publish_approved(&jb.data.id, &db, |_, _| {}),
        Err(Error::HeadMoved)
    ));
    let mut cb = Coordinator::new(&mut eb, &mut b, &control).unwrap();
    let conflict = cb.prepare().unwrap();
    assert_eq!(conflict.state, JobState::ConflictReview);
    let conflicts = cb.conflicts(&conflict.data.id).unwrap();
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].change.path, "SavedVariables/WeakAuras.lua");
    assert!(
        conflicts[0].change.before.is_some()
            && conflicts[0].change.after.is_some()
            && conflicts[0].remote.is_some()
    );
    cb.resolve(
        &conflict.data.id,
        vec![Decision {
            root: "account".into(),
            path: "SavedVariables/WeakAuras.lua".into(),
            choice: Choice::Local,
        }],
    )
    .unwrap();
    let digest = cb.approval_digest(&conflict.data.id).unwrap();
    cb.publish_approved(&conflict.data.id, &digest, |_, _| {})
        .unwrap();
    cb.apply_approved(&conflict.data.id, &digest, |_, _| {})
        .unwrap();
    cb.acknowledge_pending().unwrap();
    drop(cb);
    let mut cc = Coordinator::new(&mut ec, &mut c, &control).unwrap();
    let conflict = cc.prepare().unwrap();
    assert_eq!(conflict.state, JobState::ConflictReview);
    let conflicts = cc.conflicts(&conflict.data.id).unwrap();
    assert!(conflicts[0].change.after.is_none() && conflicts[0].remote.is_some());
    cc.resolve(
        &conflict.data.id,
        vec![Decision {
            root: "account".into(),
            path: "SavedVariables/WeakAuras.lua".into(),
            choice: Choice::Remote,
        }],
    )
    .unwrap();
    let digest = cc.approval_digest(&conflict.data.id).unwrap();
    cc.publish_approved(&conflict.data.id, &digest, |_, _| {})
        .unwrap();
    cc.apply_approved(&conflict.data.id, &digest, |_, _| {})
        .unwrap();
    cc.acknowledge_pending().unwrap();
    drop(cc);
    assert_eq!(
        std::fs::read(cp.join(weak)).unwrap(),
        b"West concurrent original bytes\r\n"
    );
    std::fs::write(cp.join(bindings), b"East offline original bytes\r\n").unwrap();
    fixture.command(json!({"kind":"pause"}));
    assert!(
        Coordinator::new(&mut ec, &mut c, &control)
            .unwrap()
            .prepare()
            .is_err()
    );
    let offline = ec
        .sync_jobs(&control)
        .unwrap()
        .into_iter()
        .find(|j| j.state == JobState::Offline)
        .unwrap();
    fixture.command(json!({"kind":"resume"}));
    let mut cc = Coordinator::new(&mut ec, &mut c, &control).unwrap();
    assert_eq!(
        cc.resume_comparison(&offline.data.id).unwrap().state,
        JobState::AwaitingApproval
    );
    let digest = cc.approval_digest(&offline.data.id).unwrap();
    cc.publish_approved(&offline.data.id, &digest, |_, _| {})
        .unwrap();
    cc.apply_approved(&offline.data.id, &digest, |_, _| {})
        .unwrap();
    cc.acknowledge_pending().unwrap();
    drop(cc);
    // A server publication does not advance A's local baseline if application rolls back.
    let prior = ea.remote_baseline(&control).unwrap().unwrap().head;
    let failing = control.clone().with_observer(|event| {
        if event.point == Point::BeforeCommit {
            Err(attuner_sync_core::Error::Integrity(
                "synthetic interrupted application".into(),
            ))
        } else {
            Ok(())
        }
    });
    let mut ca = Coordinator::new(&mut ea, &mut a, &failing).unwrap();
    let job = ca.prepare().unwrap();
    let digest = ca.approval_digest(&job.data.id).unwrap();
    ca.publish_approved(&job.data.id, &digest, |_, _| {})
        .unwrap();
    let result = ca.apply_approved(&job.data.id, &digest, |_, _| {});
    let operation = match result {
        Err(Error::Engine(attuner_sync_core::Error::RecoveryRequired { operation, .. })) => {
            operation
        }
        other => panic!(
            "Expected recovery requirement, got {}",
            if other.is_ok() {
                "success"
            } else {
                "another error"
            }
        ),
    };
    drop(ca);
    assert!(ea.pending_acknowledgements(&control).unwrap().is_empty());
    assert_eq!(ea.remote_baseline(&control).unwrap().unwrap().head, prior);
    ea.recover(operation, &control).unwrap();
    assert_eq!(
        ea.sync_job(&job.data.id, &control).unwrap().state,
        JobState::Failed
    );
    assert_eq!(
        std::fs::read(ap.join(weak)).unwrap(),
        b"North concurrent original bytes\r\n"
    );
    // Malicious wire bytes retain a correct ETag/length but cannot enter the verified local CAS.
    let policy = b.fetch_head(&fixture.profile_id).unwrap();
    let remote = b
        .fetch_snapshot(&fixture.profile_id, &policy)
        .unwrap()
        .unwrap();
    let incoming = remote
        .manifest
        .files
        .iter()
        .find(|f| f.path == "SavedVariables/bindings.txt")
        .unwrap()
        .clone();
    let old_bindings = std::fs::read(bp.join(bindings)).unwrap();
    let mut cb = Coordinator::new(&mut eb, &mut b, &control).unwrap();
    let job = cb.prepare().unwrap();
    let digest = cb.approval_digest(&job.data.id).unwrap();
    cb.publish_approved(&job.data.id, &digest, |_, _| {})
        .unwrap();
    drop(cb);
    fixture.command(json!({"kind":"corruptWire","hash":incoming.hash}));
    assert!(
        Coordinator::new(&mut eb, &mut b, &control)
            .unwrap()
            .apply_approved(&job.data.id, &digest, |_, _| {})
            .is_err()
    );
    assert_eq!(std::fs::read(bp.join(bindings)).unwrap(), old_bindings);
    assert!(!eb.has_verified_blob(&incoming, &control).unwrap());
    fixture.command(json!({"kind":"corruptWire"}));
    eb.restart_download(&incoming, &control).unwrap();
    explicit_sync(&mut eb, &mut b, BootstrapChoice::Remote);
    assert_eq!(
        std::fs::read(bp.join(bindings)).unwrap(),
        b"East offline original bytes\r\n"
    );
    let local_before_revocation = ec.scan(&control).unwrap().manifest().clone();
    assert_eq!(
        fixture.command(json!({"kind":"revoke","deviceId":c.status().device_id}))["status"],
        200
    );
    assert!(matches!(
        Coordinator::new(&mut ec, &mut c, &control)
            .unwrap()
            .prepare(),
        Err(Error::Authentication)
    ));
    assert_eq!(
        ec.scan(&control).unwrap().manifest(),
        &local_before_revocation
    );
    assert_eq!(b.fetch_head(&fixture.profile_id).unwrap().head.revision, 4);
    drop(ea);
    drop(eb);
    drop(ec);
    for path in [ap, bp, cp] {
        std::fs::remove_dir_all(path).unwrap();
    }
}
#[cfg(unix)]
#[test]
fn lost_publication_response_recovers_original_fact_without_applying_over_new_edits() {
    use attuner_sync_client::{BootstrapChoice, Coordinator};
    use attuner_sync_core::{Control, Engine, synchronization::JobState};
    let mut fixture = Fixture::with_blobs(true);
    let mut client = fixture.enrolled_client("Lost response fixture");
    let mut engine = fixture.bound_engine();
    let control = Control::fixture();
    let mut coordinator = Coordinator::new(&mut engine, &mut client, &control).unwrap();
    let job = coordinator.prepare().unwrap();
    coordinator
        .choose_bootstrap(&job.data.id, BootstrapChoice::Local)
        .unwrap();
    let digest = coordinator.approval_digest(&job.data.id).unwrap();
    drop(coordinator);
    assert_eq!(
        fixture.command(json!({"kind":"loseCommitReply"}))["armed"],
        true
    );
    assert!(
        Coordinator::new(&mut engine, &mut client, &control)
            .unwrap()
            .publish_approved(&job.data.id, &digest, |_, _| {})
            .is_err()
    );
    let offline = engine.sync_job(&job.data.id, &control).unwrap();
    assert_eq!(offline.state, JobState::Offline);
    assert_eq!(offline.data.resume_state, Some(JobState::Publishing));
    let path = engine.path().to_owned();
    drop(engine);
    let mut engine = Engine::reopen(&path, &control).unwrap();
    let edited = path.join("installation/ProfileData/SavedVariables/bindings.txt");
    std::fs::write(
        &edited,
        b"new unrelated edit after publication response loss",
    )
    .unwrap();
    let mut coordinator = Coordinator::new(&mut engine, &mut client, &control).unwrap();
    let recovered = coordinator
        .publish_approved(&job.data.id, &digest, |_, _| {})
        .unwrap();
    assert_eq!(recovered.state, JobState::RemoteCommitted);
    assert_eq!(recovered.data.published_head.unwrap().revision, 1);
    assert!(matches!(
        coordinator.apply_approved(&job.data.id, &digest, |_, _| {}),
        Err(Error::StaleReview)
    ));
    drop(coordinator);
    assert_eq!(
        std::fs::read(edited).unwrap(),
        b"new unrelated edit after publication response loss"
    );
    assert!(engine.remote_baseline(&control).unwrap().is_none());
    assert!(
        engine
            .pending_acknowledgements(&control)
            .unwrap()
            .is_empty()
    );
    assert!(
        engine
            .observe_remote(
                &attuner_sync_core::synchronization::RemoteHead::empty(),
                &control
            )
            .is_err()
    );
    drop(engine);
    std::fs::remove_dir_all(path).unwrap();
}
