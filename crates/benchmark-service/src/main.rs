use benchmark_service::{router, BenchmarkStore};
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let store = Arc::new(BenchmarkStore::open("benchmark.sqlite3")?);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:4317").await?;
    axum::serve(listener, router(store)).await?;
    Ok(())
}
