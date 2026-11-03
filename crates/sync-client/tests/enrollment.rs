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
}
impl Fixture {
    fn start() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut child = Command::new("node")
            .arg(root.join("apps/api/src/testing/native-fixture.ts"))
            .current_dir(root)
            .env("ATTUNER_TEST_FIXTURE", "1")
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
        };
        let ready = f.read();
        f.origin = ready["origin"]
            .as_str()
            .expect("public fixture origin")
            .into();
        f.ca = ready["ca"].as_str().expect("public fixture CA").into();
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
