use ide_reconciliation::*;
use serde_json::json;

fn intent() -> IntentSpecRecord {
    IntentSpecRecord {
        id: "intent-ranking".to_owned(),
        subject: "leaderboard.order".to_owned(),
        expected: json!("highest_bid_first"),
        source_path: "specs/benchmark.md".to_owned(),
        revision: "abc123".to_owned(),
    }
}

fn inverted_observation() -> ObservedBehavior {
    ObservedBehavior {
        id: "preview-observation-1".to_owned(),
        subject: "leaderboard.order".to_owned(),
        actual: json!("lowest_bid_first"),
        evidence_ids: vec!["preview-log-4".to_owned(), "test-17".to_owned()],
        observed_at_ms: 20,
    }
}

fn failed_exit(id: &str, exit_code: i32, causal_links: CausalLinks) -> PreviewProcessExit {
    PreviewProcessExit {
        id: id.to_owned(),
        preview_id: "preview-benchmark".to_owned(),
        evidence_id: format!("evidence-{id}"),
        process_id: "process-benchmark".to_owned(),
        exit_code,
        message: "benchmark process exited while starting".to_owned(),
        causal_links,
        observed_at_ms: 30,
    }
}

#[test]
fn preview_lifecycle_is_explicit_and_monotonic() {
    let mut preview = PreviewSupervisor::starting(10);
    preview
        .transition(PreviewHealth::Healthy, 11, None)
        .unwrap();
    preview
        .transition(PreviewHealth::Stale, 12, Some("source changed".to_owned()))
        .unwrap();
    preview
        .transition(PreviewHealth::Reconnecting, 13, None)
        .unwrap();
    preview
        .transition(PreviewHealth::Healthy, 14, None)
        .unwrap();

    assert_eq!(preview.state().health, PreviewHealth::Healthy);
    assert!(matches!(
        preview.transition(PreviewHealth::Starting, 15, None),
        Err(PreviewTransitionError::Invalid { .. })
    ));
    assert!(matches!(
        preview.transition(PreviewHealth::Broken, 9, None),
        Err(PreviewTransitionError::TimeWentBackwards { .. })
    ));
}

#[test]
fn failure_preserves_causal_effect_activity_and_files() {
    let mut ledger = PreviewEvidenceLedger::default();
    let failure = ledger
        .record_nonzero_process_exit(failed_exit(
            "preview-failure-1",
            17,
            CausalLinks {
                effect_ids: vec!["effect-preview-start".to_owned()],
                activity_ids: vec!["activity-42".to_owned()],
                file_paths: vec!["apps/benchmark/src/server.rs".to_owned()],
            },
        ))
        .unwrap();
    assert!(!failure.causal_links.is_empty());
    assert_eq!(failure.causal_links.activity_ids[0], "activity-42");
    assert_eq!(
        failure.kind,
        PreviewFailureKind::ProcessExited {
            process_id: "process-benchmark".to_owned(),
            exit_code: 17,
        }
    );
    assert_eq!(
        ledger.failure("preview-failure-1").unwrap().evidence_id,
        "evidence-preview-failure-1"
    );
}

#[test]
fn a_nonzero_preview_exit_creates_causal_evidence_and_a_real_divergence() {
    let mut preview = PreviewSupervisor::starting(10);
    preview
        .transition(PreviewHealth::Healthy, 11, None)
        .unwrap();

    let mut ledger = PreviewEvidenceLedger::default();
    let failure = ledger
        .record_nonzero_process_exit(PreviewProcessExit {
            id: "preview-failure-2".to_owned(),
            preview_id: "preview-benchmark".to_owned(),
            evidence_id: "evidence-preview-failure-2".to_owned(),
            process_id: "process-benchmark".to_owned(),
            exit_code: 17,
            message: "benchmark exited with status 17".to_owned(),
            causal_links: CausalLinks {
                effect_ids: vec!["effect-start-benchmark".to_owned()],
                activity_ids: vec!["activity-run-benchmark".to_owned()],
                file_paths: vec!["crates/benchmark-service/src/main.rs".to_owned()],
            },
            observed_at_ms: 12,
        })
        .unwrap()
        .clone();
    preview
        .transition(PreviewHealth::Broken, 12, Some(failure.message.clone()))
        .unwrap();

    let expectation = IntentSpecRecord {
        id: "intent-preview-health".to_owned(),
        subject: "preview.health".to_owned(),
        expected: json!("healthy"),
        source_path: "specs/benchmark.md".to_owned(),
        revision: "rev-preview-health".to_owned(),
    };
    let observation = failure.as_observation(
        "observation-preview-health",
        "preview.health",
        json!("broken"),
    );
    let divergence = detect_divergence(&expectation, &observation).unwrap();

    assert_eq!(preview.state().health, PreviewHealth::Broken);
    assert_eq!(divergence.evidence_ids, vec!["evidence-preview-failure-2"]);
    assert_eq!(
        failure.causal_links.effect_ids,
        vec!["effect-start-benchmark"]
    );
    assert_eq!(
        failure.causal_links.file_paths,
        vec!["crates/benchmark-service/src/main.rs"]
    );
}

#[test]
fn clean_exit_blank_traces_and_duplicate_failure_cannot_be_represented_as_evidence() {
    let mut ledger = PreviewEvidenceLedger::default();
    let links = CausalLinks {
        effect_ids: vec!["effect-start".to_owned()],
        activity_ids: vec!["activity-start".to_owned()],
        file_paths: vec!["main.rs".to_owned()],
    };

    assert_eq!(
        ledger
            .record_nonzero_process_exit(failed_exit("failure-clean", 0, links.clone()))
            .unwrap_err(),
        PreviewEvidenceError::CleanProcessExit
    );
    assert_eq!(
        ledger
            .record_nonzero_process_exit(failed_exit(
                "failure-empty-links",
                1,
                CausalLinks {
                    effect_ids: vec![],
                    activity_ids: vec![],
                    file_paths: vec![],
                },
            ))
            .unwrap_err(),
        PreviewEvidenceError::MissingCausalLinks
    );

    ledger
        .record_nonzero_process_exit(failed_exit("failure-duplicate", 1, links.clone()))
        .unwrap();
    assert_eq!(
        ledger
            .record_nonzero_process_exit(failed_exit("failure-duplicate", 2, links))
            .unwrap_err(),
        PreviewEvidenceError::DuplicateFailure("failure-duplicate".to_owned())
    );
}

#[test]
fn unavailable_aag_is_unknown_not_an_empty_or_successful_graph() {
    assert_eq!(
        relations_from_aag(
            &AagAvailability::Unavailable {
                reason: "local index missing".to_owned()
            },
            Some(vec!["should-not-be-used".to_owned()]),
        ),
        AagRelations::Unknown {
            reason: "AAG unavailable: local index missing".to_owned()
        }
    );
}

#[test]
fn detects_real_divergence_and_all_three_reconciliation_choices_are_honest() {
    let mut store = ReconciliationStore::default();
    store.record_intent(intent());
    store.record_observation(inverted_observation());
    let divergence_id = store
        .detect("intent-ranking", "preview-observation-1")
        .unwrap()
        .id
        .clone();

    let implementation = store
        .reconcile(
            &divergence_id,
            ReconciliationChoice::ChangeImplementation {
                proposed_effect_id: "effect-fix-sort".to_owned(),
            },
        )
        .unwrap();
    assert_eq!(
        implementation.status,
        ReconciliationStatus::PendingVerification
    );

    let intent_change = store
        .reconcile(
            &divergence_id,
            ReconciliationChoice::ChangeIntent {
                revised_expected: json!("lowest_bid_first"),
            },
        )
        .unwrap();
    assert_eq!(
        intent_change.status,
        ReconciliationStatus::PendingVerification
    );
    assert_eq!(
        store.intent("intent-ranking").unwrap().expected,
        json!("lowest_bid_first")
    );

    let exception = store
        .reconcile(
            &divergence_id,
            ReconciliationChoice::AcceptScopedException {
                scope: ExceptionScope::Path {
                    path: "experiments/ascending-ranking".to_owned(),
                },
                justification: "experimental ranking variant".to_owned(),
            },
        )
        .unwrap();
    assert_eq!(
        exception.status,
        ReconciliationStatus::AcceptedScopedException
    );
}

#[test]
fn unsupported_or_unproven_difference_is_not_a_divergence() {
    let mut no_evidence = inverted_observation();
    no_evidence.evidence_ids.clear();
    assert!(detect_divergence(&intent(), &no_evidence).is_none());

    let same = ObservedBehavior {
        actual: json!("highest_bid_first"),
        ..inverted_observation()
    };
    assert!(detect_divergence(&intent(), &same).is_none());
}
