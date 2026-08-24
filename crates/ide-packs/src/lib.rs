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
    pub note: String,
}

/// Evaluates readiness at a checkpoint: ready only when every pack check is
/// observed as passed and none is failed. Unknown/absent checks block readiness
/// rather than being treated as a pass.
pub fn readiness(pack: &Pack, passed: &[String], failed: &[String]) -> ReadinessVerdict {
    let mut missing_checks = Vec::new();
    let mut failed_checks = Vec::new();
    for check in &pack.checks {
        if failed.contains(&check.id) {
            failed_checks.push(check.id.clone());
        } else if !passed.contains(&check.id) {
            missing_checks.push(check.id.clone());
        }
    }
    let ready = missing_checks.is_empty() && failed_checks.is_empty();
    ReadinessVerdict {
        pack_id: pack.id.clone(),
        ready,
        missing_checks,
        failed_checks,
        note: if ready {
            "Todos os checks do pack passaram nesta verificação.".to_owned()
        } else {
            "Readiness bloqueada: checks pendentes ou falhos não contam como aprovação.".to_owned()
        },
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

#[derive(Debug, Default, Serialize, Deserialize)]
struct PacksSnapshot {
    installed: Vec<Pack>,
    applied: Vec<String>,
}

pub struct PackRegistry {
    path: PathBuf,
    installed: BTreeMap<String, Pack>,
    applied: Vec<String>,
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
            }
        };
        let installed = snapshot
            .installed
            .into_iter()
            .map(|pack| (pack.id.clone(), pack))
            .collect();
        let mut registry = Self {
            path,
            installed,
            applied: snapshot.applied,
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

    fn persist(&self) -> anyhow::Result<()> {
        let snapshot = PacksSnapshot {
            installed: self.installed.values().cloned().collect(),
            applied: self.applied.clone(),
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
