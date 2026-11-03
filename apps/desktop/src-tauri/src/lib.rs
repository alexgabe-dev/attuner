mod lab;
use serde::Serialize;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: &'static str,
    protocol_version: u32,
    mode: &'static str,
}
#[tauri::command]
fn get_app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        protocol_version: attuner_sync_core::PROTOCOL_VERSION,
        mode: "local-fixture-engine",
    }
}
pub fn run() {
    tauri::Builder::default()
        .manage(std::sync::Arc::new(lab::LabState::default()))
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            lab::local_lab_status,
            lab::local_lab_create,
            lab::local_lab_scan,
            lab::local_lab_snapshot,
            lab::local_lab_verify,
            lab::local_lab_cancel
        ])
        .run(tauri::generate_context!())
        .expect("Unable to launch Attuner");
}
