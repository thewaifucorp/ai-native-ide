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
//!   - `broker_approve`  params `{ root, owner }`   -> `{ approved_id: <i64> }`
//!   - `broker_rollback` params `{ root, owner, effect_id }` -> `{ rolledback: true }`
//!   - `broker_activity` params `{ root, owner }`   -> `{ activity: [...] }`
//!
//! `diff` / `merge_selected` call straight into `ide_diff::{diff, merge_selected}`.
//! The `broker_*` methods drive the REAL `ide_domain::WorkspaceEffectBroker`
//! (capability registry + SqliteApprovalGate + snapshot store) — one live broker
//! per (owner, workspace-root), kept in a process-wide registry so the
//! propose → approve → propose-executes → rollback lifecycle spans requests.

use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

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
            let p: BrokerScopeParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let broker = broker_for(&p.root, &p.owner).await?;
            let approved_id = broker.approve_next().await.map_err(|e| e.to_string())?;
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
        "broker_activity" => {
            let p: BrokerScopeParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let broker = broker_for(&p.root, &p.owner).await?;
            let activity = broker.activity().await;
            Ok(json!({ "activity": activity }))
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
        handle("broker_approve", json!({ "root": root, "owner": owner }))
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
