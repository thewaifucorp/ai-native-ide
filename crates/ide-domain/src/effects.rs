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

/// A proposed write of a binary asset (image, font, compiled resource, …).
///
/// It exists alongside [`WorkspaceWrite`] rather than replacing it: text writes
/// keep a UTF-8 `content`, while assets carry raw `bytes` that may not be valid
/// UTF-8. Both travel the same broker (propose → snapshot → approve → execute →
/// rollback) and share the same path-confinement and revision rules; only the
/// payload representation differs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceAssetWrite {
    pub effect_id: String,
    pub relative_path: PathBuf,
    /// Raw asset bytes. Serialized with plain serde (a JSON array of octets) so
    /// the crate needs no base64/serde_bytes dependency; rollback restores these
    /// exact bytes.
    pub bytes: Vec<u8>,
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
    /// `None` means this effect created the file. Reverting it must remove
    /// that file rather than inventing an empty predecessor.
    original_bytes: Option<Vec<u8>>,
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
            root.clone(),
            activity.clone(),
            snapshots.clone(),
        )))?;
        capabilities.register(Arc::new(WorkspaceAssetWriteCapability::new(
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

    /// Proposes a binary asset write. Mirrors [`Self::propose_write`] exactly —
    /// the same queue-then-approve gate, the same snapshot store, the same
    /// activity log — but routes to the asset capability so raw, non-UTF-8 bytes
    /// reach the confined path intact.
    pub async fn propose_asset_write(&self, write: &WorkspaceAssetWrite) -> anyhow::Result<Value> {
        self.activity.lock().await.push(BrokerActivity::Proposed {
            effect_id: write.effect_id.clone(),
            path: write.relative_path.clone(),
        });
        let result = self
            .capabilities
            .invoke(
                "ide:workspace_asset_write",
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

    /// Number of effects awaiting approval for this broker's owner. Used by the
    /// deterministic harness to report pending governed work honestly.
    pub async fn pending_count(&self) -> anyhow::Result<usize> {
        Ok(self.approvals.pending_for_owner(&self.owner).await?.len())
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
        match snapshot.original_bytes {
            Some(bytes) => fs::write(&snapshot.path, bytes)
                .with_context(|| format!("restore snapshot {}", snapshot.path.display()))?,
            None => fs::remove_file(&snapshot.path)
                .with_context(|| format!("remove created file {}", snapshot.path.display()))?,
        }
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
        resolve_workspace_path(&self.root, relative)
    }
}

/// Confines a proposed write to the workspace root, shared by the text and asset
/// capabilities so binary assets get exactly the same traversal and symlink
/// checks as code and Markdown.
fn resolve_workspace_path(root: &Path, relative: &Path) -> anyhow::Result<PathBuf> {
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
    let candidate = root.join(relative);
    let parent = candidate
        .parent()
        .context("workspace write requires a file path")?
        .canonicalize()?;
    if !parent.starts_with(root) {
        bail!("workspace write escapes project resource")
    }
    // An existing file may itself be a symlink. Writing through one would
    // cross the resource boundary even when its parent is trusted.
    if candidate.exists() {
        let canonical_file = candidate
            .canonicalize()
            .with_context(|| format!("resolve workspace file {}", candidate.display()))?;
        if !canonical_file.starts_with(root) {
            bail!("workspace write escapes project resource")
        }
    }
    Ok(candidate)
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
        let original_bytes = match fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error).with_context(|| format!("snapshot {}", path.display()))
            }
        };
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
                original_bytes,
            },
        );
        self.activity.lock().await.push(BrokerActivity::Executed {
            effect_id: write.effect_id,
            path: path.clone(),
        });
        Ok(json!({"written": true, "path": path}))
    }
}

/// Binary sibling of [`WorkspaceWriteCapability`]. It records the prior file
/// bytes into the shared snapshot store before overwriting, so the broker's
/// single `rollback` restores exact prior bytes — or removes a newly created
/// asset — with no separate rollback path.
struct WorkspaceAssetWriteCapability {
    root: PathBuf,
    activity: Arc<Mutex<Vec<BrokerActivity>>>,
    snapshots: Arc<Mutex<BTreeMap<String, Snapshot>>>,
    schema: Value,
}

impl WorkspaceAssetWriteCapability {
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
                "required": ["effect_id", "relative_path", "bytes"],
                "properties": {
                    "effect_id": { "type": "string" },
                    "relative_path": { "type": "string" },
                    "bytes": { "type": "array", "items": { "type": "integer" } }
                },
                "additionalProperties": false
            }),
        }
    }
}

#[async_trait]
impl Capability for WorkspaceAssetWriteCapability {
    fn name(&self) -> &str {
        "ide:workspace_asset_write"
    }
    fn description(&self) -> &str {
        "Writes a scoped workspace binary asset after explicit approval."
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
        let write: WorkspaceAssetWrite = serde_json::from_value(args)?;
        if write.effect_id.trim().is_empty() {
            bail!("effect id is required")
        }
        let path = resolve_workspace_path(&self.root, &write.relative_path)?;
        let original_bytes = match fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error).with_context(|| format!("snapshot {}", path.display()))
            }
        };
        self.activity
            .lock()
            .await
            .push(BrokerActivity::SnapshotCreated {
                effect_id: write.effect_id.clone(),
                path: path.clone(),
            });
        fs::write(&path, &write.bytes).with_context(|| format!("write {}", path.display()))?;
        self.snapshots.lock().await.insert(
            write.effect_id.clone(),
            Snapshot {
                path: path.clone(),
                original_bytes,
            },
        );
        self.activity.lock().await.push(BrokerActivity::Executed {
            effect_id: write.effect_id,
            path: path.clone(),
        });
        Ok(json!({"written": true, "path": path}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn broker(temp: &Path) -> WorkspaceEffectBroker {
        WorkspaceEffectBroker::open(temp.join("effects.sqlite3"), "owner:test", temp)
            .await
            .expect("broker")
    }

    #[tokio::test]
    async fn approved_asset_write_persists_exact_bytes() {
        let temp = tempfile::tempdir().expect("tempdir");
        let broker = broker(temp.path()).await;
        // Deliberately non-UTF-8 bytes that a text write could never carry.
        let bytes = vec![0x89u8, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe];
        let write = WorkspaceAssetWrite {
            effect_id: "effect:asset-1".into(),
            relative_path: "logo.png".into(),
            bytes: bytes.clone(),
        };
        assert_eq!(
            broker.propose_asset_write(&write).await.expect("queue")["awaiting_approval"],
            json!(true)
        );
        assert!(!temp.path().join("logo.png").exists(), "queuing writes nothing");
        broker.approve_next().await.expect("approve");
        assert_eq!(
            broker.propose_asset_write(&write).await.expect("write")["written"],
            json!(true)
        );
        assert_eq!(
            fs::read(temp.path().join("logo.png")).expect("read asset"),
            bytes
        );
    }

    #[tokio::test]
    async fn rollback_restores_prior_asset_bytes() {
        let temp = tempfile::tempdir().expect("tempdir");
        let file = temp.path().join("icon.bin");
        let original = vec![1u8, 2, 3, 4];
        fs::write(&file, &original).expect("seed");
        let broker = broker(temp.path()).await;
        let write = WorkspaceAssetWrite {
            effect_id: "effect:asset-2".into(),
            relative_path: "icon.bin".into(),
            bytes: vec![9u8, 8, 7],
        };
        broker.propose_asset_write(&write).await.expect("queue");
        broker.approve_next().await.expect("approve");
        broker.propose_asset_write(&write).await.expect("write");
        assert_eq!(fs::read(&file).expect("read new"), vec![9u8, 8, 7]);
        broker.rollback("effect:asset-2").await.expect("rollback");
        assert_eq!(fs::read(&file).expect("read restored"), original);
    }

    #[tokio::test]
    async fn rollback_removes_newly_created_asset() {
        let temp = tempfile::tempdir().expect("tempdir");
        let file = temp.path().join("new.ico");
        let broker = broker(temp.path()).await;
        let write = WorkspaceAssetWrite {
            effect_id: "effect:asset-3".into(),
            relative_path: "new.ico".into(),
            bytes: vec![0u8, 255, 128],
        };
        broker.propose_asset_write(&write).await.expect("queue");
        broker.approve_next().await.expect("approve");
        broker.propose_asset_write(&write).await.expect("write");
        assert!(file.exists());
        broker.rollback("effect:asset-3").await.expect("rollback");
        assert!(!file.exists(), "rollback removes a file that did not exist before");
    }

    #[tokio::test]
    async fn asset_write_rejects_path_traversal() {
        let temp = tempfile::tempdir().expect("tempdir");
        let broker = broker(temp.path()).await;
        let write = WorkspaceAssetWrite {
            effect_id: "effect:asset-4".into(),
            relative_path: "../escape.png".into(),
            bytes: vec![1u8, 2, 3],
        };
        broker.propose_asset_write(&write).await.expect("queue");
        broker.approve_next().await.expect("approve");
        assert!(
            broker.propose_asset_write(&write).await.is_err(),
            "traversal path must be rejected for assets just as for text"
        );
        assert!(!temp.path().parent().unwrap().join("escape.png").exists());
    }
}
