//! §4 — local packs: declarative domain rules the person installs from a file.
//!
//! `ide_packs` owns the domain: what a pack may declare (checks, guides, and
//! capabilities that deliberately have no native-execution variant), what makes a
//! pack valid, and how readiness is evaluated. This module is the host half —
//! finding candidate files under the project, reading them, and keeping the
//! registry under `.instrument/packs/`.
//!
//! # Installing is not applying, and applying is not passing
//!
//! Three separate states, and collapsing any two of them would be a lie the panel
//! then repeats:
//!
//!  * **available** — a `*.pack.json` file exists in the project. Nothing read it
//!    into force.
//!  * **installed** — the registry holds the pack. It is inert.
//!  * **applied** — the pack's checks count at a checkpoint.
//!
//! And even an applied pack does not make anything green: a pack check with no
//! observed result BLOCKS readiness. That is `ide_packs`'s rule, not this
//! module's, and it is the reason a domain pack cannot quietly bless a project.
//!
//! # Why pack readiness is blocked here today, stated rather than hidden
//!
//! A pack declares Layer-1+ domain checks ("two simultaneous bids converge on one
//! winner"). §4's deterministic engine is Layer 0 and does not run them, so no
//! result is observed for them yet, so readiness blocks. That is the honest
//! answer and it is on screen with its reason — not a green badge, and not an
//! empty panel either.

use ide_packs::{Pack, PackRegistry, ReadinessVerdict};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Where the registry lives, and where project-supplied packs are looked for.
const REGISTRY_REL: &str = ".instrument/packs";
const PACKS_DIR_REL: &str = "packs";

/// A pack file found in the project, and whether it is already installed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailablePack {
    /// Path relative to the project root — what `install` takes.
    pub path: String,
    pub id: Option<String>,
    pub name: Option<String>,
    pub domain: Option<String>,
    pub checks: usize,
    pub guides: usize,
    pub installed: bool,
    /// Why this file could not be read as a pack. A file that is present but
    /// unreadable is a different fact from a directory with no packs in it.
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PacksSnapshot {
    pub installed: Vec<Pack>,
    pub applied: Vec<String>,
    pub available: Vec<AvailablePack>,
    /// Readiness for each APPLIED pack, evaluated against observed results.
    pub readiness: Vec<ReadinessVerdict>,
    /// Where the pack files were looked for, so an empty list is not a mystery.
    pub looked_in: String,
    /// Why no pack check has an observed result. Never omitted while true.
    pub no_observed_results: Option<String>,
}

fn registry(root: &Path) -> Result<PackRegistry, String> {
    PackRegistry::open(root.join(REGISTRY_REL)).map_err(|e| e.to_string())
}

/// Resolves a project-relative path, refusing anything that leaves the project.
///
/// The path arrives from the UI, and the UI got it from a scan — but a path is a
/// path: `../../etc/passwd` has to fail here, not be trusted upstream.
fn confine(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = root.join(relative);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("{relative}: {error}"))?;
    let root_canonical = root
        .canonicalize()
        .map_err(|error| format!("raiz do projeto: {error}"))?;
    if !canonical.starts_with(&root_canonical) {
        return Err(format!("{relative} está fora do projeto — recusado"));
    }
    Ok(canonical)
}

/// Pack files the project ships, read but not installed.
fn available(root: &Path, installed: &[Pack]) -> Vec<AvailablePack> {
    let dir = root.join(PACKS_DIR_REL);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut found: Vec<AvailablePack> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        match std::fs::read(&path)
            .map_err(|e| e.to_string())
            .and_then(|bytes| serde_json::from_slice::<Pack>(&bytes).map_err(|e| e.to_string()))
        {
            Ok(pack) => {
                // Validity is the crate's call, and an invalid file is reported
                // here rather than at install time, when it is too late to be
                // useful.
                let problem = ide_packs::validate_pack(&pack).err().map(|e| e.to_string());
                found.push(AvailablePack {
                    path: rel,
                    installed: installed.iter().any(|p| p.id == pack.id),
                    id: Some(pack.id),
                    name: Some(pack.name),
                    domain: Some(pack.domain),
                    checks: pack.checks.len(),
                    guides: pack.guides.len(),
                    problem,
                });
            }
            Err(error) => found.push(AvailablePack {
                path: rel,
                id: None,
                name: None,
                domain: None,
                checks: 0,
                guides: 0,
                installed: false,
                problem: Some(error),
            }),
        }
    }
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}

/// Current picture: what is available, installed, applied, and how ready it is.
///
/// `passed` / `failed` are the check ids the caller actually observed. Passing an
/// empty pair is what happens today (§4 is Layer 0, packs are Layer 1+), and it
/// deliberately produces a BLOCKED verdict rather than an empty one.
pub fn snapshot(
    root: &Path,
    passed: &[String],
    failed: &[String],
) -> Result<PacksSnapshot, String> {
    let registry = registry(root)?;
    let installed = registry.list();
    let applied = registry.applied();
    let readiness = installed
        .iter()
        .filter(|pack| applied.contains(&pack.id))
        .map(|pack| registry.readiness_for(pack, passed, failed))
        .collect();

    let no_observed_results = (passed.is_empty() && failed.is_empty()).then(|| {
        "nenhum check de pack tem resultado observado: packs declaram checks de domínio \
         (camada 1+) e o motor determinístico do §4 é camada 0 — por isso a readiness fica \
         bloqueada, não verde"
            .to_string()
    });

    Ok(PacksSnapshot {
        available: available(root, &installed),
        installed,
        applied,
        readiness,
        looked_in: PACKS_DIR_REL.to_string(),
        no_observed_results,
    })
}

/// Installs one local pack file into the project's registry.
pub fn install(root: &Path, relative: &str) -> Result<PacksSnapshot, String> {
    let path = confine(root, relative)?;
    let mut registry = registry(root)?;
    registry
        .install_from_path(&path)
        .map_err(|error| format!("{relative}: {error:#}"))?;
    snapshot(root, &[], &[])
}

pub fn apply(root: &Path, pack_id: &str) -> Result<PacksSnapshot, String> {
    let mut registry = registry(root)?;
    registry
        .apply(pack_id)
        .map_err(|error| format!("{error:#}"))?;
    snapshot(root, &[], &[])
}

pub fn revert(root: &Path, pack_id: &str) -> Result<PacksSnapshot, String> {
    let mut registry = registry(root)?;
    registry
        .revert(pack_id)
        .map_err(|error| format!("{error:#}"))?;
    snapshot(root, &[], &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack_json(id: &str) -> String {
        format!(
            r#"{{
              "id": "{id}",
              "name": "Pack local",
              "domain": "auction",
              "description": "de arquivo",
              "checks": [{{
                "id": "lance-estrito",
                "title": "Lance excede o atual",
                "subject": "auction",
                "criterion": "Um lance igual ao atual é recusado.",
                "layer": 1
              }}],
              "guides": [],
              "capabilities": ["run_deterministic_check"],
              "reversible": true
            }}"#
        )
    }

    fn project(pack: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        if let Some(body) = pack {
            std::fs::create_dir_all(dir.path().join(PACKS_DIR_REL)).unwrap();
            std::fs::write(dir.path().join("packs/local.pack.json"), body).unwrap();
        }
        dir
    }

    /// A pack file in the project is listed as available and NOT installed.
    #[test]
    fn a_local_pack_file_is_available_before_it_is_installed() {
        let dir = project(Some(&pack_json("leilao-local")));

        let snapshot = snapshot(dir.path(), &[], &[]).expect("snapshot");

        assert_eq!(snapshot.available.len(), 1);
        assert_eq!(snapshot.available[0].path, "packs/local.pack.json");
        assert!(!snapshot.available[0].installed);
        assert!(snapshot.available[0].problem.is_none());
        assert!(!snapshot.installed.iter().any(|p| p.id == "leilao-local"));
    }

    /// Installing makes it installed and inert — applying is a separate act.
    #[test]
    fn installing_then_applying_are_two_distinct_acts() {
        let dir = project(Some(&pack_json("leilao-local")));

        let after_install = install(dir.path(), "packs/local.pack.json").expect("install");
        assert!(after_install
            .installed
            .iter()
            .any(|p| p.id == "leilao-local"));
        assert!(
            !after_install.applied.contains(&"leilao-local".to_string()),
            "instalar não pode aplicar"
        );
        assert!(after_install.available[0].installed);

        let after_apply = apply(dir.path(), "leilao-local").expect("apply");
        assert!(after_apply.applied.contains(&"leilao-local".to_string()));

        let after_revert = revert(dir.path(), "leilao-local").expect("revert");
        assert!(after_revert.applied.is_empty(), "o pack é reversível");
    }

    /// An applied pack with no observed check result blocks readiness, and the
    /// snapshot says why. This is the whole point: a pack cannot bless a project.
    #[test]
    fn an_applied_pack_with_no_observed_result_blocks_readiness() {
        let dir = project(Some(&pack_json("leilao-local")));
        install(dir.path(), "packs/local.pack.json").expect("install");

        let snapshot = apply(dir.path(), "leilao-local").expect("apply");

        let verdict = snapshot
            .readiness
            .iter()
            .find(|v| v.pack_id == "leilao-local")
            .expect("veredito do pack aplicado");
        assert!(!verdict.ready, "sem resultado observado não há readiness");
        assert!(verdict
            .missing_checks
            .contains(&"lance-estrito".to_string()));
        assert!(snapshot.no_observed_results.is_some());
    }

    /// A file that is present but unreadable as a pack says so, instead of
    /// disappearing from the list as if the directory were empty.
    #[test]
    fn an_unreadable_pack_file_is_listed_with_its_problem() {
        let dir = project(Some("{ isto não é json"));

        let snapshot = snapshot(dir.path(), &[], &[]).expect("snapshot");

        assert_eq!(snapshot.available.len(), 1);
        assert!(snapshot.available[0].problem.is_some());
        assert!(snapshot.available[0].id.is_none());
    }

    /// A path that leaves the project is refused, even though the UI only ever
    /// sends paths it got from the scan.
    #[test]
    fn a_path_outside_the_project_is_refused() {
        let dir = project(None);

        let error = install(dir.path(), "../fora.pack.json").expect_err("recusa");

        assert!(
            error.contains("fora do projeto") || error.contains("fora.pack.json"),
            "{error}"
        );
    }

    /// An empty packs directory is not a problem, and produces no invented rows.
    #[test]
    fn a_project_with_no_pack_files_lists_none() {
        let dir = project(None);

        let snapshot = snapshot(dir.path(), &[], &[]).expect("snapshot");

        assert!(snapshot.available.is_empty());
        assert_eq!(snapshot.looked_in, "packs");
        // The built-in starter pack still seeds the registry, and it is not
        // applied by existing.
        assert!(snapshot.applied.is_empty());
    }
}
