//! The privileged half of the desktop application.
//!
//! This crate deliberately exposes a small Tauri command surface. Workspace,
//! process, preview, and watch implementations are host extensions, not WebView
//! APIs: an untrusted renderer never supplies an executable, a shell command, or
//! an unrestricted filesystem path.

mod bridge;
mod host;
mod model;
mod surface;

use std::sync::Arc;

use bridge::{AcpxTarget, AgentCapabilityCard, DesktopBridge, ProjectIntentInput};
use model::{HostStatus, TauriViabilityReport};
use tauri::{AppHandle, Emitter, Manager, State};

pub use host::{
    ActiveWatch, HostEvent, HostExtension, HostRuntime, ManagedProcess, ManagedPty,
    PreviewSupervisor, ProcessLifecycle, TrustedProcessSpec, WatchScope,
};
pub use model::{HostSurface, PreviewHealth, ViabilityGate, ViabilityGateStatus};

const HOST_EVENT: &str = "ide://host-event";

#[tauri::command]
fn host_status() -> HostStatus {
    HostStatus::current()
}

#[tauri::command]
fn host_viability_report() -> TauriViabilityReport {
    TauriViabilityReport::current()
}

/// Opens an explicitly named surface. It intentionally accepts no URL or
/// filesystem location from the renderer; every surface remains inside the
/// bundled frontend origin.
#[tauri::command]
fn open_surface(app: AppHandle, surface: HostSurface) -> Result<(), String> {
    surface::open(&app, surface).map_err(|error| error.to_string())
}

/// An observable probe proves the native event bridge without granting a
/// renderer a privileged operation. Real host extensions use the same stream.
#[tauri::command]
fn emit_host_probe(runtime: State<'_, HostRuntime>) {
    runtime.publish(HostEvent::HostProbe {
        message: "renderer-to-host event bridge is operational".into(),
    });
}

#[tauri::command]
fn create_semantic_project(
    bridge: State<'_, Arc<DesktopBridge>>,
    input: ProjectIntentInput,
) -> Result<ide_domain::ProjectRecord, String> {
    bridge
        .create_project(input)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn agent_capability_card(
    bridge: State<'_, Arc<DesktopBridge>>,
    target: AcpxTarget,
) -> AgentCapabilityCard {
    bridge.agent_capability_card(target).await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_directory = app.path().app_data_dir()?;
            app.manage(Arc::new(DesktopBridge::open(
                data_directory,
                "local.owner",
            )?));
            surface::install_menu(app)?;
            let handle = app.handle().clone();
            app.manage(HostRuntime::new(Arc::new(move |event| {
                if let Err(error) = handle.emit(HOST_EVENT, event) {
                    eprintln!("could not publish host event: {error}");
                }
            })));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host_status,
            host_viability_report,
            open_surface,
            emit_host_probe,
            create_semantic_project,
            agent_capability_card
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AI-Native IDE desktop host");
}
