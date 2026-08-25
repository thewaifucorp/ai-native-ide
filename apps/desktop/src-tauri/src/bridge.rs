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
use ide_agent::{
    AcpxAgentFacade, AgentAvailability, AgentDescriptor, AgentExpectation, AgentHealth,
    AgentSandbox, AgentSessionId, AgentTask, IdeAgentEvent, StartAgentSession, SwapReport,
};
use ide_config::{
    available_profiles, ConfigField, ConfigPatch, ConfigStore, DetectedEnvironment, IdeConfig,
    LayoutProfile, Permissions, PolicyScope,
};
use ide_diff::Hunk;
use ide_domain::{
    ChangeCause, CreateProject, ProjectId, ProjectRecord, Resource, ResourceId, ResourceKind,
    SemanticProjectStore, WorkspaceAssetWrite, WorkspaceEffectBroker, WorkspaceWrite,
};
use ide_guidance::{
    ActivityContext, AppliedGuidance, CaptureDestination, Guidance, GuidanceDraft,
    GuidanceRegistry, GuidanceScope, GuidanceState, HygieneFinding, SyncProposal, TruthDeclaration,
    TruthFinding, TruthRegistry,
};
use ide_lifecycle::{ExportInputs, ExportManifest, ExportedResource, PublishLog, PublishRecord};
use ide_modes::{EffectClass, EffectPolicyDecision, InterruptionDecision, PromotionRecord};
use ide_packs::{FindingDisposition, Pack, PackRegistry, ReadinessVerdict};
use ide_reconciliation::CausalLinks;
use ide_references::{ProjectReference, ReferenceKind, ReferenceRegistry};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::Arc,
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

/// A governed binary asset write. Its bytes travel as a plain octet array; the
/// broker snapshots and can roll back the exact prior bytes, like a text write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetWriteRequest {
    pub resource_id: String,
    pub effect_id: String,
    pub relative_path: PathBuf,
    pub bytes: Vec<u8>,
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

/// Renderer-safe task input. The agent target/session is selected through opaque
/// IDs; it cannot receive a renderer-provided command, workspace root or auth path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskRequest {
    pub session_id: String,
    pub prompt: String,
    pub code_change: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedAgentSession {
    pub session_id: String,
    pub read_only: bool,
    pub policy_note: &'static str,
}

/// The outcome of swapping to a different agent: the new session id plus an
/// honest report of what state was preserved and what could not be moved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwappedAgentSession {
    pub session_id: String,
    pub report: SwapReport,
}

/// A renderer-safe file descriptor. Paths are always relative to an attached
/// resource and have already passed the host confinement check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub relative_path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileContents {
    pub relative_path: String,
    pub content: String,
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
    effect_links: Mutex<BTreeMap<String, CausalLinks>>,
    agents: Mutex<BTreeMap<String, Arc<AcpxAgentFacade>>>,
    guidance: Mutex<GuidanceRegistry>,
    truth: Mutex<TruthRegistry>,
    config: Mutex<ConfigStore>,
    packs: Mutex<PackRegistry>,
    publish_log: Mutex<PublishLog>,
    references: Mutex<ReferenceRegistry>,
    exports_dir: PathBuf,
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
            effect_links: Mutex::new(BTreeMap::new()),
            agents: Mutex::new(BTreeMap::new()),
            guidance: Mutex::new(GuidanceRegistry::open(data_directory.join("guidance"))?),
            truth: Mutex::new(TruthRegistry::open(data_directory.join("truth"))?),
            config: Mutex::new(ConfigStore::open(data_directory.join("config"))?),
            packs: Mutex::new(PackRegistry::open(data_directory.join("packs"))?),
            publish_log: Mutex::new(PublishLog::open(data_directory.join("lifecycle"))?),
            references: Mutex::new(ReferenceRegistry::open(data_directory.join("references"))?),
            exports_dir: data_directory.join("exports"),
        })
    }

    // --- Non-filesystem references (services / environments) -------------

    pub async fn link_reference(
        &self,
        id: &str,
        kind: ReferenceKind,
        name: &str,
        endpoint: &str,
        project_id: &str,
    ) -> anyhow::Result<ProjectReference> {
        validate_identifier("project id", project_id)?;
        self.references
            .lock()
            .await
            .link(id, kind, name, endpoint, project_id)
    }

    pub async fn project_references(&self, project_id: &str) -> Vec<ProjectReference> {
        self.references.lock().await.for_project(project_id)
    }

    pub async fn unlink_reference(&self, id: &str, project_id: &str) -> anyhow::Result<()> {
        self.references.lock().await.unlink(id, project_id)
    }

    // --- Export / publish / republish -----------------------------------

    /// Assembles a portable export manifest and writes it locally. No ShinAI
    /// infrastructure is required and no absolute machine path is exported.
    pub async fn export_project(&self, project_id: &str) -> anyhow::Result<ExportManifest> {
        validate_identifier("project id", project_id)?;
        let project = self
            .open_project(project_id)?
            .context("the requested semantic project does not exist")?;
        let resources = self
            .projects
            .resources_for_project(&ProjectId(project_id.to_owned()))?
            .into_iter()
            .map(|resource| ExportedResource {
                id: resource.id.0,
                kind: match resource.kind {
                    ResourceKind::Repository => "repository",
                    ResourceKind::Directory => "directory",
                }
                .to_owned(),
                label: resource
                    .canonical_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("recurso")
                    .to_owned(),
            })
            .collect();
        let applied_guidance = self
            .guidance
            .lock()
            .await
            .list()
            .into_iter()
            .filter(|guidance| guidance.state == GuidanceState::Active)
            .map(|guidance| guidance.id)
            .collect();
        let applied_packs = self.packs.lock().await.applied();
        let version = self
            .publish_log
            .lock()
            .await
            .history(project_id)
            .last()
            .map(|record| record.version.clone())
            .unwrap_or_else(|| "0.0.1".to_owned());
        let manifest = ide_lifecycle::build_export_manifest(&ExportInputs {
            project_id: project_id.to_owned(),
            title: project.title,
            intent: project.intent,
            version,
            resources,
            applied_guidance,
            applied_packs,
        });
        fs::create_dir_all(&self.exports_dir)
            .with_context(|| format!("create exports directory {}", self.exports_dir.display()))?;
        let json = serde_json::to_vec_pretty(&manifest)?;
        fs::write(self.exports_dir.join(format!("{project_id}.json")), json)
            .with_context(|| format!("write export for {project_id}"))?;
        Ok(manifest)
    }

    pub async fn publish_project(&self, project_id: &str) -> anyhow::Result<PublishRecord> {
        validate_identifier("project id", project_id)?;
        self.publish_log.lock().await.publish(project_id)
    }

    pub async fn republish_project(
        &self,
        project_id: &str,
        problem: &str,
        related_resources: Vec<String>,
    ) -> anyhow::Result<PublishRecord> {
        validate_identifier("project id", project_id)?;
        self.publish_log
            .lock()
            .await
            .republish(project_id, problem, related_resources)
    }

    pub async fn publish_history(&self, project_id: &str) -> Vec<PublishRecord> {
        self.publish_log.lock().await.history(project_id)
    }

    // --- Domain packs ---------------------------------------------------

    pub async fn list_packs(&self) -> Vec<Pack> {
        self.packs.lock().await.list()
    }

    pub async fn applied_packs(&self) -> Vec<String> {
        self.packs.lock().await.applied()
    }

    pub async fn apply_pack(&self, pack_id: &str) -> anyhow::Result<Vec<String>> {
        let mut packs = self.packs.lock().await;
        packs.apply(pack_id)?;
        Ok(packs.applied())
    }

    pub async fn revert_pack(&self, pack_id: &str) -> anyhow::Result<Vec<String>> {
        let mut packs = self.packs.lock().await;
        packs.revert(pack_id)?;
        Ok(packs.applied())
    }

    pub async fn pack_readiness(
        &self,
        pack_id: &str,
        passed: Vec<String>,
        failed: Vec<String>,
    ) -> anyhow::Result<ReadinessVerdict> {
        let packs = self.packs.lock().await;
        let pack = packs
            .list()
            .into_iter()
            .find(|pack| pack.id == pack_id)
            .with_context(|| format!("unknown pack {pack_id}"))?;
        Ok(ide_packs::readiness(&pack, &passed, &failed))
    }

    /// Records a reviewable disposition (correction, false positive or scoped
    /// exception) against a readiness finding. It never mutates the pack rules.
    pub async fn record_pack_disposition(
        &self,
        finding_key: &str,
        disposition: FindingDisposition,
        note: &str,
    ) -> anyhow::Result<()> {
        self.packs
            .lock()
            .await
            .record_disposition(finding_key, disposition, note)
    }

    /// Readiness that honours recorded dispositions: a false-positive or scoped
    /// exception no longer blocks, while genuine failures and unknowns still do.
    pub async fn pack_readiness_dispositioned(
        &self,
        pack_id: &str,
        passed: Vec<String>,
        failed: Vec<String>,
    ) -> anyhow::Result<ReadinessVerdict> {
        let packs = self.packs.lock().await;
        let pack = packs
            .list()
            .into_iter()
            .find(|pack| pack.id == pack_id)
            .with_context(|| format!("unknown pack {pack_id}"))?;
        Ok(packs.readiness_for(&pack, &passed, &failed))
    }

    // --- Configuration --------------------------------------------------

    pub async fn config(&self) -> IdeConfig {
        self.config.lock().await.config().clone()
    }

    pub async fn apply_config_defaults(
        &self,
        detected: DetectedEnvironment,
    ) -> anyhow::Result<IdeConfig> {
        Ok(self
            .config
            .lock()
            .await
            .apply_detected_defaults(detected)?
            .clone())
    }

    pub async fn set_config(&self, patch: ConfigPatch) -> anyhow::Result<IdeConfig> {
        Ok(self.config.lock().await.apply_patch(patch)?.clone())
    }

    pub async fn reset_config_field(&self, field: ConfigField) -> anyhow::Result<IdeConfig> {
        Ok(self.config.lock().await.reset_field(field)?.clone())
    }

    /// Applies a named layout profile, setting both layout and depth in one
    /// choice without fragmenting the project.
    pub async fn apply_config_profile(&self, name: &str) -> anyhow::Result<IdeConfig> {
        Ok(self.config.lock().await.apply_profile(name)?.clone())
    }

    /// The built-in layout profiles a user can switch between.
    pub fn config_profiles(&self) -> Vec<LayoutProfile> {
        available_profiles().to_vec()
    }

    // --- Build modes ----------------------------------------------------

    /// The interruption the active mode requires before an effect of this class.
    pub async fn mode_interruption(&self, class: EffectClass) -> InterruptionDecision {
        let mode = self.config.lock().await.config().mode.value;
        ide_modes::interruption_policy(mode, class)
    }

    pub async fn promote_prototype(
        &self,
        prototype_effect_id: &str,
        checkpoint_effect_id: &str,
        note: &str,
    ) -> Result<PromotionRecord, String> {
        let mode = self.config.lock().await.config().mode.value;
        ide_modes::promote_prototype(mode, prototype_effect_id, checkpoint_effect_id, note)
            .map_err(|error| error.to_string())
    }

    /// The per-effect approval policy for the active permission level.
    pub async fn effect_policy(&self, class: EffectClass) -> EffectPolicyDecision {
        let permissions = self.config.lock().await.config().permissions.value;
        ide_modes::effect_policy(permissions, class)
    }

    /// The per-effect approval policy resolved for a specific project, resource
    /// and tool: the most specific scoped override wins, else the global level.
    pub async fn effect_policy_scoped(
        &self,
        project: Option<String>,
        resource: Option<String>,
        tool: Option<String>,
        class: EffectClass,
    ) -> EffectPolicyDecision {
        let permissions = self.config.lock().await.config().resolve_permissions(
            project.as_deref(),
            resource.as_deref(),
            tool.as_deref(),
        );
        ide_modes::effect_policy(permissions, class)
    }

    /// Declares a scoped permission override for a project/resource/tool. It is
    /// reversible and never rewrites the global level silently.
    pub async fn set_scoped_permission(
        &self,
        scope: PolicyScope,
        permissions: Permissions,
    ) -> anyhow::Result<IdeConfig> {
        Ok(self
            .config
            .lock()
            .await
            .set_scoped_permission(scope, permissions)?
            .clone())
    }

    /// Removes a scoped permission override, restoring the fallback resolution.
    pub async fn clear_scoped_permission(&self, scope: PolicyScope) -> anyhow::Result<IdeConfig> {
        Ok(self
            .config
            .lock()
            .await
            .clear_scoped_permission(&scope)?
            .clone())
    }

    /// Explicit YOLO write: only allowed at the Yolo permission level, it proposes
    /// and auto-approves the effect in one step. It never bypasses the broker —
    /// the snapshot, revision and activity are all still recorded.
    pub async fn yolo_write(
        &self,
        project_id: &str,
        request: WorkspaceWriteRequest,
    ) -> anyhow::Result<serde_json::Value> {
        let permissions = self.config.lock().await.config().permissions.value;
        if !matches!(permissions, Permissions::Yolo) {
            bail!("YOLO writes require the explicit Yolo permission level")
        }
        let resource_id = request.resource_id.clone();
        let first = self.propose_write(project_id, request.clone()).await?;
        if first["written"] == serde_json::Value::Bool(true) {
            return Ok(first);
        }
        self.approve_next_write(project_id, &resource_id).await?;
        self.propose_write(project_id, request).await
    }

    // --- Guidance -------------------------------------------------------

    pub async fn capture_guidance(
        &self,
        draft: GuidanceDraft,
        destination: CaptureDestination,
    ) -> anyhow::Result<Guidance> {
        self.guidance.lock().await.capture(draft, destination)
    }

    pub async fn activate_guidance(&self, id: &str) -> anyhow::Result<Guidance> {
        self.guidance.lock().await.activate(id)
    }

    pub async fn import_steering(
        &self,
        name: &str,
        text: &str,
        scope: GuidanceScope,
    ) -> anyhow::Result<Guidance> {
        self.guidance
            .lock()
            .await
            .import_steering(name, text, scope, &self.owner)
    }

    pub async fn list_guidance(&self) -> Vec<Guidance> {
        self.guidance.lock().await.list()
    }

    pub async fn guidance_applied_now(&self, context: ActivityContext) -> Vec<AppliedGuidance> {
        self.guidance.lock().await.applied_now(&context)
    }

    pub async fn guidance_hygiene(&self) -> Vec<HygieneFinding> {
        self.guidance.lock().await.hygiene()
    }

    /// Hygiene including obsolescence: guidance idle beyond `staleness_window_ms`
    /// as of `now_ms` is surfaced as a reviewable finding, never auto-removed.
    pub async fn guidance_hygiene_with_staleness(
        &self,
        now_ms: u64,
        staleness_window_ms: u64,
    ) -> Vec<HygieneFinding> {
        self.guidance
            .lock()
            .await
            .hygiene_with_staleness(now_ms, staleness_window_ms)
    }

    // --- Local Truth Registry ------------------------------------------

    pub async fn truth_declare(
        &self,
        subject: &str,
        scope: GuidanceScope,
        authority_path: &str,
        precedence: i64,
        provenance: &str,
    ) -> anyhow::Result<TruthDeclaration> {
        self.truth
            .lock()
            .await
            .declare(subject, scope, authority_path, precedence, provenance)
    }

    pub async fn truth_add_consumer(&self, id: &str, consumer: &str) -> anyhow::Result<()> {
        self.truth.lock().await.add_consumer(id, consumer)
    }

    pub async fn truth_list(&self) -> Vec<TruthDeclaration> {
        self.truth.lock().await.list()
    }

    pub async fn truth_consumers(&self, subject: &str) -> Vec<String> {
        self.truth.lock().await.consumers_of(subject)
    }

    pub async fn truth_conflicts(&self) -> Vec<TruthFinding> {
        self.truth.lock().await.conflicts()
    }

    /// Proposes which consumers of a source of truth are out of sync, without
    /// changing anything: the sync stays a reviewable proposal.
    pub async fn truth_sync_proposal(
        &self,
        id: &str,
        up_to_date: Vec<String>,
    ) -> anyhow::Result<SyncProposal> {
        self.truth.lock().await.propose_sync(id, &up_to_date)
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

    pub fn list_projects(&self) -> anyhow::Result<Vec<ProjectRecord>> {
        self.projects.list_projects()
    }

    pub fn update_project_intent(
        &self,
        project_id: &str,
        intent: String,
    ) -> anyhow::Result<ProjectRecord> {
        validate_identifier("project id", project_id)?;
        self.projects
            .update_project_intent(&ProjectId(project_id.to_owned()), intent)
    }

    /// Restores the persisted project/resource association into this host
    /// process. Reopening a project must not require the renderer to select the
    /// same directory again: its canonical location was approved and persisted
    /// by a previous native-picker operation.
    pub async fn restore_project(&self, project_id: &str) -> anyhow::Result<Option<ProjectRecord>> {
        let Some(project) = self.open_project(project_id)? else {
            return Ok(None);
        };
        for resource in self.projects.resources_for_project(&project.id)? {
            self.register_workspace(project.id.clone(), resource)
                .await?;
        }
        Ok(Some(project))
    }

    pub fn project_resources(&self, project_id: &str) -> anyhow::Result<Vec<Resource>> {
        validate_identifier("project id", project_id)?;
        self.projects
            .resources_for_project(&ProjectId(project_id.to_owned()))
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

        self.register_workspace(project_id, resource.clone())
            .await?;
        Ok(resource)
    }

    /// Native selection is the authority for the resource identity. Deriving
    /// it from the canonical root lets the same resource be attached to more
    /// than one semantic project without the renderer inventing a duplicate ID.
    pub async fn attach_native_workspace_selection(
        &self,
        project_id: &str,
        kind: ResourceKind,
        selection: TrustedWorkspaceSelection,
    ) -> anyhow::Result<Resource> {
        let resource_id = stable_resource_id(selection.root());
        self.attach_workspace(project_id, &resource_id, kind, selection)
            .await
    }

    async fn register_workspace(
        &self,
        project_id: ProjectId,
        resource: Resource,
    ) -> anyhow::Result<()> {
        let mut workspaces = self.workspaces.lock().await;
        if let Some(existing) = workspaces.get(&resource.id.0) {
            if existing.project_id != project_id || existing.root != resource.canonical_path {
                bail!("resource id is already attached to a different project or root")
            }
            return Ok(());
        }
        let broker = WorkspaceEffectBroker::open(
            &self.approval_database,
            // Bastion approvals are selected by owner. Scope this stable local owner
            // to the resource so approval in one workspace cannot dequeue a pending
            // effect belonging to another workspace.
            format!("{}:resource:{}", self.owner, resource.id.0),
            &resource.canonical_path,
        )
        .await?;
        workspaces.insert(
            resource.id.0.clone(),
            AttachedWorkspace {
                project_id,
                root: resource.canonical_path.clone(),
                broker,
            },
        );
        Ok(())
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
        let mut result = workspace
            .broker
            .propose_write(&WorkspaceWrite {
                effect_id: request.effect_id.clone(),
                relative_path: request.relative_path.clone(),
                content: request.content.clone(),
            })
            .await?;
        // Bastion returns its internal snake_case capability receipt. Translate
        // the renderer boundary once so the TypeScript DTO remains idiomatic
        // and no WebView consumer needs to know a Core implementation detail.
        if result["awaiting_approval"] == serde_json::Value::Bool(true) {
            result["awaitingApproval"] = serde_json::Value::Bool(true);
        }
        drop(workspaces);
        if result["written"] == serde_json::Value::Bool(true) {
            if let Some(revision) = self.projects.record_ide_revision(
                &ResourceId(request.resource_id.clone()),
                &request.relative_path,
                &request.effect_id,
            )? {
                self.effect_links.lock().await.insert(
                    effect_link_key(project_id, &request.resource_id, &request.effect_id),
                    CausalLinks {
                        effect_ids: vec![request.effect_id.clone()],
                        activity_ids: vec![format!("activity:{}", revision.id)],
                        file_paths: vec![request.relative_path.display().to_string()],
                    },
                );
            }
        }
        Ok(result)
    }

    /// Proposes a governed binary asset write through the same broker as text:
    /// snapshot before mutation, approval by exact payload, rollback of prior
    /// bytes. Code, Markdown and config use text writes; assets use this path.
    pub async fn propose_asset_write(
        &self,
        project_id: &str,
        request: AssetWriteRequest,
    ) -> anyhow::Result<serde_json::Value> {
        validate_identifier("project id", project_id)?;
        validate_identifier("resource id", &request.resource_id)?;
        validate_identifier("effect id", &request.effect_id)?;
        validate_relative_path(&request.relative_path)?;
        let workspaces = self.workspaces.lock().await;
        let workspace = workspace_for(&workspaces, project_id, &request.resource_id)?;
        let mut result = workspace
            .broker
            .propose_asset_write(&WorkspaceAssetWrite {
                effect_id: request.effect_id.clone(),
                relative_path: request.relative_path.clone(),
                bytes: request.bytes.clone(),
            })
            .await?;
        if result["awaiting_approval"] == serde_json::Value::Bool(true) {
            result["awaitingApproval"] = serde_json::Value::Bool(true);
        }
        drop(workspaces);
        if result["written"] == serde_json::Value::Bool(true) {
            if let Some(revision) = self.projects.record_ide_revision(
                &ResourceId(request.resource_id.clone()),
                &request.relative_path,
                &request.effect_id,
            )? {
                self.effect_links.lock().await.insert(
                    effect_link_key(project_id, &request.resource_id, &request.effect_id),
                    CausalLinks {
                        effect_ids: vec![request.effect_id.clone()],
                        activity_ids: vec![format!("activity:{}", revision.id)],
                        file_paths: vec![request.relative_path.display().to_string()],
                    },
                );
            }
        }
        Ok(result)
    }

    /// Returns causation created by a completed governed effect. A preview cannot
    /// attach a failure to merely proposed work or manufacture an activity ID.
    pub async fn effect_causal_links(
        &self,
        project_id: &str,
        resource_id: &str,
        effect_id: &str,
    ) -> anyhow::Result<CausalLinks> {
        validate_identifier("project id", project_id)?;
        validate_identifier("resource id", resource_id)?;
        validate_identifier("effect id", effect_id)?;
        let workspaces = self.workspaces.lock().await;
        workspace_for(&workspaces, project_id, resource_id)?;
        drop(workspaces);
        if let Some(links) = self
            .effect_links
            .lock()
            .await
            .get(&effect_link_key(project_id, resource_id, effect_id))
            .cloned()
        {
            return Ok(links);
        }

        // The in-memory index is a fast path only. Reopening the desktop must
        // preserve the causal route, so rebuild it from the semantic revision
        // persisted by the approved effect rather than treating a restart as
        // an unknown external change.
        let revision = self
            .projects
            .revisions_for_resource(&ResourceId(resource_id.to_owned()))?
            .into_iter()
            .rev()
            .find(|revision| matches!(&revision.cause, ChangeCause::IdeEffect { effect_id: recorded } if recorded == effect_id))
            .context("the effect has no observed semantic revision to use as preview causation")?;
        Ok(CausalLinks {
            effect_ids: vec![effect_id.to_owned()],
            activity_ids: vec![format!("activity:{}", revision.id)],
            file_paths: vec![revision.relative_path.display().to_string()],
        })
    }

    pub async fn pending_effect_count(
        &self,
        project_id: &str,
        resource_id: &str,
    ) -> anyhow::Result<usize> {
        validate_identifier("project id", project_id)?;
        validate_identifier("resource id", resource_id)?;
        let workspaces = self.workspaces.lock().await;
        workspace_for(&workspaces, project_id, resource_id)?
            .broker
            .pending_count()
            .await
    }

    /// Diffs the on-disk file against a proposed content, hunk by hunk, so a
    /// person can accept only some changes without knowing Git.
    pub async fn diff_workspace_file(
        &self,
        project_id: &str,
        resource_id: &str,
        relative_path: PathBuf,
        proposed: &str,
    ) -> anyhow::Result<Vec<Hunk>> {
        let original = match self
            .read_workspace_file(project_id, resource_id, relative_path)
            .await
        {
            Ok(contents) => contents.content,
            Err(_) => String::new(),
        };
        Ok(ide_diff::diff(&original, proposed))
    }

    /// Merges only the selected hunks of a proposed change onto the on-disk file.
    pub async fn merge_workspace_content(
        &self,
        project_id: &str,
        resource_id: &str,
        relative_path: PathBuf,
        proposed: &str,
        selected_hunks: &[usize],
    ) -> anyhow::Result<String> {
        let original = match self
            .read_workspace_file(project_id, resource_id, relative_path)
            .await
        {
            Ok(contents) => contents.content,
            Err(_) => String::new(),
        };
        Ok(ide_diff::merge_selected(
            &original,
            proposed,
            selected_hunks,
        ))
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

    /// Starts an ACPX session through the host-owned adapter. Read-only is the
    /// default; a person may explicitly enable workspace writes for adapters
    /// whose permission model is external to the IDE broker.
    pub async fn start_agent_session(
        &self,
        target: AcpxTarget,
        project_id: &str,
        resource_id: &str,
        host_home: PathBuf,
        allow_workspace_writes: bool,
    ) -> anyhow::Result<StartedAgentSession> {
        validate_identifier("project id", project_id)?;
        validate_identifier("resource id", resource_id)?;
        let workspaces = self.workspaces.lock().await;
        let workspace = workspace_for(&workspaces, project_id, resource_id)?;
        let workspace_root = workspace.root.clone();
        drop(workspaces);

        let facade = Arc::new(AcpxAgentFacade::new(target.as_acpx_agent())?);
        let session = facade
            .start_session(StartAgentSession {
                owner: self.owner.clone(),
                workspace_root: workspace_root.clone(),
                home_dir: host_home,
                read_only: !allow_workspace_writes,
                denied_paths: vec![workspace_root.join(".git")],
                sandbox: if allow_workspace_writes {
                    AgentSandbox::WorkspaceNet
                } else {
                    AgentSandbox::Isolated
                },
                auth_profile_ref: "host-managed-acpx-default".to_owned(),
                runtime_id: "ai-native-ide".to_owned(),
                allowed_actions: if allow_workspace_writes {
                    vec!["*".to_owned()]
                } else {
                    Vec::new()
                },
                task_timeout_ms: 300_000,
                idle_timeout_ms: 900_000,
            })
            .await?;
        self.agents
            .lock()
            .await
            .insert(session.0.clone(), Arc::clone(&facade));
        Ok(StartedAgentSession {
            session_id: session.0,
            read_only: !allow_workspace_writes,
            policy_note: if allow_workspace_writes {
                "Workspace writes were explicitly enabled for this external agent. Its approval model is harness-owned and every resulting file change is observed by the IDE."
            } else {
                "The external agent is read-only. Workspace changes require a separate IDE effect approval."
            },
        })
    }

    pub async fn submit_agent_task(&self, request: AgentTaskRequest) -> anyhow::Result<u64> {
        if request.prompt.trim().is_empty() {
            bail!("agent prompt cannot be empty")
        }
        let agent = self.agent_for(&request.session_id).await?;
        agent
            .submit_task(
                &AgentSessionId(request.session_id),
                AgentTask {
                    prompt: request.prompt,
                    expectation: if request.code_change {
                        AgentExpectation::CodeChange
                    } else {
                        AgentExpectation::Conversation
                    },
                    model_hint: None,
                },
            )
            .await
            .map_err(anyhow::Error::from)
    }

    pub async fn next_agent_event(
        &self,
        session_id: &str,
    ) -> anyhow::Result<Option<IdeAgentEvent>> {
        let agent = self.agent_for(session_id).await?;
        agent
            .next_event(&AgentSessionId(session_id.to_owned()))
            .await
            .map_err(anyhow::Error::from)
    }

    pub async fn cancel_agent_session(&self, session_id: &str) -> anyhow::Result<()> {
        let agent = self.agent_for(session_id).await?;
        agent
            .cancel(&AgentSessionId(session_id.to_owned()), true)
            .await
            .map_err(anyhow::Error::from)
    }

    /// Resumes a session on its own provider when the capability is present.
    /// It degrades honestly (an error) when the provider cannot reattach.
    pub async fn resume_agent_session(&self, session_id: &str) -> anyhow::Result<String> {
        let agent = self.agent_for(session_id).await?;
        let state = agent
            .capture_state(&AgentSessionId(session_id.to_owned()))
            .await?;
        let resumed = agent.resume(&state).await?;
        self.agents
            .lock()
            .await
            .insert(resumed.0.clone(), agent);
        Ok(resumed.0)
    }

    /// Swaps the conversation to a different agent without losing transferable
    /// state. The returned report names exactly what was preserved and what the
    /// new provider could not adopt.
    pub async fn swap_agent_session(
        &self,
        session_id: &str,
        new_target: AcpxTarget,
    ) -> anyhow::Result<SwappedAgentSession> {
        let current = self.agent_for(session_id).await?;
        let state = current
            .capture_state(&AgentSessionId(session_id.to_owned()))
            .await?;
        let new_facade = Arc::new(AcpxAgentFacade::new(new_target.as_acpx_agent())?);
        let (new_id, report) = new_facade.adopt_state(state).await?;
        self.agents
            .lock()
            .await
            .insert(new_id.0.clone(), new_facade);
        Ok(SwappedAgentSession {
            session_id: new_id.0,
            report,
        })
    }

    /// Resolves the host-owned root for a project resource. The path is kept
    /// native-only and is never returned through a renderer DTO.
    pub async fn workspace_root(
        &self,
        project_id: &str,
        resource_id: &str,
    ) -> anyhow::Result<PathBuf> {
        validate_identifier("project id", project_id)?;
        validate_identifier("resource id", resource_id)?;
        let workspaces = self.workspaces.lock().await;
        Ok(workspace_for(&workspaces, project_id, resource_id)?
            .root
            .clone())
    }

    /// Enumerates a bounded, source-oriented view of an attached resource.
    /// This never follows a symlink outside the resource and deliberately skips
    /// dependency/VCS directories that would make the editor unusable.
    pub async fn list_workspace_files(
        &self,
        project_id: &str,
        resource_id: &str,
    ) -> anyhow::Result<Vec<WorkspaceFile>> {
        let root = self.workspace_root(project_id, resource_id).await?;
        let mut files = Vec::new();
        collect_workspace_files(&root, &root, &mut files)?;
        files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        Ok(files)
    }

    /// Reads a UTF-8 text file inside the selected resource. `canonicalize`
    /// after the relative-path validation prevents a symlink from turning a
    /// harmless renderer path into an out-of-workspace read.
    pub async fn read_workspace_file(
        &self,
        project_id: &str,
        resource_id: &str,
        relative_path: PathBuf,
    ) -> anyhow::Result<WorkspaceFileContents> {
        validate_relative_path(&relative_path)?;
        let root = self.workspace_root(project_id, resource_id).await?;
        let path = root.join(&relative_path).canonicalize().with_context(|| {
            format!("workspace file does not exist: {}", relative_path.display())
        })?;
        if !path.starts_with(&root) || !path.is_file() {
            bail!("workspace file is outside the selected resource or is not a file")
        }
        let metadata = path.metadata()?;
        if metadata.len() > 1_048_576 {
            bail!("workspace file exceeds the 1 MiB editor limit")
        }
        let content = fs::read_to_string(&path).with_context(|| {
            format!(
                "workspace file is not valid UTF-8: {}",
                relative_path.display()
            )
        })?;
        Ok(WorkspaceFileContents {
            relative_path: relative_path.display().to_string(),
            content,
        })
    }

    /// Records a filesystem mutation as an external causal revision. Called by
    /// the host watch callback; errors are returned to that trusted callback and
    /// never become renderer-controlled paths or effect IDs.
    pub fn observe_external_changes(
        &self,
        project_id: &str,
        resource_id: &str,
    ) -> anyhow::Result<usize> {
        validate_identifier("project id", project_id)?;
        validate_identifier("resource id", resource_id)?;
        let resources = self
            .projects
            .resources_for_project(&ProjectId(project_id.to_owned()))?;
        if !resources
            .iter()
            .any(|resource| resource.id.0 == resource_id)
        {
            bail!("resource is outside the selected semantic project")
        }
        Ok(self
            .projects
            .detect_external_changes(&ResourceId(resource_id.to_owned()))?
            .len())
    }

    async fn agent_for(&self, session_id: &str) -> anyhow::Result<Arc<AcpxAgentFacade>> {
        self.agents
            .lock()
            .await
            .get(session_id)
            .cloned()
            .context("unknown IDE-owned agent session")
    }
}

const MAX_EDITOR_FILES: usize = 2_000;

fn collect_workspace_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<WorkspaceFile>,
) -> anyhow::Result<()> {
    if files.len() >= MAX_EDITOR_FILES {
        return Ok(());
    }
    for entry in fs::read_dir(directory)? {
        if files.len() >= MAX_EDITOR_FILES {
            break;
        }
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        let name = entry.file_name();
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if matches!(
                name.to_str(),
                Some(".git" | "node_modules" | "target" | ".next")
            ) {
                continue;
            }
            collect_workspace_files(root, &path, files)?;
        } else if file_type.is_file() {
            let metadata = entry.metadata()?;
            if metadata.len() <= 1_048_576 {
                let relative_path = path
                    .strip_prefix(root)
                    .context("workspace file escaped selected resource")?
                    .display()
                    .to_string();
                files.push(WorkspaceFile {
                    relative_path,
                    size_bytes: metadata.len(),
                });
            }
        }
    }
    Ok(())
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

fn effect_link_key(project_id: &str, resource_id: &str, effect_id: &str) -> String {
    format!("{project_id}\u{1f}{resource_id}\u{1f}{effect_id}")
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

fn stable_resource_id(root: &Path) -> String {
    // FNV-1a is sufficient here: this is an opaque local identity, not a
    // security credential. The canonical path remains uniqueness-enforced by
    // SQLite, while the fixed hexadecimal representation is renderer-safe.
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in root.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("resource-{hash:016x}")
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
    fn canonical_resource_identity_is_stable_and_renderer_safe() {
        let id = stable_resource_id(Path::new("/workspace/example"));
        assert_eq!(id, stable_resource_id(Path::new("/workspace/example")));
        assert!(validate_identifier("resource id", &id).is_ok());
    }
}
