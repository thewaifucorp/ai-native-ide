//! §4 — reconciliation: what the project SAID the preview would do, against what
//! it was OBSERVED doing.
//!
//! # Scope, and why it is this narrow
//!
//! §3 already reconciles intent against implementation for the semantic product:
//! `.product/sot` claims are verified against real files, and a divergence there
//! is resolved through the broker. This module is deliberately NOT that. It
//! reconciles **declared behavior against observed behavior** — the axis
//! `ide_reconciliation` was built for, and the one nothing in the Theia shell
//! read: a `PreviewFailure` becomes an `ObservedBehavior`, and an observation can
//! disagree with a declaration.
//!
//! Doing both axes in one place would let a check-shaped divergence be resolved
//! with a claim-shaped decision, and neither surface would be right.
//!
//! # Where the intent comes from
//!
//! Two sources, in this order:
//!
//!  1. `.instrument/intents.json` — the human-editable file. Explicit wins.
//!  2. `.instrument/preview.json` — declaring a health URL IS declaring you
//!     expect it to answer. That is a literal reading of a file somebody wrote,
//!     not an inference, and the intent record points back at that file so the
//!     reader can see where the expectation came from.
//!
//! # Two rules the engine holds, not this module
//!
//!  * **An observation with no evidence never diverges.** `detect_divergence`
//!    drops it. Every observation here is minted from the preview ledger, which
//!    only mints ids for facts it accepted as evidence.
//!  * **Nothing is resolved by being decided.** `ChangeImplementation` lands as
//!    `pending_verification`, never as resolved: somebody still has to change the
//!    code and produce fresh evidence. The only status that closes on the spot is
//!    an explicitly justified, explicitly scoped exception.
//!
//! And one rule of this module's own: choosing "the intent was wrong" WRITES the
//! revised expectation into `.instrument/intents.json`. A revision that lived
//! only in memory would make the next scan re-open the same divergence, and the
//! person would have no file to review.

use ide_reconciliation::{
    detect_divergence, Divergence, IntentSpecRecord, ObservedBehavior, Reconciliation,
    ReconciliationChoice, ReconciliationStore,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// The one subject this module reconciles today.
pub const PREVIEW_SUBJECT: &str = "preview:health";

const INTENTS_REL: &str = ".instrument/intents.json";
const RECONCILIATIONS_REL: &str = ".instrument/reconciliation.json";
const PREVIEW_REL: &str = ".instrument/preview.json";

/// One declared expectation, as `.instrument/intents.json` holds it.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DeclaredIntent {
    id: String,
    subject: String,
    expected: serde_json::Value,
    #[serde(default)]
    revision: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct DeclaredIntents {
    #[serde(default)]
    intents: Vec<DeclaredIntent>,
}

/// A decision somebody took, kept on disk so it survives a restart.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredReconciliation {
    pub divergence_id: String,
    pub choice: ReconciliationChoice,
    pub status: ide_reconciliation::ReconciliationStatus,
    pub at_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StoredReconciliations {
    #[serde(default)]
    reconciliations: Vec<StoredReconciliation>,
}

/// A divergence plus the decision taken on it, if any.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DivergenceView {
    /// The engine's own record, with its own field names — not re-shaped here.
    /// A wrapper that renamed them would be one more seam to get wrong.
    pub divergence: Divergence,
    /// `None` means open. An open divergence is never rendered as resolved.
    pub reconciliation: Option<StoredReconciliation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationSnapshot {
    pub intents: Vec<IntentSpecRecord>,
    pub observations: Vec<ObservedBehavior>,
    pub divergences: Vec<DivergenceView>,
    /// Why there is nothing to compare, when there is nothing: no declared
    /// expectation, or no observation yet. Silence here would read as "all good".
    pub nothing_to_compare: Option<String>,
    /// A malformed intents file is said out loud, not swallowed.
    pub problem: Option<String>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_intents(root: &Path) -> (Vec<IntentSpecRecord>, Option<String>) {
    let path = root.join(INTENTS_REL);
    let mut records: Vec<IntentSpecRecord> = Vec::new();
    let mut problem = None;

    if let Ok(raw) = std::fs::read_to_string(&path) {
        match serde_json::from_str::<DeclaredIntents>(&raw) {
            Ok(parsed) => {
                for intent in parsed.intents {
                    if intent.id.trim().is_empty() || intent.subject.trim().is_empty() {
                        problem = Some(format!(
                            "{INTENTS_REL} tem uma intenção sem id ou sem assunto — ignorada"
                        ));
                        continue;
                    }
                    records.push(IntentSpecRecord {
                        id: intent.id,
                        subject: intent.subject,
                        expected: intent.expected,
                        source_path: INTENTS_REL.to_string(),
                        revision: intent.revision.unwrap_or_else(|| "1".to_string()),
                    });
                }
            }
            Err(error) => {
                problem = Some(format!(
                    "{INTENTS_REL} existe mas não pôde ser lido ({error}) — as intenções \
                     declaradas ali não entraram na comparação"
                ));
            }
        }
    }

    // The preview declaration is itself a statement of expected behavior, but it
    // never overrides an explicit intent for the same subject.
    let already_declared = records.iter().any(|r| r.subject == PREVIEW_SUBJECT);
    if !already_declared {
        if let Ok(raw) = std::fs::read_to_string(root.join(PREVIEW_REL)) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                if value.get("url").and_then(|u| u.as_str()).is_some() {
                    records.push(IntentSpecRecord {
                        id: "preview-responde".to_string(),
                        subject: PREVIEW_SUBJECT.to_string(),
                        expected: serde_json::json!("healthy"),
                        source_path: PREVIEW_REL.to_string(),
                        revision: "declarado-no-preview".to_string(),
                    });
                }
            }
        }
    }

    (records, problem)
}

fn read_reconciliations(root: &Path) -> Vec<StoredReconciliation> {
    std::fs::read_to_string(root.join(RECONCILIATIONS_REL))
        .ok()
        .and_then(|raw| serde_json::from_str::<StoredReconciliations>(&raw).ok())
        .map(|s| s.reconciliations)
        .unwrap_or_default()
}

fn write_reconciliations(root: &Path, all: &[StoredReconciliation]) -> Result<(), String> {
    let path = root.join(RECONCILIATIONS_REL);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&StoredReconciliations {
        reconciliations: all.to_vec(),
    })
    .map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())
}

/// Writes a revised expectation into the human-editable intents file.
///
/// Direct write, no broker: `.instrument/` is IDE runtime state, not project
/// content — the same line §5 draws for `.instrument/checks.json`. What protects
/// it is that it only ever happens because somebody chose "the intent was wrong",
/// naming the divergence.
fn upsert_intent(
    root: &Path,
    subject: &str,
    id: &str,
    expected: &serde_json::Value,
) -> Result<(), String> {
    let path = root.join(INTENTS_REL);
    let mut declared = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<DeclaredIntents>(&raw).ok())
        .unwrap_or_default();

    // The index is resolved first on purpose: matching on `iter_mut().find(..)`
    // keeps the mutable borrow alive across both arms, so the "not there yet"
    // arm could not push.
    let existing = declared.intents.iter().position(|i| i.id == id);
    match existing {
        Some(index) => {
            let entry = &mut declared.intents[index];
            entry.expected = expected.clone();
            let next = entry
                .revision
                .as_deref()
                .and_then(|r| r.parse::<u32>().ok())
                .map(|r| r + 1)
                .unwrap_or(2);
            entry.revision = Some(next.to_string());
        }
        None => declared.intents.push(DeclaredIntent {
            id: id.to_string(),
            subject: subject.to_string(),
            expected: expected.clone(),
            revision: Some("2".to_string()),
        }),
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&declared).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())
}

/// Builds the store from disk plus the live preview ledger, and detects every
/// literal disagreement. Reads only; nothing here writes or resolves.
fn build(root: &Path, observations: Vec<ObservedBehavior>) -> (ReconciliationStore, Vec<Divergence>, Vec<IntentSpecRecord>, Option<String>) {
    let (intents, problem) = read_intents(root);
    let mut store = ReconciliationStore::default();
    for intent in &intents {
        store.record_intent(intent.clone());
    }
    for observation in &observations {
        store.record_observation(observation.clone());
    }

    let mut divergences = Vec::new();
    for intent in &intents {
        for observation in &observations {
            if let Some(divergence) = detect_divergence(intent, observation) {
                // Recorded in the store too, so `reconcile` can resolve against it.
                store.detect(&intent.id, &observation.id);
                divergences.push(divergence);
            }
        }
    }
    (store, divergences, intents, problem)
}

/// Current reconciliation picture for a project.
pub fn scan(root: &Path) -> ReconciliationSnapshot {
    let observations = crate::preview::observations(root);
    let (_, divergences, intents, problem) = build(root, observations.clone());
    let stored = read_reconciliations(root);

    let nothing_to_compare = if intents.is_empty() {
        Some(format!(
            "nenhuma expectativa declarada em {INTENTS_REL} (nem url de saúde em {PREVIEW_REL}) — \
             não há o que reconciliar"
        ))
    } else if observations.is_empty() {
        Some(
            "nenhum comportamento observado ainda — o preview não registrou falha nesta sessão"
                .to_string(),
        )
    } else {
        None
    };

    let divergences = divergences
        .into_iter()
        .map(|divergence| DivergenceView {
            reconciliation: stored
                .iter()
                .find(|r| r.divergence_id == divergence.id)
                .cloned(),
            divergence,
        })
        .collect();

    ReconciliationSnapshot {
        intents,
        observations,
        divergences,
        nothing_to_compare,
        problem,
    }
}

/// Records one human decision about one divergence.
///
/// Every branch goes through `ReconciliationStore::reconcile`, so the engine's
/// refusals stand: an implementation change with no effect id, or an exception
/// with no justification or no scope, is rejected here rather than stored.
pub fn reconcile(
    root: &Path,
    divergence_id: &str,
    choice: ReconciliationChoice,
) -> Result<ReconciliationSnapshot, String> {
    let observations = crate::preview::observations(root);
    let (mut store, divergences, _, _) = build(root, observations);
    if !divergences.iter().any(|d| d.id == divergence_id) {
        return Err(format!(
            "divergência desconhecida: {divergence_id} — ela não aparece na comparação atual"
        ));
    }

    let recorded: Reconciliation = store
        .reconcile(divergence_id, choice.clone())
        .map_err(|error| error.to_string())?
        .clone();

    // "The intent was wrong" has to reach the file, or the next scan re-opens the
    // same divergence and the decision was theatre.
    if let ReconciliationChoice::ChangeIntent { revised_expected } = &choice {
        let intent_id = divergences
            .iter()
            .find(|d| d.id == divergence_id)
            .map(|d| d.intent_id.clone())
            .expect("a divergência foi encontrada acima");
        let subject = store
            .intent(&intent_id)
            .map(|i| i.subject.clone())
            .unwrap_or_else(|| PREVIEW_SUBJECT.to_string());
        upsert_intent(root, &subject, &intent_id, revised_expected)?;
    }

    let mut all = read_reconciliations(root);
    all.retain(|r| r.divergence_id != divergence_id);
    all.push(StoredReconciliation {
        divergence_id: divergence_id.to_string(),
        choice: recorded.choice,
        status: recorded.status,
        at_ms: now_ms(),
    });
    write_reconciliations(root, &all)?;

    Ok(scan(root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_reconciliation::{ExceptionScope, ReconciliationStatus};

    fn observation(id: &str, actual: &str) -> ObservedBehavior {
        ObservedBehavior {
            id: id.to_string(),
            subject: PREVIEW_SUBJECT.to_string(),
            actual: serde_json::json!(actual),
            evidence_ids: vec!["evidence:.instrument/preview.log#1".to_string()],
            observed_at_ms: 1,
        }
    }

    fn project(intents: Option<&str>, preview: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join(".instrument")).unwrap();
        if let Some(body) = intents {
            std::fs::write(dir.path().join(INTENTS_REL), body).unwrap();
        }
        if let Some(body) = preview {
            std::fs::write(dir.path().join(PREVIEW_REL), body).unwrap();
        }
        dir
    }

    /// A preview declaration with a health URL is itself the expectation, and the
    /// intent points back at the file that says so.
    #[test]
    fn the_preview_declaration_is_read_as_the_expectation() {
        let dir = project(None, Some(r#"{"command":"x","url":"http://127.0.0.1:1/"}"#));

        let (intents, _) = read_intents(dir.path());

        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].subject, PREVIEW_SUBJECT);
        assert_eq!(intents[0].expected, serde_json::json!("healthy"));
        assert_eq!(intents[0].source_path, PREVIEW_REL);
    }

    /// An explicit intent wins over the implicit one, so editing the file is how
    /// the expectation is actually controlled.
    #[test]
    fn an_explicit_intent_overrides_the_implicit_one() {
        let dir = project(
            Some(
                r#"{"intents":[{"id":"meu","subject":"preview:health","expected":"stale"}]}"#,
            ),
            Some(r#"{"command":"x","url":"http://127.0.0.1:1/"}"#),
        );

        let (intents, _) = read_intents(dir.path());

        assert_eq!(intents.len(), 1, "não pode haver duas expectativas do mesmo assunto");
        assert_eq!(intents[0].id, "meu");
        assert_eq!(intents[0].source_path, INTENTS_REL);
    }

    /// Nothing declared and nothing observed are DIFFERENT silences, and each one
    /// says which it is instead of reading as approval.
    #[test]
    fn empty_states_say_which_silence_they_are() {
        let dir = project(None, None);
        let snapshot = scan(dir.path());
        assert!(snapshot
            .nothing_to_compare
            .as_deref()
            .unwrap()
            .contains("nenhuma expectativa declarada"));

        let dir = project(None, Some(r#"{"command":"x","url":"http://127.0.0.1:1/"}"#));
        let snapshot = scan(dir.path());
        assert!(snapshot
            .nothing_to_compare
            .as_deref()
            .unwrap()
            .contains("nenhum comportamento observado"));
    }

    /// An observation with no evidence id never becomes a divergence — the engine
    /// drops it, and so must anything built on top.
    #[test]
    fn an_observation_without_evidence_never_diverges() {
        let dir = project(None, Some(r#"{"command":"x","url":"http://127.0.0.1:1/"}"#));
        let mut bare = observation("o1", "broken");
        bare.evidence_ids.clear();

        let (_, divergences, _, _) = build(dir.path(), vec![bare]);

        assert!(divergences.is_empty());
    }

    /// Declared healthy, observed broken: one divergence, carrying the evidence.
    #[test]
    fn declared_healthy_versus_observed_broken_is_a_divergence() {
        let dir = project(None, Some(r#"{"command":"x","url":"http://127.0.0.1:1/"}"#));

        let (_, divergences, _, _) = build(dir.path(), vec![observation("o1", "broken")]);

        assert_eq!(divergences.len(), 1);
        assert_eq!(divergences[0].expected, serde_json::json!("healthy"));
        assert_eq!(divergences[0].actual, serde_json::json!("broken"));
        assert!(!divergences[0].evidence_ids.is_empty());
    }

    /// Choosing "change the implementation" does NOT close anything: it lands
    /// pending verification, and it is refused outright with no effect named.
    #[test]
    fn changing_the_implementation_stays_pending_and_needs_an_effect() {
        let dir = project(None, Some(r#"{"command":"x","url":"http://127.0.0.1:1/"}"#));
        let (mut store, divergences, _, _) =
            build(dir.path(), vec![observation("o1", "broken")]);
        let id = divergences[0].id.clone();

        let refused = store.reconcile(
            &id,
            ReconciliationChoice::ChangeImplementation {
                proposed_effect_id: String::new(),
            },
        );
        assert!(refused.is_err(), "sem efeito nomeado não há decisão");

        let accepted = store
            .reconcile(
                &id,
                ReconciliationChoice::ChangeImplementation {
                    proposed_effect_id: "e-preview-1".to_string(),
                },
            )
            .expect("com efeito nomeado, registra");
        assert_eq!(accepted.status, ReconciliationStatus::PendingVerification);
    }

    /// An exception needs a justification. And it is scoped — accepting one for
    /// this preview says nothing about the rest of the project.
    #[test]
    fn an_exception_requires_a_justification_and_a_scope() {
        let dir = project(None, Some(r#"{"command":"x","url":"http://127.0.0.1:1/"}"#));
        let (mut store, divergences, _, _) =
            build(dir.path(), vec![observation("o1", "broken")]);
        let id = divergences[0].id.clone();

        let refused = store.reconcile(
            &id,
            ReconciliationChoice::AcceptScopedException {
                scope: ExceptionScope::Preview {
                    preview_id: "preview".to_string(),
                },
                justification: "   ".to_string(),
            },
        );
        assert!(refused.is_err(), "exceção sem justificativa é recusada");

        let accepted = store
            .reconcile(
                &id,
                ReconciliationChoice::AcceptScopedException {
                    scope: ExceptionScope::Preview {
                        preview_id: "preview".to_string(),
                    },
                    justification: "o serviço externo está fora hoje".to_string(),
                },
            )
            .expect("com justificativa, registra");
        assert_eq!(
            accepted.status,
            ReconciliationStatus::AcceptedScopedException
        );
    }

    /// "The intent was wrong" reaches the file. Otherwise the next scan re-opens
    /// the same divergence and the decision was theatre.
    #[test]
    fn revising_the_intent_is_written_to_disk() {
        let dir = project(None, Some(r#"{"command":"x","url":"http://127.0.0.1:1/"}"#));
        let (_, divergences, _, _) = build(dir.path(), vec![observation("o1", "broken")]);
        let id = divergences[0].id.clone();
        let intent_id = divergences[0].intent_id.clone();

        upsert_intent(
            dir.path(),
            PREVIEW_SUBJECT,
            &intent_id,
            &serde_json::json!("broken"),
        )
        .expect("grava");

        let (intents, _) = read_intents(dir.path());
        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].expected, serde_json::json!("broken"));
        assert_eq!(intents[0].source_path, INTENTS_REL);

        // And with the expectation revised, the same observation no longer
        // disagrees with anything.
        let (_, divergences, _, _) = build(dir.path(), vec![observation("o1", "broken")]);
        assert!(divergences.is_empty(), "{id} não pode reabrir");
    }

    /// A decision survives a restart: it is read back from disk, and an open
    /// divergence is never rendered as decided.
    #[test]
    fn decisions_are_persisted_and_open_divergences_stay_open() {
        let dir = project(None, Some(r#"{"command":"x","url":"http://127.0.0.1:1/"}"#));
        let stored = vec![StoredReconciliation {
            divergence_id: "preview-responde::observed:x".to_string(),
            choice: ReconciliationChoice::ChangeImplementation {
                proposed_effect_id: "e1".to_string(),
            },
            status: ReconciliationStatus::PendingVerification,
            at_ms: 7,
        }];
        write_reconciliations(dir.path(), &stored).expect("grava");

        let read_back = read_reconciliations(dir.path());
        assert_eq!(read_back.len(), 1);
        assert_eq!(read_back[0].at_ms, 7);

        // Nothing observed this session, so the snapshot shows no divergence at
        // all — and certainly not a resolved one.
        let snapshot = scan(dir.path());
        assert!(snapshot.divergences.is_empty());
    }

    /// A malformed intents file is reported, and it does not take the rest of the
    /// picture down with it.
    #[test]
    fn a_malformed_intents_file_is_reported() {
        let dir = project(Some("{ isto não é json"), Some(r#"{"command":"x","url":"http://127.0.0.1:1/"}"#));

        let snapshot = scan(dir.path());

        assert!(snapshot
            .problem
            .as_deref()
            .unwrap()
            .contains("não pôde ser lido"));
        // The implicit expectation from preview.json still stands.
        assert_eq!(snapshot.intents.len(), 1);
    }
}
