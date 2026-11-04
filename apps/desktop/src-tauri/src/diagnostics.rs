//! Explicit metadata export. No path/message/log/configuration/credential input.
use crate::connected::ConnectedState;
use serde::Serialize;
use serde_json::{Value, json};
use std::{fs::OpenOptions, io::Write, sync::Arc};
use tauri::State;
use tauri_plugin_opener::OpenerExt;

pub(crate) struct Summary {
    pub connection_configured: bool,
    pub device_enrolled: bool,
    pub enrollment_pending: bool,
    pub busy: bool,
    pub registered_synthetic_workspaces: usize,
}
fn report(summary: Summary) -> Value {
    json!({"schemaVersion":1,"applicationVersion":env!("CARGO_PKG_VERSION"),
        "protocolVersion":attuner_sync_core::PROTOCOL_VERSION,"namespaceVersion":1,
        "surface":"desktop","system":{"os":std::env::consts::OS,"architecture":std::env::consts::ARCH},
        "connectionConfigured":summary.connection_configured,"deviceEnrolled":summary.device_enrolled,
        "enrollmentPending":summary.enrollment_pending,"busy":summary.busy,
        "counts":{"registeredSyntheticWorkspaces":summary.registered_synthetic_workspaces},
        "safety":{"realInstallationsEnabled":false,"automaticSynchronizationEnabled":false,
            "windowsFilesystemApplyEnabled":false,"experimentalPacksEnabled":false}})
}
#[tauri::command]
pub fn diagnostics_preview(state: State<'_, Arc<ConnectedState>>) -> Result<Value, String> {
    Ok(report(state.diagnostic_summary()?))
}
fn write_private(report: &Value) -> std::io::Result<tempfile::TempDir> {
    let mut builder = tempfile::Builder::new();
    builder.prefix("attuner-diagnostics-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    let directory = builder.tempdir()?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(directory.path().join("attuner-diagnostics.json"))?;
    let bytes = serde_json::to_vec_pretty(report)?;
    if bytes.len() > 8192 {
        return Err(std::io::Error::other("Diagnostic size limit"));
    }
    output.write_all(&bytes)?;
    output.write_all(b"\n")?;
    output.sync_all()?;
    #[cfg(unix)]
    std::fs::File::open(directory.path())?.sync_all()?;
    Ok(directory)
}
#[derive(Serialize)]
pub struct Exported {
    saved: bool,
    revealed: bool,
}
#[tauri::command]
pub fn diagnostics_export(
    app: tauri::AppHandle,
    state: State<'_, Arc<ConnectedState>>,
) -> Result<Exported, String> {
    // Rebuild the same allowlist from native state. Renderer-supplied JSON or
    // filesystem destinations are never accepted, even after preview.
    let directory = write_private(&report(state.diagnostic_summary()?))
        .map_err(|_| "Could not save the private diagnostic report.")?;
    let destination = directory.keep().join("attuner-diagnostics.json");
    let revealed = app.opener().reveal_item_in_dir(destination).is_ok();
    Ok(Exported {
        saved: true,
        revealed,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_export_contains_only_metadata_and_uses_a_new_private_file() {
        let report = report(Summary {
            connection_configured: true,
            device_enrolled: false,
            enrollment_pending: false,
            busy: true,
            registered_synthetic_workspaces: 3,
        });
        let directory = write_private(&report).unwrap();
        let bytes = std::fs::read(directory.path().join("attuner-diagnostics.json")).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), report);
        assert_eq!(report["counts"]["registeredSyntheticWorkspaces"], 3);
        assert_eq!(report["safety"]["windowsFilesystemApplyEnabled"], false);
        assert!(
            !String::from_utf8(bytes)
                .unwrap()
                .contains(directory.path().to_str().unwrap())
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(directory.path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(directory.path().join("attuner-diagnostics.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
