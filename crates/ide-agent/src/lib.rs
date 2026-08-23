//! Host-neutral agent facade for the AI-Native IDE.
//!
//! This crate deliberately adapts a real `bastion-agent-runtime` adapter instead
//! of making the UI parse a CLI's stdout. The desktop host owns persistence and
//! event delivery; this facade owns no secrets and reports external-harness
//! policy gaps explicitly.

use bastion_agent_runtime::{
    acpx::AcpxAgentRuntime, AgentRuntime, ApprovalCoverage, ArtifactKind, AuthProfileRef,
    BudgetCoverage, CancelMode, EgressCoverage, EnvPolicy, PermissionAction, PermissionProfile,
    PolicyCoverage, RuntimeDescriptor, RuntimeError, RuntimeEvent, RuntimeHealth, RuntimeSession,
    SandboxCoverage, SandboxProfile, SessionSpec, SessionStatus, TaskExpectation, TaskInput,
    TaskOutcome, ToolVisibility, WorkspacePolicy,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use thiserror::Error;
use tokio::sync::Mutex;

/// Stable IDE-owned identity. The ACPX session reference never crosses the UI boundary.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AgentSessionId(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentAvailability {
    Ready,
    /// The adapter is usable but at least one product policy surface belongs to the harness.
    Degraded,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum IdeCoverage {
    Enforced,
    DeclaredOnly,
    HarnessOwned,
    Unknown,
}

/// A render-ready capability card. It must be shown before running an agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentPolicyCoverage {
    pub tool_visibility: IdeCoverage,
    pub approvals: IdeCoverage,
    pub egress: IdeCoverage,
    pub budget: IdeCoverage,
    pub sandbox: IdeCoverage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentDescriptor {
    pub id: String,
    pub adapter_version: String,
    pub target_version: String,
    pub transport: String,
    pub supports_resume: bool,
    pub supports_steer: bool,
    pub supports_usage_reporting: bool,
    pub supports_diff_events: bool,
    pub supports_permission_bridge: bool,
    pub supports_concurrent_sessions: bool,
    pub policy: AgentPolicyCoverage,
    /// Limitations the UI must display, rather than hide behind an optimistic label.
    pub degradations: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentHealth {
    pub availability: AgentAvailability,
    pub detected_version: Option<String>,
    pub detail: Option<String>,
    pub degradations: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartAgentSession {
    pub owner: String,
    pub workspace_root: PathBuf,
    /// Host-selected home directory required by ACPX's authenticated CLI sessions. This is a
    /// path, not credential material; no ambient environment is inherited.
    pub home_dir: PathBuf,
    pub read_only: bool,
    pub denied_paths: Vec<PathBuf>,
    pub sandbox: AgentSandbox,
    /// Opaque host-owned reference, never a token or credential value.
    pub auth_profile_ref: String,
    pub runtime_id: String,
    pub allowed_actions: Vec<String>,
    pub task_timeout_ms: u64,
    pub idle_timeout_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentSandbox {
    Isolated,
    WorkspaceNet,
    Trusted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentTask {
    pub prompt: String,
    pub expectation: AgentExpectation,
    pub model_hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentExpectation {
    Conversation,
    CodeChange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum IdeTaskOutcome {
    Success,
    Failed { reason: String },
    Cancelled,
    TimedOut,
}

/// Typed, structured events suitable for a Tauri event bridge or an in-process subscriber.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum IdeAgentEvent {
    Started {
        session_id: AgentSessionId,
    },
    MessageDelta {
        task_id: u64,
        text: String,
    },
    Thinking {
        task_id: u64,
        summary: String,
    },
    ToolCall {
        task_id: u64,
        name: String,
        input_digest: String,
    },
    ToolResult {
        task_id: u64,
        name: String,
        output_digest: String,
        is_error: bool,
    },
    PermissionRequested {
        task_id: u64,
        action: String,
        detail: String,
    },
    Diff {
        task_id: u64,
        path: PathBuf,
        added: u32,
        removed: u32,
    },
    Artifact {
        task_id: u64,
        kind: String,
        path: PathBuf,
        digest: String,
    },
    Usage {
        task_id: u64,
        input_tokens: u64,
        output_tokens: u64,
    },
    Warning {
        task_id: u64,
        code: String,
        detail: String,
    },
    Ended {
        task_id: u64,
        outcome: IdeTaskOutcome,
    },
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AgentFacadeError {
    #[error("agent session not found")]
    SessionNotFound,
    #[error("agent runtime unavailable: {detail}")]
    Unavailable { detail: String },
    #[error("agent runtime error: {detail}")]
    Runtime { detail: String },
}

struct ManagedSession {
    runtime_session: Box<dyn RuntimeSession>,
}

/// An ACPX-backed, host-neutral facade. It does no credential discovery and never logs input.
pub struct AcpxAgentFacade {
    runtime: AcpxAgentRuntime,
    sessions: Mutex<HashMap<AgentSessionId, ManagedSession>>,
    next_session_id: AtomicU64,
}

impl AcpxAgentFacade {
    /// Resolves the `acpx` executable using the runtime's own validated resolver.
    pub fn new(agent: impl Into<String>) -> Result<Self, AgentFacadeError> {
        let runtime = AcpxAgentRuntime::new(agent).map_err(map_runtime_error)?;
        Ok(Self {
            runtime,
            sessions: Mutex::new(HashMap::new()),
            next_session_id: AtomicU64::new(1),
        })
    }

    pub fn descriptor(&self) -> AgentDescriptor {
        descriptor_for(self.runtime.descriptor())
    }

    /// A non-authenticated process/version check. It intentionally returns an honest unavailable
    /// state instead of attempting a session or implicitly borrowing host credentials.
    pub async fn health(&self) -> AgentHealth {
        let descriptor = self.descriptor();
        match self.runtime.health().await {
            Ok(health) => health_for(health, &descriptor),
            Err(error) => AgentHealth {
                availability: AgentAvailability::Unavailable,
                detected_version: None,
                detail: Some(sanitize_runtime_error(&error)),
                degradations: descriptor.degradations,
            },
        }
    }

    /// Opens a real ACPX session only after its health probe says it is ready.
    pub async fn start_session(
        &self,
        request: StartAgentSession,
    ) -> Result<AgentSessionId, AgentFacadeError> {
        let health = self.health().await;
        if health.availability == AgentAvailability::Unavailable {
            return Err(AgentFacadeError::Unavailable {
                detail: health
                    .detail
                    .unwrap_or_else(|| "ACPX is not ready".to_string()),
            });
        }

        let session = self
            .runtime
            .start(session_spec_from(request))
            .await
            .map_err(map_runtime_error)?;
        let id = AgentSessionId(format!(
            "agent-{}",
            self.next_session_id.fetch_add(1, Ordering::Relaxed)
        ));
        self.sessions.lock().await.insert(
            id.clone(),
            ManagedSession {
                runtime_session: session,
            },
        );
        Ok(id)
    }

    pub async fn submit_task(
        &self,
        session_id: &AgentSessionId,
        task: AgentTask,
    ) -> Result<u64, AgentFacadeError> {
        let mut sessions = self.sessions.lock().await;
        let managed = sessions
            .get_mut(session_id)
            .ok_or(AgentFacadeError::SessionNotFound)?;
        let task_id = managed
            .runtime_session
            .submit(task_input_from(task))
            .await
            .map_err(map_runtime_error)?;
        Ok(task_id.0)
    }

    /// Pulls one structured event. The desktop host may relay this through its own bounded stream.
    pub async fn next_event(
        &self,
        session_id: &AgentSessionId,
    ) -> Result<Option<IdeAgentEvent>, AgentFacadeError> {
        let mut sessions = self.sessions.lock().await;
        let managed = sessions
            .get_mut(session_id)
            .ok_or(AgentFacadeError::SessionNotFound)?;
        Ok(managed
            .runtime_session
            .next_event()
            .await
            .map(|event| event_to_ide(session_id, event)))
    }

    /// Cancellation delegates to ACPX and preserves the adapter's idempotent semantics.
    pub async fn cancel(
        &self,
        session_id: &AgentSessionId,
        graceful: bool,
    ) -> Result<(), AgentFacadeError> {
        let mut sessions = self.sessions.lock().await;
        let managed = sessions
            .get_mut(session_id)
            .ok_or(AgentFacadeError::SessionNotFound)?;
        let mode = if graceful {
            CancelMode::Graceful {
                grace: Duration::from_secs(3),
            }
        } else {
            CancelMode::Kill
        };
        managed
            .runtime_session
            .cancel(mode)
            .await
            .map_err(map_runtime_error)
    }

    pub async fn session_status(
        &self,
        session_id: &AgentSessionId,
    ) -> Result<SessionStatus, AgentFacadeError> {
        let sessions = self.sessions.lock().await;
        let managed = sessions
            .get(session_id)
            .ok_or(AgentFacadeError::SessionNotFound)?;
        managed
            .runtime_session
            .status()
            .await
            .map_err(map_runtime_error)
    }
}

fn session_spec_from(request: StartAgentSession) -> SessionSpec {
    SessionSpec {
        owner: request.owner,
        workspace: WorkspacePolicy {
            root: request.workspace_root,
            read_only: request.read_only,
            deny: request.denied_paths,
        },
        sandbox: match request.sandbox {
            AgentSandbox::Isolated => SandboxProfile::Isolated,
            AgentSandbox::WorkspaceNet => SandboxProfile::WorkspaceNet,
            AgentSandbox::Trusted => SandboxProfile::Trusted,
        },
        permissions: PermissionProfile {
            allow: request.allowed_actions,
        },
        auth: AuthProfileRef(request.auth_profile_ref),
        runtime_id: request.runtime_id,
        timeout: bastion_agent_runtime::TimeoutPolicy {
            per_task: Duration::from_millis(request.task_timeout_ms),
            idle: Duration::from_millis(request.idle_timeout_ms),
        },
        // ACPX needs HOME to find the CLI's existing authenticated session. The host supplies
        // this one path explicitly; no ambient environment, API key, or arbitrary variables are
        // inherited by the subprocess.
        env: EnvPolicy {
            allow: [(
                "HOME".to_string(),
                request.home_dir.to_string_lossy().into_owned(),
            )]
            .into_iter()
            .collect(),
        },
        mcp_bridge: None,
        otel: Default::default(),
        model_hint: None,
    }
}

fn task_input_from(task: AgentTask) -> TaskInput {
    TaskInput {
        prompt: task.prompt,
        attachments: Vec::new(),
        expected: match task.expectation {
            AgentExpectation::Conversation => TaskExpectation::Conversation,
            AgentExpectation::CodeChange => TaskExpectation::CodeChange,
        },
        model_hint: task.model_hint,
    }
}

fn descriptor_for(descriptor: RuntimeDescriptor) -> AgentDescriptor {
    let policy = policy_for(descriptor.policy_coverage);
    let degradations = degradations_for(
        &policy,
        descriptor.supports.resume,
        descriptor.supports.steer,
    );
    AgentDescriptor {
        id: descriptor.id.to_string(),
        adapter_version: descriptor.adapter_version,
        target_version: descriptor.target_version,
        transport: format!("{:?}", descriptor.transport),
        supports_resume: descriptor.supports.resume,
        supports_steer: descriptor.supports.steer,
        supports_usage_reporting: descriptor.supports.usage_reporting,
        supports_diff_events: descriptor.supports.diff_events,
        supports_permission_bridge: descriptor.supports.permission_bridge,
        supports_concurrent_sessions: descriptor.supports.concurrent_sessions,
        policy,
        degradations,
    }
}

fn health_for(health: RuntimeHealth, descriptor: &AgentDescriptor) -> AgentHealth {
    let availability = if !health.ready {
        AgentAvailability::Unavailable
    } else if descriptor.degradations.is_empty() {
        AgentAvailability::Ready
    } else {
        AgentAvailability::Degraded
    };
    AgentHealth {
        availability,
        detected_version: Some(health.detected_version),
        detail: health.detail,
        degradations: descriptor.degradations.clone(),
    }
}

fn policy_for(policy: PolicyCoverage) -> AgentPolicyCoverage {
    AgentPolicyCoverage {
        tool_visibility: match policy.tool_visibility {
            ToolVisibility::Full => IdeCoverage::Enforced,
            ToolVisibility::DeclaredOnly => IdeCoverage::DeclaredOnly,
            ToolVisibility::Opaque => IdeCoverage::Unknown,
        },
        approvals: match policy.approvals {
            ApprovalCoverage::Bridged => IdeCoverage::Enforced,
            ApprovalCoverage::HarnessOwned => IdeCoverage::HarnessOwned,
        },
        egress: match policy.egress {
            EgressCoverage::InputFiltered => IdeCoverage::Enforced,
            EgressCoverage::HarnessOwned => IdeCoverage::HarnessOwned,
        },
        budget: match policy.budget {
            BudgetCoverage::Reported => IdeCoverage::Enforced,
            BudgetCoverage::Estimated => IdeCoverage::DeclaredOnly,
            BudgetCoverage::Unknown => IdeCoverage::Unknown,
        },
        sandbox: match policy.sandbox {
            SandboxCoverage::Honored => IdeCoverage::Enforced,
            SandboxCoverage::Partial => IdeCoverage::DeclaredOnly,
            SandboxCoverage::None => IdeCoverage::Unknown,
        },
    }
}

fn degradations_for(policy: &AgentPolicyCoverage, resume: bool, steer: bool) -> Vec<String> {
    let mut notes = Vec::new();
    if policy.tool_visibility != IdeCoverage::Enforced {
        notes.push("Tool calls are not fully mediated by the IDE.".to_string());
    }
    if policy.approvals != IdeCoverage::Enforced {
        notes.push("Approvals are owned by the external harness.".to_string());
    }
    if policy.egress != IdeCoverage::Enforced {
        notes.push(
            "The external harness can make network requests outside IDE egress control."
                .to_string(),
        );
    }
    if policy.sandbox != IdeCoverage::Enforced {
        notes.push("The requested sandbox is not fully enforced by this harness.".to_string());
    }
    if !resume {
        notes.push("Session resume after an IDE restart is unavailable.".to_string());
    }
    if !steer {
        notes.push("Mid-task steering is unavailable.".to_string());
    }
    notes
}

fn event_to_ide(session_id: &AgentSessionId, event: RuntimeEvent) -> IdeAgentEvent {
    match event {
        RuntimeEvent::Started { .. } => IdeAgentEvent::Started {
            session_id: session_id.clone(),
        },
        RuntimeEvent::MessageDelta { task, text } => IdeAgentEvent::MessageDelta {
            task_id: task.0,
            text,
        },
        RuntimeEvent::Thinking { task, summary } => IdeAgentEvent::Thinking {
            task_id: task.0,
            summary,
        },
        RuntimeEvent::ToolCall {
            task,
            name,
            input_digest,
        } => IdeAgentEvent::ToolCall {
            task_id: task.0,
            name,
            input_digest,
        },
        RuntimeEvent::ToolResult {
            task,
            name,
            output_digest,
            is_error,
        } => IdeAgentEvent::ToolResult {
            task_id: task.0,
            name,
            output_digest,
            is_error,
        },
        RuntimeEvent::PermissionRequest {
            task,
            action,
            detail,
            ..
        } => IdeAgentEvent::PermissionRequested {
            task_id: task.0,
            action: permission_action_name(action),
            detail,
        },
        RuntimeEvent::Diff {
            task,
            path,
            added,
            removed,
        } => IdeAgentEvent::Diff {
            task_id: task.0,
            path,
            added,
            removed,
        },
        RuntimeEvent::Artifact { task, artifact } => IdeAgentEvent::Artifact {
            task_id: task.0,
            kind: artifact_kind_name(artifact.kind).to_string(),
            path: artifact.path,
            digest: artifact.digest,
        },
        RuntimeEvent::Usage { task, delta } => IdeAgentEvent::Usage {
            task_id: task.0,
            input_tokens: delta.input_tokens,
            output_tokens: delta.output_tokens,
        },
        RuntimeEvent::Warning { task, code, detail } => IdeAgentEvent::Warning {
            task_id: task.0,
            code: format!("{:?}", code),
            detail,
        },
        RuntimeEvent::Ended { task, outcome } => IdeAgentEvent::Ended {
            task_id: task.0,
            outcome: outcome_to_ide(outcome),
        },
        _ => IdeAgentEvent::Warning {
            task_id: 0,
            code: "UnsupportedRuntimeEvent".to_string(),
            detail: "The selected agent emitted an event this IDE version cannot render."
                .to_string(),
        },
    }
}

fn outcome_to_ide(outcome: TaskOutcome) -> IdeTaskOutcome {
    match outcome {
        TaskOutcome::Success => IdeTaskOutcome::Success,
        TaskOutcome::Failed { reason } => IdeTaskOutcome::Failed { reason },
        TaskOutcome::Cancelled => IdeTaskOutcome::Cancelled,
        TaskOutcome::TimedOut => IdeTaskOutcome::TimedOut,
    }
}

fn permission_action_name(action: PermissionAction) -> String {
    match action {
        PermissionAction::RunCommand => "run-command".to_string(),
        PermissionAction::WriteFile => "write-file".to_string(),
        PermissionAction::Network => "network".to_string(),
        PermissionAction::UseTool => "use-tool".to_string(),
        PermissionAction::Other(value) => value,
    }
}

fn artifact_kind_name(kind: ArtifactKind) -> &'static str {
    match kind {
        ArtifactKind::Diff => "diff",
        ArtifactKind::File => "file",
        ArtifactKind::Log => "log",
    }
}

fn map_runtime_error(error: RuntimeError) -> AgentFacadeError {
    match error {
        RuntimeError::Unavailable(detail)
        | RuntimeError::Version(detail)
        | RuntimeError::Auth(detail) => AgentFacadeError::Unavailable { detail },
        error => AgentFacadeError::Runtime {
            detail: sanitize_runtime_error(&error),
        },
    }
}

fn sanitize_runtime_error(error: &RuntimeError) -> String {
    // RuntimeError's contract already forbids secrets. Keep an explicit short boundary here so
    // future runtime variants are not accidentally formatted into host logs wholesale.
    error.to_string().chars().take(300).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bastion_agent_runtime::{RuntimeSupports, Transport};

    fn descriptor(policy_coverage: PolicyCoverage) -> RuntimeDescriptor {
        RuntimeDescriptor {
            id: "test-runtime",
            adapter_version: "1.0.0".to_string(),
            target_version: "test >=1".to_string(),
            transport: Transport::Embedded,
            supports: RuntimeSupports {
                resume: false,
                steer: false,
                usage_reporting: true,
                diff_events: true,
                permission_bridge: false,
                concurrent_sessions: true,
            },
            policy_coverage,
        }
    }

    #[test]
    fn declares_harness_owned_acpx_policy_as_degraded() {
        let card = descriptor_for(descriptor(PolicyCoverage {
            tool_visibility: ToolVisibility::DeclaredOnly,
            approvals: ApprovalCoverage::HarnessOwned,
            egress: EgressCoverage::HarnessOwned,
            budget: BudgetCoverage::Reported,
            sandbox: SandboxCoverage::None,
        }));

        assert_eq!(card.policy.approvals, IdeCoverage::HarnessOwned);
        assert_eq!(card.policy.egress, IdeCoverage::HarnessOwned);
        assert!(card
            .degradations
            .iter()
            .any(|note| note.contains("network")));
        assert!(card.degradations.iter().any(|note| note.contains("resume")));
    }

    #[test]
    fn builds_a_deny_by_default_session_with_only_explicit_home_environment() {
        let spec = session_spec_from(StartAgentSession {
            owner: "local-user".to_string(),
            workspace_root: PathBuf::from("/tmp/example"),
            home_dir: PathBuf::from("/tmp/local-user-home"),
            read_only: false,
            denied_paths: vec![PathBuf::from(".env")],
            sandbox: AgentSandbox::Isolated,
            auth_profile_ref: "claude-subscription".to_string(),
            runtime_id: "claude".to_string(),
            allowed_actions: Vec::new(),
            task_timeout_ms: 5_000,
            idle_timeout_ms: 30_000,
        });

        assert!(spec.permissions.allow.is_empty());
        assert_eq!(spec.env.allow.len(), 1);
        assert_eq!(
            spec.env.allow.get("HOME"),
            Some(&"/tmp/local-user-home".to_string())
        );
        assert_eq!(spec.workspace.deny, vec![PathBuf::from(".env")]);
        assert_eq!(spec.timeout.per_task, Duration::from_secs(5));
    }

    #[test]
    fn maps_terminal_events_without_exposing_external_session_reference() {
        let event = event_to_ide(
            &AgentSessionId("agent-7".to_string()),
            RuntimeEvent::Ended {
                task: bastion_agent_runtime::TaskId(4),
                outcome: TaskOutcome::Cancelled,
            },
        );
        assert_eq!(
            event,
            IdeAgentEvent::Ended {
                task_id: 4,
                outcome: IdeTaskOutcome::Cancelled,
            }
        );
    }
}
