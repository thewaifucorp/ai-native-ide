//! §8 — guided intent: what the declared intent hides, as reviewable candidates.
//!
//! `ide_semantic` is the Layer-1 engine. Unlike Layer 0 its findings are
//! HYPOTHESES: each carries a claim, the exact text that triggered it, a
//! calibrated confidence, a severity, a remediation and a review state, and a
//! budget bounds how many are surfaced. It runs no paid inference and never runs
//! on idle.
//!
//! # The three rules this module exists to keep
//!
//!  * **Nothing is rewritten.** The person's intent text is never edited here.
//!    A finding proposes; the text stays theirs. "A intenção melhora sem rewrite
//!    oculto" is the whole point of the item, and the only way to keep it is to
//!    have no code path that writes the intent.
//!  * **Nothing is silent.** A review decision is persisted with the hash of the
//!    intent it was taken on. Edit the intent and a decision taken on the old
//!    text is shown as decided-on-another-version rather than quietly applying.
//!  * **A hypothesis never steers and never blocks.** Findings are not compiled
//!    into agent context (§6 reads guidance and authority, never this), and they
//!    gate nothing. What blocks is a Layer-0 check failing. Accepting a finding
//!    turns it into a Guidance CANDIDATE, which still needs the §13 promotion
//!    before it can steer anything — two explicit steps, neither of them
//!    automatic.
//!
//! # Where contradictions come from
//!
//! From what the project ALREADY declared: a `.product/sot` claim whose check is
//! `absent-in-file` names a pattern that must not appear. If the intent literally
//! contains that pattern, the intent and the declaration cannot both stand, and
//! the finding quotes both sides. No model, no inference — two lines anybody can
//! read.

use ide_semantic::{
    contradictions, evaluate, DeclaredStatement, EvaluationBudget, ReviewState, SemanticFinding,
    SemanticReport,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

const SOT_DIR: &str = ".product/sot";
const REVIEW_REL: &str = ".instrument/intent-review.json";

/// Default budget. Small on purpose: a wall of hypotheses is ignored wholesale.
const DEFAULT_MAX_FINDINGS: usize = 6;

/// One recorded human decision about one finding.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDecision {
    pub finding_id: String,
    /// `accepted` or `dismissed`. Open findings are simply absent.
    pub state: String,
    /// Why. Required for a dismissal — see `review`.
    pub note: String,
    /// Hash of the intent this decision was taken on.
    pub intent_hash: String,
    pub at_ms: u64,
    /// Set when accepting produced an artifact, so the trail is followable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ReviewFile {
    #[serde(default)]
    decisions: Vec<ReviewDecision>,
}

/// A finding plus what a person already decided about it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedFinding {
    pub finding: SemanticFinding,
    /// `None` means nobody decided yet.
    pub decision: Option<ReviewDecision>,
    /// True when the decision was taken on a DIFFERENT intent text. The decision
    /// still shows, marked — applying it silently to a rewritten intent would be
    /// exactly the silent state the item forbids.
    pub decided_on_other_intent: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentReview {
    /// The engine's own report (findings already carry the review state).
    pub report: SemanticReport,
    pub reviewed: Vec<ReviewedFinding>,
    /// Statements the contradiction check was run against, so an empty result is
    /// explainable instead of mysterious.
    pub declared: Vec<DeclaredStatement>,
    /// Facts about what these findings DO — not advice, and not a threat.
    pub consequences: Vec<String>,
    /// Why there is nothing to show, when there is nothing.
    pub nothing_found: Option<String>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(serde::Deserialize)]
struct SotFile {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    claims: Vec<SotClaim>,
}

#[derive(serde::Deserialize)]
struct SotClaim {
    id: String,
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

/// Reads the declarations the contradiction check can use.
///
/// Only `absent-in-file` claims qualify: those are the ones that name a literal
/// text that must NOT appear. A `present-in-file` claim says what must exist,
/// which the intent mentioning it does not contradict.
fn declared_statements(root: &Path) -> Vec<DeclaredStatement> {
    let Ok(entries) = std::fs::read_dir(root.join(SOT_DIR)) else {
        return Vec::new();
    };
    let mut files: Vec<(String, String)> = entries
        .flatten()
        .filter(|entry| entry.path().extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|entry| {
            let raw = std::fs::read_to_string(entry.path()).ok()?;
            Some((entry.file_name().to_string_lossy().into_owned(), raw))
        })
        .collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut out = Vec::new();
    for (name, raw) in files {
        let Ok(file) = serde_json::from_str::<SotFile>(&raw) else {
            continue;
        };
        for claim in file.claims {
            let Some(check) = claim.check else { continue };
            if check.kind != "absent-in-file" || check.pattern.trim().is_empty() {
                continue;
            }
            out.push(DeclaredStatement {
                id: claim.id,
                // The authority file when the SoT names one; the SoT artifact
                // otherwise. Either way it is a path somebody can open.
                source: file
                    .path
                    .clone()
                    .unwrap_or_else(|| format!("{SOT_DIR}/{name}")),
                statement: claim.statement,
                forbidden: check.pattern,
            });
        }
    }
    out
}

fn read_reviews(root: &Path) -> Vec<ReviewDecision> {
    std::fs::read_to_string(root.join(REVIEW_REL))
        .ok()
        .and_then(|raw| serde_json::from_str::<ReviewFile>(&raw).ok())
        .map(|file| file.decisions)
        .unwrap_or_default()
}

fn write_reviews(root: &Path, decisions: &[ReviewDecision]) -> Result<(), String> {
    let path = root.join(REVIEW_REL);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&ReviewFile {
        decisions: decisions.to_vec(),
    })
    .map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())
}

/// Facts about what a Layer-1 finding does. Stated because the alternative is
/// people assuming either that it blocks, or that it silently steers the agent.
fn consequences(count: usize) -> Vec<String> {
    vec![
        "isto é hipótese de camada 1: não bloqueia efeito nenhum — o que bloqueia é check \
         determinístico de camada 0 falhando"
            .to_string(),
        "hipótese não entra no contexto do agente: o §6 compila guidance ATIVA e autoridade \
         declarada, nunca finding"
            .to_string(),
        format!(
            "aceitar cria uma guidance CANDIDATA ({count} finding(s) na tela): candidata também \
             não dirige agente até ser promovida"
        ),
        "nada aqui reescreve a sua intenção: o texto continua seu, e a proposta fica ao lado dele"
            .to_string(),
    ]
}

/// Evaluates the intent and merges the recorded decisions.
pub fn review_snapshot(
    root: &Path,
    intent: &str,
    max_findings: Option<usize>,
) -> Result<IntentReview, String> {
    let budget = EvaluationBudget {
        max_findings: max_findings.unwrap_or(DEFAULT_MAX_FINDINGS),
    };
    let mut report = evaluate(intent, budget);
    let declared = declared_statements(root);
    let mut contradiction_findings = contradictions(intent, &declared);
    if !contradiction_findings.is_empty() {
        report.evaluators_run.push("declared-contradiction");
        // Contradictions are high severity and quote both sides, so they go first
        // rather than competing with keyword hypotheses for the budget.
        contradiction_findings.append(&mut report.findings);
        report.findings = contradiction_findings;
        report.findings.truncate(budget.max_findings.max(1));
    }

    let decisions: BTreeMap<String, ReviewDecision> = read_reviews(root)
        .into_iter()
        .map(|decision| (decision.finding_id.clone(), decision))
        .collect();

    let reviewed: Vec<ReviewedFinding> = report
        .findings
        .iter()
        .cloned()
        .map(|mut finding| {
            let decision = decisions.get(&finding.id).cloned();
            let decided_on_other_intent = decision
                .as_ref()
                .map(|d| d.intent_hash != report.content_hash)
                .unwrap_or(false);
            if let Some(taken) = &decision {
                // The state on the finding follows the recorded decision, but only
                // the record carries WHY and WHEN.
                finding.review_state = match taken.state.as_str() {
                    "accepted" => ReviewState::Accepted,
                    "dismissed" => ReviewState::Dismissed,
                    _ => ReviewState::Open,
                };
            }
            ReviewedFinding {
                finding,
                decision,
                decided_on_other_intent,
            }
        })
        .collect();

    let nothing_found = if intent.trim().is_empty() {
        Some("nenhuma intenção escrita ainda — não há o que avaliar".to_string())
    } else if reviewed.is_empty() {
        Some(format!(
            "{} avaliador(es) rodaram e nenhum encontrou nada nesta intenção — isso não é \
             aprovação, é ausência de hipótese",
            report.evaluators_run.len()
        ))
    } else {
        None
    };

    Ok(IntentReview {
        consequences: consequences(reviewed.len()),
        report,
        reviewed,
        declared,
        nothing_found,
    })
}

/// Records a decision about one finding.
///
/// A DISMISSAL requires a note. Dismissing without a reason is the silent state
/// this item exists to prevent: six months later nobody can tell whether the
/// hypothesis was wrong or merely inconvenient.
pub fn review(
    root: &Path,
    intent: &str,
    finding_id: &str,
    state: &str,
    note: &str,
    artifact: Option<&str>,
) -> Result<IntentReview, String> {
    let snapshot = review_snapshot(root, intent, None)?;
    if !snapshot
        .reviewed
        .iter()
        .any(|entry| entry.finding.id == finding_id)
    {
        return Err(format!(
            "finding desconhecido nesta intenção: {finding_id} — decidir sobre algo que a \
             avaliação atual não produziu deixaria um registro sem contraparte"
        ));
    }
    let state = match state {
        "accepted" | "dismissed" => state.to_string(),
        // No third state is stored: "open" is the absence of a decision, so
        // storing it would be a record that says nothing.
        other => return Err(format!("estado de revisão desconhecido: {other}")),
    };
    if state == "dismissed" && note.trim().is_empty() {
        return Err("dispensar exige dizer por quê".to_string());
    }

    let mut decisions = read_reviews(root);
    decisions.retain(|decision| decision.finding_id != finding_id);
    decisions.push(ReviewDecision {
        finding_id: finding_id.to_string(),
        state,
        note: note.to_string(),
        intent_hash: snapshot.report.content_hash.clone(),
        at_ms: now_ms(),
        artifact: artifact.map(str::to_string),
    });
    write_reviews(root, &decisions)?;
    review_snapshot(root, intent, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AUCTION_INTENT: &str = "Quero um leilão de posições com lances concorrentes";

    fn project() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn write(root: &Path, rel: &str, body: &str) {
        let abs = root.join(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(abs, body).unwrap();
    }

    /// An empty intent produces no hypotheses and says so — not an approval.
    #[test]
    fn an_empty_intent_is_not_an_approval() {
        let dir = project();

        let snapshot = review_snapshot(dir.path(), "   ", None).expect("snapshot");

        assert!(snapshot.reviewed.is_empty());
        assert!(snapshot
            .nothing_found
            .as_deref()
            .unwrap()
            .contains("não há o que avaliar"));
    }

    /// An intent nothing matched says the evaluators RAN and found nothing, which
    /// is a different sentence from "looks fine".
    #[test]
    fn nothing_found_says_the_evaluators_ran() {
        let dir = project();

        let snapshot =
            review_snapshot(dir.path(), "Um formulário de contato simples", None).expect("snapshot");

        let message = snapshot.nothing_found.expect("motivo");
        assert!(message.contains("avaliador(es) rodaram"), "{message}");
        assert!(message.contains("não é aprovação"), "{message}");
    }

    /// The keyword evaluators surface hypotheses with evidence, and every finding
    /// starts OPEN — nothing is auto-accepted.
    #[test]
    fn findings_start_open_and_carry_evidence() {
        let dir = project();

        let snapshot = review_snapshot(dir.path(), AUCTION_INTENT, None).expect("snapshot");

        assert!(!snapshot.reviewed.is_empty());
        for entry in &snapshot.reviewed {
            assert_eq!(entry.finding.review_state, ReviewState::Open);
            assert!(!entry.finding.evidence.is_empty());
            assert!(entry.decision.is_none());
        }
        // And the consequences are stated, so nobody has to guess whether a
        // hypothesis blocks or steers.
        assert!(snapshot
            .consequences
            .iter()
            .any(|line| line.contains("não bloqueia")));
        assert!(snapshot
            .consequences
            .iter()
            .any(|line| line.contains("não entra no contexto do agente")));
    }

    /// A declared `absent-in-file` claim is what makes a contradiction possible,
    /// and both sides are quoted.
    #[test]
    fn a_declaration_the_intent_violates_is_reported_with_both_sides() {
        let dir = project();
        write(
            dir.path(),
            ".product/sot/intent.json",
            r#"{"id":"intent","kind":"intent","path":"docs/product-intent.md",
                "claims":[{"id":"desempate","statement":"Empate não pode ser resolvido por ordem de criação.",
                "check":{"kind":"absent-in-file","path":"src/auction.ts","pattern":"ordem de criação"}}]}"#,
        );

        let snapshot = review_snapshot(
            dir.path(),
            "O desempate do leilão usa a ordem de criação do lance",
            None,
        )
        .expect("snapshot");

        let contradiction = snapshot
            .reviewed
            .iter()
            .find(|entry| entry.finding.evaluator == "declared-contradiction")
            .expect("contradição");
        assert!(contradiction.finding.claim.contains("docs/product-intent.md"));
        assert!(contradiction.finding.evidence.contains("ordem de criação"));
        assert_eq!(snapshot.declared.len(), 1, "a declaração usada fica listada");
        // It leads: a contradiction quotes both sides, a keyword rule guesses.
        assert_eq!(
            snapshot.reviewed[0].finding.evaluator, "declared-contradiction",
            "contradição vem antes de hipótese de palavra-chave"
        );
    }

    /// A `present-in-file` claim is not a forbidden text, so it produces no
    /// contradiction — mentioning what must exist is not a violation.
    #[test]
    fn only_absent_in_file_claims_can_be_contradicted() {
        let dir = project();
        write(
            dir.path(),
            ".product/sot/intent.json",
            r#"{"id":"intent","path":"docs/product-intent.md",
                "claims":[{"id":"valor","statement":"O valor selado existe no modelo.",
                "check":{"kind":"present-in-file","path":"src/auction.ts","pattern":"sealedAmount"}}]}"#,
        );

        let snapshot =
            review_snapshot(dir.path(), "o leilão guarda sealedAmount", None).expect("snapshot");

        assert!(snapshot.declared.is_empty());
        assert!(snapshot
            .reviewed
            .iter()
            .all(|entry| entry.finding.evaluator != "declared-contradiction"));
    }

    /// Dismissing requires a reason. Without one the record says nothing, which
    /// is the silent state this item exists to prevent.
    #[test]
    fn dismissing_requires_a_reason() {
        let dir = project();
        let snapshot = review_snapshot(dir.path(), AUCTION_INTENT, None).expect("snapshot");
        let id = snapshot.reviewed[0].finding.id.clone();

        let error = review(dir.path(), AUCTION_INTENT, &id, "dismissed", "  ", None)
            .expect_err("recusa");

        assert!(error.contains("por quê"), "{error}");
        assert!(read_reviews(dir.path()).is_empty(), "nada foi gravado");
    }

    /// A decision persists with the reason and survives a reread.
    #[test]
    fn a_decision_persists_with_its_reason() {
        let dir = project();
        let snapshot = review_snapshot(dir.path(), AUCTION_INTENT, None).expect("snapshot");
        let id = snapshot.reviewed[0].finding.id.clone();

        let after = review(
            dir.path(),
            AUCTION_INTENT,
            &id,
            "dismissed",
            "o leilão é single-writer por construção",
            None,
        )
        .expect("review");

        let entry = after
            .reviewed
            .iter()
            .find(|entry| entry.finding.id == id)
            .expect("finding");
        assert_eq!(entry.finding.review_state, ReviewState::Dismissed);
        assert_eq!(
            entry.decision.as_ref().unwrap().note,
            "o leilão é single-writer por construção"
        );
        assert!(!entry.decided_on_other_intent);
    }

    /// Editing the intent does NOT silently carry the decision over: it is shown
    /// as decided on another version of the text.
    #[test]
    fn a_decision_taken_on_another_intent_is_marked_not_applied_silently() {
        let dir = project();
        let snapshot = review_snapshot(dir.path(), AUCTION_INTENT, None).expect("snapshot");
        let id = snapshot.reviewed[0].finding.id.clone();
        review(
            dir.path(),
            AUCTION_INTENT,
            &id,
            "dismissed",
            "decidido sobre o texto antigo",
            None,
        )
        .expect("review");

        let rewritten = format!("{AUCTION_INTENT}, agora com pagamento");
        let after = review_snapshot(dir.path(), &rewritten, None).expect("snapshot");

        let entry = after
            .reviewed
            .iter()
            .find(|entry| entry.finding.id == id)
            .expect("finding");
        assert!(
            entry.decided_on_other_intent,
            "decisão tomada sobre outro texto tem de aparecer marcada"
        );
    }

    /// Deciding about a finding the current evaluation did not produce is
    /// refused: the record would have no counterpart.
    #[test]
    fn deciding_about_an_unknown_finding_is_refused() {
        let dir = project();

        let error = review(
            dir.path(),
            AUCTION_INTENT,
            "layer1:inventado:x",
            "accepted",
            "",
            None,
        )
        .expect_err("recusa");

        assert!(error.contains("finding desconhecido"), "{error}");
    }

    /// Accepting records the artifact it produced, so the trail is followable —
    /// and NOTHING here touches the intent text.
    #[test]
    fn accepting_records_the_artifact_and_never_rewrites_the_intent() {
        let dir = project();
        let snapshot = review_snapshot(dir.path(), AUCTION_INTENT, None).expect("snapshot");
        let id = snapshot.reviewed[0].finding.id.clone();

        let after = review(
            dir.path(),
            AUCTION_INTENT,
            &id,
            "accepted",
            "vale como convenção do projeto",
            Some("guidance-000003"),
        )
        .expect("review");

        let entry = after
            .reviewed
            .iter()
            .find(|entry| entry.finding.id == id)
            .expect("finding");
        assert_eq!(entry.finding.review_state, ReviewState::Accepted);
        assert_eq!(
            entry.decision.as_ref().unwrap().artifact.as_deref(),
            Some("guidance-000003")
        );
        // The intent hash is unchanged, which is the mechanical way of saying the
        // text was not rewritten.
        assert_eq!(
            after.report.content_hash,
            snapshot.report.content_hash,
            "aceitar não pode reescrever a intenção"
        );
    }
}
