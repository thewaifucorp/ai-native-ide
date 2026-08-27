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

/// Checks a pack before it is allowed into a registry.
///
/// Nothing here is about taste. Each rule exists because breaking it makes a
/// later readiness verdict unexplainable: an unnamed pack cannot be reverted by
/// name, two checks sharing an id collapse into one row that reports the other's
/// outcome, and a pack with neither checks nor guides has nothing to answer for.
///
/// Note what is NOT validated: capabilities. [`PackCapability`] has no
/// native-execution variant, so "a pack cannot run arbitrary code" is held by the
/// type, not by a check that could be forgotten.
pub fn validate_pack(pack: &Pack) -> anyhow::Result<()> {
    if pack.id.trim().is_empty() {
        anyhow::bail!("pack has no id")
    }
    if pack.name.trim().is_empty() {
        anyhow::bail!("pack {} has no name", pack.id)
    }
    if pack.domain.trim().is_empty() {
        anyhow::bail!("pack {} declares no domain", pack.id)
    }
    if pack.checks.is_empty() && pack.guides.is_empty() {
        anyhow::bail!("pack {} declares neither checks nor guides", pack.id)
    }
    let mut seen: Vec<&str> = Vec::new();
    for check in &pack.checks {
        if check.id.trim().is_empty() {
            anyhow::bail!("pack {} has a check with no id", pack.id)
        }
        if check.criterion.trim().is_empty() {
            anyhow::bail!(
                "check {} in pack {} states no criterion",
                check.id,
                pack.id
            )
        }
        if seen.contains(&check.id.as_str()) {
            anyhow::bail!("pack {} repeats check id {}", pack.id, check.id)
        }
        seen.push(&check.id);
    }
    for guide in &pack.guides {
        if guide.id.trim().is_empty() || guide.text.trim().is_empty() {
            anyhow::bail!("pack {} has a guide with no id or no text", pack.id)
        }
    }
    Ok(())
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

    /// Installs a pack the person supplied — the local-pack path.
    ///
    /// Installing is not applying: the pack becomes available and inert, and a
    /// separate explicit [`Self::apply`] is what puts it in force.
    ///
    /// Two refusals, both deliberate:
    ///
    ///  * A pack that fails [`validate_pack`] is not stored at all. A registry
    ///    that accepted a pack with two checks sharing an id would produce
    ///    readiness verdicts nobody can trace back to a rule.
    ///  * A pack whose id is already installed **and applied** is refused.
    ///    Overwriting it would change the rules in force under a readiness
    ///    verdict already taken; reverting first makes that visible.
    pub fn install(&mut self, pack: Pack) -> anyhow::Result<()> {
        validate_pack(&pack)?;
        if self.applied.iter().any(|id| *id == pack.id) {
            anyhow::bail!(
                "pack {} is applied — revert it before installing over it",
                pack.id
            )
        }
        self.installed.insert(pack.id.clone(), pack);
        self.persist()
    }

    /// Reads a pack from a local JSON file and installs it.
    ///
    /// The parse error is propagated with the path rather than collapsing into
    /// "invalid pack": a file that cannot be read and a file that declares an
    /// invalid pack are different problems for whoever wrote it.
    pub fn install_from_path(&mut self, path: impl AsRef<Path>) -> anyhow::Result<Pack> {
        let path = path.as_ref();
        let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
        let pack: Pack = serde_json::from_slice(&bytes)
            .with_context(|| format!("parse pack {}", path.display()))?;
        self.install(pack.clone())?;
        Ok(pack)
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

    fn local_pack() -> Pack {
        Pack {
            id: "leilao-local".to_owned(),
            name: "Pack local de leilão".to_owned(),
            domain: "auction".to_owned(),
            description: "Instalado de um arquivo local.".to_owned(),
            checks: vec![PackCheck {
                id: "lance-estrito".to_owned(),
                title: "Lance precisa exceder o atual".to_owned(),
                subject: "auction".to_owned(),
                criterion: "Um lance igual ao atual é recusado.".to_owned(),
                layer: 0,
            }],
            guides: Vec::new(),
            capabilities: vec![PackCapability::RunDeterministicCheck],
            reversible: true,
        }
    }

    /// Installing is not applying: a freshly installed pack is available and
    /// inert until someone applies it.
    #[test]
    fn installing_a_local_pack_does_not_apply_it() {
        let root = temp_root("install");
        let _ = fs::remove_dir_all(&root);
        let mut registry = PackRegistry::open(&root).unwrap();

        registry.install(local_pack()).unwrap();

        assert!(registry.list().iter().any(|p| p.id == "leilao-local"));
        assert!(
            registry.applied().is_empty(),
            "instalar não pode ligar nada"
        );

        // And it survives a reopen, because installing persisted it.
        let reopened = PackRegistry::open(&root).unwrap();
        assert!(reopened.list().iter().any(|p| p.id == "leilao-local"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_pack_read_from_a_local_file_is_installed() {
        let root = temp_root("install-file");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let file = root.join("leilao-local.pack.json");
        fs::write(&file, serde_json::to_vec_pretty(&local_pack()).unwrap()).unwrap();
        let mut registry = PackRegistry::open(&root).unwrap();

        let pack = registry.install_from_path(&file).unwrap();

        assert_eq!(pack.id, "leilao-local");
        assert_eq!(registry.list().len(), 2, "o starter continua lá");
        fs::remove_dir_all(&root).unwrap();
    }

    /// A pack with two checks sharing an id would produce a readiness verdict
    /// nobody can trace back to a rule, so it never enters the registry.
    #[test]
    fn a_pack_that_repeats_a_check_id_is_refused() {
        let root = temp_root("dup-check");
        let _ = fs::remove_dir_all(&root);
        let mut registry = PackRegistry::open(&root).unwrap();
        let mut pack = local_pack();
        let repeated = pack.checks[0].clone();
        pack.checks.push(repeated);

        let error = registry.install(pack).unwrap_err().to_string();

        assert!(error.contains("repeats check id"), "{error}");
        assert!(!registry.list().iter().any(|p| p.id == "leilao-local"));
        fs::remove_dir_all(&root).unwrap();
    }

    /// Overwriting an APPLIED pack would change the rules in force under a
    /// readiness verdict already taken. Reverting first makes that explicit.
    #[test]
    fn installing_over_an_applied_pack_is_refused() {
        let root = temp_root("install-applied");
        let _ = fs::remove_dir_all(&root);
        let mut registry = PackRegistry::open(&root).unwrap();
        registry.install(local_pack()).unwrap();
        registry.apply("leilao-local").unwrap();

        let error = registry.install(local_pack()).unwrap_err().to_string();
        assert!(error.contains("revert it before"), "{error}");

        registry.revert("leilao-local").unwrap();
        registry.install(local_pack()).expect("depois de reverter, entra");
        fs::remove_dir_all(&root).unwrap();
    }

    /// A pack with nothing to say — no checks, no guides — has nothing to answer
    /// for at a checkpoint, so it is not a pack.
    #[test]
    fn an_empty_pack_is_refused() {
        let mut pack = local_pack();
        pack.checks.clear();
        pack.guides.clear();

        let error = validate_pack(&pack).unwrap_err().to_string();

        assert!(error.contains("neither checks nor guides"), "{error}");
    }
}
