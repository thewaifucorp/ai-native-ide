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
//! material somebody declared: guidance adopted into `.product/guidance/`,
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
//! # Version, and why it is mtime plus size
//!
//! Every source carries a version so two runs can be told apart. It is the
//! observed `mtime` and byte length — a fact about the file on disk — rather than
//! a semantic version nobody maintains. It is honest about being coarse: it
//! detects that a file changed, and it never claims to know what changed.

use ide_context::{compile, CompiledContext, ContextInputs, EvidenceRef};
use ide_guidance::{
    AppliedGuidance, Guidance, GuidanceApplication, GuidanceDuration, GuidanceOrigin,
    GuidanceScope, GuidanceState, GuidanceStrength, GuidanceType, TruthDeclaration,
};
use serde::Serialize;
use std::path::Path;

const GUIDANCE_DIR: &str = ".product/guidance";
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

/// One adopted guidance file, as §5's adoption writes it.
#[derive(serde::Deserialize)]
struct GuidanceFile {
    id: String,
    title: String,
    #[serde(default)]
    strength: Option<String>,
    text: String,
    #[serde(default)]
    provenance: Option<GuidanceProvenance>,
}

#[derive(serde::Deserialize)]
struct GuidanceProvenance {
    path: String,
    #[serde(default)]
    line: Option<u64>,
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

/// Strength as the FILE declares it.
///
/// §5's adoption only ever writes `suggestion`, on purpose — a detector cannot
/// know a sentence is blocking. But a person editing that file can, and their
/// word is honored here. Anything unrecognized degrades to `suggestion` rather
/// than being promoted.
fn strength_of(declared: Option<&str>) -> GuidanceStrength {
    match declared {
        Some("blocking") => GuidanceStrength::Blocking,
        Some("required") => GuidanceStrength::Required,
        Some("default") => GuidanceStrength::Default,
        _ => GuidanceStrength::Suggestion,
    }
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
pub fn compile_package(root: &Path, budget_chars: Option<usize>, evidence: Vec<EvidenceRef>) -> ContextPackage {
    let budget = budget_chars.unwrap_or(DEFAULT_BUDGET);
    let mut sources: Vec<SourceRow> = Vec::new();
    let mut limits: Vec<String> = Vec::new();
    let mut excluded: Vec<Excluded> = Vec::new();
    let mut unknown: Vec<String> = Vec::new();

    // ── guidance adopted into the project ────────────────────────────────
    let mut applied: Vec<AppliedGuidance> = Vec::new();
    for (name, raw) in read_dir_json(&root.join(GUIDANCE_DIR)) {
        let rel = format!("{GUIDANCE_DIR}/{name}");
        match serde_json::from_str::<GuidanceFile>(&raw) {
            Ok(file) => {
                let provenance = file
                    .provenance
                    .as_ref()
                    .map(|p| match p.line {
                        Some(line) => format!("{}:{line}", p.path),
                        None => p.path.clone(),
                    })
                    .unwrap_or_else(|| rel.clone());
                sources.push(SourceRow {
                    path: rel.clone(),
                    kind: "guidance".to_string(),
                    version: version_of(&root.join(&rel)),
                });
                applied.push(AppliedGuidance {
                    // Short on purpose: the compiler uses `reason` for BOTH the
                    // segment's scope and its reason, so a long sentence here
                    // shows up twice on screen.
                    reason: format!("adotada em {rel}"),
                    guidance: Guidance {
                        // §5 writes ids like `guidance:AGENTS.md#desempate`, and
                        // the compiler prefixes `guidance:` itself — keeping both
                        // renders `guidance:guidance:…`.
                        id: file
                            .id
                            .strip_prefix("guidance:")
                            .unwrap_or(&file.id)
                            .to_string(),
                        name: file.title,
                        guidance_type: GuidanceType::Convention,
                        scope: GuidanceScope::Project {
                            project_id: root.to_string_lossy().into_owned(),
                        },
                        application: GuidanceApplication::General,
                        strength: strength_of(file.strength.as_deref()),
                        origin: GuidanceOrigin::Imported,
                        duration: GuidanceDuration::Permanent,
                        priority: 0,
                        owner: "projeto".to_string(),
                        provenance,
                        set: "projeto".to_string(),
                        text: file.text,
                        state: GuidanceState::Active,
                        last_used_ms: 0,
                    },
                });
            }
            Err(error) => excluded.push(Excluded {
                what: rel,
                reason: format!("não pôde ser lida ({error}) — ficou fora do pacote"),
            }),
        }
    }
    if applied.is_empty() {
        unknown.push(format!(
            "nenhuma orientação adotada em {GUIDANCE_DIR}/ — o agente não recebe convenção \
             nenhuma deste projeto"
        ));
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
        "nenhum arquivo do projeto entra no pacote por varredura: só material declarado \
         (.product/guidance, .product/sot) e evidência observada"
            .to_string(),
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

    ContextPackage {
        compiled,
        sources,
        excluded,
        policy,
        unknown,
        limits,
        project_files_not_included: project_files,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn write(root: &Path, rel: &str, body: &str) {
        let abs = root.join(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(abs, body).unwrap();
    }

    /// An empty project produces an EMPTY package that says what it does not
    /// know — never a package that looks complete.
    #[test]
    fn an_empty_project_produces_unknowns_not_a_package() {
        let dir = project();

        let package = compile_package(dir.path(), None, Vec::new());

        assert!(package.compiled.segments.is_empty());
        assert_eq!(package.unknown.len(), 4, "guidance, autoridade, intenção, evidência");
        assert!(package.policy.iter().any(|p| p.contains("retrieval governado")));
    }

    /// Adopted guidance reaches the package, and its provenance travels with it.
    #[test]
    fn adopted_guidance_reaches_the_package_with_its_provenance() {
        let dir = project();
        write(
            dir.path(),
            ".product/guidance/desempate.json",
            r#"{"id":"desempate","title":"Desempate","strength":"suggestion",
                "text":"Exceder estritamente o atual.",
                "provenance":{"path":"AGENTS.md","line":6}}"#,
        );

        let package = compile_package(dir.path(), None, Vec::new());

        let segment = package
            .compiled
            .segments
            .iter()
            .find(|s| s.origin == "guidance:desempate")
            .expect("segmento de guidance");
        assert_eq!(segment.text, "Exceder estritamente o atual.");
        assert!(!segment.verbatim, "sugestão não é verbatim");
        assert!(package
            .sources
            .iter()
            .any(|s| s.kind == "guidance" && s.version.contains("bytes:")));
    }

    /// A person can strengthen a guidance by editing the file, and then it
    /// becomes verbatim — immune to the budget. A detector never can.
    #[test]
    fn a_human_declared_blocking_guidance_is_kept_verbatim() {
        let dir = project();
        write(
            dir.path(),
            ".product/guidance/segredo.json",
            r#"{"id":"segredo","title":"Segredos","strength":"blocking",
                "text":"Nunca escreva credencial em arquivo versionado."}"#,
        );

        // A budget of ZERO would drop everything droppable.
        let package = compile_package(dir.path(), Some(0), Vec::new());

        let segment = package
            .compiled
            .segments
            .iter()
            .find(|s| s.origin == "guidance:segredo")
            .expect("bloqueante sobrevive a orçamento zero");
        assert!(segment.verbatim);
        assert!(package.policy.iter().any(|p| p.contains("guidance:segredo")));
    }

    /// Unrecognized strength degrades to suggestion instead of being promoted.
    #[test]
    fn an_unknown_strength_degrades_to_suggestion() {
        assert_eq!(strength_of(Some("mandatorio")), GuidanceStrength::Suggestion);
        assert_eq!(strength_of(None), GuidanceStrength::Suggestion);
        assert_eq!(strength_of(Some("blocking")), GuidanceStrength::Blocking);
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

        let package = compile_package(dir.path(), None, Vec::new());

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

        let package = compile_package(dir.path(), None, Vec::new());

        assert_eq!(package.project_files_not_included, 2, "node_modules não conta");
        assert!(package
            .excluded
            .iter()
            .any(|e| e.reason.contains("retrieval governado")));
    }

    /// A malformed material is reported as excluded, and does not take the rest
    /// of the package down.
    #[test]
    fn a_malformed_material_is_excluded_with_its_reason() {
        let dir = project();
        write(dir.path(), ".product/guidance/quebrada.json", "{ não é json");
        write(
            dir.path(),
            ".product/guidance/boa.json",
            r#"{"id":"boa","title":"Boa","text":"vale"}"#,
        );

        let package = compile_package(dir.path(), None, Vec::new());

        assert!(package
            .excluded
            .iter()
            .any(|e| e.what.contains("quebrada.json") && e.reason.contains("não pôde ser lida")));
        assert!(package
            .compiled
            .segments
            .iter()
            .any(|s| s.origin == "guidance:boa"));
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

        let package = compile_package(dir.path(), None, evidence);

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
