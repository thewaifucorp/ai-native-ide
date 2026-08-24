use super::host::OutputStream;
use super::{
    benchmark_preview::{BenchmarkPreviewHost, PreviewReconciliationAction},
    bridge::{DesktopBridge, ProjectIntentInput, TrustedWorkspaceSelection, WorkspaceWriteRequest},
    registered_git_executable, workspace_inspection_spec, HostEvent, HostExtension, HostRuntime,
    WatchScope,
};
use ide_domain::ResourceKind;
use std::{
    collections::VecDeque,
    fs,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use std::{
    thread,
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn temporary_directory(label: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time is after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("ai-native-ide-{label}-{nanos}"))
}

async fn preview_request(url: &str, request: &str) -> String {
    let address = url
        .strip_prefix("http://")
        .expect("preview uses loopback HTTP");
    let mut stream = tokio::net::TcpStream::connect(address)
        .await
        .expect("connect actual preview");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("send actual preview request");
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .expect("read actual preview response");
    String::from_utf8(response).expect("preview response is UTF-8")
}

/// The Gate 1 happy route is deliberately host-level: no WebView mock can make
/// a project, effect, HTTP preview, failure evidence or reconciliation appear.
#[tokio::test]
async fn informal_intent_reaches_evidenced_preview_reconciliation() {
    let root = temporary_directory("golden-workspace");
    let data = temporary_directory("golden-data");
    fs::create_dir_all(&root).expect("create workspace");
    std::process::Command::new(registered_git_executable().expect("find host Git"))
        .args(["init", "--quiet"])
        .current_dir(&root)
        .status()
        .expect("initialize benchmark workspace as a Git resource")
        .success()
        .then_some(())
        .expect("Git initialized benchmark workspace");
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

    let terminal_events = Arc::new(Mutex::new(VecDeque::new()));
    let terminal_sink = Arc::clone(&terminal_events);
    let terminal_runtime = HostRuntime::new(Arc::new(move |event| {
        terminal_sink
            .lock()
            .expect("terminal event lock")
            .push_back(event);
    }));
    let terminal_scope = WatchScope::from_project_resource(&root).expect("scope workspace PTY");
    let terminal_spec =
        workspace_inspection_spec(&terminal_scope).expect("construct fixed workspace inspection");
    let mut terminal = terminal_runtime
        .spawn_pty(terminal_spec, 24, 120)
        .expect("start host-owned workspace PTY");
    let pty_deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < pty_deadline {
        if terminal_events
            .lock()
            .expect("terminal event lock")
            .iter()
            .any(|event| {
                matches!(
                    event,
                    HostEvent::ProcessOutput {
                        extension: HostExtension::Pty,
                        stream: OutputStream::Pty,
                        line,
                    } if line.contains("benchmark.intent.md")
                )
            })
        {
            break;
        }
        terminal.poll().expect("poll host-owned workspace PTY");
        thread::sleep(Duration::from_millis(20));
    }
    let terminal_diagnostics =
        format!("{:?}", terminal_events.lock().expect("terminal event lock"));
    assert!(
        terminal_events
            .lock()
            .expect("terminal event lock")
            .iter()
            .any(|event| matches!(
                event,
                HostEvent::ProcessOutput {
                    extension: HostExtension::Pty,
                    stream: OutputStream::Pty,
                    line,
                } if line.contains("benchmark.intent.md")
            )),
        "host PTY must stream the fixed workspace inspection; events: {terminal_diagnostics}"
    );

    let previews = BenchmarkPreviewHost::open(data.join("previews")).expect("open preview host");
    let started = previews
        .start(&project.id.0)
        .await
        .expect("start local benchmark preview");
    assert!(started.url.starts_with("http://127.0.0.1:"));
    let bid = r#"{"listingId":"listing:home","bidderId":"buyer:private","amountCents":700}"#;
    let bid_response = preview_request(
        &started.url,
        &format!(
            "POST /api/bids HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{bid}",
            bid.len()
        ),
    )
    .await;
    assert!(bid_response.starts_with("HTTP/1.1 200"));
    assert!(bid_response.contains("leading_bid"));
    let leaderboard = preview_request(
        &started.url,
        "GET /api/leaderboard HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert!(leaderboard.starts_with("HTTP/1.1 200"));
    assert!(leaderboard.contains("700"));
    assert!(
        !leaderboard.contains("buyer:private"),
        "the public preview must not leak bidder identity"
    );
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
        std::slice::from_ref(&report.failure.evidence_id)
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
