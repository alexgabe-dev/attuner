mod connected;
mod diagnostics;
mod lab;
use serde::Serialize;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;
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
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state = connected::ConnectedState::new(app.path().app_data_dir()?)
                .map_err(std::io::Error::other)?;
            app.manage(state.clone());
            let handler = state.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handler.callback(url.to_string());
                }
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    state.callback(url.to_string());
                }
            }
            #[cfg(windows)]
            app.deep_link().register_all()?;
            Ok(())
        })
        .manage(std::sync::Arc::new(lab::LabState::default()))
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            diagnostics::diagnostics_preview,
            diagnostics::diagnostics_export,
            connected::sync_status,
            connected::sync_cancel,
            connected::sync_connect,
            connected::sync_enroll,
            connected::sync_finish,
            connected::sync_disconnect,
            connected::sync_remote,
            connected::sync_local,
            connected::sync_open_dashboard,
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
