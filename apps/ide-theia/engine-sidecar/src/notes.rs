//! §7 — notes by theme, and reconciliation across notes, guidance and SoTs.
//!
//! `ide_notes` is the engine: the note model, the lifecycle (open → resolved, or
//! superseded BY another note, both requiring a reason) and the deterministic
//! conflict comparison. It reads no filesystem and it decides nothing.
//!
//! This module is the half that observes the world the conflicts are checked
//! against: which files exist, which SoTs and references are declared, which
//! guidance is ACTIVE (from §13's library), and which statements forbid a literal
//! text (from §3's `absent-in-file` claims — the same source §8 uses for
//! contradictions in an intent).
//!
//! # Why "conciliar" here is a comparison, never a merge
//!
//! Every conflict is something a person can redo by reading two notes. Promotion,
//! merge and discard are separate, explicit acts:
//!
//!  * **promote** — the note becomes a guidance CANDIDATE in §13's library, which
//!    still needs the promotion there before it steers anything. Two steps, and
//!    the note records which artifact it produced.
//!  * **merge** — a NEW note is written and both originals are superseded by it,
//!    each with the reason. Nothing is edited in place, so the history reads.
//!  * **discard** — the note is superseded or resolved with a reason. Never
//!    deleted: a decision nobody can find the reasoning for is how the same
//!    argument happens twice.
//!
//! # Where notes live
//!
//! `.notes/` at the project root, versioned, with a Markdown file per theme —
//! same regime as `.guidance/` and for the same reason: this is the project's own
//! thinking, and it belongs in its history. It does not cross the broker, because
//! the text is what the person just typed.

use ide_notes::{
    conflicts, ForbiddenStatement, KnownWorld, Note, NoteConflict, NoteDraft, NoteKind, NoteLink,
    NoteStore,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const NOTES_REL: &str = ".notes";
const SOT_DIR: &str = ".product/sot";

/// Directories never walked when collecting the files a note may link to.
const SKIP_DIRS: [&str; 10] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    "lib",
    "src-gen",
    ".instrument",
    ".aag",
    "out",
    "build",
];

const MAX_FILES: usize = 800;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesSnapshot {
    pub notes: Vec<Note>,
    pub conflicts: Vec<NoteConflict>,
    /// Themes present, so the surface can group without re-deriving.
    pub themes: Vec<String>,
    /// What the conflict check was run against — an empty conflict list is only
    /// meaningful if you can see what was compared.
    pub known: KnownWorld,
    pub notes_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRequest {
    pub theme: String,
    /// `proposal`, `decision`, `question` or `alternative`.
    pub kind: String,
    pub subject: String,
    pub text: String,
    #[serde(default)]
    pub links: Vec<NoteLink>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn notes_root(root: &Path) -> PathBuf {
    root.join(NOTES_REL)
}

fn store(root: &Path) -> Result<NoteStore, String> {
    NoteStore::open(notes_root(root)).map_err(|error| format!("{error:#}"))
}

fn kind_of(value: &str) -> Result<NoteKind, String> {
    match value {
        "proposal" => Ok(NoteKind::Proposal),
        "decision" => Ok(NoteKind::Decision),
        "question" => Ok(NoteKind::Question),
        "alternative" => Ok(NoteKind::Alternative),
        // No default: the kind is what makes a note comparable with the right
        // other notes, so guessing it would fake the comparison.
        other => Err(format!("tipo de nota desconhecido: {other}")),
    }
}

/// Project files a note may link to, bounded and reported as bounded.
fn project_files(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with(".notes") {
                    stack.push(path);
                }
                continue;
            }
            if out.len() >= MAX_FILES {
                return out;
            }
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().into_owned());
            }
        }
    }
    out
}

#[derive(serde::Deserialize)]
struct SotFile {
    id: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    claims: Vec<SotClaim>,
}

#[derive(serde::Deserialize)]
struct SotClaim {
    #[serde(default)]
    statement: String,
    #[serde(default)]
    check: Option<SotCheck>,
}

#[derive(serde::Deserialize)]
struct SotCheck {
    kind: String,
    #[serde(default)]
    pattern: String,
}

/// Observes the world the conflicts are checked against.
fn known_world(root: &Path) -> KnownWorld {
    let mut known = KnownWorld {
        files: project_files(root),
        ..KnownWorld::default()
    };

    // SoTs and the statements that forbid a literal text.
    if let Ok(entries) = std::fs::read_dir(root.join(SOT_DIR)) {
        let mut files: Vec<(String, String)> = entries
            .flatten()
            .filter(|entry| entry.path().extension().and_then(|e| e.to_str()) == Some("json"))
            .filter_map(|entry| {
                let raw = std::fs::read_to_string(entry.path()).ok()?;
                Some((entry.file_name().to_string_lossy().into_owned(), raw))
            })
            .collect();
        files.sort_by(|a, b| a.0.cmp(&b.0));
        for (name, raw) in files {
            let Ok(file) = serde_json::from_str::<SotFile>(&raw) else {
                continue;
            };
            known.sots.push(file.id.clone());
            for claim in file.claims {
                let Some(check) = claim.check else { continue };
                if check.kind != "absent-in-file" || check.pattern.trim().is_empty() {
                    continue;
                }
                known.forbidden.push(ForbiddenStatement {
                    source: file
                        .path
                        .clone()
                        .unwrap_or_else(|| format!("{SOT_DIR}/{name}")),
                    statement: claim.statement,
                    forbidden: check.pattern,
                });
            }
        }
    }

    // Guidance: known vs ACTIVE, from §13's library.
    if let Ok(registry) = ide_guidance::GuidanceRegistry::open(crate::library::library_root(root)) {
        for entry in registry.list() {
            known.known_guidance.push(entry.id.clone());
            if entry.state == ide_guidance::GuidanceState::Active {
                known.active_guidance.push(entry.id);
            }
        }
    }

    // References registered by §5.
    if let Ok(entries) = std::fs::read_dir(root.join(".product/references")) {
        for entry in entries.flatten() {
            if let Some(name) = entry.path().file_stem().and_then(|s| s.to_str()) {
                known.references.push(name.to_owned());
            }
        }
    }

    // Features and Tasks belong to §9, which does not exist yet. Left empty on
    // purpose: a note linking one is reported as dangling, which is true today
    // and stops being true when §9 lands.
    known
}

fn snapshot_from(root: &Path, store: &NoteStore) -> NotesSnapshot {
    let notes = store.list();
    let known = known_world(root);
    let mut themes: Vec<String> = notes.iter().map(|note| note.theme.clone()).collect();
    themes.sort();
    themes.dedup();
    NotesSnapshot {
        conflicts: conflicts(&notes, &known),
        notes,
        themes,
        known,
        notes_path: NOTES_REL.to_string(),
    }
}

pub fn snapshot(root: &Path) -> Result<NotesSnapshot, String> {
    let store = store(root)?;
    Ok(snapshot_from(root, &store))
}

pub fn create(root: &Path, request: NoteRequest) -> Result<NotesSnapshot, String> {
    let kind = kind_of(&request.kind)?;
    let mut store = store(root)?;
    store
        .create(
            NoteDraft {
                theme: request.theme,
                kind,
                subject: request.subject,
                text: request.text,
                links: request.links,
            },
            now_ms(),
        )
        .map_err(|error| format!("{error:#}"))?;
    Ok(snapshot_from(root, &store))
}

pub fn resolve(root: &Path, id: &str, reason: &str) -> Result<NotesSnapshot, String> {
    let mut store = store(root)?;
    store
        .resolve(id, reason, now_ms())
        .map_err(|error| format!("{error:#}"))?;
    Ok(snapshot_from(root, &store))
}

pub fn supersede(root: &Path, id: &str, by: &str, reason: &str) -> Result<NotesSnapshot, String> {
    let mut store = store(root)?;
    store
        .supersede(id, by, reason, now_ms())
        .map_err(|error| format!("{error:#}"))?;
    Ok(snapshot_from(root, &store))
}

pub fn link(root: &Path, id: &str, link: NoteLink) -> Result<NotesSnapshot, String> {
    let mut store = store(root)?;
    store
        .link(id, link, now_ms())
        .map_err(|error| format!("{error:#}"))?;
    Ok(snapshot_from(root, &store))
}

/// Merges two notes into a NEW one that supersedes both.
///
/// Nothing is edited in place: the merged text is a new note, and each original
/// records that it was superseded and why. Rewriting one of them and deleting the
/// other would leave a decision whose reasoning nobody can find.
pub fn merge(
    root: &Path,
    ids: &[String],
    theme: &str,
    subject: &str,
    text: &str,
    reason: &str,
) -> Result<NotesSnapshot, String> {
    if ids.len() < 2 {
        return Err("conciliar pede pelo menos duas notas".to_string());
    }
    if reason.trim().is_empty() {
        return Err("conciliar exige dizer por quê".to_string());
    }
    let mut store = store(root)?;
    for id in ids {
        if store.get(id).is_none() {
            return Err(format!("nota desconhecida: {id}"));
        }
    }
    // The merged note is a DECISION: merging is what settles an argument, and
    // filing the result as a proposal would leave the subject open.
    let merged = store
        .create(
            NoteDraft {
                theme: theme.to_string(),
                kind: NoteKind::Decision,
                subject: subject.to_string(),
                text: text.to_string(),
                links: Vec::new(),
            },
            now_ms(),
        )
        .map_err(|error| format!("{error:#}"))?;
    for id in ids {
        store
            .supersede(id, &merged.id, reason, now_ms())
            .map_err(|error| format!("{error:#}"))?;
    }
    Ok(snapshot_from(root, &store))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn write(root: &Path, rel: &str, body: &str) {
        let abs = root.join(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(abs, body).unwrap();
    }

    fn request(kind: &str, subject: &str, text: &str) -> NoteRequest {
        NoteRequest {
            theme: "desempate".to_string(),
            kind: kind.to_string(),
            subject: subject.to_string(),
            text: text.to_string(),
            links: Vec::new(),
        }
    }

    /// An empty project has no notes and says where they would live.
    #[test]
    fn an_empty_project_has_no_notes() {
        let dir = project();

        let snapshot = snapshot(dir.path()).expect("snapshot");

        assert!(snapshot.notes.is_empty());
        assert!(snapshot.conflicts.is_empty());
        assert_eq!(snapshot.notes_path, ".notes");
    }

    /// An unknown kind fails instead of being guessed: the kind is what decides
    /// which comparison the note takes part in.
    #[test]
    fn an_unknown_kind_is_refused() {
        let dir = project();

        let error =
            create(dir.path(), request("bilhete", "desempate", "algo")).expect_err("recusa");

        assert!(error.contains("tipo de nota desconhecido"), "{error}");
    }

    /// Two decisions disagreeing on one subject is found, and merging closes it
    /// by writing a NEW note that supersedes both.
    #[test]
    fn merging_two_disagreeing_decisions_supersedes_both() {
        let dir = project();
        let first = create(
            dir.path(),
            request("decision", "desempate", "vence o maior valor"),
        )
        .expect("nota")
        .notes[0]
            .id
            .clone();
        let snapshot = create(
            dir.path(),
            request("decision", "desempate", "vence o mais antigo"),
        )
        .expect("nota");
        let second = snapshot
            .notes
            .iter()
            .find(|note| note.id != first)
            .expect("segunda")
            .id
            .clone();
        assert!(!snapshot.conflicts.is_empty(), "as duas discordam");

        let after = merge(
            dir.path(),
            &[first.clone(), second.clone()],
            "desempate",
            "desempate",
            "vence o maior valor selado; empate exato é recusado",
            "conciliadas na revisão de hoje",
        )
        .expect("merge");

        assert_eq!(after.notes.len(), 3, "a conciliada é uma nota nova");
        for id in [first, second] {
            let old = after.notes.iter().find(|note| note.id == id).unwrap();
            assert_eq!(old.state, ide_notes::NoteState::Superseded);
            assert!(old.superseded_by.is_some(), "aponta a substituta");
            assert_eq!(
                old.state_reason.as_deref(),
                Some("conciliadas na revisão de hoje")
            );
        }
        assert!(
            after.conflicts.is_empty(),
            "com as duas substituídas, o conflito fecha: {:?}",
            after.conflicts
        );
    }

    /// Merging needs two notes and a reason.
    #[test]
    fn merging_needs_two_notes_and_a_reason() {
        let dir = project();
        let snapshot = create(dir.path(), request("decision", "desempate", "algo")).expect("nota");
        let id = snapshot.notes[0].id.clone();

        assert!(merge(
            dir.path(),
            std::slice::from_ref(&id),
            "t",
            "s",
            "x",
            "motivo"
        )
        .is_err());
        assert!(merge(
            dir.path(),
            &[id.clone(), "note-999".to_string()],
            "t",
            "s",
            "x",
            "m"
        )
        .is_err());
        assert!(merge(
            dir.path(),
            &[id, "note-999".to_string()],
            "t",
            "s",
            "x",
            "  "
        )
        .is_err());
    }

    /// A note that says what a SoT forbids collides with it, with both sides
    /// named — the same source §8 uses for intents.
    #[test]
    fn a_note_can_collide_with_a_declared_statement() {
        let dir = project();
        write(
            dir.path(),
            ".product/sot/intent.json",
            r#"{"id":"intent","path":"docs/product-intent.md",
                "claims":[{"id":"c1","statement":"Empate não pode ser resolvido por ordem de criação.",
                "check":{"kind":"absent-in-file","path":"src/auction.ts","pattern":"ordem de criação"}}]}"#,
        );

        let snapshot = create(
            dir.path(),
            request(
                "proposal",
                "desempate",
                "usar ordem de criação simplifica o código",
            ),
        )
        .expect("nota");

        assert!(snapshot.conflicts.iter().any(|conflict| matches!(
            conflict,
            NoteConflict::ContradictsDeclaration { source, .. }
                if source == "docs/product-intent.md"
        )));
        assert_eq!(
            snapshot.known.forbidden.len(),
            1,
            "a declaração usada fica visível"
        );
    }

    /// A link to a file that exists is fine; one that does not is dangling. And a
    /// Feature link is dangling today because §9 does not exist yet — true now,
    /// and it stops being true when §9 lands.
    #[test]
    fn links_are_checked_against_the_observed_project() {
        let dir = project();
        write(
            dir.path(),
            "src/auction.ts",
            "export const rank = () => [];",
        );
        let snapshot = create(
            dir.path(),
            request("proposal", "ranking", "mudar o ranking"),
        )
        .expect("nota");
        let id = snapshot.notes[0].id.clone();

        let with_good = link(
            dir.path(),
            &id,
            NoteLink::File("src/auction.ts".to_string()),
        )
        .expect("link");
        assert!(
            !with_good
                .conflicts
                .iter()
                .any(|conflict| matches!(conflict, NoteConflict::DanglingLink { .. })),
            "arquivo que existe não é ligação quebrada"
        );

        let with_feature =
            link(dir.path(), &id, NoteLink::Feature("F-1".to_string())).expect("link");
        assert!(with_feature.conflicts.iter().any(|conflict| matches!(
            conflict,
            NoteConflict::DanglingLink { link, .. } if link == "feature:F-1"
        )));
    }

    /// Notes group by theme, and the themes come back for the surface.
    #[test]
    fn themes_are_reported() {
        let dir = project();
        create(dir.path(), request("decision", "desempate", "a")).expect("nota");
        let mut other = request("question", "privacidade", "b");
        other.theme = "leaderboard".to_string();
        let snapshot = create(dir.path(), other).expect("nota");

        assert_eq!(snapshot.themes, vec!["desempate", "leaderboard"]);
    }

    /// Resolving needs a reason, and a resolved note stops taking part in
    /// conflicts — history does not conflict with the present.
    #[test]
    fn resolving_needs_a_reason_and_closes_the_comparison() {
        let dir = project();
        create(
            dir.path(),
            request("decision", "desempate", "vence o maior valor"),
        )
        .expect("nota");
        let snapshot = create(
            dir.path(),
            request("decision", "desempate", "vence o mais antigo"),
        )
        .expect("nota");
        let id = snapshot.notes[1].id.clone();
        assert!(!snapshot.conflicts.is_empty());

        assert!(
            resolve(dir.path(), &id, "  ").is_err(),
            "sem motivo, não fecha"
        );

        let after = resolve(
            dir.path(),
            &id,
            "descartada: contraria a intenção declarada",
        )
        .expect("resolve");
        assert!(after.conflicts.is_empty());
    }
}
