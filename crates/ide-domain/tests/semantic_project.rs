use ide_domain::{
    ChangeCause, CreateProject, ProjectId, ResourceId, ResourceKind, SemanticProjectStore,
    SessionId,
};
use std::fs;

fn project(id: &str) -> CreateProject {
    CreateProject {
        id: ProjectId(id.to_owned()),
        title: "Storefront".to_owned(),
        intent: "Create a small store for independent makers".to_owned(),
    }
}

#[test]
fn project_resources_and_scopes_survive_reopen_without_a_transcript() {
    let temp = tempfile::tempdir().expect("temp dir");
    let resource_root = temp.path().join("storefront");
    fs::create_dir_all(&resource_root).expect("resource root");
    fs::write(resource_root.join("README.md"), "# Storefront\n").expect("seed file");
    let database = temp.path().join("semantic.sqlite3");

    let store = SemanticProjectStore::open(&database).expect("open store");
    let created = store
        .create_project(project("project:storefront"))
        .expect("create project");
    let resource = store
        .attach_local_resource(
            &created.id,
            ResourceId("resource:storefront".to_owned()),
            ResourceKind::Repository,
            &resource_root,
        )
        .expect("attach resource");
    let scope = store
        .create_session_scope(
            SessionId("session:build".to_owned()),
            &created.id,
            std::slice::from_ref(&resource.id),
        )
        .expect("create scoped session");
    drop(store);

    let reopened = SemanticProjectStore::open(&database).expect("reopen store");
    let reopened_project = reopened
        .open_project(&created.id)
        .expect("open project")
        .expect("project persists");
    assert_eq!(reopened_project.id, created.id);
    assert_eq!(reopened_project.title, created.title);
    assert_eq!(reopened_project.intent, created.intent);
    assert!(reopened_project.updated_at_ms >= created.updated_at_ms);
    assert_eq!(
        reopened
            .resources_for_project(&ProjectId("project:storefront".to_owned()))
            .expect("resources"),
        vec![resource]
    );
    assert_eq!(
        reopened.open_session_scope(&scope.id).expect("scope"),
        Some(scope)
    );
}

#[test]
fn resource_is_reusable_but_session_scope_never_leaks_between_projects() {
    let temp = tempfile::tempdir().expect("temp dir");
    let shared_root = temp.path().join("shared");
    fs::create_dir_all(&shared_root).expect("shared root");
    fs::write(shared_root.join("app.txt"), "hello").expect("seed");
    let store = SemanticProjectStore::open(temp.path().join("semantic.sqlite3")).expect("store");
    let first = store
        .create_project(project("project:first"))
        .expect("first");
    let second = store
        .create_project(project("project:second"))
        .expect("second");
    let shared_id = ResourceId("resource:shared".to_owned());
    store
        .attach_local_resource(
            &first.id,
            shared_id.clone(),
            ResourceKind::Directory,
            &shared_root,
        )
        .expect("first attach");
    store
        .attach_local_resource(
            &second.id,
            shared_id.clone(),
            ResourceKind::Directory,
            &shared_root,
        )
        .expect("second attach");

    assert_eq!(
        store
            .resources_for_project(&second.id)
            .expect("second resources")[0]
            .id,
        shared_id
    );
    let other_root = temp.path().join("other");
    fs::create_dir_all(&other_root).expect("other root");
    let other = store
        .attach_local_resource(
            &first.id,
            ResourceId("resource:other".to_owned()),
            ResourceKind::Directory,
            &other_root,
        )
        .expect("other attach");
    assert!(store
        .create_session_scope(SessionId("session:bad".to_owned()), &second.id, &[other.id])
        .is_err());
}

#[test]
fn external_edits_create_unknown_causal_revisions_and_paths_stay_scoped() {
    let temp = tempfile::tempdir().expect("temp dir");
    let root = temp.path().join("project");
    fs::create_dir_all(&root).expect("root");
    fs::write(root.join("spec.md"), "version one").expect("seed");
    let store = SemanticProjectStore::open(temp.path().join("semantic.sqlite3")).expect("store");
    let project = store
        .create_project(project("project:changes"))
        .expect("project");
    let resource = store
        .attach_local_resource(
            &project.id,
            ResourceId("resource:changes".to_owned()),
            ResourceKind::Directory,
            &root,
        )
        .expect("attach");

    fs::write(root.join("spec.md"), "version two").expect("external edit");
    let changes = store
        .detect_external_changes(&resource.id)
        .expect("scan external edit");
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].relative_path.to_string_lossy(), "spec.md");
    assert_eq!(changes[0].cause, ChangeCause::ExternalUnknown);
    assert!(store
        .read_resource_file(&resource.id, "../semantic.sqlite3")
        .is_err());

    let revisions = store
        .revisions_for_resource(&resource.id)
        .expect("revisions");
    assert_eq!(revisions.len(), 2, "baseline plus external observation");
    assert_eq!(
        revisions.last().expect("last revision").cause,
        ChangeCause::ExternalUnknown
    );
}
