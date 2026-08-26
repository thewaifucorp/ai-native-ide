//! Host-neutral agent facade for the AI-Native IDE.
//!
//! This crate deliberately adapts a real `bastion-agent-runtime` adapter instead
//! of making the UI parse a CLI's stdout. The desktop host owns persistence and
//! event delivery; this facade owns no secrets and reports external-harness
//! policy gaps explicitly.
//!
//! # Why the direct-ACP adapter, not `acpx`
//!
//! This facade used to sit on `bastion_agent_runtime::acpx`, which supervises a
//! third-party headless ACP *client*. That client answered the agent's
//! `session/request_permission` calls itself, so what reached the IDE was a
//! notification about a decision already taken — `approvals = HarnessOwned`, and
//! `respond_permission` was always an error. The Build panel could show that a
//! write had been blocked; it could not be the thing that blocked it.
//!
//! `bastion_agent_runtime::acp` makes Bastion the ACP client, so the permission
//! request parks in the IDE until someone answers it. That is the entire reason
//! for the swap, and it is what [`AgentFacade::respond_permission`] exposes.

use bastion_agent_runtime::{
    acp::AcpAgentRuntime, AgentRuntime, ApprovalCoverage, ArtifactKind, AuthProfileRef,
    BudgetCoverage, CancelMode, DenyScope, EgressCoverage, EnvPolicy, PermissionAction,
    PermissionDecision, PermissionProfile, PermissionRequestId, PolicyCoverage, ProposedEdit,
    ResumeSpec,
    RuntimeDescriptor, RuntimeError, RuntimeEvent, RuntimeHealth, RuntimeSession, SandboxCoverage,
    SandboxProfile, SessionHandle, SessionSpec, SessionStatus, TaskExpectation, TaskInput,
    TaskOutcome, ToolVisibility, WorkspacePolicy,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::sync::Mutex;

/// How long [`AgentFacade::next_event`] waits before reporting "nothing pending".
///
/// Short on purpose: the session lock is held for this long, so it bounds how
/// long any other call on the same session (notably
/// [`AgentFacade::respond_permission`]) can be delayed.
const NEXT_EVENT_WAIT: Duration = Duration::from_millis(250);

/// Stable IDE-owned identity. The harness session reference never crosses the UI boundary.
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

/// One file edit a pending permission would perform, ready to render as a diff.
///
/// Mirrors `bastion_agent_runtime::ProposedEdit` across the host boundary. It
/// exists so the person deciding sees the bytes rather than a description of
/// them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionEdit {
    /// Relative to the workspace root when inside it; ABSOLUTE when the edit
    /// aims outside — the UI must show that difference, not hide it.
    pub path: PathBuf,
    /// Previous content, when the agent reported it. `None` means "not
    /// reported", which is not the same as "the file is new".
    pub old_text: Option<String>,
    pub new_text: String,
    /// The preview was shortened. Whoever renders it must say so.
    pub truncated: bool,
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
    /// A permission request parked in the adapter, waiting for a decision.
    ///
    /// Unlike every other variant this one is not observability: nothing
    /// proceeds until [`AgentFacade::respond_permission`] is called with
    /// `request_id`. An unanswered request blocks until the task's own timeout
    /// fires, and a timed-out request is treated as a denial — the IDE never
    /// approves by falling silent.
    PermissionRequested {
        task_id: u64,
        /// Answer handle for [`AgentFacade::respond_permission`].
        request_id: u64,
        action: String,
        detail: String,
        /// The edits this request would perform. Empty when the agent reported
        /// none (a command, a network call) — never a fabricated preview.
        edits: Vec<PermissionEdit>,
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
    /// The selected agent does not declare the resume capability at all. Returned
    /// without touching the runtime, so the UI can honestly say resume is a
    /// capability this agent lacks rather than a transient failure.
    #[error("agent does not support session resume: {detail}")]
    ResumeUnsupported { detail: String },
    /// The agent supports resume, but this specific handle can no longer reattach
    /// (expired, evicted, foreign owner). Distinct from [`AgentFacadeError::ResumeUnsupported`]
    /// so the host never silently starts a fresh session in its place.
    #[error("agent session cannot be resumed: {detail}")]
    NotResumable { detail: String },
}

/// Running totals the facade accumulates from [`RuntimeEvent::Usage`] as events are
/// drained. Part of the portable snapshot so a swap does not lose spend accounting.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentUsageTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// A host-persistable snapshot of a session's transferable state.
///
/// It exists so the desktop host can (a) resume a session after a restart and
/// (b) swap the active agent without losing the state the runtime actually
/// exposes. `external_ref` is the opaque adapter session reference: it is for
/// host-side persistence only and must never be surfaced to the UI (the UI keeps
/// working with the IDE-owned [`AgentSessionId`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentSessionState {
    pub session_id: AgentSessionId,
    /// Adapter id the handle belongs to; resume/adopt revalidate it.
    pub runtime_id: String,
    pub owner: String,
    /// Opaque adapter session reference. Host-persistence only, never shown in the UI.
    pub external_ref: String,
    /// The original open request, re-appliable to start a fresh session when the
    /// live harness session cannot be transferred to the target agent.
    pub origin: StartAgentSession,
    pub usage: AgentUsageTotals,
    pub last_status: SessionStatus,
}

/// Honest accounting of what a swap moved and what it could not.
///
/// A swap to an agent that can reattach the original harness session keeps the
/// conversation/context (`resumed == true`). A swap to any other agent must start
/// fresh: the harness-owned conversation is not portable across backends, so it is
/// reported as dropped rather than silently lost.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SwapReport {
    /// True when the target reattached the original harness session (context kept).
    pub resumed: bool,
    pub preserved: Vec<String>,
    pub dropped: Vec<String>,
}

struct ManagedSession {
    runtime_session: Box<dyn RuntimeSession>,
    /// The request that opened (or last resumed) this session, kept so the state
    /// can be re-applied on a resume or a fresh-start swap.
    origin: StartAgentSession,
    /// Usage accumulated from drained [`RuntimeEvent::Usage`] events.
    usage: AgentUsageTotals,
}

/// A host-neutral facade over a direct-ACP agent session. It does no credential
/// discovery and never logs input.
pub struct AgentFacade {
    runtime: Arc<dyn AgentRuntime>,
    sessions: Mutex<HashMap<AgentSessionId, ManagedSession>>,
    next_session_id: AtomicU64,
}

impl AgentFacade {
    /// Opens a facade for a known agent name (`"claude"`, `"codex"`,
    /// `"opencode"`, `"gemini"`), resolved to its ACP bridge command by
    /// [`bridge_command_for`].
    pub fn new(agent: impl Into<String>) -> Result<Self, AgentFacadeError> {
        let agent = agent.into();
        let command = bridge_command_for(&agent).ok_or_else(|| AgentFacadeError::Unavailable {
            detail: format!("no ACP bridge is known for agent {agent:?}"),
        })?;
        Ok(Self::from_runtime(AcpAgentRuntime::new(command)))
    }

    /// Opens a facade for an arbitrary ACP bridge command, for an agent this
    /// build has no entry for.
    pub fn from_bridge_command(command: impl Into<String>) -> Self {
        Self::from_runtime(AcpAgentRuntime::new(command.into()))
    }

    fn from_runtime(runtime: impl AgentRuntime + 'static) -> Self {
        Self {
            runtime: Arc::new(runtime),
            sessions: Mutex::new(HashMap::new()),
            next_session_id: AtomicU64::new(1),
        }
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

    /// Opens a real agent session only after its health probe says it is ready.
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
            .start(session_spec_from(request.clone()))
            .await
            .map_err(map_runtime_error)?;
        Ok(self
            .insert_session(session, request, AgentUsageTotals::default())
            .await)
    }

    /// Registers a live runtime session under a fresh IDE-owned id, remembering the
    /// request that opened it and any usage carried over from a prior session.
    async fn insert_session(
        &self,
        session: Box<dyn RuntimeSession>,
        origin: StartAgentSession,
        usage: AgentUsageTotals,
    ) -> AgentSessionId {
        let id = AgentSessionId(format!(
            "agent-{}",
            self.next_session_id.fetch_add(1, Ordering::Relaxed)
        ));
        self.sessions.lock().await.insert(
            id.clone(),
            ManagedSession {
                runtime_session: session,
                origin,
                usage,
            },
        );
        id
    }

    /// Captures a host-persistable snapshot of a live session's transferable state:
    /// the adapter handle, the opening request, and the usage accumulated so far.
    /// This is what a host stores for a later [`AgentFacade::resume`] or hands to
    /// another facade's [`AgentFacade::adopt_state`] for an agent swap.
    pub async fn capture_state(
        &self,
        session_id: &AgentSessionId,
    ) -> Result<AgentSessionState, AgentFacadeError> {
        let mut sessions = self.sessions.lock().await;
        let managed = sessions
            .get_mut(session_id)
            .ok_or(AgentFacadeError::SessionNotFound)?;
        let handle = managed.runtime_session.handle();
        let last_status = managed
            .runtime_session
            .status()
            .await
            .map_err(map_runtime_error)?;
        Ok(AgentSessionState {
            session_id: session_id.clone(),
            runtime_id: handle.runtime_id,
            owner: handle.owner,
            external_ref: handle.external_ref,
            origin: managed.origin.clone(),
            usage: managed.usage,
            last_status,
        })
    }

    /// Resumes a previously captured session, honoring the resume capability.
    ///
    /// If the agent does not declare `supports_resume`, this returns
    /// [`AgentFacadeError::ResumeUnsupported`] without touching the runtime — an
    /// honest capability answer, never a pretend reattach. When the capability is
    /// present but this specific handle can no longer reattach, the runtime's
    /// [`RuntimeError::NotResumable`] surfaces as [`AgentFacadeError::NotResumable`]
    /// rather than silently starting a new session. On success a new IDE-owned
    /// [`AgentSessionId`] is returned, carrying the snapshot's usage totals forward.
    pub async fn resume(
        &self,
        state: &AgentSessionState,
    ) -> Result<AgentSessionId, AgentFacadeError> {
        if !self.descriptor().supports_resume {
            return Err(AgentFacadeError::ResumeUnsupported {
                detail: "the selected agent does not expose a session reattach protocol"
                    .to_string(),
            });
        }
        let health = self.health().await;
        if health.availability == AgentAvailability::Unavailable {
            return Err(AgentFacadeError::Unavailable {
                detail: health
                    .detail
                    .unwrap_or_else(|| "ACPX is not ready".to_string()),
            });
        }
        let handle = SessionHandle {
            runtime_id: state.runtime_id.clone(),
            owner: state.owner.clone(),
            external_ref: state.external_ref.clone(),
        };
        let session = self
            .runtime
            .resume(&handle, resume_spec_from(&state.origin))
            .await
            .map_err(map_runtime_error)?;
        Ok(self
            .insert_session(session, state.origin.clone(), state.usage)
            .await)
    }

    /// Adopts a snapshot captured from another agent facade, swapping the active
    /// agent without losing more state than the runtimes allow.
    ///
    /// When this facade's agent is the same adapter that produced the snapshot and
    /// it supports resume, the original harness session is reattached and the
    /// conversation/context is preserved. Otherwise the conversation is harness-owned
    /// and not portable across backends: a fresh session is started from the
    /// snapshot's opening request, carrying owner, workspace/policy and usage totals,
    /// while the conversation history, in-flight tasks, and the external session
    /// reference are reported as dropped. The [`SwapReport`] records exactly which.
    pub async fn adopt_state(
        &self,
        state: AgentSessionState,
    ) -> Result<(AgentSessionId, SwapReport), AgentFacadeError> {
        let descriptor = self.descriptor();
        let same_adapter = descriptor.id == state.runtime_id;
        if same_adapter && descriptor.supports_resume {
            let id = self.resume(&state).await?;
            return Ok((
                id,
                SwapReport {
                    resumed: true,
                    preserved: vec![
                        "conversation history and harness context".to_string(),
                        "external harness session reference".to_string(),
                        "accumulated usage totals".to_string(),
                    ],
                    dropped: Vec::new(),
                },
            ));
        }

        let id = self
            .insert_session(
                self.runtime
                    .start(session_spec_from(state.origin.clone()))
                    .await
                    .map_err(map_runtime_error)?,
                state.origin.clone(),
                state.usage,
            )
            .await;
        Ok((
            id,
            SwapReport {
                resumed: false,
                preserved: vec![
                    "owner and auth profile reference".to_string(),
                    "workspace root and policy".to_string(),
                    "accumulated usage totals".to_string(),
                ],
                dropped: vec![
                    "conversation history and harness context".to_string(),
                    "in-flight tasks".to_string(),
                    "external harness session reference".to_string(),
                ],
            },
        ))
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

    /// Pulls one structured event, or `None` when nothing is pending right now.
    ///
    /// The wait is BOUNDED, and that bound is load-bearing rather than a tuning
    /// knob. `RuntimeSession::next_event` parks until an event exists, and this
    /// method holds the session lock while it waits — so an unbounded wait means
    /// no other call on this session can run, `respond_permission` included.
    ///
    /// That deadlocks exactly when the product matters most: the agent stops to
    /// ask permission, which means it emits nothing until answered, which means
    /// `next_event` never returns, which means the lock is never released and the
    /// answer can never be delivered. The agent waits for a decision that is
    /// waiting for the agent. (Found by running it, not by reasoning about it —
    /// the Build panel sat on `working` forever with the bridge alive and idle.)
    ///
    /// It could not happen under the previous `acpx` adapter, which answered
    /// permission requests itself and therefore always had something to emit.
    ///
    /// Returning `None` on expiry is not a workaround: the host polls, and "no
    /// event right now" is the honest answer to a poll.
    pub async fn next_event(
        &self,
        session_id: &AgentSessionId,
    ) -> Result<Option<IdeAgentEvent>, AgentFacadeError> {
        let mut sessions = self.sessions.lock().await;
        let managed = sessions
            .get_mut(session_id)
            .ok_or(AgentFacadeError::SessionNotFound)?;
        let event = match tokio::time::timeout(
            NEXT_EVENT_WAIT,
            managed.runtime_session.next_event(),
        )
        .await
        {
            Ok(event) => event,
            // Nothing arrived in the window. The session is untouched and the
            // lock is about to be released, which is the entire point.
            Err(_) => return Ok(None),
        };
        if let Some(RuntimeEvent::Usage { delta, .. }) = &event {
            let usage = &mut managed.usage;
            usage.input_tokens = usage.input_tokens.saturating_add(delta.input_tokens);
            usage.output_tokens = usage.output_tokens.saturating_add(delta.output_tokens);
        }
        Ok(event.map(|event| event_to_ide(session_id, event)))
    }

    /// Cancellation delegates to the adapter and preserves its idempotent semantics.
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

    /// Answers a parked [`IdeAgentEvent::PermissionRequested`].
    ///
    /// `deny_ends_turn` picks the denial's blast radius, mirroring the runtime's
    /// `DenyScope`: `true` (the product default) also cancels the delegated task,
    /// so a refused write cannot be retried through some other ungated tool in
    /// the same turn; `false` refuses only this one request and lets the turn
    /// continue.
    ///
    /// Answering an id that is not parked is an error, never a silent no-op: the
    /// UI must not believe it approved something the agent never asked.
    pub async fn respond_permission(
        &self,
        session_id: &AgentSessionId,
        request_id: u64,
        allow: bool,
        deny_ends_turn: bool,
    ) -> Result<(), AgentFacadeError> {
        let mut sessions = self.sessions.lock().await;
        let managed = sessions
            .get_mut(session_id)
            .ok_or(AgentFacadeError::SessionNotFound)?;
        let decision = if allow {
            PermissionDecision::Allow
        } else {
            PermissionDecision::Deny {
                scope: if deny_ends_turn {
                    DenyScope::Turn
                } else {
                    DenyScope::Instance
                },
            }
        };
        managed
            .runtime_session
            .respond_permission(PermissionRequestId(request_id), decision)
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

/// Maps a host-facing agent name onto the command that speaks ACP for it.
///
/// Kept as a table rather than a free-form command from the UI: the host picks
/// an agent, it does not get to name an arbitrary process for the IDE to spawn.
/// Callers that genuinely need another bridge use
/// [`AgentFacade::from_bridge_command`] explicitly.
pub fn bridge_command_for(agent: &str) -> Option<&'static str> {
    match agent {
        "claude" => Some("claude-agent-acp"),
        "codex" => Some("npx -y @agentclientprotocol/codex-acp@^0.0.44"),
        "opencode" => Some("npx -y opencode-ai acp"),
        "gemini" => Some("gemini --acp"),
        _ => None,
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
        // The wrapped agent CLI needs HOME to find its existing authenticated
        // session. The host supplies this one path explicitly; no ambient
        // environment, API key, or arbitrary variables are inherited by the
        // subprocess.
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

/// Builds the re-appliable policy subset for a reattach from the opening request.
/// Workspace and sandbox are deliberately omitted: a harness session's root and
/// confinement are fixed at open time and cannot be renegotiated on resume.
fn resume_spec_from(origin: &StartAgentSession) -> ResumeSpec {
    ResumeSpec {
        timeout: bastion_agent_runtime::TimeoutPolicy {
            per_task: Duration::from_millis(origin.task_timeout_ms),
            idle: Duration::from_millis(origin.idle_timeout_ms),
        },
        permissions: PermissionProfile {
            allow: origin.allowed_actions.clone(),
        },
        env: EnvPolicy {
            allow: [(
                "HOME".to_string(),
                origin.home_dir.to_string_lossy().into_owned(),
            )]
            .into_iter()
            .collect(),
        },
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
            id,
            action,
            detail,
            edits,
        } => IdeAgentEvent::PermissionRequested {
            task_id: task.0,
            request_id: id.0,
            action: permission_action_name(action),
            detail,
            edits: edits.into_iter().map(permission_edit).collect(),
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

fn permission_edit(edit: ProposedEdit) -> PermissionEdit {
    PermissionEdit {
        path: edit.path,
        old_text: edit.old_text,
        new_text: edit.new_text,
        truncated: edit.truncated,
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
        RuntimeError::NotResumable(detail) => AgentFacadeError::NotResumable { detail },
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
    use bastion_agent_runtime::{RuntimeSupports, SessionHandle, TaskId, Transport, UsageDelta};

    #[derive(Clone, Default)]
    struct TestProbe {
        starts: Arc<Mutex<Vec<SessionSpec>>>,
        submissions: Arc<Mutex<Vec<TaskInput>>>,
        cancellations: Arc<Mutex<Vec<CancelMode>>>,
        resumes: Arc<Mutex<Vec<SessionHandle>>>,
        /// Decisions the facade forwarded, in order. Models a runtime whose
        /// `approvals` is `Bridged` — the whole point of the direct-ACP swap.
        permissions: Arc<Mutex<Vec<(u64, PermissionDecision)>>>,
    }

    #[derive(Default)]
    struct TestRuntime {
        probe: TestProbe,
        ready: bool,
        resumable: bool,
        /// Events each session opened by this runtime will replay in order.
        session_events: Vec<RuntimeEvent>,
    }

    struct TestSession {
        probe: TestProbe,
        status: SessionStatus,
        next_task: u64,
        events: std::collections::VecDeque<RuntimeEvent>,
    }

    impl TestRuntime {
        fn session(&self) -> TestSession {
            TestSession {
                probe: self.probe.clone(),
                status: SessionStatus::Idle,
                next_task: 1,
                events: self.session_events.iter().cloned().collect(),
            }
        }
    }

    #[async_trait::async_trait]
    impl AgentRuntime for TestRuntime {
        fn descriptor(&self) -> RuntimeDescriptor {
            let mut card = descriptor(PolicyCoverage {
                tool_visibility: ToolVisibility::DeclaredOnly,
                approvals: ApprovalCoverage::HarnessOwned,
                egress: EgressCoverage::HarnessOwned,
                budget: BudgetCoverage::Reported,
                sandbox: SandboxCoverage::None,
            });
            card.supports.resume = self.resumable;
            card
        }

        async fn health(&self) -> Result<RuntimeHealth, RuntimeError> {
            Ok(RuntimeHealth {
                detected_version: "test-runtime 1.0".to_string(),
                ready: self.ready,
                detail: (!self.ready).then(|| "test runtime unavailable".to_string()),
            })
        }

        async fn start(&self, spec: SessionSpec) -> Result<Box<dyn RuntimeSession>, RuntimeError> {
            self.probe.starts.lock().await.push(spec);
            Ok(Box::new(self.session()))
        }

        async fn resume(
            &self,
            handle: &SessionHandle,
            _spec: ResumeSpec,
        ) -> Result<Box<dyn RuntimeSession>, RuntimeError> {
            self.probe.resumes.lock().await.push(handle.clone());
            if !self.resumable {
                return Err(RuntimeError::NotResumable(
                    "test runtime cannot resume".to_string(),
                ));
            }
            Ok(Box::new(self.session()))
        }
    }

    #[async_trait::async_trait]
    impl RuntimeSession for TestSession {
        fn handle(&self) -> SessionHandle {
            SessionHandle {
                runtime_id: "test-runtime".to_string(),
                owner: "test-owner".to_string(),
                external_ref: "never-exposed".to_string(),
            }
        }

        async fn submit(&mut self, input: TaskInput) -> Result<TaskId, RuntimeError> {
            self.probe.submissions.lock().await.push(input);
            self.status = SessionStatus::Running;
            let task = TaskId(self.next_task);
            self.next_task += 1;
            Ok(task)
        }

        async fn next_event(&mut self) -> Option<RuntimeEvent> {
            self.events.pop_front()
        }

        async fn steer(&mut self, _text: &str) -> Result<(), RuntimeError> {
            Err(RuntimeError::Protocol(
                "steering unavailable in test runtime".to_string(),
            ))
        }

        async fn cancel(&mut self, mode: CancelMode) -> Result<(), RuntimeError> {
            self.probe.cancellations.lock().await.push(mode);
            self.status = SessionStatus::Cancelled;
            Ok(())
        }

        async fn respond_permission(
            &mut self,
            id: bastion_agent_runtime::PermissionRequestId,
            decision: bastion_agent_runtime::PermissionDecision,
        ) -> Result<(), RuntimeError> {
            self.probe.permissions.lock().await.push((id.0, decision));
            Ok(())
        }

        async fn status(&self) -> Result<SessionStatus, RuntimeError> {
            Ok(self.status)
        }
    }

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

    fn session_request() -> StartAgentSession {
        StartAgentSession {
            owner: "local-user".to_string(),
            workspace_root: PathBuf::from("/tmp/example"),
            home_dir: PathBuf::from("/tmp/local-user-home"),
            read_only: false,
            denied_paths: vec![PathBuf::from(".env")],
            sandbox: AgentSandbox::Isolated,
            auth_profile_ref: "external-profile-ref".to_string(),
            runtime_id: "claude".to_string(),
            allowed_actions: Vec::new(),
            task_timeout_ms: 5_000,
            idle_timeout_ms: 30_000,
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

    /// The permission event has to carry the handle that answers it. Without
    /// `request_id` the UI can render a decision card it has no way to submit —
    /// which is precisely the state the `acpx` adapter left the Build panel in.
    #[test]
    fn permission_request_carries_the_id_that_answers_it() {
        let event = event_to_ide(
            &AgentSessionId("s-1".to_string()),
            RuntimeEvent::PermissionRequest {
                task: bastion_agent_runtime::TaskId(7),
                id: PermissionRequestId(42),
                action: PermissionAction::WriteFile,
                detail: "Write src/main.rs".to_string(),
                edits: vec![ProposedEdit {
                    path: PathBuf::from("src/main.rs"),
                    old_text: Some("antes".to_string()),
                    new_text: "depois".to_string(),
                    truncated: false,
                }],
            },
        );
        assert_eq!(
            event,
            IdeAgentEvent::PermissionRequested {
                task_id: 7,
                request_id: 42,
                action: "write-file".to_string(),
                detail: "Write src/main.rs".to_string(),
                edits: vec![PermissionEdit {
                    path: PathBuf::from("src/main.rs"),
                    old_text: Some("antes".to_string()),
                    new_text: "depois".to_string(),
                    truncated: false,
                }],
            }
        );
    }

    /// The truncation flag has to survive the boundary: the UI cannot warn about
    /// a shortened diff it was never told about.
    #[test]
    fn a_truncated_preview_stays_marked_across_the_boundary() {
        let event = event_to_ide(
            &AgentSessionId("s-1".to_string()),
            RuntimeEvent::PermissionRequest {
                task: bastion_agent_runtime::TaskId(1),
                id: PermissionRequestId(1),
                action: PermissionAction::WriteFile,
                detail: "Write big.txt".to_string(),
                edits: vec![ProposedEdit {
                    path: PathBuf::from("big.txt"),
                    old_text: None,
                    new_text: "x".to_string(),
                    truncated: true,
                }],
            },
        );
        match event {
            IdeAgentEvent::PermissionRequested { edits, .. } => {
                assert!(edits[0].truncated);
            }
            other => panic!("expected PermissionRequested, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn respond_permission_forwards_the_decision_and_its_scope() {
        let probe = TestProbe::default();
        let facade = AgentFacade::from_runtime(TestRuntime {
            probe: probe.clone(),
            ready: true,
            ..Default::default()
        });
        let session_id = facade.start_session(session_request()).await.unwrap();

        facade
            .respond_permission(&session_id, 1, true, true)
            .await
            .unwrap();
        // Denying without ending the turn refuses one request only.
        facade
            .respond_permission(&session_id, 2, false, false)
            .await
            .unwrap();
        // The product default: a denial also ends the turn, so the agent cannot
        // reroute the same goal through another ungated tool.
        facade
            .respond_permission(&session_id, 3, false, true)
            .await
            .unwrap();

        let decisions = probe.permissions.lock().await.clone();
        assert_eq!(
            decisions,
            vec![
                (1, PermissionDecision::Allow),
                (
                    2,
                    PermissionDecision::Deny {
                        scope: DenyScope::Instance
                    }
                ),
                (
                    3,
                    PermissionDecision::Deny {
                        scope: DenyScope::Turn
                    }
                ),
            ]
        );
    }

    /// Answering a session that does not exist must fail loudly: a UI that
    /// believes it approved something is worse than one that shows an error.
    /// The deadlock this bound exists to prevent, in miniature: a session that
    /// emits nothing (the agent is blocked on a permission) must not stop
    /// `respond_permission` from running. Before the bound, this test hung.
    #[tokio::test]
    async fn a_silent_session_does_not_block_answering_its_permission() {
        let probe = TestProbe::default();
        let facade = AgentFacade::from_runtime(TestRuntime {
            probe: probe.clone(),
            ready: true,
            // No scripted events: `next_event` has nothing to hand back, exactly
            // like an agent parked on an unanswered permission request.
            ..Default::default()
        });
        let session_id = facade.start_session(session_request()).await.unwrap();

        assert_eq!(facade.next_event(&session_id).await.unwrap(), None);
        facade
            .respond_permission(&session_id, 1, true, true)
            .await
            .unwrap();

        assert_eq!(probe.permissions.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn respond_permission_on_an_unknown_session_is_an_error() {
        let facade = AgentFacade::from_runtime(TestRuntime::default());
        let result = facade
            .respond_permission(&AgentSessionId("nope".to_string()), 1, true, true)
            .await;
        assert_eq!(result, Err(AgentFacadeError::SessionNotFound));
    }

    /// The host picks an agent; it never names a process for the IDE to spawn.
    #[test]
    fn unknown_agent_names_do_not_resolve_to_a_bridge_command() {
        assert_eq!(bridge_command_for("claude"), Some("claude-agent-acp"));
        assert_eq!(bridge_command_for("rm -rf /"), None);
        assert!(matches!(
            AgentFacade::new("definitely-not-an-agent"),
            Err(AgentFacadeError::Unavailable { .. })
        ));
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

    #[tokio::test]
    async fn routes_start_submit_cancel_and_status_without_a_provider_call() {
        let probe = TestProbe::default();
        let facade = AgentFacade::from_runtime(TestRuntime {
            probe: probe.clone(),
            ready: true,
            ..Default::default()
        });

        let session_id = facade.start_session(session_request()).await.unwrap();
        assert_eq!(session_id, AgentSessionId("agent-1".to_string()));
        let starts = probe.starts.lock().await;
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0].env.allow.len(), 1);
        assert!(starts[0].env.allow.contains_key("HOME"));
        drop(starts);

        let task_id = facade
            .submit_task(
                &session_id,
                AgentTask {
                    prompt: "describe the change".to_string(),
                    expectation: AgentExpectation::CodeChange,
                    model_hint: Some("model-selected-by-user".to_string()),
                },
            )
            .await
            .unwrap();
        assert_eq!(task_id, 1);
        assert_eq!(
            facade.session_status(&session_id).await.unwrap(),
            SessionStatus::Running
        );

        facade.cancel(&session_id, false).await.unwrap();
        assert_eq!(
            facade.session_status(&session_id).await.unwrap(),
            SessionStatus::Cancelled
        );
        assert_eq!(
            probe.cancellations.lock().await.as_slice(),
            &[CancelMode::Kill]
        );
        let submitted = probe.submissions.lock().await;
        assert_eq!(submitted.len(), 1);
        assert_eq!(
            submitted[0].model_hint.as_deref(),
            Some("model-selected-by-user")
        );
    }

    #[tokio::test]
    async fn unavailable_runtime_never_starts_a_session() {
        let probe = TestProbe::default();
        let facade = AgentFacade::from_runtime(TestRuntime {
            probe: probe.clone(),
            ready: false,
            ..Default::default()
        });

        let error = facade.start_session(session_request()).await.unwrap_err();
        assert!(matches!(error, AgentFacadeError::Unavailable { .. }));
        assert!(probe.starts.lock().await.is_empty());
    }

    #[tokio::test]
    async fn resume_reattaches_the_original_handle_when_capability_is_present() {
        let probe = TestProbe::default();
        let facade = AgentFacade::from_runtime(TestRuntime {
            probe: probe.clone(),
            ready: true,
            resumable: true,
            ..Default::default()
        });

        let session_id = facade.start_session(session_request()).await.unwrap();
        let state = facade.capture_state(&session_id).await.unwrap();

        let resumed = facade.resume(&state).await.unwrap();
        assert_eq!(resumed, AgentSessionId("agent-2".to_string()));
        let resumes = probe.resumes.lock().await;
        assert_eq!(resumes.len(), 1);
        assert_eq!(resumes[0].runtime_id, "test-runtime");
        assert_eq!(resumes[0].external_ref, "never-exposed");
    }

    #[tokio::test]
    async fn resume_degrades_honestly_when_capability_is_absent() {
        let probe = TestProbe::default();
        let facade = AgentFacade::from_runtime(TestRuntime {
            probe: probe.clone(),
            ready: true,
            resumable: false,
            ..Default::default()
        });

        let session_id = facade.start_session(session_request()).await.unwrap();
        let state = facade.capture_state(&session_id).await.unwrap();

        let error = facade.resume(&state).await.unwrap_err();
        assert!(matches!(error, AgentFacadeError::ResumeUnsupported { .. }));
        // Honest degradation: the runtime's reattach protocol was never even called.
        assert!(probe.resumes.lock().await.is_empty());
    }

    #[tokio::test]
    async fn swap_to_resumable_agent_preserves_context_and_usage() {
        // Source agent accrues usage, then a same-adapter resumable target adopts it.
        let source = AgentFacade::from_runtime(TestRuntime {
            probe: TestProbe::default(),
            ready: true,
            resumable: true,
            session_events: vec![RuntimeEvent::Usage {
                task: bastion_agent_runtime::TaskId(1),
                delta: UsageDelta {
                    input_tokens: 120,
                    output_tokens: 45,
                },
            }],
        });
        let session_id = source.start_session(session_request()).await.unwrap();
        // Drain the usage event so the facade accumulates it into the snapshot.
        source.next_event(&session_id).await.unwrap();
        let state = source.capture_state(&session_id).await.unwrap();
        assert_eq!(state.usage.input_tokens, 120);
        assert_eq!(state.usage.output_tokens, 45);

        let target_probe = TestProbe::default();
        let target = AgentFacade::from_runtime(TestRuntime {
            probe: target_probe.clone(),
            ready: true,
            resumable: true,
            ..Default::default()
        });
        let (new_id, report) = target.adopt_state(state).await.unwrap();

        assert!(report.resumed);
        assert!(report.dropped.is_empty());
        assert_eq!(target_probe.resumes.lock().await.len(), 1);
        // Usage totals ride along into the adopted session.
        let carried = target.capture_state(&new_id).await.unwrap();
        assert_eq!(carried.usage.input_tokens, 120);
        assert_eq!(carried.usage.output_tokens, 45);
    }

    #[tokio::test]
    async fn swap_to_non_resumable_agent_starts_fresh_and_reports_dropped_conversation() {
        let source = AgentFacade::from_runtime(TestRuntime {
            probe: TestProbe::default(),
            ready: true,
            resumable: true,
            ..Default::default()
        });
        let session_id = source.start_session(session_request()).await.unwrap();
        let state = source.capture_state(&session_id).await.unwrap();
        let owner = state.origin.owner.clone();

        let target_probe = TestProbe::default();
        let target = AgentFacade::from_runtime(TestRuntime {
            probe: target_probe.clone(),
            ready: true,
            resumable: false,
            ..Default::default()
        });
        let (_new_id, report) = target.adopt_state(state).await.unwrap();

        assert!(!report.resumed);
        // A fresh session was started, not a reattach.
        assert!(target_probe.resumes.lock().await.is_empty());
        assert_eq!(target_probe.starts.lock().await.len(), 1);
        assert_eq!(target_probe.starts.lock().await[0].owner, owner);
        // The harness-owned conversation is honestly reported as dropped.
        assert!(report
            .dropped
            .iter()
            .any(|note| note.contains("conversation")));
        assert!(report.preserved.iter().any(|note| note.contains("usage")));
    }
}
