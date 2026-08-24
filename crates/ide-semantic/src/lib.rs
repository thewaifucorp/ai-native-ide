//! Layer-1 semantic evaluators for the AI-Native IDE.
//!
//! These evaluators read the declared intent and surface ambiguities, missing
//! decisions and domain risks *before* they become bad code. This first slice is
//! deterministic — it runs no paid inference and never runs in idle — but unlike
//! Layer 0 its findings are hypotheses: each carries an explicit claim, the
//! evidence that triggered it, a calibrated confidence, a severity, a
//! remediation and a review state. A budget bounds how many findings are
//! surfaced, and a content hash lets the host cache unchanged intent.

use ide_harness::Severity;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingCategory {
    Ambiguity,
    MissingDecision,
    Risk,
}

/// A finding is a hypothesis until a human reviews it. It is never auto-accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewState {
    Open,
    Accepted,
    Dismissed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticFinding {
    pub id: String,
    pub evaluator: &'static str,
    pub evaluator_version: &'static str,
    pub layer: u8,
    pub category: FindingCategory,
    pub claim: &'static str,
    /// The exact text that triggered the finding, so it is never a bare guess.
    pub evidence: String,
    /// Calibrated 0.0–1.0. Deterministic keyword rules stay deliberately modest.
    pub confidence: f64,
    pub severity: Severity,
    pub remediation: &'static str,
    pub review_state: ReviewState,
}

/// Bounds how many findings are surfaced at once. Nothing paid runs in idle, and
/// a low budget withholds the least severe findings rather than inventing more.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationBudget {
    pub max_findings: usize,
}

impl Default for EvaluationBudget {
    fn default() -> Self {
        Self { max_findings: 6 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticReport {
    pub findings: Vec<SemanticFinding>,
    pub withheld_for_budget: usize,
    pub evaluators_run: Vec<&'static str>,
    /// Stable hash of the evaluated intent, so the host can skip re-evaluation.
    pub content_hash: String,
}

struct Rule {
    evaluator: &'static str,
    category: FindingCategory,
    severity: Severity,
    confidence: f64,
    terms: &'static [&'static str],
    claim: &'static str,
    remediation: &'static str,
}

const RULES: &[Rule] = &[
    Rule {
        evaluator: "auction-concurrency",
        category: FindingCategory::Risk,
        severity: Severity::High,
        confidence: 0.7,
        terms: &["leilão", "leilao", "lance", "lances", "leaderboard", "ingresso"],
        claim: "Lances/posições concorrentes podem gerar corrida sem controle transacional.",
        remediation: "Defina como dois lances simultâneos são serializados e qual vence o desempate.",
    },
    Rule {
        evaluator: "account-enumeration",
        category: FindingCategory::Risk,
        severity: Severity::Medium,
        confidence: 0.6,
        terms: &["senha", "recuperação", "recuperacao", "login", "reset"],
        claim: "Recuperação/login pode permitir enumeração de contas.",
        remediation: "Padronize respostas e rate-limit para não revelar se a conta existe.",
    },
    Rule {
        evaluator: "payment-decisions",
        category: FindingCategory::MissingDecision,
        severity: Severity::High,
        confidence: 0.6,
        terms: &["pagamento", "pagar", "checkout", "cobrança", "cobranca", "assinatura"],
        claim: "Fluxo de pagamento sem decisões de split, reembolso e cancelamento.",
        remediation: "Decida split de pagamento, política de reembolso e cancelamento antes do efeito durável.",
    },
    Rule {
        evaluator: "pii-consent",
        category: FindingCategory::Risk,
        severity: Severity::High,
        confidence: 0.55,
        terms: &["localização", "localizacao", "dados pessoais", "menor", "criança", "crianca", "cpf"],
        claim: "Coleta de dados pessoais/sensíveis sem fluxo de consentimento coerente.",
        remediation: "Defina consentimento, base legal e minimização antes de coletar o dado.",
    },
    Rule {
        evaluator: "upload-bounds",
        category: FindingCategory::MissingDecision,
        severity: Severity::Medium,
        confidence: 0.5,
        terms: &["upload", "arquivo", "imagem", "anexo"],
        claim: "Upload sem limites de tipo/tamanho definidos.",
        remediation: "Decida tipos permitidos, limite de tamanho e verificação de conteúdo.",
    },
    Rule {
        evaluator: "vague-intent",
        category: FindingCategory::Ambiguity,
        severity: Severity::Low,
        confidence: 0.4,
        terms: &["etc", "essas coisas", "algo", "sei lá", "sei la"],
        claim: "A intenção contém termos vagos que escondem decisões.",
        remediation: "Substitua os termos vagos por requisitos observáveis.",
    },
];

fn djb2(input: &str) -> u64 {
    let mut hash: u64 = 5381;
    for byte in input.bytes() {
        hash = (hash.wrapping_mul(33)) ^ u64::from(byte);
    }
    hash
}

/// Runs the deterministic Layer-1 evaluators over `intent`, honestly reporting
/// which ran and how many findings were withheld for the budget.
pub fn evaluate(intent: &str, budget: EvaluationBudget) -> SemanticReport {
    let haystack = intent.to_lowercase();
    let mut candidates: Vec<SemanticFinding> = Vec::new();
    let mut evaluators_run: Vec<&'static str> = Vec::new();
    for rule in RULES {
        evaluators_run.push(rule.evaluator);
        if let Some(term) = rule.terms.iter().find(|term| haystack.contains(**term)) {
            candidates.push(SemanticFinding {
                id: format!("layer1:{}:{term}", rule.evaluator),
                evaluator: rule.evaluator,
                evaluator_version: "1",
                layer: 1,
                category: rule.category,
                claim: rule.claim,
                evidence: format!("intenção menciona \"{term}\""),
                confidence: rule.confidence,
                severity: rule.severity,
                remediation: rule.remediation,
                review_state: ReviewState::Open,
            });
        }
    }
    // Most severe, then most confident, surface first; the budget withholds the
    // rest rather than dropping high-severity findings.
    candidates.sort_by(|left, right| {
        right
            .severity
            .cmp(&left.severity)
            .then(right.confidence.total_cmp(&left.confidence))
            .then(left.id.cmp(&right.id))
    });
    let withheld_for_budget = candidates.len().saturating_sub(budget.max_findings);
    candidates.truncate(budget.max_findings);
    SemanticReport {
        findings: candidates,
        withheld_for_budget,
        evaluators_run,
        content_hash: format!("{:016x}", djb2(intent)),
    }
}

/// Stable content hash the host can compare to skip re-evaluating unchanged
/// intent, keeping paid work (in a later model-backed layer) off the idle path.
pub fn content_hash(intent: &str) -> String {
    format!("{:016x}", djb2(intent))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auction_intent_surfaces_a_high_severity_concurrency_risk() {
        let report = evaluate(
            "Quero um leilão de posições com lances concorrentes",
            EvaluationBudget::default(),
        );
        let risk = report
            .findings
            .iter()
            .find(|finding| finding.evaluator == "auction-concurrency")
            .expect("auction concurrency risk is surfaced");
        assert_eq!(risk.category, FindingCategory::Risk);
        assert_eq!(risk.severity, Severity::High);
        assert!(risk.confidence > 0.0 && risk.confidence <= 1.0);
        assert!(risk.evidence.contains("leilão"));
        assert_eq!(risk.review_state, ReviewState::Open);
    }

    #[test]
    fn empty_intent_yields_no_findings_but_still_reports_evaluators() {
        let report = evaluate("", EvaluationBudget::default());
        assert!(report.findings.is_empty());
        assert!(!report.evaluators_run.is_empty());
    }

    #[test]
    fn budget_withholds_least_severe_findings_first() {
        let intent = "leilão com pagamento, upload de arquivo e termos vagos etc";
        let report = evaluate(intent, EvaluationBudget { max_findings: 1 });
        assert_eq!(report.findings.len(), 1);
        assert!(report.withheld_for_budget >= 1);
        // The single surfaced finding is the highest severity (a High risk),
        // never the low-severity vague-intent one.
        assert_eq!(report.findings[0].severity, Severity::High);
    }

    #[test]
    fn content_hash_is_stable_and_changes_with_intent() {
        assert_eq!(content_hash("abc"), content_hash("abc"));
        assert_ne!(content_hash("abc"), content_hash("abd"));
    }
}
