//! Local benchmark preview owned by the native host.
//!
//! The renderer requests a preview for a semantic project; it never provides a
//! bind address, executable, command line, or database path. The host starts a
//! loopback-only Axum server and retains its shutdown handle.

use anyhow::Context;
use benchmark_service::{router, BenchmarkStore};
use serde::Serialize;
use std::{fs, path::PathBuf, sync::Arc};
use tokio::sync::{oneshot, Mutex};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkPreviewStatus {
    pub project_id: String,
    pub url: String,
    pub state: &'static str,
}

struct RunningPreview {
    status: BenchmarkPreviewStatus,
    shutdown: oneshot::Sender<()>,
}

pub struct BenchmarkPreviewHost {
    data_directory: PathBuf,
    running: Mutex<Option<RunningPreview>>,
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
        tokio::spawn(async move {
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
        });
        Ok(status)
    }

    pub async fn stop(&self) -> Option<BenchmarkPreviewStatus> {
        self.running.lock().await.take().map(|active| {
            let _ = active.shutdown.send(());
            BenchmarkPreviewStatus {
                state: "stopped",
                ..active.status
            }
        })
    }
}
