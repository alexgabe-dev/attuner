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
