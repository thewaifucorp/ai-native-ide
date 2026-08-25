//! Declarative domain packs for the AI-Native IDE.
//!
//! A pack is declarative data — checks, guides and declared capabilities — never
//! arbitrary native code. Packs are applied and reverted explicitly (the starter
//! pack is fully reversible), and readiness is evaluated at checkpoints such as
//! promotion or publication, not continuously. A finding can be corrected,
//! marked a false positive, or accepted as a scoped exception, all recorded
//! rather than enforced silently.

use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// What a pack is allowed to do. There is deliberately no native-execution
/// capability: a pack observes and guides, it never runs unrestricted code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackCapability {
    ReadWorkspace,
    RunDeterministicCheck,
    OfferGuidance,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackCheck {
    pub id: String,
    pub title: String,
    pub subject: String,
    pub criterion: String,
    pub layer: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackGuide {
    pub id: String,
    pub title: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    pub id: String,
    pub name: String,
    pub domain: String,
    pub description: String,
    pub checks: Vec<PackCheck>,
    pub guides: Vec<PackGuide>,
    pub capabilities: Vec<PackCapability>,
    pub reversible: bool,
}

/// The built-in, reversible starter pack for the auction/leaderboard benchmark.
pub fn auction_starter_pack() -> Pack {
    Pack {
        id: "auction-starter".to_owned(),
        name: "Leilão de posições — starter".to_owned(),
        domain: "auction".to_owned(),
        description:
            "Checks e guias para o benchmark de leilão/leaderboard: concorrência, privacidade e consistência."
                .to_owned(),
        checks: vec![
            PackCheck {
                id: "auction-concurrency".to_owned(),
                title: "Lances concorrentes são serializados".to_owned(),
                subject: "auction".to_owned(),
                criterion: "Dois lances simultâneos convergem para um único vencedor.".to_owned(),
                layer: 1,
            },
            PackCheck {
                id: "auction-privacy".to_owned(),
                title: "Leaderboard não vaza identidade do lance".to_owned(),
                subject: "auction".to_owned(),
                criterion: "A listagem pública não expõe o bidder_id.".to_owned(),
                layer: 0,
            },
        ],
        guides: vec![PackGuide {
            id: "auction-tiebreak".to_owned(),
            title: "Desempate".to_owned(),
            text: "Defina explicitamente o desempate: o lance precisa exceder estritamente o atual."
                .to_owned(),
        }],
        capabilities: vec![
            PackCapability::ReadWorkspace,
            PackCapability::RunDeterministicCheck,
            PackCapability::OfferGuidance,
        ],
        reversible: true,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessVerdict {
    pub pack_id: String,
    pub ready: bool,
    pub missing_checks: Vec<String>,
    pub failed_checks: Vec<String>,
    /// Failed checks that did not block because they carry an accepting
    /// disposition (false positive or scoped exception). Surfaced so the
    /// acceptance is reviewable rather than silently dropped.
    #[serde(default)]
    pub dispositioned_checks: Vec<String>,
    pub note: String,
}

/// Evaluates readiness at a checkpoint: ready only when every pack check is
/// observed as passed and none is failed. Unknown/absent checks block readiness
/// rather than being treated as a pass.
///
/// This is the disposition-free entry point; it is equivalent to
/// [`readiness_with_dispositions`] with an empty disposition map.
pub fn readiness(pack: &Pack, passed: &[String], failed: &[String]) -> ReadinessVerdict {
    readiness_with_dispositions(pack, passed, failed, &BTreeMap::new())
}

/// Evaluates readiness while honoring recorded finding dispositions.
///
/// A failed check whose finding carries an accepting disposition
/// ([`FindingDisposition::FalsePositive`] or [`FindingDisposition::ScopedException`])
/// no longer blocks readiness, but is reported under
/// [`ReadinessVerdict::dispositioned_checks`] so the acceptance stays visible.
/// A [`FindingDisposition::Corrected`] disposition is informational only: a
/// still-failing check keeps blocking. Missing/unknown checks always block,
/// regardless of any disposition — unknown is never treated as a pass.
pub fn readiness_with_dispositions(
    pack: &Pack,
    passed: &[String],
    failed: &[String],
    dispositions: &BTreeMap<String, DispositionRecord>,
) -> ReadinessVerdict {
    let mut missing_checks = Vec::new();
    let mut failed_checks = Vec::new();
    let mut dispositioned_checks = Vec::new();
    for check in &pack.checks {
        if failed.contains(&check.id) {
            let accepted = matches!(
                dispositions
                    .get(&check.id)
                    .map(|record| &record.disposition),
                Some(FindingDisposition::FalsePositive)
                    | Some(FindingDisposition::ScopedException { .. })
            );
            if accepted {
                dispositioned_checks.push(check.id.clone());
            } else {
                failed_checks.push(check.id.clone());
            }
        } else if !passed.contains(&check.id) {
            missing_checks.push(check.id.clone());
        }
    }
    let ready = missing_checks.is_empty() && failed_checks.is_empty();
    let note = if !ready {
        "Readiness bloqueada: checks pendentes ou falhos não contam como aprovação.".to_owned()
    } else if dispositioned_checks.is_empty() {
        "Todos os checks do pack passaram nesta verificação.".to_owned()
    } else {
        "Readiness liberada: findings aceitos por disposição registrada (revisáveis).".to_owned()
    };
    ReadinessVerdict {
        pack_id: pack.id.clone(),
        ready,
        missing_checks,
        failed_checks,
        dispositioned_checks,
        note,
    }
}

/// How a user dispositions a pack finding, recorded and reversible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum FindingDisposition {
    Corrected,
    FalsePositive,
    ScopedException {
        scope: String,
        justification: String,
    },
}

/// A recorded disposition against a specific finding, carrying provenance so the
/// decision is reviewable and never mutates a pack rule silently.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispositionRecord {
    /// The stable finding key this disposition applies to (typically a check id).
    pub finding_key: String,
    /// The disposition itself.
    pub disposition: FindingDisposition,
    /// Free-text provenance: who/why, for later review.
    pub note: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PacksSnapshot {
    installed: Vec<Pack>,
    applied: Vec<String>,
    #[serde(default)]
    dispositions: BTreeMap<String, DispositionRecord>,
}

pub struct PackRegistry {
    path: PathBuf,
    installed: BTreeMap<String, Pack>,
    applied: Vec<String>,
    dispositions: BTreeMap<String, DispositionRecord>,
}

impl PackRegistry {
    /// Opens the registry, seeding the built-in reversible starter pack the first
    /// time so the benchmark has an explainable, revertible domain pack.
    pub fn open(root: impl AsRef<Path>) -> anyhow::Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root)
            .with_context(|| format!("create packs directory {}", root.display()))?;
        let path = root.join("packs.json");
        let snapshot = if path.exists() {
            let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
            serde_json::from_slice::<PacksSnapshot>(&bytes)
                .with_context(|| format!("parse {}", path.display()))?
        } else {
            PacksSnapshot {
                installed: vec![auction_starter_pack()],
                applied: Vec::new(),
                dispositions: BTreeMap::new(),
            }
        };
        let installed = snapshot
            .installed
            .into_iter()
            .map(|pack| (pack.id.clone(), pack))
            .collect();
        let registry = Self {
            path,
            installed,
            applied: snapshot.applied,
            dispositions: snapshot.dispositions,
        };
        registry.persist()?;
        Ok(registry)
    }

    pub fn list(&self) -> Vec<Pack> {
        self.installed.values().cloned().collect()
    }

    pub fn applied(&self) -> Vec<String> {
        self.applied.clone()
    }

    pub fn apply(&mut self, pack_id: &str) -> anyhow::Result<()> {
        if !self.installed.contains_key(pack_id) {
            anyhow::bail!("unknown pack {pack_id}")
        }
        if !self.applied.iter().any(|id| id == pack_id) {
            self.applied.push(pack_id.to_owned());
        }
        self.persist()
    }

    /// Reverts an applied pack. A pack that declared itself non-reversible cannot
    /// be reverted, and that limitation is surfaced rather than hidden.
    pub fn revert(&mut self, pack_id: &str) -> anyhow::Result<()> {
        let pack = self
            .installed
            .get(pack_id)
            .with_context(|| format!("unknown pack {pack_id}"))?;
        if !pack.reversible {
            anyhow::bail!("pack {pack_id} declared itself non-reversible")
        }
        self.applied.retain(|id| id != pack_id);
        self.persist()
    }

    /// Records a disposition against a specific finding (keyed by a stable
    /// finding id, typically a check id) and persists it. Re-recording the same
    /// key overwrites the prior disposition; the decision is always stored with
    /// its note for later review rather than mutating any pack rule.
    pub fn record_disposition(
        &mut self,
        finding_key: &str,
        disposition: FindingDisposition,
        note: impl Into<String>,
    ) -> anyhow::Result<()> {
        self.dispositions.insert(
            finding_key.to_owned(),
            DispositionRecord {
                finding_key: finding_key.to_owned(),
                disposition,
                note: note.into(),
            },
        );
        self.persist()
    }

    /// The recorded dispositions, keyed by finding id, for review.
    pub fn dispositions(&self) -> &BTreeMap<String, DispositionRecord> {
        &self.dispositions
    }

    /// Evaluates readiness for a pack while honoring the registry's recorded
    /// dispositions. Convenience over [`readiness_with_dispositions`] that wires
    /// the persisted disposition map.
    pub fn readiness_for(
        &self,
        pack: &Pack,
        passed: &[String],
        failed: &[String],
    ) -> ReadinessVerdict {
        readiness_with_dispositions(pack, passed, failed, &self.dispositions)
    }

    fn persist(&self) -> anyhow::Result<()> {
        let snapshot = PacksSnapshot {
            installed: self.installed.values().cloned().collect(),
            applied: self.applied.clone(),
            dispositions: self.dispositions.clone(),
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
        std::env::temp_dir().join(format!("ide-packs-{tag}-{}", std::process::id()))
    }

    #[test]
    fn starter_pack_has_no_native_execution_capability() {
        let pack = auction_starter_pack();
        assert!(pack.reversible);
        assert!(!pack.capabilities.is_empty());
        // The capability set is a closed enum with no arbitrary-exec variant.
        assert!(pack.capabilities.iter().all(|capability| matches!(
            capability,
            PackCapability::ReadWorkspace
                | PackCapability::RunDeterministicCheck
                | PackCapability::OfferGuidance
        )));
    }

    #[test]
    fn readiness_blocks_on_missing_or_failed_checks() {
        let pack = auction_starter_pack();
        let all_passed: Vec<String> = pack.checks.iter().map(|check| check.id.clone()).collect();
        assert!(readiness(&pack, &all_passed, &[]).ready);
        assert!(!readiness(&pack, &[], &[]).ready);
        let failed = vec!["auction-privacy".to_owned()];
        let verdict = readiness(&pack, &all_passed, &failed);
        assert!(!verdict.ready);
        assert_eq!(verdict.failed_checks, failed);
    }

    #[test]
    fn registry_seeds_starter_pack_and_apply_revert_is_reversible() {
        let root = temp_root("registry");
        let _ = fs::remove_dir_all(&root);
        let mut registry = PackRegistry::open(&root).unwrap();
        assert_eq!(registry.list().len(), 1);
        registry.apply("auction-starter").unwrap();
        assert_eq!(registry.applied(), vec!["auction-starter".to_owned()]);
        registry.revert("auction-starter").unwrap();
        assert!(registry.applied().is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    fn dispo(kind: FindingDisposition) -> BTreeMap<String, DispositionRecord> {
        let mut map = BTreeMap::new();
        map.insert(
            "auction-privacy".to_owned(),
            DispositionRecord {
                finding_key: "auction-privacy".to_owned(),
                disposition: kind,
                note: "reviewed by mario".to_owned(),
            },
        );
        map
    }

    #[test]
    fn false_positive_disposition_unblocks_readiness() {
        let pack = auction_starter_pack();
        let passed = vec!["auction-concurrency".to_owned()];
        let failed = vec!["auction-privacy".to_owned()];
        let map = dispo(FindingDisposition::FalsePositive);
        let verdict = readiness_with_dispositions(&pack, &passed, &failed, &map);
        assert!(verdict.ready);
        assert!(verdict.failed_checks.is_empty());
        assert_eq!(
            verdict.dispositioned_checks,
            vec!["auction-privacy".to_owned()]
        );
    }

    #[test]
    fn scoped_exception_disposition_unblocks_readiness() {
        let pack = auction_starter_pack();
        let passed = vec!["auction-concurrency".to_owned()];
        let failed = vec!["auction-privacy".to_owned()];
        let map = dispo(FindingDisposition::ScopedException {
            scope: "staging".to_owned(),
            justification: "leaderboard privado no ambiente de teste".to_owned(),
        });
        let verdict = readiness_with_dispositions(&pack, &passed, &failed, &map);
        assert!(verdict.ready);
        assert_eq!(
            verdict.dispositioned_checks,
            vec!["auction-privacy".to_owned()]
        );
    }

    #[test]
    fn correction_is_informational_and_real_failure_still_blocks() {
        let pack = auction_starter_pack();
        let passed = vec!["auction-concurrency".to_owned()];
        let failed = vec!["auction-privacy".to_owned()];
        let map = dispo(FindingDisposition::Corrected);
        let verdict = readiness_with_dispositions(&pack, &passed, &failed, &map);
        assert!(!verdict.ready);
        assert_eq!(verdict.failed_checks, vec!["auction-privacy".to_owned()]);
        assert!(verdict.dispositioned_checks.is_empty());
    }

    #[test]
    fn unknown_check_still_not_a_pass_even_with_disposition() {
        let pack = auction_starter_pack();
        // Nothing observed: both checks are missing/unknown.
        let map = dispo(FindingDisposition::FalsePositive);
        let verdict = readiness_with_dispositions(&pack, &[], &[], &map);
        assert!(!verdict.ready);
        assert!(verdict
            .missing_checks
            .contains(&"auction-privacy".to_owned()));
    }

    #[test]
    fn registry_records_and_reloads_dispositions() {
        let root = temp_root("dispo");
        let _ = fs::remove_dir_all(&root);
        {
            let mut registry = PackRegistry::open(&root).unwrap();
            registry
                .record_disposition(
                    "auction-privacy",
                    FindingDisposition::FalsePositive,
                    "não vaza: campo é interno",
                )
                .unwrap();
            let pack = auction_starter_pack();
            let passed = vec!["auction-concurrency".to_owned()];
            let failed = vec!["auction-privacy".to_owned()];
            assert!(registry.readiness_for(&pack, &passed, &failed).ready);
        }
        let registry = PackRegistry::open(&root).unwrap();
        let record = registry.dispositions().get("auction-privacy").unwrap();
        assert_eq!(record.disposition, FindingDisposition::FalsePositive);
        assert_eq!(record.note, "não vaza: campo é interno");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn registry_reloads_applied_state() {
        let root = temp_root("reload");
        let _ = fs::remove_dir_all(&root);
        {
            let mut registry = PackRegistry::open(&root).unwrap();
            registry.apply("auction-starter").unwrap();
        }
        let registry = PackRegistry::open(&root).unwrap();
        assert_eq!(registry.applied(), vec!["auction-starter".to_owned()]);
        fs::remove_dir_all(&root).unwrap();
    }
}
