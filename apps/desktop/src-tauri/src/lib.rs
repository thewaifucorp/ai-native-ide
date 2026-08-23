//! The privileged half of the desktop application.
//!
//! This crate deliberately exposes a small Tauri command surface. Workspace,
//! process, preview, and watch implementations are host extensions, not WebView
//! APIs: an untrusted renderer never supplies an executable, a shell command, or
//! an unrestricted filesystem path.

mod benchmark_preview;
mod bridge;
mod host;
mod model;
mod surface;

use std::sync::Arc;

use benchmark_preview::{BenchmarkPreviewHost, BenchmarkPreviewStatus};
use bridge::{
    AcpxTarget, AgentCapabilityCard, DesktopBridge, ProjectIntentInput, TrustedWorkspaceSelection,
    WorkspaceWriteRequest,
};
use ide_domain::{ProjectRecord, Resource, ResourceKind};
use model::{HostStatus, TauriViabilityReport};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

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
fn open_semantic_project(
    bridge: State<'_, Arc<DesktopBridge>>,
    project_id: String,
) -> Result<Option<ProjectRecord>, String> {
    bridge
        .open_project(&project_id)
        .map_err(|error| error.to_string())
}

/// The directory selector runs in the native host. The renderer can name the
/// semantic project/resource it wants to attach, but can never submit a path.
#[tauri::command]
async fn attach_workspace_from_picker(
    app: AppHandle,
    bridge: State<'_, Arc<DesktopBridge>>,
    project_id: String,
    resource_id: String,
) -> Result<Option<Resource>, String> {
    let Some(selected) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let selection = TrustedWorkspaceSelection::from_native_host(
        selected.into_path().map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let kind = if selection.root().join(".git").is_dir() {
        ResourceKind::Repository
    } else {
        ResourceKind::Directory
    };
    bridge
        .attach_workspace(&project_id, &resource_id, kind, selection)
        .await
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn propose_workspace_write(
    bridge: State<'_, Arc<DesktopBridge>>,
    project_id: String,
    request: WorkspaceWriteRequest,
) -> Result<serde_json::Value, String> {
    bridge
        .propose_write(&project_id, request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn approve_next_workspace_write(
    bridge: State<'_, Arc<DesktopBridge>>,
    project_id: String,
    resource_id: String,
) -> Result<i64, String> {
    bridge
        .approve_next_write(&project_id, &resource_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn rollback_workspace_write(
    bridge: State<'_, Arc<DesktopBridge>>,
    project_id: String,
    resource_id: String,
    effect_id: String,
) -> Result<(), String> {
    bridge
        .rollback_write(&project_id, &resource_id, &effect_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn start_benchmark_preview(
    bridge: State<'_, Arc<DesktopBridge>>,
    previews: State<'_, BenchmarkPreviewHost>,
    runtime: State<'_, HostRuntime>,
    project_id: String,
) -> Result<BenchmarkPreviewStatus, String> {
    if bridge
        .open_project(&project_id)
        .map_err(|error| error.to_string())?
        .is_none()
    {
        return Err("the requested semantic project does not exist".to_owned());
    }
    let status = previews
        .start(&project_id)
        .await
        .map_err(|error| error.to_string())?;
    runtime.publish(HostEvent::PreviewHealth {
        health: PreviewHealth::Healthy,
    });
    Ok(status)
}

#[tauri::command]
async fn stop_benchmark_preview(
    previews: State<'_, BenchmarkPreviewHost>,
    runtime: State<'_, HostRuntime>,
) -> Result<Option<BenchmarkPreviewStatus>, String> {
    let status = previews.stop().await;
    if status.is_some() {
        runtime.publish(HostEvent::PreviewHealth {
            health: PreviewHealth::Stopped,
        });
    }
    Ok(status)
}

#[tauri::command]
async fn agent_capability_card(
    bridge: State<'_, Arc<DesktopBridge>>,
    target: AcpxTarget,
) -> Result<AgentCapabilityCard, String> {
    Ok(bridge.agent_capability_card(target).await)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_directory = app.path().app_data_dir()?;
            app.manage(BenchmarkPreviewHost::open(
                data_directory.join("benchmark-previews"),
            )?);
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
            open_semantic_project,
            attach_workspace_from_picker,
            propose_workspace_write,
            approve_next_workspace_write,
            rollback_workspace_write,
            start_benchmark_preview,
            stop_benchmark_preview,
            agent_capability_card
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AI-Native IDE desktop host");
}
