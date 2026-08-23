//! The privileged half of the desktop application.
//!
//! This crate deliberately exposes a small Tauri command surface. Workspace,
//! process, preview, and watch implementations are host extensions, not WebView
//! APIs: an untrusted renderer never supplies an executable, a shell command, or
//! an unrestricted filesystem path.

mod benchmark_preview;
mod bridge;
#[cfg(test)]
mod golden_journey;
mod host;
mod model;
mod surface;

use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use benchmark_preview::{
    BenchmarkPreviewHost, BenchmarkPreviewStatus, PreviewFailureReport, PreviewReconciliationAction,
};
use bridge::{
    AcpxTarget, AgentCapabilityCard, AgentTaskRequest, DesktopBridge, ProjectIntentInput,
    StartedAgentSession, TrustedWorkspaceSelection, WorkspaceWriteRequest,
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

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalRunStatus {
    terminal_id: String,
    state: &'static str,
    detail: &'static str,
}

/// Retains host-created PTYs so an explicit cancel always reaches the child.
/// The renderer sees only an opaque ID and cannot provide an executable/path.
struct TerminalRegistry {
    next_id: AtomicU64,
    sessions: Mutex<BTreeMap<String, ManagedPty>>,
}

impl TerminalRegistry {
    fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            sessions: Mutex::new(BTreeMap::new()),
        }
    }
}

impl Drop for TerminalRegistry {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.get_mut() {
            for terminal in sessions.values_mut() {
                let _ = terminal.stop();
            }
        }
    }
}

#[tauri::command]
async fn start_workspace_inspection(
    bridge: State<'_, Arc<DesktopBridge>>,
    runtime: State<'_, HostRuntime>,
    terminals: State<'_, TerminalRegistry>,
    project_id: String,
    resource_id: String,
) -> Result<TerminalRunStatus, String> {
    let root = bridge
        .workspace_root(&project_id, &resource_id)
        .await
        .map_err(|error| error.to_string())?;
    let scope = WatchScope::from_project_resource(root).map_err(|error| error.to_string())?;
    let executable = registered_git_executable().map_err(|error| error.to_string())?;
    let spec =
        TrustedProcessSpec::for_registered_extension(executable, ["status", "--short"], &scope)
            .map_err(|error| error.to_string())?;
    let pty = runtime
        .spawn_pty(spec, 24, 120)
        .map_err(|error| error.to_string())?;
    let terminal_id = format!(
        "terminal-{}",
        terminals.next_id.fetch_add(1, Ordering::Relaxed)
    );
    terminals
        .sessions
        .lock()
        .expect("terminal registry lock poisoned")
        .insert(terminal_id.clone(), pty);
    Ok(TerminalRunStatus {
        terminal_id,
        state: "running",
        detail: "A inspeção usa um PTY do host e git status --short no recurso anexado.",
    })
}

#[tauri::command]
fn cancel_workspace_inspection(
    terminals: State<'_, TerminalRegistry>,
    terminal_id: String,
) -> Result<(), String> {
    let mut terminal = terminals
        .sessions
        .lock()
        .expect("terminal registry lock poisoned")
        .remove(&terminal_id)
        .ok_or_else(|| "unknown IDE-owned terminal session".to_owned())?;
    terminal.stop().map_err(|error| error.to_string())
}

fn registered_git_executable() -> std::io::Result<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["git.exe"]
    } else {
        &["git"]
    };
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        for name in names {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return candidate.canonicalize();
            }
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "registered Git executable was not found in PATH",
    ))
}

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

/// A user-triggered gate probe: it stops the host-owned preview and records the
/// *actual* refused health connection against the exact approved effect.
#[tauri::command]
async fn stop_and_capture_benchmark_preview_failure(
    bridge: State<'_, Arc<DesktopBridge>>,
    previews: State<'_, BenchmarkPreviewHost>,
    runtime: State<'_, HostRuntime>,
    project_id: String,
    resource_id: String,
    effect_id: String,
) -> Result<Option<PreviewFailureReport>, String> {
    let project = bridge
        .open_project(&project_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "the requested semantic project does not exist".to_owned())?;
    let causal_links = bridge
        .effect_causal_links(&project_id, &resource_id, &effect_id)
        .await
        .map_err(|error| error.to_string())?;
    let failure = previews
        .stop_and_capture_health_failure(causal_links, &project.intent)
        .await
        .map_err(|error| error.to_string())?;
    if failure.is_some() {
        runtime.publish(HostEvent::PreviewHealth {
            health: PreviewHealth::Broken,
        });
    }
    Ok(failure)
}

#[tauri::command]
async fn reconcile_benchmark_preview_failure(
    previews: State<'_, BenchmarkPreviewHost>,
    divergence_id: String,
    action: PreviewReconciliationAction,
) -> Result<ide_reconciliation::Reconciliation, String> {
    previews
        .reconcile_failure(&divergence_id, action)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn agent_capability_card(
    bridge: State<'_, Arc<DesktopBridge>>,
    target: AcpxTarget,
) -> Result<AgentCapabilityCard, String> {
    Ok(bridge.agent_capability_card(target).await)
}

#[tauri::command]
async fn start_read_only_agent_session(
    app: AppHandle,
    bridge: State<'_, Arc<DesktopBridge>>,
    target: AcpxTarget,
    project_id: String,
    resource_id: String,
) -> Result<StartedAgentSession, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    bridge
        .start_read_only_agent_session(target, &project_id, &resource_id, home)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn submit_agent_task(
    bridge: State<'_, Arc<DesktopBridge>>,
    request: AgentTaskRequest,
) -> Result<u64, String> {
    bridge
        .submit_agent_task(request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn next_agent_event(
    bridge: State<'_, Arc<DesktopBridge>>,
    session_id: String,
) -> Result<Option<ide_agent::IdeAgentEvent>, String> {
    bridge
        .next_agent_event(&session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn cancel_agent_session(
    bridge: State<'_, Arc<DesktopBridge>>,
    session_id: String,
) -> Result<(), String> {
    bridge
        .cancel_agent_session(&session_id)
        .await
        .map_err(|error| error.to_string())
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
            app.manage(TerminalRegistry::new());
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
            stop_and_capture_benchmark_preview_failure,
            reconcile_benchmark_preview_failure,
            agent_capability_card,
            start_read_only_agent_session,
            submit_agent_task,
            next_agent_event,
            cancel_agent_session,
            start_workspace_inspection,
            cancel_workspace_inspection
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AI-Native IDE desktop host");
}
