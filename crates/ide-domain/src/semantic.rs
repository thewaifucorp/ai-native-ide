//! Durable semantic-project storage.
//!
//! The SQLite ledger indexes a semantic project above repositories and sessions.  It
//! deliberately stores stable resource identities separately from local paths: paths are
//! locators, while project membership and session scope are references.  Files remain the
//! editable implementation; this ledger records observations and never claims they belong
//! to a chat.

use crate::{ProjectId, ResourceId, SessionId};
use anyhow::{bail, Context};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

/// A named product context.  It is deliberately independent from repository and session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectRecord {
    pub id: ProjectId,
    pub title: String,
    pub intent: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateProject {
    pub id: ProjectId,
    pub title: String,
    pub intent: String,
}

/// The host can extend this later without treating an arbitrary filesystem path as a repo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    Directory,
    Repository,
}

impl ResourceKind {
    fn as_db(self) -> &'static str {
        match self {
            Self::Directory => "directory",
            Self::Repository => "repository",
        }
    }

    fn from_db(value: &str) -> anyhow::Result<Self> {
        match value {
            "directory" => Ok(Self::Directory),
            "repository" => Ok(Self::Repository),
            other => bail!("unknown resource kind in semantic store: {other}"),
        }
    }
}

/// Stable resource identity plus the currently usable canonical local locator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resource {
    pub id: ResourceId,
    pub kind: ResourceKind,
    pub canonical_path: PathBuf,
    pub created_at_ms: i64,
}

/// A content-addressed observed file state. `relative_path` is always relative to a resource.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceRevision {
    pub id: String,
    pub resource_id: ResourceId,
    pub relative_path: PathBuf,
    pub content_hash: String,
    pub observed_at_ms: i64,
    pub cause: ChangeCause,
}

/// Causation is explicit. A filesystem scan must never invent an IDE effect ID.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChangeCause {
    InitialDiscovery,
    IdeEffect { effect_id: String },
    ExternalUnknown,
}

impl ChangeCause {
    fn as_db(&self) -> (&'static str, Option<&str>) {
        match self {
            Self::InitialDiscovery => ("initial_discovery", None),
            Self::IdeEffect { effect_id } => ("ide_effect", Some(effect_id)),
            Self::ExternalUnknown => ("external_unknown", None),
        }
    }

    fn from_db(kind: &str, effect_id: Option<String>) -> anyhow::Result<Self> {
        match kind {
            "initial_discovery" => Ok(Self::InitialDiscovery),
            "ide_effect" => Ok(Self::IdeEffect {
                effect_id: effect_id.context("ide revision missing effect id")?,
            }),
            "external_unknown" => Ok(Self::ExternalUnknown),
            other => bail!("unknown revision cause in semantic store: {other}"),
        }
    }
}

/// A temporal work episode that references resources but can never own their files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionScope {
    pub id: SessionId,
    pub project_id: ProjectId,
    pub resource_ids: Vec<ResourceId>,
    pub created_at_ms: i64,
}

/// Local SQLite semantic graph/index. It intentionally opens short-lived connections so a
/// desktop host can call it from synchronous or asynchronous command handlers safely.
#[derive(Debug, Clone)]
pub struct SemanticProjectStore {
    database_path: PathBuf,
}

impl SemanticProjectStore {
    pub fn open(database_path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let database_path = database_path.as_ref().to_path_buf();
        if let Some(parent) = database_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create semantic data dir {}", parent.display()))?;
        }
        let store = Self { database_path };
        store.connect()?;
        Ok(store)
    }

    pub fn create_project(&self, input: CreateProject) -> anyhow::Result<ProjectRecord> {
        validate_text("project title", &input.title)?;
        validate_text("project intent", &input.intent)?;
        let now = now_ms();
        let conn = self.connect()?;
        conn.execute(
            "INSERT INTO semantic_projects (id, title, intent, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![input.id.0, input.title, input.intent, now],
        )
        .context("create semantic project")?;
        Ok(self.project_from_connection(&conn, &input.id)?)
    }

    pub fn open_project(&self, project_id: &ProjectId) -> anyhow::Result<Option<ProjectRecord>> {
        Ok(self
            .project_from_connection(&self.connect()?, project_id)
            .optional()?)
    }

    /// Associates an existing directory/repository with a project. A canonical locator is
    /// deduplicated globally, so the same resource can safely belong to other projects.
    pub fn attach_local_resource(
        &self,
        project_id: &ProjectId,
        resource_id: ResourceId,
        kind: ResourceKind,
        path: impl AsRef<Path>,
    ) -> anyhow::Result<Resource> {
        let canonical_path = fs::canonicalize(path.as_ref()).with_context(|| {
            format!("resource path does not exist: {}", path.as_ref().display())
        })?;
        if !canonical_path.is_dir() {
            bail!(
                "resource root must be a directory: {}",
                canonical_path.display()
            );
        }
        let mut conn = self.connect()?;
        let tx = conn.transaction()?;
        ensure_project_exists(&tx, project_id)?;

        let existing: Option<(String, String, i64)> = tx
            .query_row(
                "SELECT id, kind, created_at_ms FROM semantic_resources WHERE canonical_path = ?1",
                params![canonical_path.to_string_lossy().as_ref()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let resource = match existing {
            Some((id, stored_kind, created_at_ms)) => {
                if id != resource_id.0 {
                    bail!("resource locator already has stable id {id}; do not duplicate it")
                }
                Resource {
                    id: resource_id,
                    kind: ResourceKind::from_db(&stored_kind)?,
                    canonical_path,
                    created_at_ms,
                }
            }
            None => {
                let now = now_ms();
                tx.execute(
                    "INSERT INTO semantic_resources (id, kind, canonical_path, created_at_ms) VALUES (?1, ?2, ?3, ?4)",
                    params![resource_id.0, kind.as_db(), canonical_path.to_string_lossy().as_ref(), now],
                )?;
                Resource {
                    id: resource_id,
                    kind,
                    canonical_path,
                    created_at_ms: now,
                }
            }
        };
        tx.execute(
            "INSERT OR IGNORE INTO project_resources (project_id, resource_id, attached_at_ms) VALUES (?1, ?2, ?3)",
            params![project_id.0, resource.id.0, now_ms()],
        )?;
        tx.execute(
            "UPDATE semantic_projects SET updated_at_ms = ?2 WHERE id = ?1",
            params![project_id.0, now_ms()],
        )?;
        tx.commit()?;

        // Establish a baseline after attachment. It creates revisions but no activity because
        // the IDE has not observed an external mutation yet.
        self.capture_resource_snapshot(&resource, ChangeCause::InitialDiscovery, false)?;
        Ok(resource)
    }

    pub fn resources_for_project(&self, project_id: &ProjectId) -> anyhow::Result<Vec<Resource>> {
        let conn = self.connect()?;
        let mut statement = conn.prepare(
            "SELECT r.id, r.kind, r.canonical_path, r.created_at_ms
             FROM semantic_resources r JOIN project_resources p ON p.resource_id = r.id
             WHERE p.project_id = ?1 ORDER BY r.created_at_ms, r.id",
        )?;
        let resources = statement
            .query_map(params![project_id.0], row_to_resource)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(anyhow::Error::from)?;
        Ok(resources)
    }

    pub fn create_session_scope(
        &self,
        session_id: SessionId,
        project_id: &ProjectId,
        resource_ids: &[ResourceId],
    ) -> anyhow::Result<SessionScope> {
        let conn = self.connect()?;
        ensure_project_exists(&conn, project_id)?;
        let scope = if resource_ids.is_empty() {
            self.resources_for_project(project_id)?
                .into_iter()
                .map(|resource| resource.id)
                .collect()
        } else {
            resource_ids.to_vec()
        };
        if scope.is_empty() {
            bail!(
                "a session requires at least one resource; attach a directory or repository first"
            )
        }
        for resource_id in &scope {
            let attached: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM project_resources WHERE project_id = ?1 AND resource_id = ?2)",
                params![project_id.0, resource_id.0],
                |row| row.get(0),
            )?;
            if !attached {
                bail!(
                    "resource {} is outside project {} scope",
                    resource_id.0,
                    project_id.0
                );
            }
        }
        let now = now_ms();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO semantic_sessions (id, project_id, created_at_ms) VALUES (?1, ?2, ?3)",
            params![session_id.0, project_id.0, now],
        )?;
        for resource_id in &scope {
            tx.execute(
                "INSERT INTO session_resources (session_id, resource_id) VALUES (?1, ?2)",
                params![session_id.0, resource_id.0],
            )?;
        }
        tx.commit()?;
        Ok(SessionScope {
            id: session_id,
            project_id: project_id.clone(),
            resource_ids: scope,
            created_at_ms: now,
        })
    }

    pub fn open_session_scope(
        &self,
        session_id: &SessionId,
    ) -> anyhow::Result<Option<SessionScope>> {
        let conn = self.connect()?;
        let row: Option<(String, i64)> = conn
            .query_row(
                "SELECT project_id, created_at_ms FROM semantic_sessions WHERE id = ?1",
                params![session_id.0],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((project_id, created_at_ms)) = row else {
            return Ok(None);
        };
        let mut statement = conn.prepare(
            "SELECT resource_id FROM session_resources WHERE session_id = ?1 ORDER BY resource_id",
        )?;
        let resource_ids = statement
            .query_map(params![session_id.0], |row| Ok(ResourceId(row.get(0)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(SessionScope {
            id: session_id.clone(),
            project_id: ProjectId(project_id),
            resource_ids,
            created_at_ms,
        }))
    }

    /// Reads only a declared resource-relative file. UI supplied paths never gain authority.
    pub fn read_resource_file(
        &self,
        resource_id: &ResourceId,
        relative_path: impl AsRef<Path>,
    ) -> anyhow::Result<Vec<u8>> {
        let resource = self.resource(resource_id)?.context("unknown resource")?;
        let path = resolve_scoped_existing_path(&resource.canonical_path, relative_path.as_ref())?;
        fs::read(&path).with_context(|| format!("read declared resource file {}", path.display()))
    }

    /// Re-scans one resource and emits a causal activity for every changed or deleted file.
    /// Files created through a future privileged effect broker should use
    /// `record_ide_revision` instead, so causation remains honest.
    pub fn detect_external_changes(
        &self,
        resource_id: &ResourceId,
    ) -> anyhow::Result<Vec<ResourceRevision>> {
        let resource = self.resource(resource_id)?.context("unknown resource")?;
        self.capture_resource_snapshot(&resource, ChangeCause::ExternalUnknown, true)
    }

    /// Lets the privileged workspace broker attribute a post-effect observation to its exact
    /// approved effect. It never writes files and therefore cannot bypass that broker.
    pub fn record_ide_revision(
        &self,
        resource_id: &ResourceId,
        relative_path: impl AsRef<Path>,
        effect_id: impl Into<String>,
    ) -> anyhow::Result<Option<ResourceRevision>> {
        let resource = self.resource(resource_id)?.context("unknown resource")?;
        let relative_path = clean_relative_path(relative_path.as_ref())?;
        let absolute = resolve_scoped_existing_path(&resource.canonical_path, &relative_path)?;
        self.record_file_if_changed(
            &resource,
            &relative_path,
            &absolute,
            ChangeCause::IdeEffect {
                effect_id: effect_id.into(),
            },
            true,
        )
    }

    pub fn revisions_for_resource(
        &self,
        resource_id: &ResourceId,
    ) -> anyhow::Result<Vec<ResourceRevision>> {
        let conn = self.connect()?;
        let mut statement = conn.prepare(
            "SELECT id, relative_path, content_hash, observed_at_ms, cause_kind, effect_id
             FROM resource_revisions WHERE resource_id = ?1 ORDER BY observed_at_ms, id",
        )?;
        let revisions = statement
            .query_map(params![resource_id.0], |row| {
                Ok(ResourceRevision {
                    id: row.get(0)?,
                    resource_id: resource_id.clone(),
                    relative_path: PathBuf::from(row.get::<_, String>(1)?),
                    content_hash: row.get(2)?,
                    observed_at_ms: row.get(3)?,
                    cause: change_cause_from_row(&row.get::<_, String>(4)?, row.get(5)?)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(anyhow::Error::from)?;
        Ok(revisions)
    }

    fn resource(&self, resource_id: &ResourceId) -> anyhow::Result<Option<Resource>> {
        self.connect()?.query_row(
            "SELECT id, kind, canonical_path, created_at_ms FROM semantic_resources WHERE id = ?1",
            params![resource_id.0], row_to_resource,
        ).optional().map_err(Into::into)
    }

    fn project_from_connection(
        &self,
        conn: &Connection,
        project_id: &ProjectId,
    ) -> rusqlite::Result<ProjectRecord> {
        conn.query_row(
            "SELECT id, title, intent, created_at_ms, updated_at_ms FROM semantic_projects WHERE id = ?1",
            params![project_id.0],
            |row| Ok(ProjectRecord { id: ProjectId(row.get(0)?), title: row.get(1)?, intent: row.get(2)?, created_at_ms: row.get(3)?, updated_at_ms: row.get(4)? }),
        )
    }

    fn capture_resource_snapshot(
        &self,
        resource: &Resource,
        cause: ChangeCause,
        emit_activity: bool,
    ) -> anyhow::Result<Vec<ResourceRevision>> {
        let files = listed_files(&resource.canonical_path)?;
        let mut changed = Vec::new();
        for (relative_path, absolute) in files {
            if let Some(revision) = self.record_file_if_changed(
                resource,
                &relative_path,
                &absolute,
                cause.clone(),
                emit_activity,
            )? {
                changed.push(revision);
            }
        }
        if emit_activity {
            let current: BTreeMap<_, _> = listed_files(&resource.canonical_path)?
                .into_iter()
                .map(|(relative, _)| (relative.to_string_lossy().into_owned(), ()))
                .collect();
            let conn = self.connect()?;
            let mut statement = conn.prepare("SELECT relative_path, content_hash FROM resource_file_state WHERE resource_id = ?1")?;
            let missing = statement
                .query_map(params![resource.id.0], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (relative, previous_hash) in missing
                .into_iter()
                .filter(|(relative, _)| !current.contains_key(relative))
            {
                let revision = self.insert_revision(
                    resource,
                    Path::new(&relative),
                    &format!("deleted:{previous_hash}"),
                    ChangeCause::ExternalUnknown,
                    true,
                )?;
                conn.execute(
                    "DELETE FROM resource_file_state WHERE resource_id = ?1 AND relative_path = ?2",
                    params![resource.id.0, relative],
                )?;
                changed.push(revision);
            }
        }
        Ok(changed)
    }

    fn record_file_if_changed(
        &self,
        resource: &Resource,
        relative_path: &Path,
        absolute: &Path,
        cause: ChangeCause,
        emit_activity: bool,
    ) -> anyhow::Result<Option<ResourceRevision>> {
        let content = fs::read(absolute)
            .with_context(|| format!("read observed file {}", absolute.display()))?;
        let hash = hex_digest(&content);
        let relative = relative_path.to_string_lossy();
        let conn = self.connect()?;
        let previous: Option<String> = conn.query_row(
            "SELECT content_hash FROM resource_file_state WHERE resource_id = ?1 AND relative_path = ?2",
            params![resource.id.0, relative.as_ref()], |row| row.get(0),
        ).optional()?;
        if previous.as_deref() == Some(&hash) {
            return Ok(None);
        }
        let revision =
            self.insert_revision(resource, relative_path, &hash, cause, emit_activity)?;
        conn.execute(
            "INSERT INTO resource_file_state (resource_id, relative_path, content_hash) VALUES (?1, ?2, ?3)
             ON CONFLICT(resource_id, relative_path) DO UPDATE SET content_hash = excluded.content_hash",
            params![resource.id.0, relative.as_ref(), hash],
        )?;
        Ok(Some(revision))
    }

    fn insert_revision(
        &self,
        resource: &Resource,
        relative_path: &Path,
        content_hash: &str,
        cause: ChangeCause,
        emit_activity: bool,
    ) -> anyhow::Result<ResourceRevision> {
        let id = format!(
            "revision:{}:{}",
            now_ms(),
            hex_digest(format!("{}:{content_hash}", relative_path.display()).as_bytes())
        );
        let observed_at_ms = now_ms();
        let (cause_kind, effect_id) = cause.as_db();
        let conn = self.connect()?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO resource_revisions (id, resource_id, relative_path, content_hash, observed_at_ms, cause_kind, effect_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, resource.id.0, relative_path.to_string_lossy().as_ref(), content_hash, observed_at_ms, cause_kind, effect_id],
        )?;
        if emit_activity {
            tx.execute(
                "INSERT INTO semantic_activities (id, resource_id, revision_id, kind, cause_kind, effect_id, created_at_ms)
                 VALUES (?1, ?2, ?3, 'resource_revision_observed', ?4, ?5, ?6)",
                params![format!("activity:{id}"), resource.id.0, id, cause_kind, effect_id, observed_at_ms],
            )?;
        }
        tx.commit()?;
        Ok(ResourceRevision {
            id,
            resource_id: resource.id.clone(),
            relative_path: relative_path.to_path_buf(),
            content_hash: content_hash.to_owned(),
            observed_at_ms,
            cause,
        })
    }

    fn connect(&self) -> anyhow::Result<Connection> {
        let conn = Connection::open(&self.database_path)
            .with_context(|| format!("open semantic database {}", self.database_path.display()))?;
        conn.execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS semantic_projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, intent TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS semantic_resources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, canonical_path TEXT NOT NULL UNIQUE, created_at_ms INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS project_resources (project_id TEXT NOT NULL REFERENCES semantic_projects(id) ON DELETE CASCADE, resource_id TEXT NOT NULL REFERENCES semantic_resources(id) ON DELETE RESTRICT, attached_at_ms INTEGER NOT NULL, PRIMARY KEY(project_id, resource_id));
             CREATE TABLE IF NOT EXISTS semantic_sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES semantic_projects(id) ON DELETE CASCADE, created_at_ms INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS session_resources (session_id TEXT NOT NULL REFERENCES semantic_sessions(id) ON DELETE CASCADE, resource_id TEXT NOT NULL REFERENCES semantic_resources(id) ON DELETE RESTRICT, PRIMARY KEY(session_id, resource_id));
             CREATE TABLE IF NOT EXISTS resource_file_state (resource_id TEXT NOT NULL REFERENCES semantic_resources(id) ON DELETE CASCADE, relative_path TEXT NOT NULL, content_hash TEXT NOT NULL, PRIMARY KEY(resource_id, relative_path));
             CREATE TABLE IF NOT EXISTS resource_revisions (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES semantic_resources(id) ON DELETE CASCADE, relative_path TEXT NOT NULL, content_hash TEXT NOT NULL, observed_at_ms INTEGER NOT NULL, cause_kind TEXT NOT NULL, effect_id TEXT);
             CREATE TABLE IF NOT EXISTS semantic_activities (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES semantic_resources(id) ON DELETE CASCADE, revision_id TEXT NOT NULL REFERENCES resource_revisions(id) ON DELETE CASCADE, kind TEXT NOT NULL, cause_kind TEXT NOT NULL, effect_id TEXT, created_at_ms INTEGER NOT NULL);",
        )?;
        Ok(conn)
    }
}

fn ensure_project_exists(conn: &Connection, project_id: &ProjectId) -> anyhow::Result<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM semantic_projects WHERE id = ?1)",
        params![project_id.0],
        |row| row.get(0),
    )?;
    if !exists {
        bail!("unknown project {}", project_id.0)
    }
    Ok(())
}

fn row_to_resource(row: &rusqlite::Row<'_>) -> rusqlite::Result<Resource> {
    let kind: String = row.get(1)?;
    let kind = ResourceKind::from_db(&kind).map_err(|_| rusqlite::Error::InvalidQuery)?;
    Ok(Resource {
        id: ResourceId(row.get(0)?),
        kind,
        canonical_path: PathBuf::from(row.get::<_, String>(2)?),
        created_at_ms: row.get(3)?,
    })
}

fn change_cause_from_row(kind: &str, effect_id: Option<String>) -> rusqlite::Result<ChangeCause> {
    ChangeCause::from_db(kind, effect_id).map_err(|_| rusqlite::Error::InvalidQuery)
}

fn listed_files(root: &Path) -> anyhow::Result<Vec<(PathBuf, PathBuf)>> {
    let mut files = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let absolute = entry.path().to_path_buf();
        let relative = absolute
            .strip_prefix(root)
            .context("walked file escaped resource root")?
            .to_path_buf();
        files.push((relative, absolute));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(files)
}

fn resolve_scoped_existing_path(root: &Path, relative_path: &Path) -> anyhow::Result<PathBuf> {
    let relative_path = clean_relative_path(relative_path)?;
    let candidate = root.join(relative_path);
    let canonical = fs::canonicalize(&candidate)
        .with_context(|| format!("resource file does not exist: {}", candidate.display()))?;
    if !canonical.starts_with(root) {
        bail!("resource path escapes declared root")
    }
    Ok(canonical)
}

fn clean_relative_path(path: &Path) -> anyhow::Result<PathBuf> {
    if path.is_absolute() {
        bail!("resource path must be relative")
    }
    if path.as_os_str().is_empty() {
        bail!("resource path must not be empty")
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        bail!("resource path traversal is not allowed")
    }
    Ok(path.to_path_buf())
}

fn validate_text(label: &str, value: &str) -> anyhow::Result<()> {
    if value.trim().is_empty() {
        bail!("{label} must not be empty")
    }
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn hex_digest(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}
