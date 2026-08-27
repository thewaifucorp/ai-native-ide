use ide_domain::{BrokerActivity, WorkspaceEffectBroker, WorkspaceWrite};
use serde_json::json;

#[tokio::test]
async fn exact_approved_write_snapshots_and_rolls_back() {
    let temp = tempfile::tempdir().expect("tempdir");
    let file = temp.path().join("app.txt");
    std::fs::write(&file, "before").expect("seed");
    let broker = WorkspaceEffectBroker::open(
        temp.path().join("effects.sqlite3"),
        "owner:test",
        temp.path(),
    )
    .await
    .expect("broker");
    let write = WorkspaceWrite {
        effect_id: "effect:write-1".into(),
        relative_path: "app.txt".into(),
        content: "after".into(),
    };
    assert_eq!(
        broker.propose_write(&write).await.expect("queue")["awaiting_approval"],
        json!(true)
    );
    assert_eq!(
        std::fs::read_to_string(&file).expect("read queued"),
        "before"
    );
    broker
        .approve_effect("effect:write-1")
        .await
        .expect("approve");
    assert_eq!(
        broker.propose_write(&write).await.expect("write")["written"],
        json!(true)
    );
    assert_eq!(
        std::fs::read_to_string(&file).expect("read written"),
        "after"
    );
    broker.rollback("effect:write-1").await.expect("rollback");
    assert_eq!(
        std::fs::read_to_string(&file).expect("read rollback"),
        "before"
    );
    assert!(broker
        .activity()
        .await
        .iter()
        .any(|entry| matches!(entry, BrokerActivity::SnapshotCreated { .. })));
}

#[tokio::test]
async fn changed_payload_cannot_reuse_prior_approval() {
    let temp = tempfile::tempdir().expect("tempdir");
    std::fs::write(temp.path().join("app.txt"), "before").expect("seed");
    let broker = WorkspaceEffectBroker::open(
        temp.path().join("effects.sqlite3"),
        "owner:test",
        temp.path(),
    )
    .await
    .expect("broker");
    let approved = WorkspaceWrite {
        effect_id: "effect:write-1".into(),
        relative_path: "app.txt".into(),
        content: "safe".into(),
    };
    broker.propose_write(&approved).await.expect("queue");
    broker
        .approve_effect("effect:write-1")
        .await
        .expect("approve");
    let altered = WorkspaceWrite {
        content: "altered".into(),
        ..approved
    };
    assert_eq!(
        broker.propose_write(&altered).await.expect("new queue")["awaiting_approval"],
        json!(true)
    );
    assert_eq!(
        std::fs::read_to_string(temp.path().join("app.txt")).expect("not written"),
        "before"
    );
}

#[tokio::test]
async fn approved_new_file_is_removed_by_rollback() {
    let temp = tempfile::tempdir().expect("tempdir");
    let file = temp.path().join("created.txt");
    let broker = WorkspaceEffectBroker::open(
        temp.path().join("effects.sqlite3"),
        "owner:test",
        temp.path(),
    )
    .await
    .expect("broker");
    let write = WorkspaceWrite {
        effect_id: "effect:create-1".into(),
        relative_path: "created.txt".into(),
        content: "created by an approved effect".into(),
    };

    assert_eq!(
        broker.propose_write(&write).await.expect("queue")["awaiting_approval"],
        json!(true)
    );
    assert!(!file.exists(), "queuing cannot create a file");

    broker
        .approve_effect("effect:create-1")
        .await
        .expect("approve");
    assert_eq!(
        broker.propose_write(&write).await.expect("write")["written"],
        json!(true)
    );
    assert_eq!(
        std::fs::read_to_string(&file).expect("read created file"),
        "created by an approved effect"
    );

    broker.rollback("effect:create-1").await.expect("rollback");
    assert!(
        !file.exists(),
        "rollback removes a file that did not exist before"
    );
}

/// The bug `approve_effect` exists to make impossible.
///
/// With two decisions open, positional approval (`approve_next`, the oldest
/// pending row) authorized the wrong effect: deciding on B granted A, A executed
/// on its next propose, and B stayed awaiting. It caused two real incidents and
/// forced the Node adapter to refuse stacked proposals and drain stale grants.
///
/// Approving B must execute B and leave A untouched — on disk and in the queue.
#[tokio::test]
async fn approving_the_second_proposal_does_not_authorize_the_first() {
    let temp = tempfile::tempdir().expect("tempdir");
    let broker = WorkspaceEffectBroker::open(
        temp.path().join("effects.sqlite3"),
        "owner:test",
        temp.path(),
    )
    .await
    .expect("broker");

    let first = WorkspaceWrite {
        effect_id: "effect:a".into(),
        relative_path: "a.txt".into(),
        content: "conteudo A".into(),
    };
    let second = WorkspaceWrite {
        effect_id: "effect:b".into(),
        relative_path: "b.txt".into(),
        content: "conteudo B".into(),
    };
    broker.propose_write(&first).await.expect("queue A");
    broker.propose_write(&second).await.expect("queue B");
    assert_eq!(broker.pending_count().await.expect("pending"), 2);

    // Decide on the SECOND one.
    broker.approve_effect("effect:b").await.expect("approve B");

    assert_eq!(
        broker.propose_write(&second).await.expect("write B")["written"],
        json!(true)
    );
    assert_eq!(
        std::fs::read_to_string(temp.path().join("b.txt")).expect("read B"),
        "conteudo B"
    );

    // A was never decided on, so it must still be queued and still unwritten.
    assert_eq!(
        broker.propose_write(&first).await.expect("re-queue A")["awaiting_approval"],
        json!(true),
        "aprovar B não pode ter autorizado A"
    );
    assert!(
        !temp.path().join("a.txt").exists(),
        "A não pode ter sido escrito por uma decisão que não era dele"
    );
}

/// An id nobody proposed must fail, naming what IS pending — never fall through
/// to approving whatever happens to be first.
#[tokio::test]
async fn approving_an_unknown_effect_is_an_error_that_names_the_pending_ones() {
    let temp = tempfile::tempdir().expect("tempdir");
    let broker = WorkspaceEffectBroker::open(
        temp.path().join("effects.sqlite3"),
        "owner:test",
        temp.path(),
    )
    .await
    .expect("broker");

    let write = WorkspaceWrite {
        effect_id: "effect:real".into(),
        relative_path: "real.txt".into(),
        content: "x".into(),
    };
    broker.propose_write(&write).await.expect("queue");

    let err = broker
        .approve_effect("effect:inventado")
        .await
        .expect_err("must not approve an effect nobody proposed");
    let message = err.to_string();
    assert!(message.contains("effect:inventado"), "{message}");
    assert!(message.contains("effect:real"), "{message}");

    assert_eq!(
        broker.propose_write(&write).await.expect("still queued")["awaiting_approval"],
        json!(true)
    );
}
