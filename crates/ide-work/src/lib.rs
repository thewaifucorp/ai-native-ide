//! §9 — Features, Tasks and the status nobody is allowed to type.
//!
//! The whole point of this crate is that **status is derived, never written**. A
//! person (or an agent) writes what is true — the criteria, what implements them,
//! and the evidence a verification produced — and the status is a function of
//! those facts plus what the material looks like NOW. Nothing here can be set to
//! `Verified` by claiming it.
//!
//! # The two rules this exists to enforce
//!
//! * **A finished task does not promote its feature.** A feature is only verified
//!   when its own criteria are verified too. Children finishing is not evidence
//!   about the parent; it is evidence about the children.
//! * **A relevant change makes old proof stale.** Evidence records the hash of
//!   the material it was taken over. When that material moves, the evidence stops
//!   counting and says so — it is not silently kept, and it is not deleted
//!   either. Same shape §8 uses for intent (`content_hash`) and §7 for notes
//!   (`supersededBy`): one pattern, not three.
//!
//! # Shell-neutral, like the other engines
//!
//! This crate reads no disk and runs no check. The host supplies the items and a
//! map of `subject -> current hash`; the engine answers what that means. A
//! subject the host did not observe is NOT assumed unchanged — it is reported as
//! unobserved, and evidence over it cannot claim freshness.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Where an item sits in the hierarchy. `Subtask` is optional by design: a task
/// may be direct, and a task may serve more than one feature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkKind {
    Feature,
    Task,
    Subtask,
}

/// What a verification produced, and over WHAT material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    /// Whether the verification passed. A failing verification is still evidence.
    pub passed: bool,
    /// When it was taken (host clock, ms). Carried for display, never for truth.
    pub at_ms: u64,
    /// The subject the proof was taken over — a path, a check id, whatever the
    /// host can hash later to ask "is this still the same material?".
    pub subject: String,
    /// Hash of that subject AT PROOF TIME. The comparison against the current
    /// hash is what makes proof go stale instead of lying.
    pub subject_hash: String,
    /// Free text: what was run, what was seen.
    pub note: String,
}

/// One acceptance criterion of an item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Criterion {
    pub id: String,
    pub text: String,
    /// Evidence for this criterion, when a verification already ran.
    #[serde(default)]
    pub evidence: Option<Evidence>,
    /// True when an AGENT proposed this criterion and no person adopted it yet.
    ///
    /// A proposed criterion is SHOWN and does not count: letting an agent's
    /// proposal change a status would let it verify its own work by writing more
    /// criteria. Adopting it is an edit to the artifact — the same door a person
    /// already uses.
    #[serde(default)]
    pub proposed: bool,
}

/// One work item, exactly as the artifact declares it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub id: String,
    pub title: String,
    pub kind: WorkKind,
    /// Ids of the items this one serves. Empty for a direct task; more than one
    /// for a task that serves several features — both are valid.
    #[serde(default)]
    pub parents: Vec<String>,
    #[serde(default)]
    pub criteria: Vec<Criterion>,
    /// Subjects that implement this item (paths, check ids). Their presence is
    /// what separates "not started" from "implemented but not verified".
    #[serde(default)]
    pub implementation: Vec<String>,
    /// Set when someone declared this item blocked, with the reason. A blocked
    /// item is never reported as progressing.
    #[serde(default)]
    pub blocked: Option<String>,
}

/// The seven states §9 asks for. None of them is writable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkStatus {
    NotStarted,
    InProgress,
    ImplementedNotVerified,
    PartiallyVerified,
    Verified,
    Blocked,
    /// Proof exists but the material it was taken over has changed since.
    EvidenceStale,
}

/// A computed status plus the reason it came out that way. The reason is not
/// decoration: a status nobody can explain is indistinguishable from one somebody
/// typed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub id: String,
    pub status: WorkStatus,
    pub reason: String,
    /// Criteria that count (proposed ones excluded), and how many are verified.
    pub criteria_total: usize,
    pub criteria_verified: usize,
    /// Criteria whose evidence went stale, by criterion id.
    pub stale_criteria: Vec<String>,
    /// Subjects the host did not observe, so freshness could not be checked.
    pub unobserved_subjects: Vec<String>,
    /// Criteria an agent proposed and nobody adopted. Counted nowhere.
    pub proposed_criteria: usize,
    /// Children that took part in this status, for a parent.
    pub children: Vec<String>,
}

/// Why a set of items could not be read as a hierarchy. Reported, never guessed
/// around: a cycle silently broken would produce a status about a shape nobody
/// declared.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyProblem {
    pub id: String,
    pub problem: String,
}

/// Everything a §9 surface renders in one pass.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkReport {
    pub statuses: Vec<StatusReport>,
    pub problems: Vec<HierarchyProblem>,
}

/// How one criterion stands right now.
enum CriterionState {
    /// No verification ran.
    Unverified,
    /// Verification ran and passed over material that has not changed.
    Fresh,
    /// Verification ran and failed.
    Failed,
    /// Verification ran, but the material moved since.
    Stale,
    /// Verification ran and the host did not observe the subject, so freshness
    /// is unknown. Treated as stale: an unknown is not a pass.
    Unobserved,
}

fn criterion_state(criterion: &Criterion, observed: &BTreeMap<String, String>) -> CriterionState {
    let Some(evidence) = &criterion.evidence else {
        return CriterionState::Unverified;
    };
    if !evidence.passed {
        return CriterionState::Failed;
    }
    match observed.get(&evidence.subject) {
        None => CriterionState::Unobserved,
        Some(current) if *current == evidence.subject_hash => CriterionState::Fresh,
        Some(_) => CriterionState::Stale,
    }
}

/// Computes the status of every item.
///
/// `observed` maps a subject to its CURRENT hash, as the host measured it now. A
/// subject missing from the map is unobserved, not unchanged.
pub fn report(items: &[WorkItem], observed: &BTreeMap<String, String>) -> WorkReport {
    let mut problems = Vec::new();
    let by_id: BTreeMap<&str, &WorkItem> =
        items.iter().map(|item| (item.id.as_str(), item)).collect();

    // Children, by parent. A parent named by nobody is a fine leaf; a parent that
    // does not exist is a problem the surface has to see.
    let mut children: BTreeMap<&str, Vec<&WorkItem>> = BTreeMap::new();
    for item in items {
        for parent in &item.parents {
            match by_id.get(parent.as_str()) {
                Some(_) => children.entry(parent.as_str()).or_default().push(item),
                None => problems.push(HierarchyProblem {
                    id: item.id.clone(),
                    problem: format!("aponta para o item {parent}, que não existe"),
                }),
            }
        }
    }

    let mut statuses: Vec<StatusReport> = Vec::new();
    for item in items {
        let mut seen = BTreeSet::new();
        match status_of(item, &by_id, &children, observed, &mut seen) {
            Ok(report) => statuses.push(report),
            Err(problem) => {
                problems.push(problem);
                statuses.push(StatusReport {
                    id: item.id.clone(),
                    status: WorkStatus::Blocked,
                    reason: "hierarquia com ciclo: o status não pode ser calculado".to_string(),
                    criteria_total: 0,
                    criteria_verified: 0,
                    stale_criteria: Vec::new(),
                    unobserved_subjects: Vec::new(),
                    proposed_criteria: 0,
                    children: Vec::new(),
                });
            }
        }
    }
    statuses.sort_by(|a, b| a.id.cmp(&b.id));
    problems
        .sort_by(|a, b| (a.id.clone(), a.problem.clone()).cmp(&(b.id.clone(), b.problem.clone())));
    WorkReport { statuses, problems }
}

fn status_of<'a>(
    item: &'a WorkItem,
    by_id: &BTreeMap<&'a str, &'a WorkItem>,
    children: &BTreeMap<&'a str, Vec<&'a WorkItem>>,
    observed: &BTreeMap<String, String>,
    seen: &mut BTreeSet<String>,
) -> Result<StatusReport, HierarchyProblem> {
    if !seen.insert(item.id.clone()) {
        return Err(HierarchyProblem {
            id: item.id.clone(),
            problem: "ciclo na hierarquia — um item é ancestral de si mesmo".to_string(),
        });
    }

    let counted: Vec<&Criterion> = item.criteria.iter().filter(|c| !c.proposed).collect();
    let proposed_criteria = item.criteria.len() - counted.len();

    let mut verified = 0usize;
    let mut failed = 0usize;
    let mut stale_criteria = Vec::new();
    let mut unobserved_subjects = Vec::new();
    for criterion in &counted {
        match criterion_state(criterion, observed) {
            CriterionState::Fresh => verified += 1,
            CriterionState::Failed => failed += 1,
            CriterionState::Stale => stale_criteria.push(criterion.id.clone()),
            CriterionState::Unobserved => {
                stale_criteria.push(criterion.id.clone());
                if let Some(evidence) = &criterion.evidence {
                    unobserved_subjects.push(evidence.subject.clone());
                }
            }
            CriterionState::Unverified => {}
        }
    }

    // Children first: a parent's status is a function of its own facts AND of
    // what its children are, and a child's problem is the parent's problem.
    let mut child_reports = Vec::new();
    for child in children.get(item.id.as_str()).into_iter().flatten() {
        child_reports.push(status_of(child, by_id, children, observed, seen)?);
    }
    seen.remove(&item.id);
    let child_ids: Vec<String> = child_reports.iter().map(|r| r.id.clone()).collect();

    let base = StatusReport {
        id: item.id.clone(),
        status: WorkStatus::NotStarted,
        reason: String::new(),
        criteria_total: counted.len(),
        criteria_verified: verified,
        stale_criteria: stale_criteria.clone(),
        unobserved_subjects: unobserved_subjects.clone(),
        proposed_criteria,
        children: child_ids,
    };

    // 1. Declared blocked wins over everything: an item nobody can advance is not
    //    "in progress" because someone wrote code near it.
    if let Some(reason) = &item.blocked {
        return Ok(StatusReport {
            status: WorkStatus::Blocked,
            reason: format!("bloqueado: {reason}"),
            ..base
        });
    }
    if let Some(blocked_child) = child_reports
        .iter()
        .find(|r| r.status == WorkStatus::Blocked)
    {
        return Ok(StatusReport {
            status: WorkStatus::Blocked,
            reason: format!("bloqueado por {}", blocked_child.id),
            ..base
        });
    }

    // 2. Stale proof is louder than a good status: a `verified` computed over
    //    material that moved is exactly the lie this section exists to kill.
    if !stale_criteria.is_empty() {
        let unobserved = !unobserved_subjects.is_empty();
        return Ok(StatusReport {
            status: WorkStatus::EvidenceStale,
            reason: if unobserved {
                format!(
                    "prova sobre material que o host não observou ({}): frescor desconhecido não é aprovação",
                    unobserved_subjects.join(", ")
                )
            } else {
                format!(
                    "{} critério(s) provados sobre material que mudou depois",
                    stale_criteria.len()
                )
            },
            ..base
        });
    }
    if let Some(stale_child) = child_reports
        .iter()
        .find(|r| r.status == WorkStatus::EvidenceStale)
    {
        return Ok(StatusReport {
            status: WorkStatus::EvidenceStale,
            reason: format!("prova desatualizada em {}", stale_child.id),
            ..base
        });
    }

    let children_all_verified = !child_reports.is_empty()
        && child_reports
            .iter()
            .all(|r| r.status == WorkStatus::Verified);
    let children_any_progress = child_reports
        .iter()
        .any(|r| r.status != WorkStatus::NotStarted);

    // 3. Verified requires this item's OWN criteria to be verified. A parent
    //    whose children are all done but whose own criteria are not proved is
    //    NOT verified — "task concluída não promove feature", literally.
    if counted.is_empty() {
        if !child_reports.is_empty() {
            return Ok(StatusReport {
                status: if children_all_verified {
                    WorkStatus::ImplementedNotVerified
                } else if children_any_progress {
                    WorkStatus::InProgress
                } else {
                    WorkStatus::NotStarted
                },
                reason: if children_all_verified {
                    "filhos verificados, mas este item não declara critério próprio: \
                     concluir filho não promove o pai"
                        .to_string()
                } else if children_any_progress {
                    "filhos em andamento".to_string()
                } else {
                    "nada começou".to_string()
                },
                ..base
            });
        }
        return Ok(StatusReport {
            status: if item.implementation.is_empty() {
                WorkStatus::NotStarted
            } else {
                WorkStatus::ImplementedNotVerified
            },
            reason: if item.implementation.is_empty() {
                "sem critério e sem implementação declarada".to_string()
            } else {
                format!(
                    "{} implementação(ões) declarada(s) e nenhum critério para verificar",
                    item.implementation.len()
                )
            },
            ..base
        });
    }

    if verified == counted.len() {
        if !child_reports.is_empty() && !children_all_verified {
            return Ok(StatusReport {
                status: WorkStatus::PartiallyVerified,
                reason: "critérios próprios verificados, mas há filho não verificado".to_string(),
                ..base
            });
        }
        return Ok(StatusReport {
            status: WorkStatus::Verified,
            reason: format!(
                "{verified}/{} critérios verificados com prova fresca",
                counted.len()
            ),
            ..base
        });
    }
    if verified > 0 {
        return Ok(StatusReport {
            status: WorkStatus::PartiallyVerified,
            reason: format!("{verified}/{} critérios verificados", counted.len()),
            ..base
        });
    }
    if failed > 0 {
        return Ok(StatusReport {
            status: WorkStatus::InProgress,
            reason: format!("{failed} critério(s) verificados e REPROVADOS"),
            ..base
        });
    }
    Ok(StatusReport {
        status: if !item.implementation.is_empty() {
            WorkStatus::ImplementedNotVerified
        } else if children_any_progress {
            WorkStatus::InProgress
        } else {
            WorkStatus::NotStarted
        },
        reason: if !item.implementation.is_empty() {
            format!(
                "implementado ({}) e nenhum dos {} critérios foi verificado",
                item.implementation.join(", "),
                counted.len()
            )
        } else if children_any_progress {
            "filhos em andamento, nada verificado aqui".to_string()
        } else {
            format!(
                "{} critério(s) declarados, nada implementado",
                counted.len()
            )
        },
        ..base
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observed(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    fn criterion(id: &str, evidence: Option<Evidence>) -> Criterion {
        Criterion {
            id: id.to_string(),
            text: format!("critério {id}"),
            evidence,
            proposed: false,
        }
    }

    fn passing(subject: &str, hash: &str) -> Evidence {
        Evidence {
            passed: true,
            at_ms: 1,
            subject: subject.to_string(),
            subject_hash: hash.to_string(),
            note: "rodou e passou".to_string(),
        }
    }

    fn item(id: &str, kind: WorkKind) -> WorkItem {
        WorkItem {
            id: id.to_string(),
            title: format!("item {id}"),
            kind,
            parents: Vec::new(),
            criteria: Vec::new(),
            implementation: Vec::new(),
            blocked: None,
        }
    }

    fn status(report: &WorkReport, id: &str) -> WorkStatus {
        report
            .statuses
            .iter()
            .find(|s| s.id == id)
            .unwrap_or_else(|| panic!("sem status para {id}"))
            .status
    }

    #[test]
    fn nothing_declared_is_not_started() {
        let report = report(&[item("t1", WorkKind::Task)], &observed(&[]));
        assert_eq!(status(&report, "t1"), WorkStatus::NotStarted);
    }

    #[test]
    fn implementation_without_verification_says_exactly_that() {
        let mut task = item("t1", WorkKind::Task);
        task.implementation = vec!["src/a.rs".to_string()];
        task.criteria = vec![criterion("c1", None)];

        let report = report(&[task], &observed(&[]));

        assert_eq!(status(&report, "t1"), WorkStatus::ImplementedNotVerified);
    }

    #[test]
    fn partial_and_full_verification_are_different_states() {
        let mut task = item("t1", WorkKind::Task);
        task.criteria = vec![
            criterion("c1", Some(passing("src/a.rs", "h1"))),
            criterion("c2", None),
        ];
        let partial = report(&[task.clone()], &observed(&[("src/a.rs", "h1")]));
        assert_eq!(status(&partial, "t1"), WorkStatus::PartiallyVerified);

        task.criteria[1] = criterion("c2", Some(passing("src/b.rs", "h2")));
        let full = report(
            &[task],
            &observed(&[("src/a.rs", "h1"), ("src/b.rs", "h2")]),
        );
        assert_eq!(status(&full, "t1"), WorkStatus::Verified);
    }

    /// A regra que o §9 pede em uma linha: mudou o material, a prova velha para
    /// de valer — e o item diz isso em vez de continuar `verified`.
    #[test]
    fn a_relevant_change_makes_old_proof_stale() {
        let mut task = item("t1", WorkKind::Task);
        task.criteria = vec![criterion("c1", Some(passing("src/a.rs", "h1")))];

        let fresh = report(&[task.clone()], &observed(&[("src/a.rs", "h1")]));
        assert_eq!(status(&fresh, "t1"), WorkStatus::Verified);

        let moved = report(&[task], &observed(&[("src/a.rs", "OUTRO")]));
        assert_eq!(status(&moved, "t1"), WorkStatus::EvidenceStale);
        let entry = moved.statuses.iter().find(|s| s.id == "t1").unwrap();
        assert_eq!(entry.stale_criteria, vec!["c1".to_string()]);
        assert!(entry.reason.contains("mudou depois"));
    }

    /// Não observar não é aprovar. Frescor desconhecido conta como desatualizado.
    #[test]
    fn an_unobserved_subject_cannot_claim_freshness() {
        let mut task = item("t1", WorkKind::Task);
        task.criteria = vec![criterion("c1", Some(passing("src/a.rs", "h1")))];

        let report = report(&[task], &observed(&[]));

        assert_eq!(status(&report, "t1"), WorkStatus::EvidenceStale);
        let entry = report.statuses.iter().find(|s| s.id == "t1").unwrap();
        assert_eq!(entry.unobserved_subjects, vec!["src/a.rs".to_string()]);
    }

    /// A outra regra literal do §9: filho concluído NÃO promove o pai.
    #[test]
    fn finishing_every_task_does_not_verify_the_feature() {
        let feature = item("f1", WorkKind::Feature);
        let mut task = item("t1", WorkKind::Task);
        task.parents = vec!["f1".to_string()];
        task.criteria = vec![criterion("c1", Some(passing("src/a.rs", "h1")))];

        let report = report(&[feature, task], &observed(&[("src/a.rs", "h1")]));

        assert_eq!(status(&report, "t1"), WorkStatus::Verified);
        assert_eq!(status(&report, "f1"), WorkStatus::ImplementedNotVerified);
        let entry = report.statuses.iter().find(|s| s.id == "f1").unwrap();
        assert!(entry.reason.contains("não promove o pai"));
    }

    #[test]
    fn a_feature_with_its_own_verified_criteria_and_verified_children_is_verified() {
        let mut feature = item("f1", WorkKind::Feature);
        feature.criteria = vec![criterion("fc1", Some(passing("docs/f1.md", "h9")))];
        let mut task = item("t1", WorkKind::Task);
        task.parents = vec!["f1".to_string()];
        task.criteria = vec![criterion("c1", Some(passing("src/a.rs", "h1")))];

        let report = report(
            &[feature, task],
            &observed(&[("src/a.rs", "h1"), ("docs/f1.md", "h9")]),
        );

        assert_eq!(status(&report, "f1"), WorkStatus::Verified);
    }

    #[test]
    fn a_feature_whose_own_criteria_pass_but_child_does_not_is_only_partial() {
        let mut feature = item("f1", WorkKind::Feature);
        feature.criteria = vec![criterion("fc1", Some(passing("docs/f1.md", "h9")))];
        let mut task = item("t1", WorkKind::Task);
        task.parents = vec!["f1".to_string()];
        task.implementation = vec!["src/a.rs".to_string()];

        let report = report(&[feature, task], &observed(&[("docs/f1.md", "h9")]));

        assert_eq!(status(&report, "f1"), WorkStatus::PartiallyVerified);
    }

    /// Task multi-feature e task direta são as duas válidas.
    #[test]
    fn a_task_may_serve_several_features_and_counts_for_each() {
        let f1 = item("f1", WorkKind::Feature);
        let f2 = item("f2", WorkKind::Feature);
        let mut task = item("t1", WorkKind::Task);
        task.parents = vec!["f1".to_string(), "f2".to_string()];
        task.criteria = vec![criterion("c1", Some(passing("src/a.rs", "h1")))];

        let report = report(&[f1, f2, task], &observed(&[("src/a.rs", "h1")]));

        for feature in ["f1", "f2"] {
            let entry = report.statuses.iter().find(|s| s.id == feature).unwrap();
            assert_eq!(entry.children, vec!["t1".to_string()]);
            assert_eq!(entry.status, WorkStatus::ImplementedNotVerified);
        }
    }

    #[test]
    fn a_blocked_item_blocks_its_parent_and_names_who() {
        let feature = item("f1", WorkKind::Feature);
        let mut task = item("t1", WorkKind::Task);
        task.parents = vec!["f1".to_string()];
        task.blocked = Some("falta credencial do provedor".to_string());

        let report = report(&[feature, task], &observed(&[]));

        assert_eq!(status(&report, "t1"), WorkStatus::Blocked);
        assert_eq!(status(&report, "f1"), WorkStatus::Blocked);
        let entry = report.statuses.iter().find(|s| s.id == "f1").unwrap();
        assert!(entry.reason.contains("t1"));
    }

    /// Critério proposto por agente aparece e não conta: senão o agente
    /// verificaria o próprio trabalho escrevendo mais critérios.
    #[test]
    fn a_proposed_criterion_is_shown_and_counted_nowhere() {
        let mut task = item("t1", WorkKind::Task);
        task.criteria = vec![
            criterion("c1", Some(passing("src/a.rs", "h1"))),
            Criterion {
                proposed: true,
                ..criterion("c2", None)
            },
        ];

        let report = report(&[task], &observed(&[("src/a.rs", "h1")]));

        let entry = report.statuses.iter().find(|s| s.id == "t1").unwrap();
        assert_eq!(entry.status, WorkStatus::Verified);
        assert_eq!(entry.criteria_total, 1);
        assert_eq!(entry.proposed_criteria, 1);
    }

    #[test]
    fn failing_evidence_is_progress_never_verification() {
        let mut task = item("t1", WorkKind::Task);
        task.criteria = vec![criterion(
            "c1",
            Some(Evidence {
                passed: false,
                ..passing("src/a.rs", "h1")
            }),
        )];

        let report = report(&[task], &observed(&[("src/a.rs", "h1")]));

        assert_eq!(status(&report, "t1"), WorkStatus::InProgress);
        let entry = report.statuses.iter().find(|s| s.id == "t1").unwrap();
        assert!(entry.reason.contains("REPROVADOS"));
    }

    #[test]
    fn a_parent_that_does_not_exist_is_a_reported_problem() {
        let mut task = item("t1", WorkKind::Task);
        task.parents = vec!["fantasma".to_string()];

        let report = report(&[task], &observed(&[]));

        assert_eq!(report.problems.len(), 1);
        assert!(report.problems[0].problem.contains("fantasma"));
    }

    #[test]
    fn a_cycle_is_reported_instead_of_silently_broken() {
        let mut a = item("a", WorkKind::Feature);
        let mut b = item("b", WorkKind::Task);
        a.parents = vec!["b".to_string()];
        b.parents = vec!["a".to_string()];

        let report = report(&[a, b], &observed(&[]));

        assert!(!report.problems.is_empty());
        assert!(report.problems.iter().any(|p| p.problem.contains("ciclo")));
    }
}
