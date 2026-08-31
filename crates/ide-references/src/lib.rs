//! Non-filesystem project references: services and environments.
//!
//! A project links repositories and directories as filesystem resources, but it
//! also needs to link things that are not directories — a running service or a
//! deployment environment. Those are reference-only: they carry a name and an
//! endpoint, never a canonical path, so they do not go through the workspace
//! broker or watcher. A reference is shared by id, so the same service can belong
//! to several projects without duplication.

use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceKind {
    Service,
    Environment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectReference {
    pub id: String,
    pub kind: ReferenceKind,
    pub name: String,
    /// An endpoint/URL/label; deliberately not a filesystem path.
    pub endpoint: String,
    /// Projects that link this reference. Shared, so no duplication.
    pub projects: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ReferencesSnapshot {
    entries: Vec<ProjectReference>,
}

pub struct ReferenceRegistry {
    path: PathBuf,
    entries: BTreeMap<String, ProjectReference>,
}

impl ReferenceRegistry {
    pub fn open(root: impl AsRef<Path>) -> anyhow::Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root)
            .with_context(|| format!("create references directory {}", root.display()))?;
        let path = root.join("references.json");
        let snapshot = if path.exists() {
            let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
            serde_json::from_slice::<ReferencesSnapshot>(&bytes)
                .with_context(|| format!("parse {}", path.display()))?
        } else {
            ReferencesSnapshot::default()
        };
        let entries = snapshot
            .entries
            .into_iter()
            .map(|entry| (entry.id.clone(), entry))
            .collect();
        Ok(Self { path, entries })
    }

    /// Links a reference to a project, creating it on first use and reusing it
    /// (no duplication) when the id already exists.
    pub fn link(
        &mut self,
        id: &str,
        kind: ReferenceKind,
        name: &str,
        endpoint: &str,
        project_id: &str,
    ) -> anyhow::Result<ProjectReference> {
        let entry = self
            .entries
            .entry(id.to_owned())
            .or_insert_with(|| ProjectReference {
                id: id.to_owned(),
                kind,
                name: name.to_owned(),
                endpoint: endpoint.to_owned(),
                projects: Vec::new(),
            });
        if !entry.projects.iter().any(|linked| linked == project_id) {
            entry.projects.push(project_id.to_owned());
        }
        let linked = entry.clone();
        self.persist()?;
        Ok(linked)
    }

    pub fn for_project(&self, project_id: &str) -> Vec<ProjectReference> {
        self.entries
            .values()
            .filter(|entry| entry.projects.iter().any(|linked| linked == project_id))
            .cloned()
            .collect()
    }

    pub fn unlink(&mut self, id: &str, project_id: &str) -> anyhow::Result<()> {
        if let Some(entry) = self.entries.get_mut(id) {
            entry.projects.retain(|linked| linked != project_id);
        }
        self.persist()
    }

    fn persist(&self) -> anyhow::Result<()> {
        let snapshot = ReferencesSnapshot {
            entries: self.entries.values().cloned().collect(),
        };
        let json = serde_json::to_vec_pretty(&snapshot)?;
        fs::write(&self.path, json).with_context(|| format!("write {}", self.path.display()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ide-references-{tag}-{}", std::process::id()))
    }

    #[test]
    fn a_reference_is_shared_across_projects_without_duplication() {
        let root = temp_root("share");
        let _ = fs::remove_dir_all(&root);
        let mut registry = ReferenceRegistry::open(&root).unwrap();
        registry
            .link(
                "svc:api",
                ReferenceKind::Service,
                "API",
                "https://api.local",
                "p1",
            )
            .unwrap();
        registry
            .link(
                "svc:api",
                ReferenceKind::Service,
                "API",
                "https://api.local",
                "p2",
            )
            .unwrap();
        // One entry, linked to both projects.
        assert_eq!(registry.for_project("p1").len(), 1);
        assert_eq!(registry.for_project("p2").len(), 1);
        assert_eq!(registry.for_project("p1")[0].projects.len(), 2);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn environment_reference_has_no_filesystem_path() {
        let root = temp_root("env");
        let _ = fs::remove_dir_all(&root);
        let mut registry = ReferenceRegistry::open(&root).unwrap();
        let reference = registry
            .link(
                "env:prod",
                ReferenceKind::Environment,
                "Prod",
                "https://prod",
                "p1",
            )
            .unwrap();
        assert_eq!(reference.kind, ReferenceKind::Environment);
        assert_eq!(reference.endpoint, "https://prod");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn unlink_removes_only_the_project_link() {
        let root = temp_root("unlink");
        let _ = fs::remove_dir_all(&root);
        let mut registry = ReferenceRegistry::open(&root).unwrap();
        registry
            .link("svc:api", ReferenceKind::Service, "API", "e", "p1")
            .unwrap();
        registry.unlink("svc:api", "p1").unwrap();
        assert!(registry.for_project("p1").is_empty());
        fs::remove_dir_all(&root).unwrap();
    }
}
