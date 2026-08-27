//! Line-delimited JSON-over-stdio sidecar exposing the real `ide-diff` engine.
//!
//! Protocol: one JSON object per line on stdin, one JSON object per line on
//! stdout. Request: `{ "id": <any>, "method": "...", "params": { ... } }`.
//! Response: `{ "id": <echoed>, "result": <value> }` or
//! `{ "id": <echoed>, "error": "<message>" }`.
//!
//! Methods:
//!   - `ping`            -> `{ "pong": true, "engine": "ide-diff+ide-domain" }`
//!   - `diff`            params `{ original, proposed }`            -> `{ "hunks": [...] }`
//!   - `merge_selected`  params `{ original, proposed, selected }`  -> `{ "merged": "..." }`
//!   - `broker_propose`  params `{ root, owner, effect_id, relative_path, content }`
//!                                                                  -> the broker's Value
//!                        (`{ awaiting_approval: true }` on the first call, then
//!                         `{ written: true, path }` once the effect is approved)
//!   - `broker_approve`  params `{ root, owner, effect_id }` -> `{ approved_id: <i64> }`
//!   - `broker_rollback` params `{ root, owner, effect_id }` -> `{ rolledback: true }`
//!   - `broker_activity` params `{ root, owner }`   -> `{ activity: [...] }`
//!   - `harness_run`     params `{ root, owner, run_tools }` -> the §4 report
//!   - `preview_start` / `preview_status` / `preview_stop` params `{ root }`
//!                                                      -> the §4 preview snapshot
//!   - `reconcile_scan`  params `{ root }`              -> intents vs observations
//!   - `reconcile_decide` params `{ root, divergence_id, choice }`
//!   - `packs_snapshot`  params `{ root, passed, failed }`
//!   - `packs_install`   params `{ root, path }`
//!   - `packs_apply` / `packs_revert` params `{ root, pack_id }`
//!   - `context_compile` params `{ root, budget_chars }` -> the §6 package
//!   - `library_*`   the §13 Guidance Library + Truth Registry
//!   - `settings_*`  the §13 config (one schema for the panel and the file)
//!   - `project_*`   the §13 durable project (identity, intent, resources)
//!   - `intent_review` / `intent_decide` the §8 guided intent (Layer-1 hypotheses)
//!   - `notes_*`      the §7 notes by theme and their reconciliation
//!
//! `diff` / `merge_selected` call straight into `ide_diff::{diff, merge_selected}`.
//! The `broker_*` methods drive the REAL `ide_domain::WorkspaceEffectBroker`
//! (capability registry + SqliteApprovalGate + snapshot store) — one live broker
//! per (owner, workspace-root), kept in a process-wide registry so the
//! propose → approve → propose-executes → rollback lifecycle spans requests.

mod context;
mod harness;
mod intent;
mod library;
mod notes;
mod packs;
mod policy;
mod project;
mod settings;
mod preview;
mod reconcile;

use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use ide_agent::{
    AgentFacade, AgentAvailability, AgentExpectation, AgentSandbox, AgentSessionId, AgentTask,
    StartAgentSession,
};
use ide_diff::{diff, merge_selected, Hunk};
use ide_domain::{WorkspaceEffectBroker, WorkspaceWrite};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
struct Response {
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Deserialize)]
struct DiffParams {
    original: String,
    proposed: String,
}

#[derive(Deserialize)]
struct MergeParams {
    original: String,
    proposed: String,
    #[serde(default)]
    selected: Vec<usize>,
}

#[derive(Serialize)]
struct DiffResult {
    hunks: Vec<Hunk>,
}

#[derive(Serialize)]
struct MergeResult {
    merged: String,
}

#[derive(Deserialize)]
struct BrokerProposeParams {
    root: String,
    owner: String,
    effect_id: String,
    relative_path: String,
    content: String,
}

#[derive(Deserialize)]
struct BrokerScopeParams {
    root: String,
    owner: String,
}

/// Scope plus the effect being decided on. `effect_id` is required: approving
/// without naming the effect is what let a decision on one proposal authorize
/// another.
#[derive(Deserialize)]
struct BrokerApproveParams {
    root: String,
    owner: String,
    effect_id: String,
}

#[derive(Deserialize)]
struct BrokerRollbackParams {
    root: String,
    owner: String,
    effect_id: String,
}

/// Process-wide registry of live brokers, keyed by (owner, workspace-root). The
/// broker owns the SqliteApprovalGate + snapshot store, so the SAME instance must
/// serve every request in one propose → approve → propose → rollback lifecycle.
type BrokerRegistry = Mutex<HashMap<String, Arc<WorkspaceEffectBroker>>>;

fn registry() -> &'static BrokerRegistry {
    static REGISTRY: OnceLock<BrokerRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve (or lazily open) the broker for one (owner, root). The approval DB
/// lives under `<root>/.instrument/effects.sqlite3` so the gate persists per
/// project without polluting the visible tree.
async fn broker_for(root: &str, owner: &str) -> Result<Arc<WorkspaceEffectBroker>, String> {
    let key = format!("{owner}\u{0}{root}");
    let mut map = registry().lock().await;
    if let Some(existing) = map.get(&key) {
        return Ok(existing.clone());
    }
    let root_path = PathBuf::from(root);
    let db_dir = root_path.join(".instrument");
    std::fs::create_dir_all(&db_dir).map_err(|e| e.to_string())?;
    let db = db_dir.join("effects.sqlite3");
    let broker = WorkspaceEffectBroker::open(&db, owner, &root_path)
        .await
        .map_err(|e| e.to_string())?;
    let arc = Arc::new(broker);
    map.insert(key, arc.clone());
    Ok(arc)
}

/// Dispatches one request to the real engine, returning a JSON result or an
/// error string. Never panics: every fallible step maps into `Err`.
/// Process-wide registry of live agent facades, keyed by adapter id.
///
/// A facade owns its ACPX sessions, so it has to outlive a single request the same
/// way the brokers do: `agent_start_session` returns an id that later
/// `agent_submit_task` / `agent_next_event` / `agent_cancel` calls resolve against
/// the SAME facade instance.
fn agent_facades() -> &'static Mutex<HashMap<String, Arc<AgentFacade>>> {
    static FACADES: OnceLock<Mutex<HashMap<String, Arc<AgentFacade>>>> = OnceLock::new();
    FACADES.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn facade_for(agent: &str) -> Result<Arc<AgentFacade>, String> {
    let mut facades = agent_facades().lock().await;
    if let Some(existing) = facades.get(agent) {
        return Ok(existing.clone());
    }
    let facade = Arc::new(AgentFacade::new(agent.to_string()).map_err(|e| e.to_string())?);
    facades.insert(agent.to_string(), facade.clone());
    Ok(facade)
}

/// Parameters shared by every session call: which adapter, which session.
#[derive(Deserialize)]
struct AgentSessionParams {
    agent: String,
    session_id: String,
}

/// Opening a session. Everything the IDE does not send has a conservative
/// default: read-only, isolated sandbox, no extra allowed actions.
#[derive(Deserialize)]
struct AgentStartParams {
    agent: String,
    owner: String,
    workspace_root: String,
    #[serde(default)]
    home_dir: Option<String>,
    /// Defaults to TRUE: a session the IDE has not been told to trust with writes
    /// must not be able to write. The caller opts out explicitly.
    #[serde(default = "default_true")]
    read_only: bool,
    #[serde(default)]
    denied_paths: Vec<String>,
    #[serde(default)]
    sandbox: Option<String>,
    #[serde(default)]
    auth_profile_ref: Option<String>,
    #[serde(default)]
    allowed_actions: Vec<String>,
    #[serde(default = "default_task_timeout")]
    task_timeout_ms: u64,
    #[serde(default = "default_idle_timeout")]
    idle_timeout_ms: u64,
}

fn default_true() -> bool {
    true
}
fn default_task_timeout() -> u64 {
    600_000
}
fn default_idle_timeout() -> u64 {
    900_000
}

#[derive(Deserialize)]
struct AgentTaskParams {
    agent: String,
    session_id: String,
    prompt: String,
    /// "conversation" (default) or "code-change".
    #[serde(default)]
    expectation: Option<String>,
    #[serde(default)]
    model_hint: Option<String>,
}

#[derive(Deserialize)]
struct AgentCancelParams {
    agent: String,
    session_id: String,
    #[serde(default = "default_true")]
    graceful: bool,
}

/// Answer to a parked `PermissionRequested` event.
///
/// `allow` has no default on purpose: a malformed call must fail to deserialize
/// rather than fall through to some assumed answer. `deny_ends_turn` defaults to
/// the product default — a refusal also ends the turn.
#[derive(Deserialize)]
struct AgentPermissionParams {
    agent: String,
    session_id: String,
    request_id: u64,
    allow: bool,
    #[serde(default = "default_true")]
    deny_ends_turn: bool,
}

async fn handle(method: &str, params: Value) -> Result<Value, String> {
    match method {
        "ping" => Ok(json!({ "pong": true, "engine": "ide-diff+ide-domain" })),
        "diff" => {
            let p: DiffParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let hunks = diff(&p.original, &p.proposed);
            serde_json::to_value(DiffResult { hunks }).map_err(|e| e.to_string())
        }
        "merge_selected" => {
            let p: MergeParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let merged = merge_selected(&p.original, &p.proposed, &p.selected);
            serde_json::to_value(MergeResult { merged }).map_err(|e| e.to_string())
        }
        "broker_propose" => {
            let p: BrokerProposeParams =
                serde_json::from_value(params).map_err(|e| e.to_string())?;
            let broker = broker_for(&p.root, &p.owner).await?;
            let write = WorkspaceWrite {
                effect_id: p.effect_id,
                relative_path: PathBuf::from(p.relative_path),
                content: p.content,
            };
            broker.propose_write(&write).await.map_err(|e| e.to_string())
        }
        "broker_approve" => {
            let p: BrokerApproveParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let broker = broker_for(&p.root, &p.owner).await?;
            let approved_id = broker
                .approve_effect(&p.effect_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "approved_id": approved_id }))
        }
        "broker_rollback" => {
            let p: BrokerRollbackParams =
                serde_json::from_value(params).map_err(|e| e.to_string())?;
            let broker = broker_for(&p.root, &p.owner).await?;
            broker
                .rollback(&p.effect_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "rolledback": true }))
        }
        // §4 — deterministic Layer-0 checks. `run_tools` defaults to FALSE: a
        // refresh must never execute a command a repository file declared.
        // Running them is an explicit act, per call.
        "harness_run" => {
            #[derive(Deserialize)]
            struct HarnessRunParams {
                root: String,
                owner: String,
                #[serde(default)]
                run_tools: bool,
            }
            let p: HarnessRunParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let broker = broker_for(&p.root, &p.owner).await?;
            let pending = broker.pending_count().await.map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            // Walking the tree and running builds is blocking work; keep it off
            // the async worker so the sidecar stays responsive.
            let run = tokio::task::spawn_blocking(move || harness::run(&root, pending, p.run_tools))
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(run).map_err(|e| e.to_string())
        }
        // §4 — preview. Spawning a process, sleeping between probes and opening
        // sockets is blocking work; it runs off the async worker like the checks.
        // `preview_status` never starts anything: not started is its own state.
        "preview_start" | "preview_status" | "preview_stop" => {
            #[derive(Deserialize)]
            struct RootParams {
                root: String,
            }
            let p: RootParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let method = method.to_string();
            let snapshot = tokio::task::spawn_blocking(move || match method.as_str() {
                "preview_start" => preview::start(&root),
                "preview_stop" => preview::stop(&root),
                _ => preview::status(&root),
            })
            .await
            .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        // §6 — the context an agent would receive. Reads only declared material
        // (.product/guidance, .product/sot) plus evidence the §4 engines
        // recorded; everything else is reported as excluded or unknown.
        "context_compile" => {
            #[derive(Deserialize)]
            struct ContextParams {
                root: String,
                #[serde(default)]
                budget_chars: Option<usize>,
            }
            let p: ContextParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let package = tokio::task::spawn_blocking(move || {
                // Evidence comes from the preview ledger: it is the only thing in
                // this process that has actually observed behavior, and the
                // ledger is what mints evidence ids.
                let evidence = preview::observations(&root)
                    .into_iter()
                    .map(|observation| ide_context::EvidenceRef {
                        id: observation
                            .evidence_ids
                            .first()
                            .cloned()
                            .unwrap_or_else(|| observation.id.clone()),
                        summary: format!(
                            "{} observado como {}",
                            observation.subject, observation.actual
                        ),
                        source: observation.subject.clone(),
                    })
                    .collect();
                context::compile_package(&root, p.budget_chars, evidence)
            })
            .await
            .map_err(|e| e.to_string())??;
            serde_json::to_value(package).map_err(|e| e.to_string())
        }
        // §7 — notes by theme, and the comparison between them. Nothing here
        // promotes, merges or discards on its own: each is an explicit call.
        "notes_snapshot" => {
            #[derive(Deserialize)]
            struct RootParams {
                root: String,
            }
            let p: RootParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot = tokio::task::spawn_blocking(move || notes::snapshot(&root))
                .await
                .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "notes_create" => {
            #[derive(Deserialize)]
            struct CreateParams {
                root: String,
                #[serde(flatten)]
                note: notes::NoteRequest,
            }
            let p: CreateParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot = tokio::task::spawn_blocking(move || notes::create(&root, p.note))
                .await
                .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "notes_resolve" => {
            #[derive(Deserialize)]
            struct ResolveParams {
                root: String,
                id: String,
                #[serde(default)]
                reason: String,
            }
            let p: ResolveParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot =
                tokio::task::spawn_blocking(move || notes::resolve(&root, &p.id, &p.reason))
                    .await
                    .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "notes_supersede" => {
            #[derive(Deserialize)]
            struct SupersedeParams {
                root: String,
                id: String,
                by: String,
                #[serde(default)]
                reason: String,
            }
            let p: SupersedeParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot = tokio::task::spawn_blocking(move || {
                notes::supersede(&root, &p.id, &p.by, &p.reason)
            })
            .await
            .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "notes_link" => {
            #[derive(Deserialize)]
            struct LinkParams {
                root: String,
                id: String,
                link: ide_notes::NoteLink,
            }
            let p: LinkParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot = tokio::task::spawn_blocking(move || notes::link(&root, &p.id, p.link))
                .await
                .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "notes_merge" => {
            #[derive(Deserialize)]
            struct MergeParams {
                root: String,
                ids: Vec<String>,
                theme: String,
                subject: String,
                text: String,
                #[serde(default)]
                reason: String,
            }
            let p: MergeParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot = tokio::task::spawn_blocking(move || {
                notes::merge(&root, &p.ids, &p.theme, &p.subject, &p.text, &p.reason)
            })
            .await
            .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        // §8 — guided intent. Layer-1 findings are hypotheses: they do not block
        // and they never reach the agent context. Nothing here writes the intent.
        "intent_review" => {
            #[derive(Deserialize)]
            struct ReviewParams {
                root: String,
                #[serde(default)]
                intent: String,
                #[serde(default)]
                max_findings: Option<usize>,
            }
            let p: ReviewParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot = tokio::task::spawn_blocking(move || {
                intent::review_snapshot(&root, &p.intent, p.max_findings)
            })
            .await
            .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "intent_decide" => {
            #[derive(Deserialize)]
            struct DecideParams {
                root: String,
                intent: String,
                finding_id: String,
                /// `accepted` or `dismissed`. There is no stored `open`.
                state: String,
                #[serde(default)]
                note: String,
                #[serde(default)]
                artifact: Option<String>,
            }
            let p: DecideParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot = tokio::task::spawn_blocking(move || {
                intent::review(
                    &root,
                    &p.intent,
                    &p.finding_id,
                    &p.state,
                    &p.note,
                    p.artifact.as_deref(),
                )
            })
            .await
            .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        // §13 — Guidance Library and Truth Registry. `ide_guidance` owns its own
        // files (`.guidance/`), so these arms are thin: resolve the root, carry
        // the clock, hand back what the panel renders.
        "library_snapshot" => {
            #[derive(Deserialize)]
            struct LibraryParams {
                root: String,
                #[serde(default)]
                context: ide_guidance::ActivityContext,
            }
            let p: LibraryParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot =
                tokio::task::spawn_blocking(move || library::snapshot(&root, p.context))
                    .await
                    .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "library_capture" => {
            #[derive(Deserialize)]
            struct CaptureParams {
                root: String,
                #[serde(flatten)]
                request: library::CaptureRequest,
            }
            let p: CaptureParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot =
                tokio::task::spawn_blocking(move || library::capture(&root, p.request))
                    .await
                    .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "library_import" => {
            #[derive(Deserialize)]
            struct ImportParams {
                root: String,
                name: String,
                text: String,
                #[serde(default)]
                owner: Option<String>,
                #[serde(default)]
                provenance: Option<String>,
            }
            let p: ImportParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let imported = tokio::task::spawn_blocking(move || {
                library::import(
                    &root,
                    &p.name,
                    &p.text,
                    p.owner.as_deref(),
                    p.provenance.as_deref(),
                )
            })
            .await
            .map_err(|e| e.to_string())??;
            serde_json::to_value(imported).map_err(|e| e.to_string())
        }
        "library_lifecycle" => {
            #[derive(Deserialize)]
            struct LifecycleParams {
                root: String,
                id: String,
                to: String,
                #[serde(default)]
                by: Option<String>,
            }
            let p: LifecycleParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot = tokio::task::spawn_blocking(move || {
                library::lifecycle(&root, &p.id, &p.to, p.by.as_deref())
            })
            .await
            .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "library_truth_declare" => {
            #[derive(Deserialize)]
            struct DeclareParams {
                root: String,
                subject: String,
                authority_path: String,
                #[serde(default = "default_precedence")]
                precedence: i64,
                #[serde(default)]
                provenance: Option<String>,
            }
            fn default_precedence() -> i64 {
                100
            }
            let p: DeclareParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot = tokio::task::spawn_blocking(move || {
                library::declare_truth(
                    &root,
                    &p.subject,
                    &p.authority_path,
                    p.precedence,
                    p.provenance.as_deref().unwrap_or("declarado no IDE"),
                    None,
                )
            })
            .await
            .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "library_truth_consumer" => {
            #[derive(Deserialize)]
            struct ConsumerParams {
                root: String,
                id: String,
                consumer: String,
            }
            let p: ConsumerParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot = tokio::task::spawn_blocking(move || {
                library::add_consumer(&root, &p.id, &p.consumer)
            })
            .await
            .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "library_truth_sync" => {
            #[derive(Deserialize)]
            struct SyncParams {
                root: String,
                id: String,
                #[serde(default)]
                up_to_date: Vec<String>,
            }
            let p: SyncParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let proposal = tokio::task::spawn_blocking(move || {
                library::propose_sync(&root, &p.id, &p.up_to_date)
            })
            .await
            .map_err(|e| e.to_string())??;
            serde_json::to_value(proposal).map_err(|e| e.to_string())
        }
        // §13 — configuration. The panel and `.instrument/config.json` are the
        // same schema; an unknown value fails instead of being stored as
        // something the caller did not ask for.
        "settings_snapshot" | "settings_reset" | "settings_profile" => {
            #[derive(Deserialize)]
            struct SettingsParams {
                root: String,
                #[serde(default)]
                field: Option<String>,
                #[serde(default)]
                profile: Option<String>,
            }
            let p: SettingsParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let method = method.to_string();
            let snapshot = tokio::task::spawn_blocking(move || match method.as_str() {
                "settings_reset" => match p.field.as_deref() {
                    Some(field) => settings::reset(&root, field),
                    None => Err("reset precisa dizer qual campo".to_string()),
                },
                "settings_profile" => match p.profile.as_deref() {
                    Some(name) => settings::profile(&root, name),
                    None => Err("perfil precisa de nome".to_string()),
                },
                _ => settings::snapshot(&root),
            })
            .await
            .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        // §14 — the mode/permission policy, asked BEFORE a governed effect is
        // decided. It answers; it never executes and never skips the broker.
        "policy_decide" => {
            #[derive(Deserialize)]
            struct PolicyParams {
                root: String,
                #[serde(default = "default_effect_class")]
                class: String,
                #[serde(default)]
                project: Option<String>,
                #[serde(default)]
                resource: Option<String>,
                #[serde(default)]
                tool: Option<String>,
            }
            // Durable is the safe default: an unstated class must not be the one
            // that skips the question.
            fn default_effect_class() -> String {
                "durable".to_string()
            }
            let p: PolicyParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let decision = tokio::task::spawn_blocking(move || {
                policy::decide(
                    &root,
                    &p.class,
                    p.project.as_deref(),
                    p.resource.as_deref(),
                    p.tool.as_deref(),
                )
            })
            .await
            .map_err(|e| e.to_string())??;
            serde_json::to_value(decision).map_err(|e| e.to_string())
        }
        "settings_patch" => {
            #[derive(Deserialize)]
            struct PatchParams {
                root: String,
                #[serde(flatten)]
                patch: settings::PatchRequest,
            }
            let p: PatchParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot = tokio::task::spawn_blocking(move || settings::patch(&root, p.patch))
                .await
                .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "settings_detected" => {
            #[derive(Deserialize)]
            struct DetectedParams {
                root: String,
                #[serde(default)]
                git: bool,
                #[serde(default)]
                agent: bool,
                #[serde(default)]
                aag: bool,
            }
            let p: DetectedParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot = tokio::task::spawn_blocking(move || {
                settings::detected(&root, p.git, p.agent, p.aag)
            })
            .await
            .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        // §13 — the durable project. Opening a folder is not registering a
        // project: registering needs a title and a written intent, which are what
        // survive with no transcript.
        "project_snapshot" => {
            #[derive(Deserialize)]
            struct RootParams {
                root: String,
            }
            let p: RootParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot = tokio::task::spawn_blocking(move || project::snapshot(&root))
                .await
                .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "project_register" => {
            #[derive(Deserialize)]
            struct RegisterParams {
                root: String,
                title: String,
                intent: String,
            }
            let p: RegisterParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot =
                tokio::task::spawn_blocking(move || project::register(&root, &p.title, &p.intent))
                    .await
                    .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "project_attach" => {
            #[derive(Deserialize)]
            struct AttachParams {
                root: String,
                path: String,
                #[serde(default = "default_kind")]
                kind: String,
            }
            fn default_kind() -> String {
                "directory".to_string()
            }
            let p: AttachParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot =
                tokio::task::spawn_blocking(move || project::attach(&root, &p.path, &p.kind))
                    .await
                    .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "project_intent" => {
            #[derive(Deserialize)]
            struct IntentParams {
                root: String,
                intent: String,
            }
            let p: IntentParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot =
                tokio::task::spawn_blocking(move || project::set_intent(&root, &p.intent))
                    .await
                    .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        // §4 — reconciliation of declared vs observed behavior.
        "reconcile_scan" => {
            #[derive(Deserialize)]
            struct RootParams {
                root: String,
            }
            let p: RootParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot = tokio::task::spawn_blocking(move || reconcile::scan(&root))
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "reconcile_decide" => {
            #[derive(Deserialize)]
            struct DecideParams {
                root: String,
                divergence_id: String,
                /// The engine's own `ReconciliationChoice`, deserialized by the
                /// engine. A malformed decision fails to parse instead of falling
                /// through to some assumed choice.
                choice: ide_reconciliation::ReconciliationChoice,
            }
            let p: DecideParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot = tokio::task::spawn_blocking(move || {
                reconcile::reconcile(&root, &p.divergence_id, p.choice)
            })
            .await
            .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        // §4 — local packs. `passed` / `failed` are the check ids the caller
        // actually observed; an empty pair blocks readiness rather than emptying
        // it, which is the honest state today (packs are Layer 1+, §4 is Layer 0).
        "packs_snapshot" => {
            #[derive(Deserialize)]
            struct PacksParams {
                root: String,
                #[serde(default)]
                passed: Vec<String>,
                #[serde(default)]
                failed: Vec<String>,
            }
            let p: PacksParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot =
                tokio::task::spawn_blocking(move || packs::snapshot(&root, &p.passed, &p.failed))
                    .await
                    .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "packs_install" => {
            #[derive(Deserialize)]
            struct InstallParams {
                root: String,
                path: String,
            }
            let p: InstallParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let snapshot = tokio::task::spawn_blocking(move || packs::install(&root, &p.path))
                .await
                .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "packs_apply" | "packs_revert" => {
            #[derive(Deserialize)]
            struct PackIdParams {
                root: String,
                pack_id: String,
            }
            let p: PackIdParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let root = PathBuf::from(&p.root);
            let revert = method == "packs_revert";
            let snapshot = tokio::task::spawn_blocking(move || {
                if revert {
                    packs::revert(&root, &p.pack_id)
                } else {
                    packs::apply(&root, &p.pack_id)
                }
            })
            .await
            .map_err(|e| e.to_string())??;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "broker_activity" => {
            let p: BrokerScopeParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let broker = broker_for(&p.root, &p.owner).await?;
            let activity = broker.activity().await;
            Ok(json!({ "activity": activity }))
        }
        "agent_start_session" => {
            let p: AgentStartParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let facade = facade_for(&p.agent).await?;
            let sandbox = match p.sandbox.as_deref() {
                Some("workspace-net") => AgentSandbox::WorkspaceNet,
                Some("trusted") => AgentSandbox::Trusted,
                _ => AgentSandbox::Isolated,
            };
            let home_dir = p
                .home_dir
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
                .ok_or_else(|| "home_dir is required (no HOME in env)".to_string())?;
            let request = StartAgentSession {
                owner: p.owner,
                workspace_root: PathBuf::from(p.workspace_root),
                home_dir,
                read_only: p.read_only,
                denied_paths: p.denied_paths.into_iter().map(PathBuf::from).collect(),
                sandbox,
                auth_profile_ref: p.auth_profile_ref.unwrap_or_default(),
                runtime_id: p.agent.clone(),
                allowed_actions: p.allowed_actions,
                task_timeout_ms: p.task_timeout_ms,
                idle_timeout_ms: p.idle_timeout_ms,
            };
            let id = facade
                .start_session(request)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "session_id": id.0 }))
        }
        "agent_submit_task" => {
            let p: AgentTaskParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let facade = facade_for(&p.agent).await?;
            let expectation = match p.expectation.as_deref() {
                Some("code-change") => AgentExpectation::CodeChange,
                _ => AgentExpectation::Conversation,
            };
            let task = AgentTask {
                prompt: p.prompt,
                expectation,
                model_hint: p.model_hint,
            };
            let task_id = facade
                .submit_task(&AgentSessionId(p.session_id), task)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "task_id": task_id }))
        }
        "agent_next_event" => {
            let p: AgentSessionParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let facade = facade_for(&p.agent).await?;
            let event = facade
                .next_event(&AgentSessionId(p.session_id))
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "event": event }))
        }
        "agent_cancel" => {
            let p: AgentCancelParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let facade = facade_for(&p.agent).await?;
            facade
                .cancel(&AgentSessionId(p.session_id), p.graceful)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "cancelled": true }))
        }
        "agent_respond_permission" => {
            let p: AgentPermissionParams =
                serde_json::from_value(params).map_err(|e| e.to_string())?;
            let facade = facade_for(&p.agent).await?;
            facade
                .respond_permission(
                    &AgentSessionId(p.session_id),
                    p.request_id,
                    p.allow,
                    p.deny_ends_turn,
                )
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "answered": true }))
        }
        "agent_session_status" => {
            let p: AgentSessionParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let facade = facade_for(&p.agent).await?;
            let status = facade
                .session_status(&AgentSessionId(p.session_id))
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "status": status }))
        }
        "agent_probe" => {
            #[derive(Deserialize)]
            struct AgentProbeParams {
                agent: String,
            }
            let p: AgentProbeParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            // Build the REAL ide-agent facade and run its non-authenticated health
            // probe. A missing `acpx`/agent binary surfaces as an honest
            // `unavailable` with a reason — never a fabricated "ready".
            match AgentFacade::new(p.agent.clone()) {
                Ok(facade) => {
                    let d = facade.descriptor();
                    let h = facade.health().await;
                    let availability = match h.availability {
                        AgentAvailability::Ready => "ready",
                        AgentAvailability::Degraded => "degraded",
                        AgentAvailability::Unavailable => "unavailable",
                    };
                    Ok(json!({
                        "agent": p.agent,
                        "available": h.availability != AgentAvailability::Unavailable,
                        "availability": availability,
                        "detail": h.detail,
                        "detectedVersion": h.detected_version,
                        "transport": d.transport,
                        "adapterVersion": d.adapter_version,
                        "targetVersion": d.target_version,
                        "supportsResume": d.supports_resume,
                        "supportsSteer": d.supports_steer,
                        "degradations": h.degradations,
                    }))
                }
                Err(error) => Ok(json!({
                    "agent": p.agent,
                    "available": false,
                    "availability": "unavailable",
                    "detail": error.to_string(),
                    "degradations": [],
                })),
            }
        }
        other => Err(format!("unknown method: {other}")),
    }
}

fn main() -> io::Result<()> {
    // A small multi-thread runtime: the broker's SqliteApprovalGate/SessionManager
    // may hop onto blocking threads, so `current_thread` is not enough. Requests
    // are handled one at a time (block_on per line); responses still carry their
    // echoed id, so the Node side stays correct regardless.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(req) => match rt.block_on(handle(&req.method, req.params)) {
                Ok(result) => Response {
                    id: req.id,
                    result: Some(result),
                    error: None,
                },
                Err(err) => Response {
                    id: req.id,
                    result: None,
                    error: Some(err),
                },
            },
            Err(err) => Response {
                id: Value::Null,
                result: None,
                error: Some(format!("invalid request: {err}")),
            },
        };
        let encoded = serde_json::to_string(&response).unwrap_or_else(|_| {
            String::from("{\"id\":null,\"error\":\"failed to encode response\"}")
        });
        out.write_all(encoded.as_bytes())?;
        out.write_all(b"\n")?;
        out.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ping_reports_engine() {
        let v = handle("ping", Value::Null).await.expect("ping ok");
        assert_eq!(v["pong"], json!(true));
        assert_eq!(v["engine"], json!("ide-diff+ide-domain"));
    }

    #[tokio::test]
    async fn diff_returns_hunks() {
        let params = json!({ "original": "a\nb\nc\n", "proposed": "a\nB\nc\n" });
        let v = handle("diff", params).await.expect("diff ok");
        assert_eq!(v["hunks"].as_array().map(|a| a.len()), Some(1));
    }

    #[tokio::test]
    async fn merge_selected_accepts_nothing() {
        let params = json!({
            "original": "a\nb\nc\n",
            "proposed": "a\nB\nc\n",
            "selected": []
        });
        let v = handle("merge_selected", params).await.expect("merge ok");
        assert_eq!(v["merged"], json!("a\nb\nc\n"));
    }

    #[tokio::test]
    async fn unknown_method_errors() {
        assert!(handle("nope", Value::Null).await.is_err());
    }

    /// The agent probe never panics and always yields a well-formed card: a string
    /// `availability` and a boolean `available`. In CI (no acpx/agent binary) it
    /// reports the honest `unavailable` rather than a fabricated ready state.
    #[tokio::test]
    async fn agent_probe_reports_honest_availability() {
        let v = handle("agent_probe", json!({ "agent": "codex" }))
            .await
            .expect("probe ok");
        assert!(v["availability"].is_string(), "availability must be a string");
        assert!(v["available"].is_boolean(), "available must be a boolean");
        assert_eq!(v["agent"], json!("codex"));
    }

    /// A session call for an id nobody opened must fail honestly, not panic and
    /// not invent a session. Runs in CI without any agent binary present.
    #[tokio::test]
    async fn session_calls_reject_unknown_sessions() {
        for method in [
            "agent_next_event",
            "agent_session_status",
        ] {
            let out = handle(method, json!({ "agent": "codex", "session_id": "nao-existe" })).await;
            assert!(out.is_err(), "{method} must not invent a session");
        }
        // Same rule for the permission answer, which carries extra fields: an
        // approval aimed at a session nobody opened must never report success.
        let out = handle(
            "agent_respond_permission",
            json!({
                "agent": "codex",
                "session_id": "nao-existe",
                "request_id": 1,
                "allow": true
            }),
        )
        .await;
        assert!(
            out.is_err(),
            "agent_respond_permission must not invent a session"
        );
        {
        }
    }

    /// Opening a session defaults to READ-ONLY: the caller has to opt in to writes.
    /// Without an agent binary the call fails with the runtime's reason — which is
    /// the honest answer — but it must never succeed silently.
    #[tokio::test]
    async fn start_session_is_read_only_by_default_and_fails_honestly() {
        let temp = tempfile::tempdir().expect("tempdir");
        let params = json!({
            "agent": "codex",
            "owner": "owner:test",
            "workspace_root": temp.path().to_str().unwrap(),
            "home_dir": temp.path().to_str().unwrap()
        });
        // `read_only` is absent on purpose: the default must be the safe one.
        let parsed: AgentStartParams =
            serde_json::from_value(params.clone()).expect("params parse");
        assert!(parsed.read_only, "sessão sem read_only explícito tem de ser somente leitura");

        match handle("agent_start_session", params).await {
            Ok(v) => assert!(
                v["session_id"].is_string(),
                "uma sessão aberta precisa devolver um id"
            ),
            Err(detail) => assert!(
                !detail.is_empty(),
                "a falha precisa dizer por quê (adapter ausente, auth, etc.)"
            ),
        }
    }

    /// End-to-end proof over the sidecar protocol that the REAL broker governs:
    /// first propose queues (nothing written), approve grants the gate, the second
    /// propose executes the write, and rollback restores the prior bytes.
    #[tokio::test]
    async fn broker_governs_write_lifecycle_over_the_protocol() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().to_str().unwrap().to_owned();
        let file = temp.path().join("note.txt");
        std::fs::write(&file, "before\n").expect("seed");
        let owner = "owner:test";

        let propose = || {
            json!({
                "root": root, "owner": owner, "effect_id": "e1",
                "relative_path": "note.txt", "content": "after\n"
            })
        };

        // 1) First propose only QUEUES — file is untouched.
        let queued = handle("broker_propose", propose()).await.expect("queue");
        assert_eq!(queued["awaiting_approval"], json!(true));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "before\n");

        // 2) Approve grants the SqliteApprovalGate.
        handle(
            "broker_approve",
            json!({ "root": root, "owner": owner, "effect_id": "e1" }),
        )
        .await
        .expect("approve");

        // 3) Second propose now EXECUTES the write.
        let written = handle("broker_propose", propose()).await.expect("write");
        assert_eq!(written["written"], json!(true));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "after\n");

        // 4) Rollback restores the snapshot.
        handle(
            "broker_rollback",
            json!({ "root": root, "owner": owner, "effect_id": "e1" }),
        )
        .await
        .expect("rollback");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "before\n");
    }
}
