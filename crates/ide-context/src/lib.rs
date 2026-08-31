//! Deterministic context compiler for the AI-Native IDE.
//!
//! Agents never receive every file. The compiler selects, orders and budgets the
//! context for the current activity with explicit provenance, and preserves
//! policies, requirements and blocking guidance verbatim — those are never
//! compressed or dropped to fit a budget. It also maps a subject to its source
//! of truth, authorities and evidence so navigation stays honest.

use ide_guidance::{AppliedGuidance, GuidanceStrength, TruthDeclaration};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceRef {
    pub id: String,
    pub summary: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInputs {
    pub intent: String,
    pub applied_guidance: Vec<AppliedGuidance>,
    pub truth: Vec<TruthDeclaration>,
    pub evidence: Vec<EvidenceRef>,
    pub budget_chars: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSegment {
    pub origin: String,
    pub scope: String,
    pub reason: String,
    pub text: String,
    /// Verbatim segments (policies, requirements, blocking/required guidance) are
    /// never compressed or dropped, even when the budget is exceeded.
    pub verbatim: bool,
    pub priority: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledContext {
    pub segments: Vec<ContextSegment>,
    pub dropped_for_budget: Vec<String>,
    pub used_chars: usize,
    pub budget_chars: usize,
}

/// Human-readable scope of a piece of guidance, for the segment's `scope`.
fn scope_label(scope: &ide_guidance::GuidanceScope) -> String {
    match scope {
        ide_guidance::GuidanceScope::Person => "pessoa".to_owned(),
        ide_guidance::GuidanceScope::Project { project_id } => format!("projeto {project_id}"),
        ide_guidance::GuidanceScope::Resource { resource_id } => {
            format!("recurso {resource_id}")
        }
        ide_guidance::GuidanceScope::Path { path } => format!("caminho {path}"),
        ide_guidance::GuidanceScope::Task { session_id } => format!("tarefa {session_id}"),
    }
}

fn guidance_priority(strength: GuidanceStrength) -> u8 {
    match strength {
        GuidanceStrength::Blocking => 100,
        GuidanceStrength::Required => 90,
        GuidanceStrength::Default => 55,
        GuidanceStrength::Suggestion => 45,
    }
}

fn guidance_is_verbatim(strength: GuidanceStrength) -> bool {
    matches!(
        strength,
        GuidanceStrength::Blocking | GuidanceStrength::Required
    )
}

/// Compiles the context deterministically: strongest and most authoritative
/// first, verbatim policies always kept, everything else dropped from the least
/// important end until the budget is met.
pub fn compile(inputs: &ContextInputs) -> CompiledContext {
    let mut segments: Vec<ContextSegment> = Vec::new();

    for applied in &inputs.applied_guidance {
        let strength = applied.guidance.strength;
        segments.push(ContextSegment {
            origin: format!("guidance:{}", applied.guidance.id),
            // The SCOPE the guidance declares, not a copy of the reason. Those are
            // different questions — "where does this apply" and "why is it here
            // now" — and duplicating the reason into both rendered the same
            // sentence twice on screen while hiding the scope entirely.
            scope: scope_label(&applied.guidance.scope),
            reason: applied.reason.clone(),
            text: applied.guidance.text.clone(),
            verbatim: guidance_is_verbatim(strength),
            priority: guidance_priority(strength),
        });
    }

    if !inputs.intent.trim().is_empty() {
        segments.push(ContextSegment {
            origin: "intent".to_owned(),
            scope: "projeto".to_owned(),
            reason: "intenção declarada do projeto".to_owned(),
            text: inputs.intent.clone(),
            verbatim: true,
            priority: 80,
        });
    }

    for declaration in &inputs.truth {
        segments.push(ContextSegment {
            origin: format!("truth:{}", declaration.id),
            scope: declaration.subject.clone(),
            reason: format!("autoridade sobre {}", declaration.subject),
            text: format!(
                "Autoridade de \"{}\": {}",
                declaration.subject, declaration.authority_path
            ),
            verbatim: true,
            priority: 70,
        });
    }

    for evidence in &inputs.evidence {
        segments.push(ContextSegment {
            origin: format!("evidence:{}", evidence.id),
            scope: evidence.source.clone(),
            reason: "evidência observada".to_owned(),
            text: evidence.summary.clone(),
            verbatim: false,
            priority: 40,
        });
    }

    // Most important first; ties are broken by origin for determinism.
    segments.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then(left.origin.cmp(&right.origin))
    });

    let mut kept: Vec<ContextSegment> = Vec::new();
    let mut dropped_for_budget: Vec<String> = Vec::new();
    let mut used_chars = 0usize;
    for segment in segments {
        let length = segment.text.chars().count();
        if segment.verbatim || used_chars + length <= inputs.budget_chars {
            used_chars += length;
            kept.push(segment);
        } else {
            dropped_for_budget.push(segment.origin);
        }
    }

    CompiledContext {
        segments: kept,
        dropped_for_budget,
        used_chars,
        budget_chars: inputs.budget_chars,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Authority {
    pub authority_path: String,
    pub precedence: i64,
    pub consumers: Vec<String>,
}

/// A code artifact or resource that implements a subject.
///
/// Implementation links are supplied to [`navigate`]; the crate never scans the
/// filesystem itself, consistent with how authorities and evidence are provided.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImplementationRef {
    /// Stable identifier of the implementation link.
    pub id: String,
    /// Subject (or resource) this implementation realises.
    pub subject: String,
    /// Where the implementation lives (path, service, environment, ...).
    pub location: String,
    /// Kind of implementation reference, e.g. `"code"`, `"service"`, `"environment"`.
    pub kind: String,
    /// How this link is known, kept for honest provenance.
    pub provenance: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Navigation {
    pub subject: String,
    pub authorities: Vec<Authority>,
    /// The implementation hop: code/resources that realise the subject. Empty
    /// (never absent) when no implementation link was supplied for the subject.
    pub implementations: Vec<ImplementationRef>,
    pub evidence: Vec<EvidenceRef>,
}

/// Maps a subject to its authorities (source of truth), the implementations that
/// realise it, and the evidence whose source references it, so a person can
/// navigate subject → SoT → implementation → evidence.
///
/// Implementation links are supplied by the caller (`implementations`); a subject
/// with no matching link degrades to an explicit empty-implementation state while
/// authorities and evidence are still returned.
pub fn navigate(
    inputs: &ContextInputs,
    subject: &str,
    implementations: &[ImplementationRef],
) -> Navigation {
    let mut authorities: Vec<Authority> = inputs
        .truth
        .iter()
        .filter(|declaration| declaration.subject == subject)
        .map(|declaration| Authority {
            authority_path: declaration.authority_path.clone(),
            precedence: declaration.precedence,
            consumers: declaration.consumers.clone(),
        })
        .collect();
    authorities.sort_by_key(|authority| std::cmp::Reverse(authority.precedence));
    let mut implementations: Vec<ImplementationRef> = implementations
        .iter()
        .filter(|implementation| implementation.subject == subject)
        .cloned()
        .collect();
    // Deterministic order regardless of caller input order.
    implementations.sort_by(|left, right| left.id.cmp(&right.id));
    let evidence = inputs
        .evidence
        .iter()
        .filter(|evidence| evidence.source.contains(subject))
        .cloned()
        .collect();
    Navigation {
        subject: subject.to_owned(),
        authorities,
        implementations,
        evidence,
    }
}

#[cfg(test)]
mod tests {
    // See `scope_of_a_segment_is_the_declared_scope` below: `scope` and `reason`
    // answer different questions and must not be the same string.

    use super::*;
    use ide_guidance::{
        Guidance, GuidanceApplication, GuidanceDuration, GuidanceOrigin, GuidanceScope,
        GuidanceState, GuidanceType,
    };

    fn applied(name: &str, strength: GuidanceStrength, text: &str) -> AppliedGuidance {
        AppliedGuidance {
            guidance: Guidance {
                id: name.to_owned(),
                name: name.to_owned(),
                guidance_type: GuidanceType::Policy,
                scope: GuidanceScope::Person,
                application: GuidanceApplication::General,
                strength,
                origin: GuidanceOrigin::Created,
                duration: GuidanceDuration::Permanent,
                priority: 0,
                owner: "local".to_owned(),
                provenance: "test".to_owned(),
                set: "policies".to_owned(),
                text: text.to_owned(),
                state: GuidanceState::Active,
                last_used_ms: 0,
            },
            reason: "escopo pessoal aplica".to_owned(),
        }
    }

    fn truth(subject: &str, path: &str, precedence: i64) -> TruthDeclaration {
        TruthDeclaration {
            id: format!("truth-{subject}"),
            subject: subject.to_owned(),
            scope: GuidanceScope::Person,
            authority_path: path.to_owned(),
            precedence,
            consumers: vec!["cart".to_owned()],
            provenance: "test".to_owned(),
        }
    }

    #[test]
    fn blocking_guidance_is_verbatim_and_never_dropped_by_budget() {
        let inputs = ContextInputs {
            intent: "construir checkout".to_owned(),
            applied_guidance: vec![
                applied(
                    "policy",
                    GuidanceStrength::Blocking,
                    "NUNCA registrar cartão",
                ),
                applied(
                    "pref",
                    GuidanceStrength::Suggestion,
                    "x".repeat(500).as_str(),
                ),
            ],
            truth: vec![],
            evidence: vec![],
            budget_chars: 10,
        };
        let compiled = compile(&inputs);
        // The blocking policy and the intent survive even though the budget is
        // tiny; the low-priority preference is dropped.
        assert!(compiled
            .segments
            .iter()
            .any(|segment| segment.origin == "guidance:policy" && segment.verbatim));
        assert!(compiled
            .segments
            .iter()
            .any(|segment| segment.origin == "intent"));
        assert!(compiled
            .dropped_for_budget
            .contains(&"guidance:pref".to_owned()));
    }

    #[test]
    fn compile_orders_by_priority() {
        let inputs = ContextInputs {
            intent: String::new(),
            applied_guidance: vec![
                applied("weak", GuidanceStrength::Suggestion, "a"),
                applied("strong", GuidanceStrength::Blocking, "b"),
            ],
            truth: vec![],
            evidence: vec![],
            budget_chars: 1000,
        };
        let compiled = compile(&inputs);
        assert_eq!(compiled.segments[0].origin, "guidance:strong");
    }

    fn implementation(id: &str, subject: &str, location: &str) -> ImplementationRef {
        ImplementationRef {
            id: id.to_owned(),
            subject: subject.to_owned(),
            location: location.to_owned(),
            kind: "code".to_owned(),
            provenance: "test".to_owned(),
        }
    }

    #[test]
    fn navigate_returns_all_four_hops_in_order() {
        let inputs = ContextInputs {
            intent: String::new(),
            applied_guidance: vec![],
            truth: vec![truth("checkout", "docs/checkout.md", 10)],
            evidence: vec![EvidenceRef {
                id: "e1".to_owned(),
                summary: "teste do checkout passou".to_owned(),
                source: "checkout-suite".to_owned(),
            }],
            budget_chars: 1000,
        };
        let implementations = vec![
            implementation("impl-b", "checkout", "src/checkout/pay.rs"),
            implementation("impl-a", "checkout", "src/checkout/cart.rs"),
            implementation("other", "billing", "src/billing.rs"),
        ];
        let navigation = navigate(&inputs, "checkout", &implementations);
        // Hop 1: subject.
        assert_eq!(navigation.subject, "checkout");
        // Hop 2: SoT/authorities.
        assert_eq!(navigation.authorities.len(), 1);
        assert_eq!(navigation.authorities[0].authority_path, "docs/checkout.md");
        // Hop 3: implementation — only matching subject, deterministically ordered.
        assert_eq!(navigation.implementations.len(), 2);
        assert_eq!(navigation.implementations[0].id, "impl-a");
        assert_eq!(navigation.implementations[1].id, "impl-b");
        // Hop 4: evidence.
        assert_eq!(navigation.evidence.len(), 1);
    }

    #[test]
    fn navigate_missing_implementation_degrades_to_empty_state() {
        let inputs = ContextInputs {
            intent: String::new(),
            applied_guidance: vec![],
            truth: vec![truth("checkout", "docs/checkout.md", 10)],
            evidence: vec![EvidenceRef {
                id: "e1".to_owned(),
                summary: "teste do checkout passou".to_owned(),
                source: "checkout-suite".to_owned(),
            }],
            budget_chars: 1000,
        };
        // No implementation link supplied for the subject: explicit empty hop,
        // never a panic; authorities and evidence are still present.
        let navigation = navigate(&inputs, "checkout", &[]);
        assert!(navigation.implementations.is_empty());
        assert_eq!(navigation.authorities.len(), 1);
        assert_eq!(navigation.evidence.len(), 1);
    }

    /// `scope` is WHERE the guidance applies; `reason` is WHY it was compiled
    /// now. They used to be the same string, which showed the reason twice and
    /// hid the scope.
    #[test]
    fn scope_of_a_segment_is_the_declared_scope() {
        use ide_guidance::{
            Guidance, GuidanceApplication, GuidanceDuration, GuidanceOrigin, GuidanceScope,
            GuidanceState, GuidanceStrength, GuidanceType,
        };
        let inputs = ContextInputs {
            intent: String::new(),
            applied_guidance: vec![AppliedGuidance {
                reason: "sugestão · projeto ativo corresponde".to_owned(),
                guidance: Guidance {
                    id: "g1".to_owned(),
                    name: "Desempate".to_owned(),
                    guidance_type: GuidanceType::Convention,
                    scope: GuidanceScope::Project {
                        project_id: "leilao".to_owned(),
                    },
                    application: GuidanceApplication::General,
                    strength: GuidanceStrength::Suggestion,
                    origin: GuidanceOrigin::Created,
                    duration: GuidanceDuration::Permanent,
                    priority: 0,
                    owner: "pessoa".to_owned(),
                    provenance: "AGENTS.md:6".to_owned(),
                    set: "project".to_owned(),
                    text: "exceder estritamente".to_owned(),
                    state: GuidanceState::Active,
                    last_used_ms: 0,
                },
            }],
            truth: Vec::new(),
            evidence: Vec::new(),
            budget_chars: 1_000,
        };

        let compiled = compile(&inputs);

        let segment = &compiled.segments[0];
        assert_eq!(segment.scope, "projeto leilao");
        assert_eq!(segment.reason, "sugestão · projeto ativo corresponde");
        assert_ne!(segment.scope, segment.reason);
    }
}
