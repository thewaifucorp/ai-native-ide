use super::host::OutputStream;
use super::{
    benchmark_preview::{BenchmarkPreviewHost, PreviewReconciliationAction},
    bridge::{
        AcpxTarget, DesktopBridge, ProjectIntentInput, TrustedWorkspaceSelection,
        WorkspaceWriteRequest,
    },
    registered_git_executable, workspace_inspection_spec, HostEvent, HostExtension, HostRuntime,
    WatchScope,
};
use ide_agent::AgentAvailability;
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
        .approve_write(&project.id.0, "auction-local", "benchmark-plan-v1")
        .await
        .expect("approve exact effect");
    let written = bridge
        .propose_write(&project.id.0, write)
        .await
        .expect("execute approved effect");
    assert_eq!(written["written"], true);
    assert!(root.join("benchmark.intent.md").is_file());

    // Agent leg: the journey reaches a real external-agent adapter. Without the
    // `acpx` binary installed (as in CI) it must degrade to an explicit
    // Unavailable that explains why — never a fabricated session.
    let card = bridge.agent_capability_card(AcpxTarget::Claude).await;
    match card.health.availability {
        AgentAvailability::Ready | AgentAvailability::Degraded => {
            assert!(
                card.descriptor.is_some(),
                "a usable agent exposes a descriptor"
            );
        }
        AgentAvailability::Unavailable => {
            assert!(
                card.health.detail.is_some(),
                "an unavailable agent must explain its degradation"
            );
        }
    }

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

/// Gate 6 for a non-technical person: the whole publish → reopen → diagnose →
/// fix → republish loop is driven only through high-level semantic commands. No
/// Git, no raw file editing and no version string is ever touched by hand; the
/// host owns versioning and carries honest reversibility evidence on each record.
#[tokio::test]
async fn nontechnical_person_publishes_reopens_diagnoses_and_republishes() {
    let data = temporary_directory("gate6-data");
    let bridge = DesktopBridge::open(&data, "gate6.owner").expect("open desktop bridge");

    let project = bridge
        .create_project(ProjectIntentInput {
            project_id: "auction".to_owned(),
            title: "Leilão de posições".to_owned(),
            intent: "Publicar um leilão simples de posições para pessoas divulgarem ferramentas."
                .to_owned(),
        })
        .expect("persist semantic project from plain intent");

    // Publish: an external effect. The record must carry honest reversibility
    // evidence rather than pretend the publication can be simply undone.
    let published = bridge
        .publish_project(&project.id.0)
        .await
        .expect("publish the project locally");
    assert!(
        !matches!(
            published.reversibility,
            ide_lifecycle::Reversibility::Reversible
        ),
        "an external publication is never a plain reversible effect"
    );

    // Reopen the published product in the same project after the host forgot its
    // in-memory state — no directory re-selection, no Git knowledge required.
    let reopened = bridge
        .restore_project(&project.id.0)
        .await
        .expect("reopen persisted project")
        .expect("the published project still exists");
    assert_eq!(reopened.id.0, project.id.0);

    // Diagnose + fix: relate the observed problem to the intent by editing the
    // spec in plain language, then republish. The host bumps the version.
    bridge
        .update_project_intent(
            &project.id.0,
            "Publicar um leilão de posições que também mostre o lance vencedor sem vazar quem lançou."
                .to_owned(),
        )
        .expect("edit the spec in plain language");
    let republished = bridge
        .republish_project(
            &project.id.0,
            "O produto publicado vazava a identidade de quem deu o lance.",
            vec!["auction-local".to_owned()],
        )
        .await
        .expect("republish a fixed version");
    assert_eq!(
        republished.problem.as_deref(),
        Some("O produto publicado vazava a identidade de quem deu o lance.")
    );
    assert_ne!(
        republished.version, published.version,
        "a republish must produce a new version"
    );

    let history = bridge.publish_history(&project.id.0).await;
    assert_eq!(history.len(), 2, "publish then republish are both recorded");
    assert!(
        history.last().expect("republish record").problem.is_some(),
        "the latest record explains the problem it fixed"
    );

    fs::remove_dir_all(&data).expect("remove host data");
}
