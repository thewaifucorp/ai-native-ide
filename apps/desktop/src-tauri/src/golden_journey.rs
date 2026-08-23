use super::{
    benchmark_preview::{BenchmarkPreviewHost, PreviewReconciliationAction},
    bridge::{DesktopBridge, ProjectIntentInput, TrustedWorkspaceSelection, WorkspaceWriteRequest},
};
use ide_domain::ResourceKind;
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

fn temporary_directory(label: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time is after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("ai-native-ide-{label}-{nanos}"))
}

/// The Gate 1 happy route is deliberately host-level: no WebView mock can make
/// a project, effect, HTTP preview, failure evidence or reconciliation appear.
#[tokio::test]
async fn informal_intent_reaches_evidenced_preview_reconciliation() {
    let root = temporary_directory("golden-workspace");
    let data = temporary_directory("golden-data");
    fs::create_dir_all(&root).expect("create workspace");
    let bridge = DesktopBridge::open(&data, "golden.owner").expect("open desktop bridge");
    let project = bridge
        .create_project(ProjectIntentInput {
            project_id: "auction".to_owned(),
            title: "Leilão de posições".to_owned(),
            intent: "Quero um leilão simples de posições para divulgar ferramentas.".to_owned(),
        })
        .expect("persist semantic project");
    bridge
        .attach_workspace(
            &project.id.0,
            "auction-local",
            ResourceKind::Directory,
            TrustedWorkspaceSelection::from_native_host(&root).expect("select workspace"),
        )
        .await
        .expect("attach semantic resource");

    let write = WorkspaceWriteRequest {
        resource_id: "auction-local".to_owned(),
        effect_id: "benchmark-plan-v1".to_owned(),
        relative_path: "benchmark.intent.md".into(),
        content: "# Benchmark intent\n\nA posição vencedora deve ser observável.".to_owned(),
    };
    let proposed = bridge
        .propose_write(&project.id.0, write.clone())
        .await
        .expect("propose governed effect");
    assert_eq!(proposed["awaitingApproval"], true);
    bridge
        .approve_next_write(&project.id.0, "auction-local")
        .await
        .expect("approve exact effect");
    let written = bridge
        .propose_write(&project.id.0, write)
        .await
        .expect("execute approved effect");
    assert_eq!(written["written"], true);
    assert!(root.join("benchmark.intent.md").is_file());

    let previews = BenchmarkPreviewHost::open(data.join("previews")).expect("open preview host");
    let started = previews
        .start(&project.id.0)
        .await
        .expect("start local benchmark preview");
    assert!(started.url.starts_with("http://127.0.0.1:"));
    let causal = bridge
        .effect_causal_links(&project.id.0, "auction-local", "benchmark-plan-v1")
        .await
        .expect("recover effect causation");
    let report = previews
        .stop_and_capture_health_failure(causal, &project.intent)
        .await
        .expect("capture actual failed health check")
        .expect("running preview yields failure evidence");
    assert_eq!(
        report.failure.causal_links.file_paths,
        ["benchmark.intent.md"]
    );
    assert_eq!(
        report.divergence.evidence_ids,
        [report.failure.evidence_id.clone()]
    );

    let reconciliation = previews
        .reconcile_failure(
            &report.divergence.id,
            PreviewReconciliationAction::ChangeImplementation,
        )
        .await
        .expect("register reconciliation");
    assert!(matches!(
        reconciliation.status,
        ide_reconciliation::ReconciliationStatus::PendingVerification
    ));

    fs::remove_dir_all(&root).expect("remove workspace");
    fs::remove_dir_all(&data).expect("remove host data");
}
