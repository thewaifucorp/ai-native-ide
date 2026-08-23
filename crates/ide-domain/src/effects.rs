//! Project-scoped workspace effects governed by Bastion capabilities.

use anyhow::{bail, Context};
use async_trait::async_trait;
use bastion_memory::PrivacyTier;
use bastion_runtime::agent::ports::ApprovalGate;
use bastion_runtime::capability::{Capability, CapabilityRegistry, InvokeCtx, SqliteApprovalGate};
use bastion_runtime::session::SessionManager;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceWrite {
    pub effect_id: String,
    pub relative_path: PathBuf,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BrokerActivity {
    Proposed { effect_id: String, path: PathBuf },
    AwaitingApproval { effect_id: String },
    SnapshotCreated { effect_id: String, path: PathBuf },
    Executed { effect_id: String, path: PathBuf },
    RolledBack { effect_id: String, path: PathBuf },
}

#[derive(Clone)]
struct Snapshot {
    path: PathBuf,
    bytes: Vec<u8>,
}

/// The only write route exposed by this crate. The renderer and agent layer
/// must propose a typed `WorkspaceWrite`; Core decides whether its exact
/// payload is pending/approved, and the capability records its own snapshot.
pub struct WorkspaceEffectBroker {
    owner: String,
    approvals: Arc<SqliteApprovalGate>,
    capabilities: CapabilityRegistry,
    activity: Arc<Mutex<Vec<BrokerActivity>>>,
    snapshots: Arc<Mutex<BTreeMap<String, Snapshot>>>,
}

impl WorkspaceEffectBroker {
    pub async fn open(
        approval_db: impl AsRef<Path>,
        owner: impl Into<String>,
        workspace_root: impl AsRef<Path>,
    ) -> anyhow::Result<Self> {
        let approval_db = approval_db
            .as_ref()
            .to_str()
            .context("approval database path must be UTF-8")?
            .to_owned();
        SessionManager::new(approval_db.clone())
            .init_schema()
            .await?;
        let root = workspace_root.as_ref().canonicalize().with_context(|| {
            format!(
                "workspace root missing: {}",
                workspace_root.as_ref().display()
            )
        })?;
        if !root.is_dir() {
            bail!("workspace root must be a directory")
        }
        let owner = owner.into();
        let activity = Arc::new(Mutex::new(Vec::new()));
        let snapshots = Arc::new(Mutex::new(BTreeMap::new()));
        let mut capabilities = CapabilityRegistry::new();
        let approvals = Arc::new(SqliteApprovalGate::new(approval_db));
        capabilities = capabilities.with_approval_gate(approvals.clone());
        capabilities.register(Arc::new(WorkspaceWriteCapability::new(
            root,
            activity.clone(),
            snapshots.clone(),
        )))?;
        Ok(Self {
            owner,
            approvals,
            capabilities,
            activity,
            snapshots,
        })
    }

    pub async fn propose_write(&self, write: &WorkspaceWrite) -> anyhow::Result<Value> {
        self.activity.lock().await.push(BrokerActivity::Proposed {
            effect_id: write.effect_id.clone(),
            path: write.relative_path.clone(),
        });
        let result = self
            .capabilities
            .invoke(
                "ide:workspace_write",
                serde_json::to_value(write)?,
                &InvokeCtx {
                    owner: self.owner.clone(),
                    privacy_tier: Some(PrivacyTier::LocalOnly),
                    allowed_tools: None,
                },
            )
            .await?;
        if result.data["awaiting_approval"] == json!(true) {
            self.activity
                .lock()
                .await
                .push(BrokerActivity::AwaitingApproval {
                    effect_id: write.effect_id.clone(),
                });
        }
        Ok(result.data)
    }

    pub async fn approve_next(&self) -> anyhow::Result<i64> {
        let pending = self.approvals.pending_for_owner(&self.owner).await?;
        let pending = pending
            .into_iter()
            .next()
            .context("no effect is awaiting approval")?;
        self.approvals.approve(&self.owner, pending.id).await?;
        Ok(pending.id)
    }

    pub async fn rollback(&self, effect_id: &str) -> anyhow::Result<()> {
        let snapshot = self
            .snapshots
            .lock()
            .await
            .remove(effect_id)
            .with_context(|| format!("no snapshot exists for {effect_id}"))?;
        fs::write(&snapshot.path, snapshot.bytes)
            .with_context(|| format!("restore snapshot {}", snapshot.path.display()))?;
        self.activity.lock().await.push(BrokerActivity::RolledBack {
            effect_id: effect_id.to_owned(),
            path: snapshot.path,
        });
        Ok(())
    }

    pub async fn activity(&self) -> Vec<BrokerActivity> {
        self.activity.lock().await.clone()
    }
}

struct WorkspaceWriteCapability {
    root: PathBuf,
    activity: Arc<Mutex<Vec<BrokerActivity>>>,
    snapshots: Arc<Mutex<BTreeMap<String, Snapshot>>>,
    schema: Value,
}

impl WorkspaceWriteCapability {
    fn new(
        root: PathBuf,
        activity: Arc<Mutex<Vec<BrokerActivity>>>,
        snapshots: Arc<Mutex<BTreeMap<String, Snapshot>>>,
    ) -> Self {
        Self {
            root,
            activity,
            snapshots,
            schema: json!({
                "type": "object",
                "required": ["effect_id", "relative_path", "content"],
                "properties": {
                    "effect_id": { "type": "string" },
                    "relative_path": { "type": "string" },
                    "content": { "type": "string" }
                },
                "additionalProperties": false
            }),
        }
    }

    fn resolve(&self, relative: &Path) -> anyhow::Result<PathBuf> {
        if relative.is_absolute()
            || relative.components().any(|part| {
                matches!(
                    part,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            bail!("workspace write path must be relative and traversal-free")
        }
        let candidate = self.root.join(relative);
        let parent = candidate
            .parent()
            .context("workspace write requires a file path")?
            .canonicalize()?;
        if !parent.starts_with(&self.root) {
            bail!("workspace write escapes project resource")
        }
        Ok(candidate)
    }
}

#[async_trait]
impl Capability for WorkspaceWriteCapability {
    fn name(&self) -> &str {
        "ide:workspace_write"
    }
    fn description(&self) -> &str {
        "Writes a scoped workspace file after explicit approval."
    }
    fn input_schema(&self) -> &Value {
        &self.schema
    }
    fn is_local(&self) -> bool {
        true
    }
    fn needs_approval(&self) -> bool {
        true
    }

    async fn invoke(&self, args: Value, _ctx: &InvokeCtx) -> anyhow::Result<Value> {
        let write: WorkspaceWrite = serde_json::from_value(args)?;
        if write.effect_id.trim().is_empty() {
            bail!("effect id is required")
        }
        let path = self.resolve(&write.relative_path)?;
        let bytes = fs::read(&path).with_context(|| format!("snapshot {}", path.display()))?;
        self.activity
            .lock()
            .await
            .push(BrokerActivity::SnapshotCreated {
                effect_id: write.effect_id.clone(),
                path: path.clone(),
            });
        fs::write(&path, write.content.as_bytes())
            .with_context(|| format!("write {}", path.display()))?;
        self.snapshots.lock().await.insert(
            write.effect_id.clone(),
            Snapshot {
                path: path.clone(),
                bytes,
            },
        );
        self.activity.lock().await.push(BrokerActivity::Executed {
            effect_id: write.effect_id,
            path: path.clone(),
        });
        Ok(json!({"written": true, "path": path}))
    }
}
