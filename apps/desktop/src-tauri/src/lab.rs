use attuner_sync_core::{Cancellation, CompleteScan, Control, Engine, Error, Verification};
use serde::Serialize;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
#[derive(Default)]
struct Session {
    engine: Option<Engine>,
    scan: Option<CompleteScan>,
    verification: Option<Verification>,
    scan_ms: f64,
}
#[derive(Default)]
pub struct LabState {
    session: Mutex<Session>,
    active: AtomicBool,
    cancellation: Mutex<Cancellation>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabError {
    code: String,
    message: String,
}
impl From<Error> for LabError {
    fn from(error: Error) -> Self {
        let code = match error {
            Error::Cancelled => "CANCELLED",
            Error::Busy => "BUSY",
            Error::GameState => "UNSAFE_RUNTIME",
            Error::PendingRecovery | Error::RecoveryRequired { .. } => "RECOVERY_REQUIRED",
            Error::NoSpace { .. } => "NO_SPACE",
            Error::Integrity(_) => "INTEGRITY",
            _ => "LOCAL_ENGINE_ERROR",
        };
        Self {
            code: code.into(),
            message: error.to_string(),
        }
    }
}
fn poisoned() -> LabError {
    LabError {
        code: "SESSION_UNAVAILABLE".into(),
        message: "The local fixture session is unavailable. Restart Attuner.".into(),
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRow {
    root: String,
    path: String,
    hash: String,
    size: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRow {
    root: String,
    path: String,
    kind: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRow {
    id: i64,
    label: String,
    files: usize,
    bytes: u64,
    created_at: i64,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabView {
    opened: bool,
    workspace_path: Option<String>,
    adapter_version: Option<u32>,
    sqlite_version: Option<String>,
    scanned: bool,
    files: usize,
    bytes: u64,
    scan_ms: f64,
    entries: Vec<FileRow>,
    changes: Vec<ChangeRow>,
    change_count: usize,
    snapshots: Vec<SnapshotRow>,
    verification: Option<Verification>,
    baseline_id: Option<i64>,
}
impl Session {
    fn view(&self, control: &Control) -> Result<LabView, LabError> {
        let Some(engine) = &self.engine else {
            return Ok(LabView::default());
        };
        let mut view = LabView {
            opened: true,
            workspace_path: Some(engine.path().to_string_lossy().into()),
            adapter_version: Some(engine.adapter().version),
            sqlite_version: Some(engine.sqlite_version().into()),
            scan_ms: self.scan_ms,
            verification: self.verification.clone(),
            ..LabView::default()
        };
        if let Some(scan) = &self.scan {
            view.scanned = true;
            view.files = scan.files;
            view.bytes = scan.bytes;
            view.entries = scan
                .manifest()
                .files
                .iter()
                .take(100)
                .map(|f| FileRow {
                    root: f.root.clone(),
                    path: f.path.clone(),
                    hash: f.hash.clone(),
                    size: f.size,
                })
                .collect();
            let changes = engine.changes(scan, control)?;
            view.change_count = changes.len();
            view.changes = changes
                .iter()
                .take(100)
                .map(|c| ChangeRow {
                    root: c.root.clone(),
                    path: c.path.clone(),
                    kind: c.kind().into(),
                })
                .collect();
        }
        view.baseline_id = engine.baseline(control)?.map(|s| s.id);
        view.snapshots = engine
            .snapshots(control)?
            .into_iter()
            .take(20)
            .map(|s| SnapshotRow {
                id: s.id,
                label: s.label.clone(),
                files: s.manifest().files.len(),
                bytes: s.manifest().files.iter().map(|f| f.size).sum(),
                created_at: s.created_at,
            })
            .collect();
        Ok(view)
    }
}
enum Action {
    Status,
    Create,
    Scan,
    Snapshot,
    Verify(i64),
}
async fn execute(state: Arc<LabState>, action: Action) -> Result<LabView, LabError> {
    if state
        .active
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(Error::Busy.into());
    }
    struct Active(Arc<LabState>);
    impl Drop for Active {
        fn drop(&mut self) {
            self.0.active.store(false, Ordering::SeqCst);
        }
    }
    let active = Active(state.clone());
    let cancellation = Cancellation::default();
    *state.cancellation.lock().map_err(|_| poisoned())? = cancellation.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _active = active;
        let mut control = Control::fixture();
        control.cancellation = cancellation;
        let mut session = state.session.lock().map_err(|_| poisoned())?;
        match action {
            Action::Status => {}
            Action::Create => {
                if session.engine.is_none() {
                    session.engine = Some(Engine::create_fixture(1, &control)?);
                }
            }
            Action::Scan => {
                let engine = session.engine.as_mut().ok_or_else(|| LabError {
                    code: "NO_WORKSPACE".into(),
                    message: "Create an isolated fixture workspace first.".into(),
                })?;
                let start = std::time::Instant::now();
                let result = engine.scan(&control)?;
                session.scan_ms = start.elapsed().as_secs_f64() * 1000.;
                session.scan = Some(result);
                session.verification = None;
            }
            Action::Snapshot => {
                let scan = session.scan.clone().ok_or_else(|| LabError {
                    code: "NO_SCAN".into(),
                    message: "Complete a fresh scan first.".into(),
                })?;
                let engine = session.engine.as_mut().ok_or_else(poisoned)?;
                engine.capture_snapshot(&scan, "Local fixture snapshot", &control)?;
                session.verification = None;
            }
            Action::Verify(id) => {
                let engine = session.engine.as_ref().ok_or_else(poisoned)?;
                session.verification = Some(engine.verify_snapshot(id, &control)?);
            }
        }
        let mut inspection = Control::fixture();
        inspection.runtime = control.runtime.clone();
        session.view(&inspection)
    })
    .await
    .map_err(|_| poisoned())?
}
#[tauri::command]
pub async fn local_lab_status(state: tauri::State<'_, Arc<LabState>>) -> Result<LabView, LabError> {
    execute(state.inner().clone(), Action::Status).await
}
#[tauri::command]
pub async fn local_lab_create(state: tauri::State<'_, Arc<LabState>>) -> Result<LabView, LabError> {
    execute(state.inner().clone(), Action::Create).await
}
#[tauri::command]
pub async fn local_lab_scan(state: tauri::State<'_, Arc<LabState>>) -> Result<LabView, LabError> {
    execute(state.inner().clone(), Action::Scan).await
}
#[tauri::command]
pub async fn local_lab_snapshot(
    state: tauri::State<'_, Arc<LabState>>,
) -> Result<LabView, LabError> {
    execute(state.inner().clone(), Action::Snapshot).await
}
#[tauri::command]
pub async fn local_lab_verify(
    snapshot_id: i64,
    state: tauri::State<'_, Arc<LabState>>,
) -> Result<LabView, LabError> {
    execute(state.inner().clone(), Action::Verify(snapshot_id)).await
}
#[tauri::command]
pub fn local_lab_cancel(state: tauri::State<'_, Arc<LabState>>) -> Result<bool, LabError> {
    state.cancellation.lock().map_err(|_| poisoned())?.cancel();
    Ok(state.active.load(Ordering::SeqCst))
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn native_summary_contains_real_bounded_results() {
        let control = Control::fixture();
        let mut engine = Engine::create_fixture(1, &control).unwrap();
        let home = engine.path().to_owned();
        for n in 0..105 {
            attuner_sync_core::write_synthetic_file(
                &engine,
                "account",
                &format!("extra-{n}.bin"),
                8,
                &control,
            )
            .unwrap();
        }
        let scan = engine.scan(&control).unwrap();
        let mut session = Session {
            engine: Some(engine),
            scan: Some(scan),
            ..Session::default()
        };
        let view = session.view(&control).unwrap();
        assert_eq!(view.files, 108);
        assert_eq!(view.entries.len(), 100);
        assert_eq!(view.change_count, 108);
        assert!(view.snapshots.is_empty());
        let scan = session.scan.clone().unwrap();
        session
            .engine
            .as_mut()
            .unwrap()
            .capture_snapshot(&scan, "Native test", &control)
            .unwrap();
        assert_eq!(session.view(&control).unwrap().change_count, 0);
        drop(session);
        std::fs::remove_dir_all(home).unwrap();
    }
}
