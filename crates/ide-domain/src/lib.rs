//! Shell-neutral contracts and the smallest real Bastion embedding used by the IDE.
//!
//! This crate owns no Tauri commands and no UI state. It gives every future host the
//! same project vocabulary and proves that a governed effect crosses Bastion's memory,
//! capability, approval and observation boundaries.

use anyhow::Context;
use async_trait::async_trait;
use bastion_memory::sqlite::SqliteMemory;
use bastion_memory::{Memory, PrivacyTier, SharedMemory};
use bastion_runtime::agent::ports::ApprovalGate;
use bastion_runtime::capability::{Capability, CapabilityRegistry, InvokeCtx, SqliteApprovalGate};
use bastion_runtime::session::SessionManager;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

mod semantic;

pub use semantic::{
    ChangeCause, CreateProject, ProjectRecord, Resource, ResourceKind, ResourceRevision,
    SemanticProjectStore, SessionScope,
};

/// Stable identity belongs to a semantic project, never to a chat transcript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectContract {
    pub id: ProjectId,
    pub title: String,
    pub intent: String,
    pub resources: Vec<ResourceId>,
}

/// A proposed privileged action. Later phases add resource scoping and snapshots.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProposedEffect {
    pub id: String,
    pub project_id: ProjectId,
    pub capability: String,
    pub args: Value,
    pub requires_approval: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Evidence {
    pub effect_id: String,
    pub kind: String,
    pub payload: Value,
    pub verified: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Activity {
    EffectProposed { effect_id: String },
    AwaitingApproval { effect_id: String },
    EffectObserved { evidence: Evidence },
}

/// Offline, deterministic demonstration of the Bastion substrate.
///
/// It is deliberately small: this is not the IDE's final effect broker. It establishes
/// the rule that a host owns domain state and observations while Bastion owns the
/// governed capability/approval/memory mechanisms beneath it.
pub struct FoundationSlice {
    owner: String,
    memory: SharedMemory,
    approvals: Arc<SqliteApprovalGate>,
    capabilities: CapabilityRegistry,
    activity: Arc<Mutex<Vec<Activity>>>,
}

impl FoundationSlice {
    pub async fn open(db_path: impl AsRef<Path>, owner: impl Into<String>) -> anyhow::Result<Self> {
        let db_path = db_path
            .as_ref()
            .to_str()
            .context("foundation database path must be valid UTF-8")?
            .to_owned();
        SessionManager::new(db_path.clone()).init_schema().await?;

        let owner = owner.into();
        let memory: SharedMemory = Arc::new(RwLock::new(
            Box::new(SqliteMemory::new(&db_path)) as Box<dyn Memory>
        ));
        let approvals = Arc::new(SqliteApprovalGate::new(db_path));
        let activity = Arc::new(Mutex::new(Vec::new()));
        let capability = Arc::new(RecordEffectCapability::new(activity.clone()));
        let mut capabilities = CapabilityRegistry::new().with_approval_gate(approvals.clone());
        capabilities.register(capability)?;

        Ok(Self {
            owner,
            memory,
            approvals,
            capabilities,
            activity,
        })
    }

    /// Stores a low-risk, owner-scoped factual memory. Guidance and SoTs remain IDE domains.
    pub async fn remember_intent(&self, project: &ProjectContract) -> anyhow::Result<i64> {
        self.memory
            .read()
            .await
            .store_belief(
                &self.owner,
                None,
                &format!("Project {} intent: {}", project.id.0, project.intent),
                "foundation-slice",
                "ide-domain::remember_intent",
                false,
                Some(PrivacyTier::LocalOnly),
            )
            .await
    }

    /// First call queues; a subsequent call after explicit approval dispatches exactly once.
    pub async fn propose_effect(&self, effect: &ProposedEffect) -> anyhow::Result<Value> {
        self.activity.lock().await.push(Activity::EffectProposed {
            effect_id: effect.id.clone(),
        });

        let result = self
            .capabilities
            .invoke(
                &effect.capability,
                effect.args.clone(),
                &InvokeCtx {
                    owner: self.owner.clone(),
                    privacy_tier: Some(PrivacyTier::LocalOnly),
                    allowed_tools: None,
                },
            )
            .await?;

        if result.data["awaiting_approval"] == json!(true) {
            self.activity.lock().await.push(Activity::AwaitingApproval {
                effect_id: effect.id.clone(),
            });
        }

        Ok(result.data)
    }

    pub async fn approve_next_effect(&self) -> anyhow::Result<i64> {
        let pending = self.approvals.pending_for_owner(&self.owner).await?;
        let row = pending
            .into_iter()
            .next()
            .context("no effect is awaiting approval")?;
        self.approvals.approve(&self.owner, row.id).await?;
        Ok(row.id)
    }

    pub async fn activity(&self) -> Vec<Activity> {
        self.activity.lock().await.clone()
    }

    pub async fn remembered_facts(&self) -> anyhow::Result<usize> {
        Ok(self
            .memory
            .read()
            .await
            .retrieve_tagged(&self.owner, None)
            .await?
            .len())
    }
}

struct RecordEffectCapability {
    activity: Arc<Mutex<Vec<Activity>>>,
    schema: Value,
}

impl RecordEffectCapability {
    fn new(activity: Arc<Mutex<Vec<Activity>>>) -> Self {
        Self {
            activity,
            schema: json!({
                "type": "object",
                "required": ["effect_id", "summary"],
                "properties": {
                    "effect_id": { "type": "string" },
                    "summary": { "type": "string" }
                },
                "additionalProperties": false
            }),
        }
    }
}

#[async_trait]
impl Capability for RecordEffectCapability {
    fn name(&self) -> &str {
        "ide:record_effect"
    }

    fn description(&self) -> &str {
        "Records a local, approval-gated IDE effect for the foundation slice."
    }

    fn input_schema(&self) -> &Value {
        &self.schema
    }

    async fn invoke(&self, args: Value, _ctx: &InvokeCtx) -> anyhow::Result<Value> {
        let effect_id = args["effect_id"]
            .as_str()
            .context("effect_id is required")?
            .to_owned();
        let evidence = Evidence {
            effect_id,
            kind: "foundation-effect".to_string(),
            payload: args.clone(),
            verified: false,
        };
        self.activity
            .lock()
            .await
            .push(Activity::EffectObserved { evidence });
        Ok(json!({"recorded": true, "effect": args}))
    }

    fn is_local(&self) -> bool {
        true
    }

    fn needs_approval(&self) -> bool {
        true
    }
}
