//! Local benchmark preview owned by the native host.
//!
//! The renderer requests a preview for a semantic project; it never provides a
//! bind address, executable, command line, or database path. The host starts a
//! loopback-only Axum server and retains its shutdown handle.

use anyhow::Context;
use benchmark_service::{router, BenchmarkStore};
use ide_reconciliation::{
    CausalLinks, Divergence, IntentSpecRecord, PreviewEvidenceLedger, PreviewFailure,
    PreviewHealthCheck, PreviewHealthCheckObservation, ReconciliationStore,
};
use serde::Serialize;
use std::{
    fs,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{oneshot, Mutex},
    task::JoinHandle,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkPreviewStatus {
    pub project_id: String,
    pub url: String,
    pub state: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFailureReport {
    pub failure: PreviewFailure,
    pub divergence: Divergence,
}

struct RunningPreview {
    status: BenchmarkPreviewStatus,
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

pub struct BenchmarkPreviewHost {
    data_directory: PathBuf,
    running: Mutex<Option<RunningPreview>>,
    reconciliation: Mutex<ReconciliationStore>,
}

impl BenchmarkPreviewHost {
    pub fn open(data_directory: PathBuf) -> anyhow::Result<Self> {
        fs::create_dir_all(&data_directory).with_context(|| {
            format!(
                "create benchmark preview directory {}",
                data_directory.display()
            )
        })?;
        Ok(Self {
            data_directory,
            running: Mutex::new(None),
            reconciliation: Mutex::new(ReconciliationStore::default()),
        })
    }

    pub async fn start(&self, project_id: &str) -> anyhow::Result<BenchmarkPreviewStatus> {
        let mut running = self.running.lock().await;
        if let Some(active) = running.as_ref() {
            if active.status.project_id == project_id {
                return Ok(active.status.clone());
            }
        }
        if let Some(active) = running.take() {
            let _ = active.shutdown.send(());
        }

        let database_path = self.data_directory.join(format!("{project_id}.sqlite3"));
        let store = Arc::new(BenchmarkStore::open(database_path)?);
        store.ensure_listing("listing:home", "Página inicial")?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let (shutdown, receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router(store))
                .with_graceful_shutdown(async move {
                    let _ = receiver.await;
                })
                .await;
        });
        let status = BenchmarkPreviewStatus {
            project_id: project_id.to_owned(),
            url: format!("http://{address}"),
            state: "healthy",
        };
        *running = Some(RunningPreview {
            status: status.clone(),
            shutdown,
            task,
        });
        Ok(status)
    }

    pub async fn stop(&self) -> Option<BenchmarkPreviewStatus> {
        let active = self.running.lock().await.take()?;
        let _ = active.shutdown.send(());
        let _ = active.task.await;
        Some(BenchmarkPreviewStatus {
            state: "stopped",
            ..active.status
        })
    }

    /// Stops a real loopback preview and records the resulting failed HTTP probe.
    /// The endpoint, process lifecycle and failure detail remain host-owned; the
    /// caller supplies only causal links already observed by the semantic bridge.
    pub async fn stop_and_capture_health_failure(
        &self,
        causal_links: CausalLinks,
        declared_intent: &str,
    ) -> anyhow::Result<Option<PreviewFailureReport>> {
        let Some(status) = self.stop().await else {
            return Ok(None);
        };
        let detail = probe_health(&status.url)
            .await
            .err()
            .context("stopped benchmark preview unexpectedly answered its health check")?;
        let observed_at_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
        let mut ledger = PreviewEvidenceLedger::default();
        let failure = ledger
            .record_failed_health_check(PreviewHealthCheck {
                id: format!("preview-health:{}:{observed_at_ms}", status.project_id),
                preview_id: status.project_id.clone(),
                evidence_id: format!(
                    "evidence:preview-health:{}:{observed_at_ms}",
                    status.project_id
                ),
                url: status.url,
                observation: PreviewHealthCheckObservation::Failed {
                    detail: detail.to_string(),
                },
                causal_links,
                observed_at_ms,
            })?
            .clone();
        let intent_id = format!("intent:benchmark-preview:{}", status.project_id);
        let observation_id = format!("observation:{}", failure.id);
        let subject = format!("benchmark-preview:{}", status.project_id);
        let mut reconciliation = self.reconciliation.lock().await;
        reconciliation.record_intent(IntentSpecRecord {
            id: intent_id.clone(),
            subject: subject.clone(),
            expected: serde_json::json!({ "health": "healthy" }),
            source_path: "benchmark.intent.md".to_owned(),
            revision: declared_intent.to_owned(),
        });
        reconciliation.record_observation(failure.as_observation(
            observation_id.clone(),
            subject,
            serde_json::json!({ "health": "broken" }),
        ));
        let divergence = reconciliation
            .detect(&intent_id, &observation_id)
            .cloned()
            .context("failed preview did not yield an evidenced intent divergence")?;
        Ok(Some(PreviewFailureReport {
            failure,
            divergence,
        }))
    }
}

async fn probe_health(url: &str) -> anyhow::Result<()> {
    let address = url
        .strip_prefix("http://")
        .context("preview URL must use loopback HTTP")?;
    let mut stream = tokio::net::TcpStream::connect(address)
        .await
        .with_context(|| format!("connect preview health endpoint {url}"))?;
    stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await?;
    anyhow::ensure!(
        response.starts_with(b"HTTP/1.1 204"),
        "preview health endpoint returned a non-204 response"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stopped_preview_produces_causal_failed_health_evidence() {
        let directory = std::env::temp_dir().join(format!(
            "ai-native-ide-preview-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock is after epoch")
                .as_nanos()
        ));
        let host = BenchmarkPreviewHost::open(directory.clone()).expect("open preview host");
        host.start("auction").await.expect("start preview");

        let failure = host
            .stop_and_capture_health_failure(
                CausalLinks {
                    effect_ids: vec!["benchmark-plan-v1".to_owned()],
                    activity_ids: vec!["activity:revision-1".to_owned()],
                    file_paths: vec!["benchmark.intent.md".to_owned()],
                },
                "# Benchmark intent",
            )
            .await
            .expect("capture failed health")
            .expect("a running preview should yield evidence");

        assert_eq!(
            failure.failure.causal_links.effect_ids,
            ["benchmark-plan-v1"]
        );
        assert!(matches!(
            failure.failure.kind,
            ide_reconciliation::PreviewFailureKind::HealthCheckFailed { .. }
        ));
        assert_eq!(
            failure.divergence.evidence_ids,
            [failure.failure.evidence_id]
        );
        fs::remove_dir_all(directory).expect("remove preview test directory");
    }
}
