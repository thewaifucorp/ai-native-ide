//! §13 — the durable project: identity, intent and the resources it spans.
//!
//! `ide_domain::semantic::SemanticProjectStore` is the engine: a local SQLite
//! store with project identity, human intent, attached local resources
//! (directories and repositories, each with a stable id independent of its
//! current path), session scopes, and content-hashed revisions whose cause is
//! explicit — initial discovery, an IDE effect naming its id, or an external
//! change nobody can attribute.
//!
//! # What "durable" buys, concretely
//!
//! Reopening the IDE recovers the project WITHOUT a transcript: the title, the
//! intent somebody wrote, and every resource attached to it. A folder is not a
//! project — a project is a record that can span more than one folder or repo,
//! and that keeps its identity when a folder moves.
//!
//! # Two refusals inherited from the engine, both load-bearing
//!
//!  * **A resource must exist and be a directory.** `attach_local_resource`
//!    canonicalizes and checks; a path that is not there cannot be attached, so
//!    the record never claims a resource nobody can open.
//!  * **A scan never invents an IDE effect.** `ChangeCause` separates
//!    `IdeEffect { effect_id }` from `ExternalUnknown`, which is the same
//!    distinction the WORK-05 observer holds on the TS side.
//!
//! # And one omission, stated rather than faked
//!
//! Services and environments are NOT attachable resources here. The engine's
//! resource is a canonical local directory; a service is an endpoint and an
//! environment is a set of variables. Giving them a directory to satisfy the
//! schema would be inventing a fact — the §5 analysis already surfaces both WITH
//! provenance, and making them durable needs a resource kind that does not exist
//! yet. Named in the snapshot so the gap is visible instead of implied.

use ide_domain::{
    CreateProject, ProjectId, ProjectRecord, Resource, ResourceId, ResourceKind,
    SemanticProjectStore,
};
use serde::Serialize;
use std::path::Path;

/// Where the durable store lives: IDE runtime state, per project root.
const STORE_REL: &str = ".instrument/semantic.sqlite3";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    /// `None` when no durable project was registered for this root yet. NOT an
    /// error, and not something to create silently: registering is a human act
    /// that needs a title and an intent.
    pub project: Option<ProjectRecord>,
    pub resources: Vec<Resource>,
    /// Every durable project the store knows, so a person can see that opening a
    /// folder is not the same as choosing a project.
    pub all_projects: Vec<ProjectRecord>,
    pub store_path: String,
    /// Why this root has no project yet, when it has none.
    pub not_registered_reason: Option<String>,
    /// Capabilities this surface deliberately does not have yet.
    pub gaps: Vec<String>,
}

fn store(root: &Path) -> Result<SemanticProjectStore, String> {
    SemanticProjectStore::open(root.join(STORE_REL)).map_err(|error| format!("{error:#}"))
}

/// The project id for a root. Derived from the canonical path so reopening the
/// same folder finds the same record, and two folders never collide.
fn id_for(root: &Path) -> ProjectId {
    let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    ProjectId(format!("project:{}", canonical.to_string_lossy()))
}

fn gaps() -> Vec<String> {
    vec![
        "serviço e ambiente não são RECURSO durável — recurso do motor é diretório \
         canônico. Eles entram como REFERÊNCIA (endereço, sem caminho), no registro \
         de referências deste projeto; registrar declara dependência e não verifica \
         nada"
            .to_string(),
    ]
}

pub fn snapshot(root: &Path) -> Result<ProjectSnapshot, String> {
    let store = store(root)?;
    let id = id_for(root);
    let project = store
        .open_project(&id)
        .map_err(|error| format!("{error:#}"))?;
    let resources = match &project {
        Some(record) => store
            .resources_for_project(&record.id)
            .map_err(|error| format!("{error:#}"))?,
        None => Vec::new(),
    };
    let all_projects = store
        .list_projects()
        .map_err(|error| format!("{error:#}"))?;
    let not_registered_reason = if project.is_none() {
        Some(
            "esta pasta ainda não é um projeto durável — registrar pede um título e uma \
             intenção, e é ato de pessoa"
                .to_string(),
        )
    } else {
        None
    };
    Ok(ProjectSnapshot {
        not_registered_reason,
        project,
        resources,
        all_projects,
        store_path: STORE_REL.to_string(),
        gaps: gaps(),
    })
}

/// Registers the durable project for this root and attaches the root itself as
/// its first resource.
///
/// The root is attached because a project with no resource cannot be worked in,
/// and the folder that is open is unambiguously one of its resources. Every other
/// resource is attached explicitly.
pub fn register(root: &Path, title: &str, intent: &str) -> Result<ProjectSnapshot, String> {
    if title.trim().is_empty() || intent.trim().is_empty() {
        return Err(
            "projeto durável precisa de título e de intenção escrita — os dois são o que \
             sobrevive sem transcript"
                .to_string(),
        );
    }
    let store = store(root)?;
    let id = id_for(root);
    if store
        .open_project(&id)
        .map_err(|error| format!("{error:#}"))?
        .is_some()
    {
        return Err(format!("já existe projeto durável para {}", root.display()));
    }
    store
        .create_project(CreateProject {
            id: id.clone(),
            title: title.to_string(),
            intent: intent.to_string(),
        })
        .map_err(|error| format!("{error:#}"))?;
    attach(root, root.to_string_lossy().as_ref(), "directory")?;
    snapshot(root)
}

/// Attaches another local directory or repository to the durable project.
pub fn attach(root: &Path, path: &str, kind: &str) -> Result<ProjectSnapshot, String> {
    let kind = match kind {
        "repository" => ResourceKind::Repository,
        "directory" => ResourceKind::Directory,
        other => return Err(format!("tipo de recurso desconhecido: {other}")),
    };
    let store = store(root)?;
    let id = id_for(root);
    // Absolute paths are allowed here on purpose: a durable project spans more
    // than one folder, so a resource outside the open root is the point. What is
    // NOT allowed is a path that does not exist — the engine refuses that.
    let target = if Path::new(path).is_absolute() {
        Path::new(path).to_path_buf()
    } else {
        root.join(path)
    };
    let resource_id = ResourceId(format!(
        "resource:{}",
        std::fs::canonicalize(&target)
            .map_err(|error| format!("{}: {error}", target.display()))?
            .to_string_lossy()
    ));
    store
        .attach_local_resource(&id, resource_id, kind, &target)
        .map_err(|error| format!("{error:#}"))?;
    snapshot(root)
}

/// Rewrites the durable intent. The intent is the part that answers "what is this
/// project for" after every transcript is gone, so it is editable and versioned
/// by the store rather than derived from chat.
pub fn set_intent(root: &Path, intent: &str) -> Result<ProjectSnapshot, String> {
    if intent.trim().is_empty() {
        return Err(
            "intenção vazia apagaria a única coisa que sobrevive sem transcript".to_string(),
        );
    }
    let store = store(root)?;
    store
        .update_project_intent(&id_for(root), intent.to_string())
        .map_err(|error| format!("{error:#}"))?;
    snapshot(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    /// An unregistered folder is NOT a project, and says why rather than being
    /// registered silently.
    #[test]
    fn a_folder_is_not_a_project_until_somebody_registers_it() {
        let dir = project();

        let snapshot = snapshot(dir.path()).expect("snapshot");

        assert!(snapshot.project.is_none());
        assert!(snapshot.resources.is_empty());
        assert!(snapshot
            .not_registered_reason
            .as_deref()
            .unwrap()
            .contains("ato de pessoa"));
        assert_eq!(snapshot.store_path, ".instrument/semantic.sqlite3");
        assert_eq!(snapshot.gaps.len(), 1, "a lacuna de serviços fica dita");
    }

    /// Registering needs a title AND an intent: those are what survive without a
    /// transcript, so an empty one is refused.
    #[test]
    fn registering_requires_a_title_and_an_intent() {
        let dir = project();

        assert!(register(dir.path(), "", "algo").is_err());
        assert!(register(dir.path(), "Leilão", "   ").is_err());
        assert!(snapshot(dir.path()).unwrap().project.is_none());
    }

    /// Registering attaches the open folder, and reopening finds the same record
    /// with no transcript involved.
    #[test]
    fn reopening_recovers_the_project_without_a_transcript() {
        let dir = project();

        let after = register(dir.path(), "Leilão", "lances selados, sem vazar identidade")
            .expect("register");
        assert_eq!(after.project.as_ref().unwrap().title, "Leilão");
        assert_eq!(after.resources.len(), 1, "a pasta aberta é recurso");

        // A fresh read — a new store handle, like a restart.
        let reopened = snapshot(dir.path()).expect("snapshot");
        assert_eq!(
            reopened.project.as_ref().unwrap().intent,
            "lances selados, sem vazar identidade"
        );
        assert_eq!(reopened.resources.len(), 1);
        assert!(reopened.not_registered_reason.is_none());
    }

    /// Registering twice is refused instead of quietly creating a second record
    /// for the same folder.
    #[test]
    fn registering_twice_is_refused() {
        let dir = project();
        register(dir.path(), "Leilão", "intenção").expect("register");

        let error = register(dir.path(), "Outro", "outra").expect_err("recusa");

        assert!(error.contains("já existe projeto durável"), "{error}");
    }

    /// A project spans more than one folder: a second directory attaches, and a
    /// path that does not exist is refused by the engine.
    #[test]
    fn a_project_spans_more_than_one_folder() {
        let dir = project();
        let other = project();
        register(dir.path(), "Leilão", "intenção").expect("register");

        let after =
            attach(dir.path(), other.path().to_str().unwrap(), "repository").expect("attach");
        assert_eq!(after.resources.len(), 2);

        assert!(
            attach(dir.path(), "/nao/existe/em/lugar/nenhum", "directory").is_err(),
            "recurso que não existe não pode ser prometido no registro"
        );
        assert!(
            attach(dir.path(), ".", "servico").is_err(),
            "tipo desconhecido"
        );
    }

    /// The intent is editable, and clearing it is refused: it is the one field
    /// that answers "what is this for" after the transcript is gone.
    #[test]
    fn the_intent_is_editable_but_not_erasable() {
        let dir = project();
        register(dir.path(), "Leilão", "primeira intenção").expect("register");

        let after = set_intent(dir.path(), "segunda intenção").expect("set_intent");
        assert_eq!(after.project.unwrap().intent, "segunda intenção");

        assert!(set_intent(dir.path(), "  ").is_err());
    }
}
