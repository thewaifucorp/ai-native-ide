use ide_domain::{Activity, FoundationSlice, ProjectContract, ProjectId, ProposedEffect};
use serde_json::json;

#[tokio::test]
async fn governed_effect_requires_approval_then_emits_observation() {
    let temp = tempfile::tempdir().expect("temp dir");
    let slice = FoundationSlice::open(temp.path().join("foundation.sqlite3"), "owner:local")
        .await
        .expect("open slice");
    let project = ProjectContract {
        id: ProjectId("project:benchmark".to_string()),
        title: "Benchmark".to_string(),
        intent: "Create a simple auction leaderboard".to_string(),
        resources: vec![],
    };
    slice
        .remember_intent(&project)
        .await
        .expect("remember intent");
    assert_eq!(slice.remembered_facts().await.expect("facts"), 1);

    let effect = ProposedEffect {
        id: "effect:foundation".to_string(),
        project_id: project.id,
        capability: "ide:record_effect".to_string(),
        args: json!({"effect_id": "effect:foundation", "summary": "Create benchmark shell"}),
        requires_approval: true,
    };

    let queued = slice.propose_effect(&effect).await.expect("queue effect");
    assert_eq!(queued["awaiting_approval"], json!(true));
    slice
        .approve_next_effect()
        .await
        .expect("approve exact effect");

    let observed = slice
        .propose_effect(&effect)
        .await
        .expect("dispatch approved effect");
    assert_eq!(observed["recorded"], json!(true));
    assert!(slice
        .activity()
        .await
        .iter()
        .any(|event| matches!(event, Activity::EffectObserved { .. })));
}
