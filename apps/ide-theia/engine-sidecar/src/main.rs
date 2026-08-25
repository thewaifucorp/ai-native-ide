//! Line-delimited JSON-over-stdio sidecar exposing the real `ide-diff` engine.
//!
//! Protocol: one JSON object per line on stdin, one JSON object per line on
//! stdout. Request: `{ "id": <any>, "method": "...", "params": { ... } }`.
//! Response: `{ "id": <echoed>, "result": <value> }` or
//! `{ "id": <echoed>, "error": "<message>" }`.
//!
//! Methods:
//!   - `ping`           -> `{ "pong": true, "engine": "ide-diff" }`
//!   - `diff`           params `{ original, proposed }`            -> `{ "hunks": [...] }`
//!   - `merge_selected` params `{ original, proposed, selected }`  -> `{ "merged": "..." }`
//!
//! `diff` / `merge_selected` call straight into `ide_diff::{diff, merge_selected}`.

use std::io::{self, BufRead, Write};

use ide_diff::{diff, merge_selected, Hunk};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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

/// Dispatches one request to the real engine, returning a JSON result or an
/// error string. Never panics: every fallible step maps into `Err`.
fn handle(method: &str, params: Value) -> Result<Value, String> {
    match method {
        "ping" => Ok(serde_json::json!({ "pong": true, "engine": "ide-diff" })),
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
        other => Err(format!("unknown method: {other}")),
    }
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(req) => match handle(&req.method, req.params) {
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

    #[test]
    fn ping_reports_engine() {
        let v = handle("ping", Value::Null).expect("ping ok");
        assert_eq!(v["pong"], serde_json::json!(true));
        assert_eq!(v["engine"], serde_json::json!("ide-diff"));
    }

    #[test]
    fn diff_returns_hunks() {
        let params = serde_json::json!({ "original": "a\nb\nc\n", "proposed": "a\nB\nc\n" });
        let v = handle("diff", params).expect("diff ok");
        assert_eq!(v["hunks"].as_array().map(|a| a.len()), Some(1));
    }

    #[test]
    fn merge_selected_accepts_nothing() {
        let params = serde_json::json!({
            "original": "a\nb\nc\n",
            "proposed": "a\nB\nc\n",
            "selected": []
        });
        let v = handle("merge_selected", params).expect("merge ok");
        assert_eq!(v["merged"], serde_json::json!("a\nb\nc\n"));
    }

    #[test]
    fn unknown_method_errors() {
        assert!(handle("nope", Value::Null).is_err());
    }
}
