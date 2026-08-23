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
    broker.approve_next().await.expect("approve");
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
    broker.approve_next().await.expect("approve");
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

    broker.approve_next().await.expect("approve");
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
