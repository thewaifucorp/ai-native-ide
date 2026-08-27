//! Notes by theme, and the deterministic reconciliation between them.
//!
//! A note is a piece of thinking somebody wrote down: a proposal, a decision, a
//! question, an alternative. It is linked to what it is about — a file, a source
//! of truth, a reference, a guidance, a feature, a task, a message — and it has a
//! lifecycle: open, resolved, or superseded BY another note.
//!
//! # What this crate refuses to do
//!
//! **It does not decide.** Every conflict it reports is a comparison anybody can
//! redo by reading two notes; nothing is promoted, merged or discarded here. The
//! functions that change state (`resolve`, `supersede`) require a reason, and
//! superseding requires naming the replacement — a note marked superseded with
//! nothing pointing forward hides what replaced it, which defeats the whole point
//! of keeping the old one.
//!
//! **It does not infer agreement.** Two notes are only reported as disagreeing
//! when they are decisions ON THE SAME SUBJECT with different text. Deciding that
//! two paragraphs mean the same thing needs a model, and a model's guess dressed
//! as a conflict would send people to reconcile things that never disagreed.
//!
//! **It reads no filesystem.** Whether a linked file or SoT exists is a fact the
//! host observes; it passes what exists via [`KnownWorld`], and a link pointing
//! outside it is reported as dangling rather than silently trusted.

use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// What kind of thinking the note holds.
///
/// `Superseded` is deliberately NOT here: being replaced is a state, not a kind.
/// A decision that was replaced is still a decision, and losing that would make
/// the history unreadable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteKind {
    Proposal,
    Decision,
    Question,
    Alternative,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteState {
    Open,
    Resolved,
    Superseded,
}

/// What a note is about. Ids are opaque: their owners are other subsystems, and
/// this crate never interprets them.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "id")]
pub enum NoteLink {
    Message(String),
    Reference(String),
    File(String),
    Sot(String),
    Guidance(String),
    Feature(String),
    Task(String),
}

impl NoteLink {
    /// Stable label for a link, for messages and for the Markdown mirror.
    pub fn label(&self) -> String {
        match self {
            Self::Message(id) => format!("mensagem:{id}"),
            Self::Reference(id) => format!("referência:{id}"),
            Self::File(path) => format!("arquivo:{path}"),
            Self::Sot(id) => format!("sot:{id}"),
            Self::Guidance(id) => format!("guidance:{id}"),
            Self::Feature(id) => format!("feature:{id}"),
            Self::Task(id) => format!("task:{id}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    /// Free-form grouping the person chose. One Markdown file per theme.
    pub theme: String,
    pub kind: NoteKind,
    /// WHAT the note is about, in the person's words. Two decisions sharing a
    /// subject are comparable; without it nothing here could find a conflict.
    pub subject: String,
    pub text: String,
    pub links: Vec<NoteLink>,
    pub state: NoteState,
    /// Set only when `state` is `Superseded`, and never empty then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    /// Why it was resolved or superseded. Required for both.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_reason: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDraft {
    pub theme: String,
    pub kind: NoteKind,
    pub subject: String,
    pub text: String,
    #[serde(default)]
    pub links: Vec<NoteLink>,
}

/// A statement the project declared, and the literal text it forbids.
///
/// Same shape §8 uses for intents, on purpose: a note that says what a source of
/// truth forbids is the same kind of collision as an intent that does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForbiddenStatement {
    pub source: String,
    pub statement: String,
    pub forbidden: String,
}

/// What the host observed to exist. A link outside this is dangling.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownWorld {
    pub files: Vec<String>,
    pub sots: Vec<String>,
    pub references: Vec<String>,
    /// Guidance ids that are ACTIVE. An archived or superseded guidance is known
    /// but not active, so a note leaning on it is stale rather than dangling.
    pub active_guidance: Vec<String>,
    pub known_guidance: Vec<String>,
    pub features: Vec<String>,
    pub tasks: Vec<String>,
    /// Declarations a note's text can literally contradict.
    pub forbidden: Vec<ForbiddenStatement>,
}

/// A comparison anybody can redo by reading the notes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum NoteConflict {
    /// Two OPEN decisions about the same subject, with different text.
    DecisionsDisagree {
        subject: String,
        note_ids: Vec<String>,
    },
    /// A note says, literally, what a declaration forbids.
    ContradictsDeclaration {
        note_id: String,
        source: String,
        forbidden: String,
        statement: String,
    },
    /// An open question about a subject that already has an open decision. Not a
    /// contradiction — an asymmetry: somebody decided while somebody else was
    /// still asking.
    QuestionOnDecidedSubject {
        subject: String,
        question_id: String,
        decision_id: String,
    },
    /// A link pointing at something the host did not observe.
    DanglingLink { note_id: String, link: String },
    /// A note leaning on guidance that exists but is not active any more.
    StaleGuidanceLink {
        note_id: String,
        guidance_id: String,
    },
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct NotesSnapshot {
    #[serde(default)]
    notes: Vec<Note>,
    #[serde(default)]
    next_seq: u64,
}

/// The note store. `notes.json` is the source of truth; one Markdown file per
/// theme is regenerated from it, so the human surface and the machine state never
/// disagree.
pub struct NoteStore {
    root: PathBuf,
    notes: BTreeMap<String, Note>,
    next_seq: u64,
}

impl NoteStore {
    pub fn open(root: impl AsRef<Path>) -> anyhow::Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root)
            .with_context(|| format!("create notes directory {}", root.display()))?;
        let path = root.join("notes.json");
        let snapshot = if path.exists() {
            let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
            serde_json::from_slice::<NotesSnapshot>(&bytes)
                .with_context(|| format!("parse {}", path.display()))?
        } else {
            NotesSnapshot::default()
        };
        Ok(Self {
            root,
            notes: snapshot
                .notes
                .into_iter()
                .map(|note| (note.id.clone(), note))
                .collect(),
            next_seq: snapshot.next_seq,
        })
    }

    pub fn list(&self) -> Vec<Note> {
        self.notes.values().cloned().collect()
    }

    pub fn get(&self, id: &str) -> Option<Note> {
        self.notes.get(id).cloned()
    }

    /// Writes a new note. `now_ms` is injected: this crate keeps no clock.
    pub fn create(&mut self, draft: NoteDraft, now_ms: u64) -> anyhow::Result<Note> {
        if draft.theme.trim().is_empty() {
            anyhow::bail!("a note needs a theme")
        }
        if draft.subject.trim().is_empty() {
            anyhow::bail!("a note needs a subject: without it nothing can be compared")
        }
        if draft.text.trim().is_empty() {
            anyhow::bail!("a note needs text")
        }
        let id = format!("note-{:06}", self.next_seq);
        self.next_seq += 1;
        let note = Note {
            id: id.clone(),
            theme: draft.theme,
            kind: draft.kind,
            subject: draft.subject,
            text: draft.text,
            links: draft.links,
            state: NoteState::Open,
            superseded_by: None,
            state_reason: None,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
        };
        self.notes.insert(id, note.clone());
        self.persist()?;
        Ok(note)
    }

    /// Closes a note with the reason it is closed.
    ///
    /// The reason is required: "resolved" with no account of how is the shape of a
    /// note nobody can learn anything from six months later.
    pub fn resolve(&mut self, id: &str, reason: &str, now_ms: u64) -> anyhow::Result<Note> {
        if reason.trim().is_empty() {
            anyhow::bail!("resolving a note requires saying how")
        }
        let note = self
            .notes
            .get_mut(id)
            .with_context(|| format!("unknown note {id}"))?;
        note.state = NoteState::Resolved;
        note.state_reason = Some(reason.to_owned());
        note.updated_at_ms = now_ms;
        let updated = note.clone();
        self.persist()?;
        Ok(updated)
    }

    /// Marks `id` superseded BY `by`, with a reason.
    ///
    /// Both are required, and `by` must exist and differ from `id`. A superseded
    /// note with nothing pointing forward is worse than a deleted one: it takes
    /// up space and answers nothing.
    pub fn supersede(
        &mut self,
        id: &str,
        by: &str,
        reason: &str,
        now_ms: u64,
    ) -> anyhow::Result<Note> {
        if id == by {
            anyhow::bail!("a note cannot supersede itself")
        }
        if reason.trim().is_empty() {
            anyhow::bail!("superseding a note requires a reason")
        }
        if !self.notes.contains_key(by) {
            anyhow::bail!("unknown replacement note {by}")
        }
        let note = self
            .notes
            .get_mut(id)
            .with_context(|| format!("unknown note {id}"))?;
        note.state = NoteState::Superseded;
        note.superseded_by = Some(by.to_owned());
        note.state_reason = Some(reason.to_owned());
        note.updated_at_ms = now_ms;
        let updated = note.clone();
        self.persist()?;
        Ok(updated)
    }

    /// Adds a link to an existing note. Re-adding the same link is a no-op.
    pub fn link(&mut self, id: &str, link: NoteLink, now_ms: u64) -> anyhow::Result<Note> {
        let note = self
            .notes
            .get_mut(id)
            .with_context(|| format!("unknown note {id}"))?;
        if !note.links.contains(&link) {
            note.links.push(link);
            note.links.sort();
            note.updated_at_ms = now_ms;
        }
        let updated = note.clone();
        self.persist()?;
        Ok(updated)
    }

    fn persist(&self) -> anyhow::Result<()> {
        let snapshot = NotesSnapshot {
            notes: self.notes.values().cloned().collect(),
            next_seq: self.next_seq,
        };
        fs::write(
            self.root.join("notes.json"),
            serde_json::to_vec_pretty(&snapshot)?,
        )
        .with_context(|| format!("write notes in {}", self.root.display()))?;
        self.write_markdown_mirror()
    }

    /// One Markdown file per theme, regenerated from the store.
    fn write_markdown_mirror(&self) -> anyhow::Result<()> {
        let mut by_theme: BTreeMap<&str, Vec<&Note>> = BTreeMap::new();
        for note in self.notes.values() {
            by_theme.entry(note.theme.as_str()).or_default().push(note);
        }
        for (theme, notes) in by_theme {
            let mut body = format!("# Notas — {theme}\n\n");
            for note in notes {
                body.push_str(&format!(
                    "## {} · {:?}\n\n- id: {}\n- estado: {:?}{}\n- ligações: {}\n{}\n{}\n\n",
                    note.subject,
                    note.kind,
                    note.id,
                    note.state,
                    note.superseded_by
                        .as_ref()
                        .map(|by| format!(" (substituída por {by})"))
                        .unwrap_or_default(),
                    if note.links.is_empty() {
                        "nenhuma".to_owned()
                    } else {
                        note.links
                            .iter()
                            .map(NoteLink::label)
                            .collect::<Vec<_>>()
                            .join(", ")
                    },
                    note.state_reason
                        .as_ref()
                        .map(|reason| format!("- motivo: {reason}"))
                        .unwrap_or_default(),
                    note.text,
                ));
            }
            let file = format!("{}.md", slug(theme));
            fs::write(self.root.join(&file), body)
                .with_context(|| format!("write notes theme {file}"))?;
        }
        Ok(())
    }
}

fn slug(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-').to_owned();
    if trimmed.is_empty() {
        "tema".to_owned()
    } else {
        trimmed
    }
}

/// Every conflict the notes and the observed world can prove, deterministically.
///
/// Only OPEN notes take part: a resolved or superseded note is history, and
/// history cannot be in conflict with the present — reporting it would send
/// people to reconcile decisions they already reconciled.
pub fn conflicts(notes: &[Note], known: &KnownWorld) -> Vec<NoteConflict> {
    let mut findings = Vec::new();
    let open: Vec<&Note> = notes
        .iter()
        .filter(|note| note.state == NoteState::Open)
        .collect();

    // Decisions that disagree: same subject, different text.
    let mut by_subject: BTreeMap<&str, Vec<&Note>> = BTreeMap::new();
    for note in open.iter().filter(|n| n.kind == NoteKind::Decision) {
        by_subject
            .entry(note.subject.as_str())
            .or_default()
            .push(note);
    }
    for (subject, decisions) in &by_subject {
        let mut texts: Vec<&str> = decisions.iter().map(|note| note.text.as_str()).collect();
        texts.sort();
        texts.dedup();
        if decisions.len() > 1 && texts.len() > 1 {
            let mut note_ids: Vec<String> = decisions.iter().map(|note| note.id.clone()).collect();
            note_ids.sort();
            findings.push(NoteConflict::DecisionsDisagree {
                subject: (*subject).to_owned(),
                note_ids,
            });
        }
    }

    // An open question about a subject that already has an open decision.
    for question in open.iter().filter(|n| n.kind == NoteKind::Question) {
        if let Some(decision) = by_subject
            .get(question.subject.as_str())
            .and_then(|decisions| decisions.first())
        {
            findings.push(NoteConflict::QuestionOnDecidedSubject {
                subject: question.subject.clone(),
                question_id: question.id.clone(),
                decision_id: decision.id.clone(),
            });
        }
    }

    for note in &open {
        // A note that literally says what a declaration forbids.
        let haystack = note.text.to_lowercase();
        for statement in &known.forbidden {
            if statement.forbidden.trim().is_empty() {
                continue;
            }
            if haystack.contains(&statement.forbidden.to_lowercase()) {
                findings.push(NoteConflict::ContradictsDeclaration {
                    note_id: note.id.clone(),
                    source: statement.source.clone(),
                    forbidden: statement.forbidden.clone(),
                    statement: statement.statement.clone(),
                });
            }
        }

        // Links pointing at what the host did not observe.
        for link in &note.links {
            let known_target = match link {
                NoteLink::File(path) => known.files.contains(path),
                NoteLink::Sot(id) => known.sots.contains(id),
                NoteLink::Reference(id) => known.references.contains(id),
                NoteLink::Feature(id) => known.features.contains(id),
                NoteLink::Task(id) => known.tasks.contains(id),
                NoteLink::Guidance(id) => known.known_guidance.contains(id),
                // A message id belongs to a transcript this crate cannot see, and
                // a durable note must not depend on one being around. Never
                // reported as dangling.
                NoteLink::Message(_) => true,
            };
            if !known_target {
                findings.push(NoteConflict::DanglingLink {
                    note_id: note.id.clone(),
                    link: link.label(),
                });
                continue;
            }
            if let NoteLink::Guidance(id) = link {
                if !known.active_guidance.contains(id) {
                    findings.push(NoteConflict::StaleGuidanceLink {
                        note_id: note.id.clone(),
                        guidance_id: id.clone(),
                    });
                }
            }
        }
    }

    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ide-notes-{tag}-{}", std::process::id()))
    }

    fn draft(kind: NoteKind, subject: &str, text: &str) -> NoteDraft {
        NoteDraft {
            theme: "desempate".to_owned(),
            kind,
            subject: subject.to_owned(),
            text: text.to_owned(),
            links: Vec::new(),
        }
    }

    fn store(tag: &str) -> (NoteStore, PathBuf) {
        let root = temp_root(tag);
        let _ = fs::remove_dir_all(&root);
        (NoteStore::open(&root).unwrap(), root)
    }

    /// A note without a subject cannot be compared with anything, so it is not a
    /// note this store accepts.
    #[test]
    fn a_note_needs_theme_subject_and_text() {
        let (mut store, root) = store("required");

        assert!(store
            .create(draft(NoteKind::Decision, "", "algo"), 1)
            .is_err());
        assert!(store
            .create(draft(NoteKind::Decision, "assunto", "  "), 1)
            .is_err());
        let mut no_theme = draft(NoteKind::Decision, "assunto", "texto");
        no_theme.theme = "  ".to_owned();
        assert!(store.create(no_theme, 1).is_err());
        assert!(store.list().is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    /// Notes persist, and the Markdown mirror is regenerated per theme.
    #[test]
    fn notes_persist_and_mirror_by_theme() {
        let (mut store, root) = store("persist");
        store
            .create(
                draft(NoteKind::Question, "desempate", "quem vence empate?"),
                10,
            )
            .unwrap();

        let reopened = NoteStore::open(&root).unwrap();
        assert_eq!(reopened.list().len(), 1);
        let mirror = fs::read_to_string(root.join("desempate.md")).unwrap();
        assert!(mirror.contains("quem vence empate?"), "{mirror}");
        assert!(mirror.contains("Question"), "{mirror}");
        fs::remove_dir_all(&root).unwrap();
    }

    /// Two open decisions on the same subject with different text disagree.
    #[test]
    fn two_open_decisions_on_one_subject_disagree() {
        let (mut store, root) = store("disagree");
        store
            .create(
                draft(
                    NoteKind::Decision,
                    "desempate",
                    "vence o maior valor selado",
                ),
                1,
            )
            .unwrap();
        store
            .create(
                draft(NoteKind::Decision, "desempate", "vence o lance mais antigo"),
                2,
            )
            .unwrap();

        let found = conflicts(&store.list(), &KnownWorld::default());

        assert!(found.iter().any(|conflict| matches!(
            conflict,
            NoteConflict::DecisionsDisagree { subject, note_ids }
                if subject == "desempate" && note_ids.len() == 2
        )));
        fs::remove_dir_all(&root).unwrap();
    }

    /// Same subject, same text is agreement, not conflict. And a resolved note is
    /// history: it stops taking part.
    #[test]
    fn agreement_and_history_are_not_conflicts() {
        let (mut store, root) = store("agreement");
        store
            .create(
                draft(NoteKind::Decision, "desempate", "vence o maior valor"),
                1,
            )
            .unwrap();
        store
            .create(
                draft(NoteKind::Decision, "desempate", "vence o maior valor"),
                2,
            )
            .unwrap();
        assert!(conflicts(&store.list(), &KnownWorld::default()).is_empty());

        let third = store
            .create(
                draft(NoteKind::Decision, "desempate", "vence o mais antigo"),
                3,
            )
            .unwrap();
        assert!(!conflicts(&store.list(), &KnownWorld::default()).is_empty());

        store
            .resolve(&third.id, "descartada na reconciliação de hoje", 4)
            .unwrap();
        assert!(
            conflicts(&store.list(), &KnownWorld::default()).is_empty(),
            "nota resolvida é história, e história não conflita com o presente"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    /// A note that literally says what a source of truth forbids collides with it,
    /// and both sides are named.
    #[test]
    fn a_note_that_says_the_forbidden_collides_with_the_declaration() {
        let (mut store, root) = store("forbidden");
        store
            .create(
                draft(
                    NoteKind::Proposal,
                    "desempate",
                    "resolver empate por ordem de criação é mais simples",
                ),
                1,
            )
            .unwrap();
        let known = KnownWorld {
            forbidden: vec![ForbiddenStatement {
                source: "docs/product-intent.md".to_owned(),
                statement: "Empate não pode ser resolvido por ordem de criação.".to_owned(),
                forbidden: "ordem de criação".to_owned(),
            }],
            ..KnownWorld::default()
        };

        let found = conflicts(&store.list(), &known);

        assert!(found.iter().any(|conflict| matches!(
            conflict,
            NoteConflict::ContradictsDeclaration { source, forbidden, .. }
                if source == "docs/product-intent.md" && forbidden == "ordem de criação"
        )));
        fs::remove_dir_all(&root).unwrap();
    }

    /// An open question on an already-decided subject is an asymmetry worth
    /// showing: somebody decided while somebody else was still asking.
    #[test]
    fn an_open_question_on_a_decided_subject_is_surfaced() {
        let (mut store, root) = store("question");
        store
            .create(
                draft(NoteKind::Decision, "desempate", "vence o maior valor"),
                1,
            )
            .unwrap();
        store
            .create(
                draft(
                    NoteKind::Question,
                    "desempate",
                    "e se os dois forem iguais?",
                ),
                2,
            )
            .unwrap();

        let found = conflicts(&store.list(), &KnownWorld::default());

        assert!(found
            .iter()
            .any(|conflict| matches!(conflict, NoteConflict::QuestionOnDecidedSubject { .. })));
        fs::remove_dir_all(&root).unwrap();
    }

    /// A link the host did not observe is dangling; a message link never is,
    /// because a durable note must not depend on a transcript being around.
    #[test]
    fn links_are_checked_against_what_the_host_observed() {
        let (mut store, root) = store("links");
        let note = store
            .create(draft(NoteKind::Proposal, "ranking", "mudar o ranking"), 1)
            .unwrap();
        store
            .link(&note.id, NoteLink::File("src/auction.ts".to_owned()), 2)
            .unwrap();
        store
            .link(&note.id, NoteLink::File("src/sumiu.ts".to_owned()), 3)
            .unwrap();
        store
            .link(&note.id, NoteLink::Message("msg-1".to_owned()), 4)
            .unwrap();
        let known = KnownWorld {
            files: vec!["src/auction.ts".to_owned()],
            ..KnownWorld::default()
        };

        let found = conflicts(&store.list(), &known);

        let dangling: Vec<String> = found
            .iter()
            .filter_map(|conflict| match conflict {
                NoteConflict::DanglingLink { link, .. } => Some(link.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(dangling, vec!["arquivo:src/sumiu.ts"]);
        fs::remove_dir_all(&root).unwrap();
    }

    /// Guidance that exists but is no longer active makes the note STALE, not
    /// dangling — the difference is whether the target vanished or merely stopped
    /// steering.
    #[test]
    fn guidance_that_stopped_being_active_is_stale_not_dangling() {
        let (mut store, root) = store("stale");
        let note = store
            .create(
                draft(NoteKind::Decision, "desempate", "seguir a guidance"),
                1,
            )
            .unwrap();
        store
            .link(
                &note.id,
                NoteLink::Guidance("guidance-000000".to_owned()),
                2,
            )
            .unwrap();
        let known = KnownWorld {
            known_guidance: vec!["guidance-000000".to_owned()],
            active_guidance: Vec::new(),
            ..KnownWorld::default()
        };

        let found = conflicts(&store.list(), &known);

        assert!(found
            .iter()
            .any(|conflict| matches!(conflict, NoteConflict::StaleGuidanceLink { .. })));
        assert!(
            !found
                .iter()
                .any(|conflict| matches!(conflict, NoteConflict::DanglingLink { .. })),
            "guidance conhecida não é ligação quebrada"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    /// Resolving and superseding both require a reason, and superseding requires a
    /// replacement that exists and is not itself.
    #[test]
    fn closing_a_note_requires_an_account_of_why() {
        let (mut store, root) = store("close");
        let first = store
            .create(draft(NoteKind::Decision, "desempate", "por valor"), 1)
            .unwrap();
        let second = store
            .create(
                draft(NoteKind::Decision, "desempate", "por valor selado"),
                2,
            )
            .unwrap();

        assert!(store.resolve(&first.id, "   ", 3).is_err());
        assert!(store.supersede(&first.id, &second.id, "", 3).is_err());
        assert!(store.supersede(&first.id, &first.id, "motivo", 3).is_err());
        assert!(store
            .supersede(&first.id, "note-999999", "motivo", 3)
            .is_err());

        let superseded = store
            .supersede(&first.id, &second.id, "mesma decisão, texto melhor", 4)
            .unwrap();
        assert_eq!(superseded.state, NoteState::Superseded);
        assert_eq!(
            superseded.superseded_by.as_deref(),
            Some(second.id.as_str())
        );
        assert_eq!(
            superseded.state_reason.as_deref(),
            Some("mesma decisão, texto melhor")
        );
        // And with the old one out of the way, the disagreement is gone.
        assert!(conflicts(&store.list(), &KnownWorld::default()).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }
}
