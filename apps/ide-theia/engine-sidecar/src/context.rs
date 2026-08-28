//! §6 — the context an agent actually receives, compiled and accountable.
//!
//! `ide_context` is the deterministic compiler: it orders material by authority
//! and strength, keeps policies and required guidance VERBATIM regardless of
//! budget, and drops the least important tail when the budget runs out —
//! reporting exactly what it dropped. It reads no filesystem, exactly like
//! `ide_harness` and `ide_reconciliation`. So gathering the material is this
//! module's job.
//!
//! # The rule this exists to hold
//!
//! An agent never receives the project. It receives a MINIMUM PACKAGE built from
//! material somebody declared: ACTIVE guidance from the §13 Guidance Library,
//! authorities declared in `.product/sot/`, and evidence the §4 engines recorded.
//! Everything else is not in the package, and that absence is reported two ways:
//!
//!  * **excluded** — it exists and was deliberately left out, with the reason.
//!  * **unknown** — nobody can answer it from declared material, and only a
//!    governed retrieval could. That retrieval does not exist yet, so `unknown`
//!    stays `unknown` instead of being filled by a scan nobody asked for.
//!
//! A panel that showed neither would let "the agent got what it needed" be an
//! assumption. The whole point of §6 is that it is a statement with a list.
//!
//! # Where the guidance comes from (corrected in §13)
//!
//! The first cut of this module read `.product/guidance/*.json` with a shape of
//! its own. That was a hand-rolled half of something that already existed:
//! `ide_guidance::GuidanceRegistry` owns the model, the lifecycle and — crucially
//! — `applied_now`, which compiles only guidance whose SCOPE and APPLICATION
//! match the current activity, each with a reason. Reading files directly meant
//! every candidate looked active and every scope looked applicable.
//!
//! Now the registry is the source, and two things follow for free:
//!
//!  * A CANDIDATE (what an import or a detector produces) never reaches an agent.
//!    Only an explicit `activate` makes guidance eligible, and the package says
//!    how many candidates are waiting instead of silently including or hiding
//!    them.
//!  * What the package actually used is stamped back with `mark_used`, which is
//!    what gives the hygiene staleness report any meaning.
//!
//! # Version, and why it is mtime plus size
//!
//! Every source carries a version so two runs can be told apart. It is the
//! observed `mtime` and byte length — a fact about the file on disk — rather than
//! a semantic version nobody maintains. It is honest about being coarse: it
//! detects that a file changed, and it never claims to know what changed.

use ide_context::{compile, CompiledContext, ContextInputs, EvidenceRef};
use ide_guidance::{
    ActivityContext, AppliedGuidance, GuidanceRegistry, GuidanceScope, GuidanceState,
    TruthDeclaration,
};
use serde::Serialize;
use std::path::Path;

const SOT_DIR: &str = ".product/sot";

/// Default character budget for the compiled package.
const DEFAULT_BUDGET: usize = 4_000;

/// Cap on the declared-intent text folded into the package. The intent segment is
/// verbatim, so an uncapped one would smuggle a whole document past the budget —
/// which is the "dump the project" failure wearing the right hat.
const MAX_INTENT_CHARS: usize = 1_200;

/// One material read from disk, with where it came from and its coarse version.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRow {
    pub path: String,
    /// `guidance`, `authority` or `evidence`.
    pub kind: String,
    /// Observed version: mtime in ms plus byte length. Coarse on purpose.
    pub version: String,
}

/// Something real that was deliberately NOT included.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Excluded {
    pub what: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPackage {
    /// The compiler's own output: ordered segments, what it dropped, sizes.
    pub compiled: CompiledContext,
    pub sources: Vec<SourceRow>,
    pub excluded: Vec<Excluded>,
    /// Rules held while compiling, each stated as a fact about this package.
    pub policy: Vec<String>,
    /// Questions declared material cannot answer. Only governed retrieval could.
    pub unknown: Vec<String>,
    /// Budgets and caps actually hit.
    pub limits: Vec<String>,
    /// Files in the project that are NOT in the package — the count alone, so
    /// "nothing was dumped" is measurable.
    pub project_files_not_included: usize,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn version_of(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis().to_string())
                .unwrap_or_else(|| "mtime desconhecido".to_string());
            format!("mtime:{mtime} bytes:{}", meta.len())
        }
        Err(_) => "não pôde ser lido".to_string(),
    }
}

/// One SoT artifact, as §3 writes and reads it.
#[derive(serde::Deserialize)]
struct SotFile {
    id: String,
    #[serde(default)]
    kind: Option<String>,
    path: String,
    #[serde(default, rename = "authorityOver")]
    authority_over: Vec<String>,
    #[serde(default)]
    claims: Vec<SotClaim>,
}

#[derive(serde::Deserialize)]
struct SotClaim {
    #[serde(default)]
    statement: String,
}

fn read_dir_json(dir: &Path) -> Vec<(String, String)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<(String, String)> = entries
        .flatten()
        .filter(|entry| {
            entry.path().extension().and_then(|e| e.to_str()) == Some("json")
                && entry.path().is_file()
        })
        .filter_map(|entry| {
            let raw = std::fs::read_to_string(entry.path()).ok()?;
            Some((entry.file_name().to_string_lossy().into_owned(), raw))
        })
        .collect();
    // Deterministic order: two runs on the same disk must compile the same
    // package, and directory order is not guaranteed.
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Counts text files in the project, skipping build output. Used only to state
/// how many project files are NOT in the package.
fn count_project_files(root: &Path) -> usize {
    const SKIP: [&str; 9] = [
        ".git",
        "node_modules",
        "target",
        "dist",
        "lib",
        "src-gen",
        ".instrument",
        ".aag",
        "out",
    ];
    let mut count = 0usize;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if !SKIP.contains(&name.as_str()) {
                    stack.push(path);
                }
                continue;
            }
            count += 1;
            if count > 5_000 {
                return count;
            }
        }
    }
    count
}

/// Compiles the package an agent would receive for `intent_subject`.
pub fn compile_package(
    root: &Path,
    budget_chars: Option<usize>,
    evidence: Vec<EvidenceRef>,
) -> Result<ContextPackage, String> {
    let budget = budget_chars.unwrap_or(DEFAULT_BUDGET);
    let mut sources: Vec<SourceRow> = Vec::new();
    let mut limits: Vec<String> = Vec::new();
    let mut excluded: Vec<Excluded> = Vec::new();
    let mut unknown: Vec<String> = Vec::new();

    // ── active guidance, from the §13 library ────────────────────────────
    //
    // `applied_now` is the engine's own compilation: only ACTIVE guidance whose
    // scope and application match this activity, ordered strongest-and-most-
    // specific first, each carrying the reason it applies.
    let mut registry = GuidanceRegistry::open(crate::library::library_root(root))
        .map_err(|error| format!("{error:#}"))?;
    let all = registry.list();
    let context = ActivityContext {
        project_id: Some(root.to_string_lossy().into_owned()),
        ..ActivityContext::default()
    };
    let applied: Vec<AppliedGuidance> = registry.applied_now(&context);
    let library_rel = crate::library::LIBRARY_REL;

    for entry in &applied {
        sources.push(SourceRow {
            path: format!("{library_rel}/{}.md", entry.guidance.set),
            kind: "guidance".to_string(),
            // The provenance is where the SENTENCE came from (a file and line,
            // when §5 imported it); the version is the state of the library file
            // it now lives in. Both, because they answer different questions.
            version: format!(
                "{} · {}",
                entry.guidance.provenance,
                version_of(&root.join(format!("{library_rel}/registry.json")))
            ),
        });
    }

    // Candidates and non-applicable guidance are DIFFERENT absences, and neither
    // is "no guidance".
    let candidates = all
        .iter()
        .filter(|entry| entry.state == GuidanceState::Candidate)
        .count();
    let active_elsewhere = all
        .iter()
        .filter(|entry| entry.state == GuidanceState::Active)
        .count()
        - applied.len().min(
            all.iter()
                .filter(|entry| entry.state == GuidanceState::Active)
                .count(),
        );

    if applied.is_empty() && all.is_empty() {
        unknown.push(format!(
            "biblioteca de guidance vazia em {library_rel}/ — o agente não recebe convenção \
             nenhuma deste projeto"
        ));
    }
    if candidates > 0 {
        // Named, not included: a candidate is exactly what nobody has reviewed.
        excluded.push(Excluded {
            what: format!("{candidates} guidance candidata(s)"),
            reason: "candidata não entra em contexto de agente — promover é ato explícito"
                .to_string(),
        });
    }
    if active_elsewhere > 0 {
        excluded.push(Excluded {
            what: format!("{active_elsewhere} guidance ativa(s) de outro escopo"),
            reason: "ativa, mas o escopo ou a aplicação não correspondem a esta atividade"
                .to_string(),
        });
    }

    // ── authorities and declared intent ──────────────────────────────────
    let mut truth: Vec<TruthDeclaration> = Vec::new();
    let mut intent_parts: Vec<String> = Vec::new();
    for (name, raw) in read_dir_json(&root.join(SOT_DIR)) {
        let rel = format!("{SOT_DIR}/{name}");
        match serde_json::from_str::<SotFile>(&raw) {
            Ok(file) => {
                sources.push(SourceRow {
                    path: rel.clone(),
                    kind: "authority".to_string(),
                    version: version_of(&root.join(&rel)),
                });
                // The authority is the file the SoT points at; the subjects are
                // what it declares authority over. A SoT with no declared
                // subject still declares authority over ITSELF.
                let subjects = if file.authority_over.is_empty() {
                    vec![file.id.clone()]
                } else {
                    file.authority_over.clone()
                };
                for subject in subjects {
                    truth.push(TruthDeclaration {
                        id: format!("{}:{subject}", file.id),
                        subject,
                        scope: GuidanceScope::Project {
                            project_id: root.to_string_lossy().into_owned(),
                        },
                        authority_path: file.path.clone(),
                        precedence: 100,
                        consumers: file.authority_over.clone(),
                        provenance: rel.clone(),
                    });
                }
                if file.kind.as_deref() == Some("intent") {
                    for claim in &file.claims {
                        if !claim.statement.trim().is_empty() {
                            intent_parts.push(claim.statement.trim().to_string());
                        }
                    }
                    // The document itself is NOT folded in. Only the statements
                    // somebody wrote as claims are.
                    excluded.push(Excluded {
                        what: file.path.clone(),
                        reason: "documento inteiro fora do pacote: entram as afirmações \
                                 declaradas, não o texto do arquivo"
                            .to_string(),
                    });
                }
            }
            Err(error) => excluded.push(Excluded {
                what: rel,
                reason: format!("não pôde ser lido ({error}) — ficou fora do pacote"),
            }),
        }
    }
    if truth.is_empty() {
        unknown.push(format!(
            "nenhuma autoridade declarada em {SOT_DIR}/ — para qualquer assunto, quem manda é \
             desconhecido"
        ));
    }

    let mut intent = intent_parts.join("\n");
    if intent.chars().count() > MAX_INTENT_CHARS {
        intent = intent.chars().take(MAX_INTENT_CHARS).collect();
        limits.push(format!(
            "intenção declarada cortada em {MAX_INTENT_CHARS} caracteres (segmento verbatim não \
             pode escapar do orçamento)"
        ));
    }
    if intent.trim().is_empty() {
        unknown.push(
            "nenhuma intenção declarada em afirmação de SoT — o agente não recebe o que o \
             projeto quer ser"
                .to_string(),
        );
    }

    for reference in &evidence {
        sources.push(SourceRow {
            path: reference.source.clone(),
            kind: "evidence".to_string(),
            version: format!("observada: {}", reference.id),
        });
    }
    if evidence.is_empty() {
        unknown.push(
            "nenhuma evidência observada nesta sessão — checks e preview do §4 são o que produz \
             evidência, e nada rodou"
                .to_string(),
        );
    }

    let inputs = ContextInputs {
        intent,
        applied_guidance: applied,
        truth,
        evidence,
        budget_chars: budget,
    };
    let compiled = compile(&inputs);

    // Stamp what the package ACTUALLY carried. Segments dropped for budget are
    // deliberately not stamped: they did not reach the agent, so counting them as
    // used would make the staleness report lie in the other direction.
    let used: Vec<String> = compiled
        .segments
        .iter()
        .filter_map(|segment| segment.origin.strip_prefix("guidance:").map(str::to_string))
        .collect();
    if !used.is_empty() {
        // A failure to stamp is reported, not swallowed: it means the next
        // hygiene report is wrong about this guidance.
        if let Err(error) = registry.mark_used(&used, now_ms()) {
            limits.push(format!("uso não registrado na biblioteca ({error:#})"));
        }
    }

    if !compiled.dropped_for_budget.is_empty() {
        limits.push(format!(
            "{} segmento(s) cortado(s) pelo orçamento de {budget} caracteres",
            compiled.dropped_for_budget.len()
        ));
    }

    // Policy is stated as facts about THIS package, not as a creed.
    let verbatim: Vec<&str> = compiled
        .segments
        .iter()
        .filter(|segment| segment.verbatim)
        .map(|segment| segment.origin.as_str())
        .collect();
    let mut policy = vec![
        format!(
            "nenhum arquivo do projeto entra no pacote por varredura: só guidance ATIVA de \
             {library_rel}/, autoridade declarada em {SOT_DIR}/ e evidência observada"
        ),
        format!(
            "{} segmento(s) mantido(s) verbatim, imunes ao orçamento: {}",
            verbatim.len(),
            if verbatim.is_empty() {
                "nenhum".to_string()
            } else {
                verbatim.join(", ")
            }
        ),
    ];
    policy.push(
        "retrieval governado não existe ainda: o que falta continua `unknown` em vez de ser \
         preenchido por varredura"
            .to_string(),
    );

    let project_files = count_project_files(root);
    excluded.push(Excluded {
        what: format!("{project_files} arquivo(s) do projeto"),
        reason: "fora do pacote mínimo — só entrariam por retrieval governado, que ainda não \
                 existe"
            .to_string(),
    });

    Ok(ContextPackage {
        compiled,
        sources,
        excluded,
        policy,
        unknown,
        limits,
        project_files_not_included: project_files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{capture, import, lifecycle, CaptureRequest};

    fn project() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn write(root: &Path, rel: &str, body: &str) {
        let abs = root.join(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(abs, body).unwrap();
    }

    fn request(name: &str, strength: &str) -> CaptureRequest {
        CaptureRequest {
            name: name.to_string(),
            text: format!("texto de {name}"),
            guidance_type: None,
            application: None,
            strength: Some(strength.to_string()),
            scope: None,
            owner: None,
            provenance: None,
            destination: "create_stable".to_string(),
        }
    }

    fn package(root: &Path, budget: Option<usize>) -> ContextPackage {
        compile_package(root, budget, Vec::new()).expect("pacote")
    }

    /// An empty project produces an EMPTY package that says what it does not
    /// know — never a package that looks complete.
    #[test]
    fn an_empty_project_produces_unknowns_not_a_package() {
        let dir = project();

        let package = package(dir.path(), None);

        assert!(package.compiled.segments.is_empty());
        assert_eq!(
            package.unknown.len(),
            4,
            "biblioteca, autoridade, intenção, evidência: {:?}",
            package.unknown
        );
        assert!(package
            .policy
            .iter()
            .any(|p| p.contains("retrieval governado")));
    }

    /// Active guidance from the library reaches the package, and its provenance
    /// travels with it as the source's version line.
    #[test]
    fn active_guidance_reaches_the_package_with_its_provenance() {
        let dir = project();
        capture(dir.path(), request("Desempate", "suggestion")).expect("capture");

        let package = package(dir.path(), None);

        let segment = package
            .compiled
            .segments
            .iter()
            .find(|s| s.origin.starts_with("guidance:"))
            .expect("segmento de guidance");
        assert_eq!(segment.text, "texto de Desempate");
        assert!(!segment.verbatim, "sugestão não é verbatim");
        assert!(package
            .sources
            .iter()
            .any(|s| s.kind == "guidance" && s.version.contains("capturada no IDE")));
    }

    /// A CANDIDATE never reaches an agent, and the package names how many are
    /// waiting instead of hiding them.
    #[test]
    fn a_candidate_is_named_but_never_included() {
        let dir = project();
        let imported = import(
            dir.path(),
            "AGENTS.md — Desempate",
            "exceder estritamente o atual",
            None,
            Some("AGENTS.md:6"),
        )
        .expect("import");

        let before = package(dir.path(), None);
        assert!(
            before
                .compiled
                .segments
                .iter()
                .all(|s| !s.origin.starts_with("guidance:")),
            "candidata não entra"
        );
        assert!(before
            .excluded
            .iter()
            .any(|e| e.what.contains("candidata") && e.reason.contains("ato explícito")));

        lifecycle(dir.path(), &imported.id, "active", None).expect("activate");

        let after = package(dir.path(), None);
        let segment = after
            .compiled
            .segments
            .iter()
            .find(|s| s.origin.starts_with("guidance:"))
            .expect("promovida entra");
        assert_eq!(segment.text, "exceder estritamente o atual");
        assert!(after
            .sources
            .iter()
            .any(|s| s.version.contains("AGENTS.md:6")));
    }

    /// A person can declare a guidance blocking, and then it is verbatim — immune
    /// to the budget. A detector never can.
    #[test]
    fn a_human_declared_blocking_guidance_is_kept_verbatim() {
        let dir = project();
        capture(dir.path(), request("Segredos", "blocking")).expect("capture");

        // A budget of ZERO would drop everything droppable.
        let package = package(dir.path(), Some(0));

        let segment = package
            .compiled
            .segments
            .iter()
            .find(|s| s.origin.starts_with("guidance:"))
            .expect("bloqueante sobrevive a orçamento zero");
        assert!(segment.verbatim);
        assert!(package.policy.iter().any(|p| p.contains(&segment.origin)));
    }

    /// Compiling stamps what it USED, which is what gives the hygiene staleness
    /// report meaning. A segment the budget dropped is not stamped.
    #[test]
    fn compiling_stamps_only_the_guidance_it_carried() {
        let dir = project();
        capture(dir.path(), request("Levada", "blocking")).expect("capture");
        capture(dir.path(), request("Cortada", "suggestion")).expect("capture");

        // Zero budget: the blocking one is verbatim and stays, the suggestion is
        // dropped.
        let package = package(dir.path(), Some(0));
        assert_eq!(package.compiled.dropped_for_budget.len(), 1);

        let library =
            GuidanceRegistry::open(crate::library::library_root(dir.path())).expect("library");
        let stamped: Vec<(String, u64)> = library
            .list()
            .into_iter()
            .map(|entry| (entry.name, entry.last_used_ms))
            .collect();
        for (name, last_used) in stamped {
            if name == "Levada" {
                assert!(last_used > 0, "a que foi levada é marcada como usada");
            } else {
                assert_eq!(last_used, 0, "a que o orçamento cortou não foi usada");
            }
        }
    }

    /// The SoT gives authority per subject, and the intent comes from the
    /// declared CLAIMS — the document itself stays out, and says so.
    #[test]
    fn the_sot_gives_authority_and_the_document_stays_out() {
        let dir = project();
        write(
            dir.path(),
            ".product/sot/intent.json",
            r#"{"id":"intent","kind":"intent","path":"docs/product-intent.md",
                "authorityOver":["ranking"],
                "claims":[{"id":"c1","statement":"Empate não é resolvido por ordem de criação."}]}"#,
        );

        let package = package(dir.path(), None);

        assert!(package
            .compiled
            .segments
            .iter()
            .any(|s| s.origin == "truth:intent:ranking" && s.scope == "ranking"));
        let intent = package
            .compiled
            .segments
            .iter()
            .find(|s| s.origin == "intent")
            .expect("intenção declarada");
        assert!(intent.text.contains("ordem de criação"));
        assert!(package
            .excluded
            .iter()
            .any(|e| e.what == "docs/product-intent.md"));
    }

    /// The package always states how many project files it did NOT include.
    /// "Nothing was dumped" has to be measurable.
    #[test]
    fn the_package_counts_the_project_files_it_left_out() {
        let dir = project();
        write(dir.path(), "src/a.ts", "x");
        write(dir.path(), "src/b.ts", "y");
        write(dir.path(), "node_modules/big.js", "z");

        let package = package(dir.path(), None);

        assert_eq!(
            package.project_files_not_included, 2,
            "node_modules não conta"
        );
        assert!(package
            .excluded
            .iter()
            .any(|e| e.reason.contains("retrieval governado")));
    }

    /// A malformed authority is reported as excluded, and does not take the rest
    /// of the package down.
    #[test]
    fn a_malformed_material_is_excluded_with_its_reason() {
        let dir = project();
        write(dir.path(), ".product/sot/quebrada.json", "{ não é json");
        write(
            dir.path(),
            ".product/sot/boa.json",
            r#"{"id":"boa","path":"docs/boa.md","authorityOver":["assunto"]}"#,
        );

        let package = package(dir.path(), None);

        assert!(package
            .excluded
            .iter()
            .any(|e| e.what.contains("quebrada.json") && e.reason.contains("não pôde ser lido")));
        assert!(package
            .compiled
            .segments
            .iter()
            .any(|s| s.origin == "truth:boa:assunto"));
    }

    /// Evidence supplied by the §4 engines becomes a source with its id.
    #[test]
    fn observed_evidence_becomes_a_source() {
        let dir = project();
        let evidence = vec![EvidenceRef {
            id: "preview-failure:health:1".to_string(),
            summary: "health check failed for http://127.0.0.1:8787/health".to_string(),
            source: "preview:health".to_string(),
        }];

        let package = compile_package(dir.path(), None, evidence).expect("pacote");

        assert!(package
            .sources
            .iter()
            .any(|s| s.kind == "evidence" && s.version.contains("preview-failure")));
        assert!(
            !package
                .unknown
                .iter()
                .any(|u| u.contains("nenhuma evidência")),
            "com evidência, o unknown correspondente desaparece"
        );
    }
}
