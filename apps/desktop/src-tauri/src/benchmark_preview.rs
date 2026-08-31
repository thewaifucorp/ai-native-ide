//! Local benchmark preview owned by the native host.
//!
//! The renderer requests a preview for a semantic project; it never provides a
//! bind address, executable, command line, or database path. The host starts a
//! loopback-only Axum server and retains its shutdown handle.

use anyhow::Context;
use benchmark_service::{router, BenchmarkStore};
use ide_reconciliation::{
    CausalLinks, Divergence, ExceptionScope, IntentSpecRecord, PreviewEvidenceLedger,
    PreviewFailure, PreviewHealth as SupervisorHealth, PreviewHealthCheck,
    PreviewHealthCheckObservation, PreviewSupervisor, Reconciliation, ReconciliationChoice,
    ReconciliationStore,
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
    /// Live health derived from a real loopback probe, not a host assertion.
    pub health: crate::model::PreviewHealth,
    pub detail: Option<String>,
    pub changed_at_ms: u64,
}

/// Result of an actual loopback health probe against a running preview.
enum PreviewProbe {
    /// `/health` answered `204`.
    Up,
    /// The server accepted the connection but did not answer a healthy check.
    Degraded(String),
    /// The server could not be reached at all.
    Down(String),
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

fn to_model_health(health: &SupervisorHealth) -> crate::model::PreviewHealth {
    match health {
        SupervisorHealth::Starting => crate::model::PreviewHealth::Starting,
        SupervisorHealth::Healthy => crate::model::PreviewHealth::Healthy,
        SupervisorHealth::Stale => crate::model::PreviewHealth::Stale,
        SupervisorHealth::Broken => crate::model::PreviewHealth::Broken,
        SupervisorHealth::Reconnecting => crate::model::PreviewHealth::Reconnecting,
    }
}

fn status_from(
    project_id: &str,
    url: &str,
    supervisor: &PreviewSupervisor,
) -> BenchmarkPreviewStatus {
    let state = supervisor.state();
    BenchmarkPreviewStatus {
        project_id: project_id.to_owned(),
        url: url.to_owned(),
        health: to_model_health(&state.health),
        detail: state.detail.clone(),
        changed_at_ms: state.changed_at_ms,
    }
}

/// The next legal supervisor state for an observed probe. `None` keeps the
/// current state (and its `changed_at_ms`), so a steady preview does not churn.
/// Every returned target is a single legal transition from `current`.
fn next_health(current: &SupervisorHealth, probe: &PreviewProbe) -> Option<SupervisorHealth> {
    use SupervisorHealth::*;
    let target = match probe {
        PreviewProbe::Up => match current {
            Starting => Healthy,
            Healthy => return None,
            Stale => Healthy,
            Broken => Reconnecting,
            Reconnecting => Healthy,
        },
        PreviewProbe::Degraded(_) => match current {
            Starting => Stale,
            Healthy => Stale,
            Stale => return None,
            Broken => Reconnecting,
            Reconnecting => Stale,
        },
        PreviewProbe::Down(_) => match current {
            Broken => return None,
            _ => Broken,
        },
    };
    Some(target)
}

fn apply_probe(supervisor: &mut PreviewSupervisor, probe: &PreviewProbe) {
    let Some(next) = next_health(&supervisor.state().health, probe) else {
        return;
    };
    let detail = match probe {
        PreviewProbe::Up => None,
        PreviewProbe::Degraded(detail) | PreviewProbe::Down(detail) => Some(detail.clone()),
    };
    // The target is always a legal one-step transition and `now_ms` is
    // monotonic against the supervisor, so a transition error is unreachable.
    let _ = supervisor.transition(next, now_ms(), detail);
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFailureReport {
    pub failure: PreviewFailure,
    pub divergence: Divergence,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewReconciliationAction {
    ChangeImplementation,
    ChangeIntent,
    AcceptPreviewException,
}

struct RunningPreview {
    status: BenchmarkPreviewStatus,
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<()>,
    supervisor: PreviewSupervisor,
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
        let url = format!("http://{address}");
        // The lifecycle starts before any observation, then advances only on a
        // real loopback probe. No state is asserted without evidence.
        let mut supervisor = PreviewSupervisor::starting(now_ms());
        apply_probe(&mut supervisor, &classify_health(&url).await);
        let status = status_from(project_id, &url, &supervisor);
        *running = Some(RunningPreview {
            status: status.clone(),
            shutdown,
            task,
            supervisor,
        });
        Ok(status)
    }

    /// Runs a real loopback health probe against the active preview and advances
    /// the lifecycle. Returns `None` when no preview is running.
    pub async fn poll(&self) -> Option<BenchmarkPreviewStatus> {
        let mut running = self.running.lock().await;
        let active = running.as_mut()?;
        let probe = classify_health(&active.status.url).await;
        apply_probe(&mut active.supervisor, &probe);
        active.status = status_from(
            &active.status.project_id,
            &active.status.url,
            &active.supervisor,
        );
        Some(active.status.clone())
    }

    pub async fn stop(&self) -> Option<BenchmarkPreviewStatus> {
        let active = self.running.lock().await.take()?;
        let _ = active.shutdown.send(());
        let _ = active.task.await;
        Some(BenchmarkPreviewStatus {
            health: crate::model::PreviewHealth::Stopped,
            detail: Some("preview stopped by host".to_owned()),
            changed_at_ms: now_ms(),
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

    pub async fn reconcile_failure(
        &self,
        divergence_id: &str,
        action: PreviewReconciliationAction,
    ) -> anyhow::Result<Reconciliation> {
        let mut reconciliation = self.reconciliation.lock().await;
        let choice = match action {
            PreviewReconciliationAction::ChangeImplementation => {
                ReconciliationChoice::ChangeImplementation {
                    proposed_effect_id: format!("reconcile:{divergence_id}:implementation"),
                }
            }
            PreviewReconciliationAction::ChangeIntent => ReconciliationChoice::ChangeIntent {
                revised_expected: serde_json::json!({ "health": "broken" }),
            },
            PreviewReconciliationAction::AcceptPreviewException => {
                let subject = reconciliation
                    .divergence(divergence_id)
                    .map(|divergence| divergence.subject.as_str())
                    .context("unknown preview divergence")?;
                let preview_id = subject
                    .strip_prefix("benchmark-preview:")
                    .context("preview divergence has an invalid subject")?;
                ReconciliationChoice::AcceptScopedException {
                    scope: ExceptionScope::Preview { preview_id: preview_id.to_owned() },
                    justification: "Explicitly accepted through the AI-Native IDE preview reconciliation surface.".to_owned(),
                }
            }
        };
        reconciliation
            .reconcile(divergence_id, choice)
            .cloned()
            .context("unknown preview divergence")
    }
}

/// Classifies a real loopback health probe. A connect failure is `Down`; an
/// accepted connection that does not answer `204` is `Degraded`. The host never
/// manufactures a health verdict — every branch reflects an observed socket.
async fn classify_health(url: &str) -> PreviewProbe {
    let Some(address) = url.strip_prefix("http://") else {
        return PreviewProbe::Down("preview URL must use loopback HTTP".to_owned());
    };
    let mut stream = match tokio::net::TcpStream::connect(address).await {
        Ok(stream) => stream,
        Err(error) => return PreviewProbe::Down(format!("connect {url}: {error}")),
    };
    if let Err(error) = stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
    {
        return PreviewProbe::Down(format!("write {url}: {error}"));
    }
    let mut response = Vec::new();
    if let Err(error) = stream.read_to_end(&mut response).await {
        return PreviewProbe::Degraded(format!("read {url}: {error}"));
    }
    if response.starts_with(b"HTTP/1.1 204") {
        PreviewProbe::Up
    } else {
        PreviewProbe::Degraded(format!("health endpoint {url} returned a non-204 response"))
    }
}

async fn probe_health(url: &str) -> anyhow::Result<()> {
    match classify_health(url).await {
        PreviewProbe::Up => Ok(()),
        PreviewProbe::Degraded(detail) | PreviewProbe::Down(detail) => {
            anyhow::bail!(detail)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_advances_only_through_legal_lifecycle_transitions() {
        use SupervisorHealth::*;
        // A first healthy probe leaves `Starting`.
        assert_eq!(next_health(&Starting, &PreviewProbe::Up), Some(Healthy));
        // A steady healthy preview does not churn its state.
        assert_eq!(next_health(&Healthy, &PreviewProbe::Up), None);
        // A lost connection breaks a healthy preview, then holds broken.
        assert_eq!(
            next_health(&Healthy, &PreviewProbe::Down(String::new())),
            Some(Broken)
        );
        assert_eq!(
            next_health(&Broken, &PreviewProbe::Down(String::new())),
            None
        );
        // Recovery is observed as reconnecting before it is trusted as healthy.
        assert_eq!(next_health(&Broken, &PreviewProbe::Up), Some(Reconnecting));
        assert_eq!(next_health(&Reconnecting, &PreviewProbe::Up), Some(Healthy));
        // A reachable-but-unhealthy server is stale, never silently healthy.
        assert_eq!(
            next_health(&Healthy, &PreviewProbe::Degraded(String::new())),
            Some(Stale)
        );
        assert_eq!(next_health(&Stale, &PreviewProbe::Up), Some(Healthy));
    }

    #[tokio::test]
    async fn a_running_preview_reports_real_healthy_state_and_polls() {
        let directory = std::env::temp_dir().join(format!(
            "ai-native-ide-preview-live-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock is after epoch")
                .as_nanos()
        ));
        let host = BenchmarkPreviewHost::open(directory.clone()).expect("open preview host");
        let started = host.start("auction").await.expect("start preview");
        assert_eq!(started.health, crate::model::PreviewHealth::Healthy);
        let polled = host.poll().await.expect("running preview polls");
        assert_eq!(polled.health, crate::model::PreviewHealth::Healthy);
        assert!(polled.url.starts_with("http://127.0.0.1:"));
        host.stop().await;
        assert!(host.poll().await.is_none());
        fs::remove_dir_all(directory).expect("remove preview test directory");
    }

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

    #[tokio::test]
    async fn preview_exception_uses_the_actual_preview_scope() {
        let directory = std::env::temp_dir().join(format!(
            "ai-native-ide-preview-scope-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock is after epoch")
                .as_nanos()
        ));
        let host = BenchmarkPreviewHost::open(directory.clone()).expect("open preview host");
        host.start("auction").await.expect("start preview");
        let report = host
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
            .expect("running preview yields failure evidence");

        let reconciliation = host
            .reconcile_failure(
                &report.divergence.id,
                PreviewReconciliationAction::AcceptPreviewException,
            )
            .await
            .expect("scope preview exception");
        assert!(matches!(
            reconciliation.choice,
            ReconciliationChoice::AcceptScopedException {
                scope: ExceptionScope::Preview { ref preview_id },
                ..
            } if preview_id == "auction"
        ));
        fs::remove_dir_all(directory).expect("remove preview test directory");
    }
}
