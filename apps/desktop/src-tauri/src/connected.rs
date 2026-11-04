//! Renderer capabilities are IDs and typed actions; all paths and credentials stay native.
use attuner_sync_client::{
    BootstrapChoice, Coordinator, DeviceClient, OsCredentialStore, ServerConnection,
};
use attuner_sync_core::{
    Cancellation, Control, Engine, FixtureRegistry,
    synchronization::{Binding, Decision, JobState, SyncJob},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::State;
use tauri_plugin_opener::OpenerExt;
type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicConnection {
    origin: String,
    ca: String,
    server_id: String,
}
struct Context {
    home: PathBuf,
    client: Option<DeviceClient>,
    registry: Option<FixtureRegistry>,
    preferences: Option<PublicConnection>,
}
pub struct ConnectedState {
    context: Mutex<Context>,
    busy: AtomicBool,
    callback_pending: AtomicBool,
    cancel: Mutex<Option<Cancellation>>,
    cached: RwLock<Value>,
}
impl ConnectedState {
    pub(crate) fn diagnostic_summary(&self) -> Result<crate::diagnostics::Summary> {
        let value = self.cached.read().map_err(|_| "Native host unavailable.")?;
        Ok(crate::diagnostics::Summary {
            connection_configured: value["connection"].is_object(),
            device_enrolled: value["device"]["enrolled"].as_bool().unwrap_or(false),
            enrollment_pending: value["device"]["enrollmentPending"]
                .as_bool()
                .unwrap_or(false),
            busy: self.busy.load(Ordering::Acquire),
            registered_synthetic_workspaces: value["fixtures"].as_array().map_or(0, Vec::len),
        })
    }
    pub fn new(home: PathBuf) -> Result<Arc<Self>> {
        std::fs::create_dir_all(&home).map_err(|_| "Cannot open Attuner application data.")?;
        let db = preferences(&home)?;
        let preferences = db
            .query_row("SELECT value FROM public_connection WHERE id=1", [], |r| {
                r.get::<_, String>(0)
            })
            .ok()
            .and_then(|v| serde_json::from_str(&v).ok());
        let registry = if cfg!(unix) {
            Some(FixtureRegistry::open(&home, &Control::fixture()).map_err(|e| e.to_string())?)
        } else {
            None
        };
        let result = Arc::new(Self {
            context: Mutex::new(Context {
                home,
                client: None,
                registry,
                preferences,
            }),
            busy: AtomicBool::new(false),
            callback_pending: AtomicBool::new(false),
            cancel: Mutex::new(None),
            cached: RwLock::new(json!({})),
        });
        result.refresh(&Control::fixture())?;
        Ok(result)
    }
    fn refresh(&self, control: &Control) -> Result<()> {
        let ctx = self
            .context
            .lock()
            .map_err(|_| "Native host unavailable.")?;
        let fixtures = ctx
            .registry
            .as_ref()
            .map(|r| r.list(control))
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        let value = json!({"connection":ctx.preferences,"device":ctx.client.as_ref().map(DeviceClient::status),"fixtures":fixtures,"localSupported":cfg!(unix)});
        *self
            .cached
            .write()
            .map_err(|_| "Native host unavailable.")? = value;
        Ok(())
    }
    pub fn callback(self: &Arc<Self>, value: String) {
        // Callback secrets never enter renderer events or logs. The client checks PKCE/state.
        if value.len() > 2048
            || !value.starts_with("app.attuner.desktop:/enrollment?")
            || self
                .callback_pending
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
        {
            return;
        }
        let state = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _pending = CallbackPending(state.clone());
            while state
                .busy
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            let _guard = Busy(state.clone());
            let result = state
                .context
                .lock()
                .map_err(|_| "Native host unavailable.".to_string())
                .and_then(|mut c| {
                    if c.client.is_none() {
                        let pref = c
                            .preferences
                            .as_ref()
                            .ok_or("Reconnect to finish enrollment.")?;
                        let connection = ServerConnection::connect(
                            &pref.origin,
                            (!pref.ca.is_empty()).then_some(pref.ca.as_str()),
                        )
                        .map_err(|e| e.to_string())?;
                        if connection.info.server_id != pref.server_id {
                            return Err("Server identity changed.".into());
                        }
                        c.client = Some(
                            DeviceClient::open(connection, Arc::new(OsCredentialStore::default()))
                                .map_err(|e| e.to_string())?,
                        );
                    }
                    c.client
                        .as_mut()
                        .ok_or("Connect to the server first.".into())
                        .and_then(|client| {
                            client
                                .accept_callback(&value)
                                .map(|_| ())
                                .map_err(|e| e.to_string())
                        })
                });
            let _ = state.refresh(&Control::fixture());
            if let Err(message) = result
                && let Ok(mut cached) = state.cached.write()
            {
                cached["error"] = json!(message);
            }
        });
    }
}
fn public_ca_only(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    if value.len() > 16384 {
        return false;
    }
    let mut inside = false;
    let mut certificates = 0;
    let mut body = false;
    for line in value.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line == "-----BEGIN CERTIFICATE-----" && !inside && certificates == 0 {
            inside = true;
        } else if line == "-----END CERTIFICATE-----" && inside && body {
            inside = false;
            certificates += 1;
        } else if inside
            && line.len() <= 128
            && line
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
        {
            body = true;
        } else {
            return false;
        }
    }
    !inside && certificates == 1
}
fn preferences(home: &std::path::Path) -> Result<rusqlite::Connection> {
    // Public origin, CA and server identity only. No token, proof key, PKCE or callback.
    let db = rusqlite::Connection::open(home.join("connection.sqlite"))
        .map_err(|_| "Cannot open connection preferences.")?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS public_connection(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);").map_err(|_|"Cannot initialize connection preferences.")?;
    Ok(db)
}
struct CallbackPending(Arc<ConnectedState>);
impl Drop for CallbackPending {
    fn drop(&mut self) {
        self.0.callback_pending.store(false, Ordering::SeqCst);
    }
}
fn phase(state: &ConnectedState, label: &str) {
    if let Ok(mut cached) = state.cached.write() {
        cached["progress"] = json!({"phase":label});
    }
}
struct Busy(Arc<ConnectedState>);
impl Drop for Busy {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::SeqCst);
        if let Ok(mut c) = self.0.cancel.lock() {
            *c = None;
        }
    }
}
async fn blocking<T: Send + 'static>(
    state: Arc<ConnectedState>,
    f: impl FnOnce(&mut Context, &Control, &Arc<ConnectedState>) -> Result<T> + Send + 'static,
) -> Result<T> {
    if state
        .busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Another foreground operation is active.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = Busy(state.clone());
        let progress = state.clone();
        let control = Control::fixture().with_observer(move |event| {
            if let Ok(mut cached) = progress.cached.write() {
                cached["progress"] =
                    json!({"phase":event.point,"index":event.index,"path":event.path});
            }
            Ok(())
        });
        *state
            .cancel
            .lock()
            .map_err(|_| "Native host unavailable.")? = Some(control.cancellation.clone());
        let result = {
            let mut ctx = state
                .context
                .lock()
                .map_err(|_| "Native host unavailable.")?;
            f(&mut ctx, &control, &state)
        };
        // A cancelled operation still refreshes durable state with a fresh control.
        let refreshed = state.refresh(&Control::fixture());
        match result {
            Ok(v) => {
                refreshed?;
                Ok(v)
            }
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|_| "Native worker failed.".to_string())?
}
#[tauri::command]
pub fn sync_status(state: State<'_, Arc<ConnectedState>>) -> Value {
    let mut value = state.cached.read().map(|v| v.clone()).unwrap_or(json!({}));
    value["busy"] = json!(state.busy.load(Ordering::SeqCst));
    value
}
#[tauri::command]
pub fn sync_cancel(state: State<'_, Arc<ConnectedState>>) {
    if let Ok(cancel) = state.cancel.lock()
        && let Some(c) = cancel.as_ref()
    {
        c.cancel();
    }
}
#[tauri::command]
pub async fn sync_connect(
    state: State<'_, Arc<ConnectedState>>,
    origin: String,
    ca: String,
) -> Result<Value> {
    blocking(state.inner().clone(), move |ctx, _, state| {
        if !public_ca_only(&ca) {
            return Err("Supply a public CA certificate only.".into());
        }
        phase(state, "Verifying server certificate");
        let connection = ServerConnection::connect(&origin, (!ca.is_empty()).then_some(ca.as_str()))
            .map_err(|e| e.to_string())?;
        if let Some(prior) = &ctx.preferences
            && prior.origin == connection.origin()
            && prior.server_id != connection.info.server_id
        {
            return Err("Server identity changed. Verify the server before forgetting this connection.".into());
        }
        let pref = PublicConnection {
            origin: connection.origin().into(), ca, server_id: connection.info.server_id.clone(),
        };
        phase(state, "Opening secure credential storage");
        let client = DeviceClient::open(connection, Arc::new(OsCredentialStore::default()))
            .map_err(|e| e.to_string())?;
        preferences(&ctx.home)?.execute(
            "INSERT INTO public_connection VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
            [serde_json::to_string(&pref).map_err(|_| "Invalid public preferences.")?],
        ).map_err(|_| "Cannot save public connection.")?;
        ctx.client = Some(client);
        ctx.preferences = Some(pref);
        Ok(json!({"connected": true}))
    }).await
}
#[tauri::command]
pub async fn sync_enroll(
    app: tauri::AppHandle,
    state: State<'_, Arc<ConnectedState>>,
    name: String,
) -> Result<Value> {
    blocking(state.inner().clone(), move |ctx, _, _| {
        let os = if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(windows) {
            "windows"
        } else {
            "linux"
        };
        let enrollment = client(ctx)?
            .begin_enrollment(&name, os, env!("CARGO_PKG_VERSION"))
            .map_err(|e| e.to_string())?;
        app.opener()
            .open_url(enrollment.authorization_url, None::<&str>)
            .map_err(|_| "Cannot open the enrollment browser.")?;
        Ok(json!({"pending":true}))
    })
    .await
}
#[tauri::command]
pub async fn sync_finish(state: State<'_, Arc<ConnectedState>>) -> Result<Value> {
    blocking(state.inner().clone(), |ctx, _, _| {
        client(ctx)?
            .finish_enrollment()
            .map(|v| json!(v))
            .map_err(|e| e.to_string())
    })
    .await
}
#[tauri::command]
pub async fn sync_disconnect(
    state: State<'_, Arc<ConnectedState>>,
    forget_only: bool,
) -> Result<Value> {
    blocking(state.inner().clone(), move |ctx, _, _| {
        if forget_only {
            if let Some(c) = ctx.client.take() {
                c.erase_local_credential().map_err(|e| e.to_string())?;
            } else if let Some(pref) = &ctx.preferences {
                DeviceClient::erase_saved_credential(
                    &pref.origin,
                    &pref.server_id,
                    &OsCredentialStore::default(),
                )
                .map_err(|e| e.to_string())?;
            }
        } else {
            client(ctx)?.sign_out().map_err(|e| e.to_string())?;
            ctx.client = None;
        }
        preferences(&ctx.home)?
            .execute("DELETE FROM public_connection", [])
            .map_err(|_| "Cannot clear public connection.")?;
        ctx.preferences = None;
        Ok(json!({"disconnected":true}))
    })
    .await
}
fn client(ctx: &mut Context) -> Result<&mut DeviceClient> {
    ctx.client
        .as_mut()
        .ok_or("Connect to the server first.".into())
}
fn uuid(value: &str) -> Result<()> {
    uuid::Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| "Invalid identifier.".into())
}
#[derive(Deserialize)]
#[serde(tag = "view", rename_all = "camelCase", deny_unknown_fields)]
pub enum RemoteView {
    Profiles,
    Head {
        profile: String,
    },
    Devices {
        profile: String,
    },
    Snapshots {
        profile: String,
        before: Option<u64>,
    },
    Snapshot {
        profile: String,
        snapshot: String,
    },
    Jobs {
        profile: String,
        before: Option<u64>,
    },
    Activity {
        profile: String,
        before: Option<u64>,
    },
    Conflicts {
        profile: String,
        job: String,
        offset: Option<u64>,
    },
    Proposals {
        profile: String,
        job: String,
    },
    Preview {
        profile: String,
        snapshot: String,
        root: String,
        path: String,
    },
}
impl RemoteView {
    fn path(self) -> Result<String> {
        let (profile, tail) = match self {
            Self::Profiles => return Ok("/api/v1/profiles".into()),
            Self::Head { profile } => (profile, "head".into()),
            Self::Devices { profile } => (profile, "devices".into()),
            Self::Snapshots { profile, before } => (
                profile,
                format!("snapshots?before={}", before.unwrap_or(9007199254740991)),
            ),
            Self::Snapshot { profile, snapshot } => {
                uuid(&snapshot)?;
                (profile, format!("snapshots/{snapshot}"))
            }
            Self::Jobs { profile, before } => (
                profile,
                format!("jobs?before={}", before.unwrap_or(9007199254740991)),
            ),
            Self::Activity { profile, before } => (
                profile,
                format!("activity?before={}", before.unwrap_or(9007199254740991)),
            ),
            Self::Conflicts {
                profile,
                job,
                offset,
            } => {
                uuid(&job)?;
                (
                    profile,
                    format!("jobs/{job}/conflicts?offset={}", offset.unwrap_or(0)),
                )
            }
            Self::Proposals { profile, job } => {
                uuid(&job)?;
                (profile, format!("jobs/{job}/proposals"))
            }
            Self::Preview {
                profile,
                snapshot,
                root,
                path,
            } => {
                uuid(&snapshot)?;
                if !matches!(root.as_str(), "account" | "addons" | "character") || path.len() > 1024
                {
                    return Err("Invalid preview.".into());
                }
                (
                    profile,
                    format!(
                        "snapshots/{snapshot}/preview?root={root}&path={}",
                        percent(&path)
                    ),
                )
            }
        };
        uuid(&profile)?;
        Ok(format!("/api/v1/profiles/{profile}/{tail}"))
    }
}
fn percent(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
#[tauri::command]
pub async fn sync_remote(
    state: State<'_, Arc<ConnectedState>>,
    request: RemoteView,
) -> Result<Value> {
    blocking(state.inner().clone(), move |ctx, _, _| {
        client(ctx)?
            .request("GET", &request.path()?, None, None)
            .map_err(|e| e.to_string())
    })
    .await
}
#[tauri::command]
pub async fn sync_open_dashboard(
    app: tauri::AppHandle,
    state: State<'_, Arc<ConnectedState>>,
) -> Result<()> {
    blocking(state.inner().clone(), move |ctx, _, _| {
        let url = format!("{}/devices", client(ctx)?.connection.origin());
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|_| "Cannot open dashboard.".into())
    })
    .await
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum LocalAction {
    Create {
        profile: String,
        adapter: u32,
    },
    Inspect {
        fixture: String,
    },
    Prepare {
        fixture: String,
    },
    Resume {
        fixture: String,
        job: String,
    },
    Bootstrap {
        fixture: String,
        job: String,
        choice: BootstrapChoice,
    },
    Resolve {
        fixture: String,
        job: String,
        decisions: Vec<Decision>,
    },
    AcceptProposal {
        fixture: String,
        job: String,
        proposal: String,
    },
    Publish {
        fixture: String,
        job: String,
        digest: String,
    },
    Apply {
        fixture: String,
        job: String,
        digest: String,
    },
    Conflicts {
        fixture: String,
        job: String,
        offset: usize,
    },
    Acknowledge {
        fixture: String,
    },
    Cancel {
        fixture: String,
        job: String,
    },
    Recover {
        fixture: String,
        operation: i64,
    },
    Verify {
        fixture: String,
        snapshot: i64,
    },
}
fn conflict_view(c: attuner_sync_core::compare::Conflict) -> Value {
    let group = if c.reason.contains("group") {
        c.change
            .after
            .as_ref()
            .or(c.change.before.as_ref())
            .or(c.remote.as_ref())
            .map(|f| f.group.clone())
    } else {
        None
    };
    json!({
        "root": c.change.root, "path": c.change.path,
        "baseline": c.change.before, "local": c.change.after,
        "remote": c.remote, "group": group, "reason": c.reason,
    })
}
fn job_view(engine: &Engine, job: &SyncJob, control: &Control) -> Result<Value> {
    let digest = if matches!(
        job.state,
        JobState::AwaitingApproval
            | JobState::RemoteCommitted
            | JobState::Offline
            | JobState::Transferring
            | JobState::Publishing
    ) {
        engine.sync_review_digest(&job.data.id, control).ok()
    } else {
        None
    };
    let local = job
        .data
        .local_snapshot
        .and_then(|id| engine.snapshot(id, control).ok());
    let proposed = job.data.proposed.as_ref();
    let conflicts = if job.state == JobState::ConflictReview {
        let baseline = engine
            .snapshot(
                job.data.baseline_snapshot.ok_or("Baseline unavailable.")?,
                control,
            )
            .map_err(|e| e.to_string())?;
        let merge = engine
            .compare_captured(
                job.data.local_snapshot.ok_or("Capture unavailable.")?,
                baseline.manifest(),
                job.data
                    .remote_manifest
                    .as_ref()
                    .ok_or("Remote comparison unavailable.")?,
                control,
            )
            .map_err(|e| e.to_string())?;
        merge
            .conflicts
            .into_iter()
            .map(conflict_view)
            .collect::<Vec<_>>()
    } else {
        vec![]
    };
    let changes = proposed
        .map(|target| changed_files(local.as_ref().map(|s| s.manifest()), target))
        .unwrap_or_default();
    let publication_changes = proposed
        .map(|target| changed_files(job.data.remote_manifest.as_ref(), target))
        .unwrap_or_default();
    let conflict_total = conflicts.len();
    Ok(
        json!({"conflictTotal":conflict_total,"conflicts":conflicts.into_iter().take(200).collect::<Vec<_>>(),"id":job.data.id,"state":job.state,"resumeState":job.data.resume_state,"generation":job.generation,"reason":job.data.reason,"publishedHead":job.data.published_head,"remoteHead":job.data.remote.as_ref().map(|r|&r.head),"digest":digest,"localFiles":local.as_ref().map(|s|s.manifest().files.len()),"candidateFiles":proposed.map(|m|m.files.len()),"changeCount":changes.len(),"changes":changes.into_iter().take(200).collect::<Vec<_>>(),"publicationChangeCount":publication_changes.len(),"publicationChanges":publication_changes.into_iter().take(200).collect::<Vec<_>>()}),
    )
}
fn changed_files(
    before: Option<&attuner_sync_core::Manifest>,
    target: &attuner_sync_core::Manifest,
) -> Vec<Value> {
    let prior: std::collections::BTreeMap<_, _> = before
        .into_iter()
        .flat_map(|m| &m.files)
        .map(|f| ((f.root.as_str(), f.path.as_str()), f))
        .collect();
    let after: std::collections::BTreeMap<_, _> = target
        .files
        .iter()
        .map(|f| ((f.root.as_str(), f.path.as_str()), f))
        .collect();
    let keys: std::collections::BTreeSet<_> = prior.keys().chain(after.keys()).copied().collect();
    keys.into_iter().filter_map(|(root,path)|{let a=prior.get(&(root,path));let b=after.get(&(root,path));(a.map(|f|(&f.hash,f.size))!=b.map(|f|(&f.hash,f.size))).then(||json!({"root":root,"path":path,"kind":if a.is_none(){"added"}else if b.is_none(){"removed"}else{"modified"}}))}).collect()
}

fn inspect(engine: &Engine, control: &Control) -> Result<Value> {
    let jobs = engine
        .active_sync_job(control)
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect::<Vec<_>>();
    let views = jobs
        .iter()
        .map(|j| job_view(engine, j, control))
        .collect::<Result<Vec<_>>>()?;
    let snapshots = engine
        .snapshot_summaries(control)
        .map_err(|e| e.to_string())?;
    Ok(
        json!({"jobs":views,"snapshots":snapshots,"operations":engine.operations(control).map_err(|e|e.to_string())?,"pendingAcknowledgements":engine.pending_acknowledgements(control).map_err(|e|e.to_string())?.len()}),
    )
}
#[tauri::command]
pub async fn sync_local(
    state: State<'_, Arc<ConnectedState>>,
    request: LocalAction,
) -> Result<Value> {
    blocking(state.inner().clone(), move |ctx, control, state| {
        if let LocalAction::Create { profile, adapter } = request {
            uuid(&profile)?;
            let c = client(ctx)?;
            let head = c.fetch_head(&profile).map_err(|e| e.to_string())?;
            let binding = Binding {
                server_id: c.connection.info.server_id.clone(),
                origin: c.connection.origin().into(),
                profile_id: profile.clone(),
                policy_version: head.policy_version,
                roots: head.roots,
            };
            let (_, mut engine) = ctx
                .registry
                .as_mut()
                .ok_or("Local filesystem operations await Windows qualification.")?
                .create_fixture(adapter, &profile, control)
                .map_err(|e| e.to_string())?;
            engine
                .bind_remote(&binding, control)
                .map_err(|e| e.to_string())?;
            return inspect(&engine, control);
        }
        let fixture = match &request {
            LocalAction::Create { .. } => unreachable!(),
            LocalAction::Inspect { fixture }
            | LocalAction::Prepare { fixture }
            | LocalAction::Resume { fixture, .. }
            | LocalAction::Bootstrap { fixture, .. }
            | LocalAction::Resolve { fixture, .. }
            | LocalAction::AcceptProposal { fixture, .. }
            | LocalAction::Publish { fixture, .. }
            | LocalAction::Apply { fixture, .. }
            | LocalAction::Conflicts { fixture, .. }
            | LocalAction::Acknowledge { fixture }
            | LocalAction::Cancel { fixture, .. }
            | LocalAction::Recover { fixture, .. }
            | LocalAction::Verify { fixture, .. } => fixture,
        };
        uuid(fixture)?;
        let mut engine = ctx
            .registry
            .as_ref()
            .ok_or("Local filesystem operations await Windows qualification.")?
            .reopen(fixture, control)
            .map_err(|e| e.to_string())?;
        match request {
            LocalAction::Inspect { .. } => return inspect(&engine, control),
            LocalAction::Conflicts { job, offset, .. } => {
                if offset > 100000 {
                    return Err("Conflict offset exceeds the supported limit.".into());
                }
                let captured = engine.sync_job(&job, control).map_err(|e| e.to_string())?;
                let mut view = job_view(&engine, &captured, control)?;
                // The initial view is bounded, so compute the requested slice from the engine.
                let baseline = engine
                    .snapshot(
                        captured.data.baseline_snapshot.ok_or("No baseline.")?,
                        control,
                    )
                    .map_err(|e| e.to_string())?;
                let all = engine
                    .compare_captured(
                        captured.data.local_snapshot.ok_or("No capture.")?,
                        baseline.manifest(),
                        captured
                            .data
                            .remote_manifest
                            .as_ref()
                            .ok_or("No comparison.")?,
                        control,
                    )
                    .map_err(|e| e.to_string())?
                    .conflicts;
                view["conflicts"] = json!(
                    all.into_iter()
                        .skip(offset)
                        .take(200)
                        .map(conflict_view)
                        .collect::<Vec<_>>()
                );
                return Ok(view);
            }
            LocalAction::Verify { snapshot, .. } => {
                return engine
                    .verify_snapshot(snapshot, control)
                    .map(|v| json!(v))
                    .map_err(|e| e.to_string());
            }
            LocalAction::Recover { operation, .. } => {
                engine
                    .recover(operation, control)
                    .map_err(|e| e.to_string())?;
                return inspect(&engine, control);
            }
            _ => {}
        }
        let mut coordinator =
            Coordinator::new(&mut engine, client(ctx)?, control).map_err(|e| e.to_string())?;
        let progress = |file: &attuner_sync_core::ManifestFile,
                        p: attuner_sync_client::TransferProgress| {
            if let Ok(mut cached) = state.cached.write() {
                cached["progress"] = json!({"phase":"transfer","path":file.path,"transfer":p});
            }
        };
        let job = match request {
            LocalAction::Prepare { .. } => Some(coordinator.prepare()),
            LocalAction::Resume { job, .. } => Some(coordinator.resume_comparison(&job)),
            LocalAction::Bootstrap { job, choice, .. } => {
                Some(coordinator.choose_bootstrap(&job, choice))
            }
            LocalAction::Resolve { job, decisions, .. } => {
                Some(coordinator.resolve(&job, decisions))
            }
            LocalAction::AcceptProposal { job, proposal, .. } => {
                Some(coordinator.accept_web_proposal(&job, &proposal))
            }
            LocalAction::Publish { job, digest, .. } => {
                Some(coordinator.publish_approved(&job, &digest, progress))
            }
            LocalAction::Apply { job, digest, .. } => {
                Some(coordinator.apply_approved(&job, &digest, progress))
            }
            LocalAction::Cancel { job, .. } => Some(coordinator.cancel(&job)),
            LocalAction::Acknowledge { .. } => {
                coordinator
                    .acknowledge_pending()
                    .map_err(|e| e.to_string())?;
                None
            }
            _ => None,
        };
        if let Some(result) = job {
            result.map_err(|e| e.to_string())?;
        }
        inspect(&engine, control)
    })
    .await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_preferences_cannot_store_a_pasted_private_key_or_trailing_secret() {
        let certificate = "-----BEGIN CERTIFICATE-----\ndGVzdA==\n-----END CERTIFICATE-----\n";
        assert!(public_ca_only(certificate));
        assert!(public_ca_only(""));
        assert!(!public_ca_only(
            &(certificate.to_owned() + "password=not-a-certificate")
        ));
        assert!(!public_ca_only(
            &(certificate.to_owned()
                + "-----BEGIN PRIVATE KEY-----\ndGVzdA==\n-----END PRIVATE KEY-----")
        ));
        assert!(!public_ca_only(
            "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----"
        ));
    }
    #[test]
    fn renderer_reads_have_no_ambient_url_or_filesystem_capability() {
        assert!(
            serde_json::from_value::<RemoteView>(
                json!({"view":"fetch","url":"file:///etc/passwd"})
            )
            .is_err()
        );
        assert!(
            RemoteView::Snapshot {
                profile: "../x".into(),
                snapshot: uuid::Uuid::new_v4().to_string()
            }
            .path()
            .is_err()
        );
        let p = RemoteView::Preview {
            profile: uuid::Uuid::new_v4().to_string(),
            snapshot: uuid::Uuid::new_v4().to_string(),
            root: "account".into(),
            path: "x?y&z/../a.lua".into(),
        }
        .path()
        .unwrap();
        assert!(p.contains("x%3Fy%26z%2F..%2Fa.lua"));
        assert!(
            serde_json::from_value::<LocalAction>(
                json!({"action":"apply","fixture":"x","job":"y","digest":"z","path":"/tmp"})
            )
            .is_err()
        );
    }
}
