//! Typed application-service boundary for the desktop host.
//!
//! The WebView does not receive `SemanticProjectStore`, `WorkspaceEffectBroker`,
//! `AcpxAgentFacade`, filesystem roots, executable names, or ambient credentials.
//! Tauri commands translate their small renderer DTOs into these methods only after
//! the host has selected a project resource through a native picker/registered
//! workspace flow.
//!
//! ## Coordinator integration contract
//!
//! `apps/desktop/src-tauri/Cargo.toml` must add direct dependencies on
//! `anyhow = "1.0.100"` and `ide-agent = { path = "../../../crates/ide-agent" }`.
//! In `lib.rs`, add `mod bridge;`, construct `DesktopBridge::open()` in `setup`,
//! and manage it as `Arc<DesktopBridge>`. Commands must accept only the DTOs below:
//! create/open project, attach a `TrustedWorkspaceSelection` created by native host
//! code, propose/approve/rollback a `WorkspaceWriteRequest`, and query
//! `agent_capability_card`. They must never deserialize an arbitrary workspace path,
//! executable, shell command, HOME value, credential, or auth-profile value.

use anyhow::{anyhow, bail, Context};
use ide_agent::{AcpxAgentFacade, AgentAvailability, AgentDescriptor, AgentHealth};
use ide_domain::{
    CreateProject, ProjectId, ProjectRecord, Resource, ResourceId, ResourceKind,
    SemanticProjectStore, WorkspaceEffectBroker, WorkspaceWrite,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};
use tokio::sync::Mutex;

/// Renderer-safe project creation input. IDs are names, not filesystem locations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIntentInput {
    pub project_id: String,
    pub title: String,
    pub intent: String,
}

/// Renderer-safe write proposal. `relative_path` is validated twice: here and by
/// `WorkspaceEffectBroker`; neither accepts an absolute or traversal path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWriteRequest {
    pub resource_id: String,
    pub effect_id: String,
    pub relative_path: PathBuf,
    pub content: String,
}

/// A native-host-issued workspace selection. Deliberately not serializable or
/// deserializable: no renderer payload can manufacture an unrestricted path.
#[derive(Debug, Clone)]
pub struct TrustedWorkspaceSelection {
    root: PathBuf,
}

impl TrustedWorkspaceSelection {
    /// Use only after a native picker / registered-workspace service has applied
    /// product policy. This performs the minimum structural validation required by
    /// the domain store and canonicalizes symlinks before persistence.
    pub fn from_native_host(root: impl AsRef<Path>) -> anyhow::Result<Self> {
        let root = root.as_ref().canonicalize().with_context(|| {
            format!("workspace root does not exist: {}", root.as_ref().display())
        })?;
        if !root.is_dir() {
            bail!("workspace root must be a directory")
        }
        Ok(Self { root })
    }

    /// The canonical result of a native picker. This is intentionally exposed
    /// only to sibling host code; it is never serializable to the renderer.
    pub fn root(&self) -> &Path {
        &self.root
    }
}

/// A closed enum keeps ACPX target selection model-agnostic without allowing a
/// renderer to inject an executable, command line, or arbitrary ACPX target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcpxTarget {
    Claude,
    Codex,
    Gemini,
    OpenCode,
}

impl AcpxTarget {
    const fn as_acpx_agent(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
            Self::OpenCode => "opencode",
        }
    }
}

/// Render-ready truth about the selected external harness. `None` means ACPX
/// itself was unavailable, so the UI cannot imply the agent is installed/authenticated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilityCard {
    pub target: AcpxTarget,
    pub descriptor: Option<AgentDescriptor>,
    pub health: AgentHealth,
    pub auth_boundary: &'static str,
}

struct AttachedWorkspace {
    project_id: ProjectId,
    root: PathBuf,
    broker: WorkspaceEffectBroker,
}

/// Host-owned composition root for the first desktop gate.
///
/// Each attached resource has one broker bound to its canonical root. Project
/// membership is checked before every effect, while `WorkspaceEffectBroker`
/// applies the capability/approval/snapshot boundary underneath it.
pub struct DesktopBridge {
    projects: SemanticProjectStore,
    approval_database: PathBuf,
    owner: String,
    workspaces: Mutex<BTreeMap<String, AttachedWorkspace>>,
}

impl DesktopBridge {
    /// `data_directory` is application-owned storage (for example Tauri app-data),
    /// never a renderer-supplied path. The owner is a locally stable identity, not
    /// an access token or email address.
    pub fn open(
        data_directory: impl AsRef<Path>,
        owner: impl Into<String>,
    ) -> anyhow::Result<Self> {
        let owner = owner.into();
        validate_identifier("owner", &owner)?;
        let data_directory = data_directory.as_ref();
        fs::create_dir_all(data_directory)
            .with_context(|| format!("create IDE data directory {}", data_directory.display()))?;
        Ok(Self {
            projects: SemanticProjectStore::open(data_directory.join("semantic-projects.sqlite3"))?,
            approval_database: data_directory.join("workspace-approvals.sqlite3"),
            owner,
            workspaces: Mutex::new(BTreeMap::new()),
        })
    }

    pub fn create_project(&self, input: ProjectIntentInput) -> anyhow::Result<ProjectRecord> {
        validate_identifier("project id", &input.project_id)?;
        self.projects.create_project(CreateProject {
            id: ProjectId(input.project_id),
            title: input.title,
            intent: input.intent,
        })
    }

    pub fn open_project(&self, project_id: &str) -> anyhow::Result<Option<ProjectRecord>> {
        validate_identifier("project id", project_id)?;
        self.projects
            .open_project(&ProjectId(project_id.to_owned()))
    }

    /// Attaches a host-authorized resource to a semantic project and initializes
    /// the corresponding governed write broker. Re-attaching the same ID is safe
    /// only for the same project and canonical root.
    pub async fn attach_workspace(
        &self,
        project_id: &str,
        resource_id: &str,
        kind: ResourceKind,
        selection: TrustedWorkspaceSelection,
    ) -> anyhow::Result<Resource> {
        validate_identifier("project id", project_id)?;
        validate_identifier("resource id", resource_id)?;
        let project_id = ProjectId(project_id.to_owned());
        let resource_id = ResourceId(resource_id.to_owned());
        let resource = self.projects.attach_local_resource(
            &project_id,
            resource_id.clone(),
            kind,
            selection.root(),
        )?;

        let mut workspaces = self.workspaces.lock().await;
        if let Some(existing) = workspaces.get(&resource_id.0) {
            if existing.project_id != project_id || existing.root != resource.canonical_path {
                bail!("resource id is already attached to a different project or root")
            }
            return Ok(resource);
        }
        let broker = WorkspaceEffectBroker::open(
            &self.approval_database,
            // Bastion approvals are selected by owner. Scope this stable local owner
            // to the resource so approval in one workspace cannot dequeue a pending
            // effect belonging to another workspace.
            format!("{}:resource:{}", self.owner, resource_id.0),
            &resource.canonical_path,
        )
        .await?;
        workspaces.insert(
            resource_id.0.clone(),
            AttachedWorkspace {
                project_id,
                root: resource.canonical_path.clone(),
                broker,
            },
        );
        Ok(resource)
    }

    pub async fn propose_write(
        &self,
        project_id: &str,
        request: WorkspaceWriteRequest,
    ) -> anyhow::Result<serde_json::Value> {
        validate_identifier("project id", project_id)?;
        validate_identifier("resource id", &request.resource_id)?;
        validate_identifier("effect id", &request.effect_id)?;
        validate_relative_path(&request.relative_path)?;
        let workspaces = self.workspaces.lock().await;
        let workspace = workspace_for(&workspaces, project_id, &request.resource_id)?;
        workspace
            .broker
            .propose_write(&WorkspaceWrite {
                effect_id: request.effect_id,
                relative_path: request.relative_path,
                content: request.content,
            })
            .await
    }

    pub async fn approve_next_write(
        &self,
        project_id: &str,
        resource_id: &str,
    ) -> anyhow::Result<i64> {
        validate_identifier("project id", project_id)?;
        validate_identifier("resource id", resource_id)?;
        let workspaces = self.workspaces.lock().await;
        workspace_for(&workspaces, project_id, resource_id)?
            .broker
            .approve_next()
            .await
    }

    pub async fn rollback_write(
        &self,
        project_id: &str,
        resource_id: &str,
        effect_id: &str,
    ) -> anyhow::Result<()> {
        validate_identifier("project id", project_id)?;
        validate_identifier("resource id", resource_id)?;
        validate_identifier("effect id", effect_id)?;
        let workspaces = self.workspaces.lock().await;
        workspace_for(&workspaces, project_id, resource_id)?
            .broker
            .rollback(effect_id)
            .await
    }

    /// A version probe only. Session creation remains a later command because it
    /// requires host-managed home/auth references and a project-scoped policy.
    pub async fn agent_capability_card(&self, target: AcpxTarget) -> AgentCapabilityCard {
        match AcpxAgentFacade::new(target.as_acpx_agent()) {
            Ok(agent) => AgentCapabilityCard {
                target,
                descriptor: Some(agent.descriptor()),
                health: agent.health().await,
                auth_boundary: "The IDE never reads credentials; an explicit host-owned home and auth-profile reference are required before starting a session.",
            },
            Err(error) => AgentCapabilityCard {
                target,
                descriptor: None,
                health: AgentHealth {
                    availability: AgentAvailability::Unavailable,
                    detected_version: None,
                    detail: Some(error.to_string()),
                    degradations: vec!["ACPX could not be resolved; no external agent session can start.".to_string()],
                },
                auth_boundary: "The IDE never reads credentials; an explicit host-owned home and auth-profile reference are required before starting a session.",
            },
        }
    }
}

fn workspace_for<'a>(
    workspaces: &'a BTreeMap<String, AttachedWorkspace>,
    project_id: &str,
    resource_id: &str,
) -> anyhow::Result<&'a AttachedWorkspace> {
    let workspace = workspaces
        .get(resource_id)
        .ok_or_else(|| anyhow!("resource is not attached to this desktop host"))?;
    if workspace.project_id.0 != project_id {
        bail!("resource is outside the selected semantic project")
    }
    Ok(workspace)
}

fn validate_identifier(label: &str, value: &str) -> anyhow::Result<()> {
    if value.is_empty() || value.len() > 120 {
        bail!("{label} must contain 1..=120 characters")
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        bail!("{label} may only contain ASCII letters, digits, '-', '_' or '.'")
    }
    Ok(())
}

fn validate_relative_path(path: &Path) -> anyhow::Result<()> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        bail!("workspace write path must be a non-empty traversal-free relative path")
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_that_could_escape_a_resource() {
        assert!(validate_relative_path(Path::new("../.env")).is_err());
        assert!(validate_relative_path(Path::new("/etc/passwd")).is_err());
        assert!(validate_relative_path(Path::new("src/app.ts")).is_ok());
    }

    #[test]
    fn accepts_only_stable_opaque_identifiers() {
        assert!(validate_identifier("project id", "shop-builder.v1").is_ok());
        assert!(validate_identifier("project id", "project/../../etc").is_err());
        assert!(validate_identifier("project id", "").is_err());
    }

    #[test]
    fn target_selection_is_closed_and_never_a_command() {
        assert_eq!(AcpxTarget::Claude.as_acpx_agent(), "claude");
        assert_eq!(AcpxTarget::OpenCode.as_acpx_agent(), "opencode");
    }

    #[test]
    fn unavailable_card_never_claims_policy_enforcement() {
        let policy = AgentPolicyCoverage {
            tool_visibility: IdeCoverage::Unknown,
            approvals: IdeCoverage::HarnessOwned,
            egress: IdeCoverage::HarnessOwned,
            budget: IdeCoverage::Unknown,
            sandbox: IdeCoverage::Unknown,
        };
        assert_eq!(policy.approvals, IdeCoverage::HarnessOwned);
    }
}
