//! §4 — gathering the facts the deterministic Layer-0 checks evaluate.
//!
//! `ide_harness` is shell-neutral on purpose: it never starts a process, reads a
//! repository, or invents confidence. It turns *observed facts* into findings
//! that carry an explicit state, evidence and remediation, and it keeps
//! `Unknown` and `NotRun` distinct from a pass. Everything in this module is the
//! other half of that split — the part that actually looks at the disk and runs
//! the commands, so the engine can stay pure.
//!
//! # Where the commands come from
//!
//! Build/test/typecheck are not detected here. They are **declared**, in
//! `.instrument/checks.json`:
//!
//! ```json
//! {
//!   "build":     { "command": "yarn build", "cwd": "apps/web" },
//!   "test":      { "command": "cargo test -q" },
//!   "typecheck": { "command": "tsc --noEmit" }
//! }
//! ```
//!
//! Detecting a project's stack and commands *with provenance* is §5's whole job.
//! Guessing them here would duplicate that with a worse version and would make
//! the IDE run something nobody wrote down. When §5 lands it proposes candidates
//! **into this file**, reviewable, instead of competing with it.
//!
//! A missing file, a missing entry, or a malformed one is never an error that
//! hides the rest: those three checks come back `NotRun` with the reason stated.
//!
//! # Running declared commands is an explicit act
//!
//! `run_tools` defaults to false. Opening a project must never execute anything
//! a repository file asked for — the person asks for it, per run. This is not
//! new authority (the IDE already hosts terminals and an agent), but it is
//! execution of code that arrived with the repo, so it stays deliberate.
//!
//! Each outcome's `detail` carries the raw command and its exit status, and
//! `ide_harness` folds `detail` into the finding's `evidence`. That is what
//! makes a green check inspectable: the panel can always show what produced it.

use ide_harness::{DependencyLock, HarnessInputs, HarnessReport, ToolOutcome, ToolStatus};
use serde::Serialize;
use std::path::Path;
use std::process::Command;

/// Extensions the secret scan reads. Same list the desktop host uses, so both
/// shells scan the same surface rather than disagreeing about what a "file" is.
const TEXT_EXTENSIONS: [&str; 13] = [
    "rs", "ts", "tsx", "js", "jsx", "json", "md", "toml", "yaml", "yml", "env", "txt", "css",
];

/// Directories never walked: build output, dependencies and IDE runtime state.
/// Scanning them would drown the report in findings nobody can act on.
const SKIP_DIRS: [&str; 10] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    "lib",
    "src-gen",
    ".instrument",
    ".aag",
    "out",
    "build",
];

/// Upper bound on files read for the scan, matching the desktop host.
const MAX_FILES: usize = 400;

/// Largest file read into the scan. A generated blob past this is skipped and
/// said to be skipped, never silently treated as clean.
const MAX_FILE_BYTES: u64 = 512 * 1024;

/// How much of a failing command's output is kept as evidence.
const MAX_OUTPUT_TAIL: usize = 400;

/// One declared command, as read from `.instrument/checks.json`.
#[derive(Debug, Clone, serde::Deserialize)]
struct DeclaredCommand {
    command: String,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct DeclaredChecks {
    build: Option<DeclaredCommand>,
    test: Option<DeclaredCommand>,
    typecheck: Option<DeclaredCommand>,
}

/// What the panel needs to explain the report, beyond the findings themselves.
#[derive(Debug, Clone, Serialize)]
pub struct HarnessRun {
    pub report: HarnessReport,
    /// Declared command per slug, so the UI can show `build: yarn build` even
    /// when it was not run this time.
    pub declared: Vec<DeclaredEntry>,
    /// True when this call actually executed the declared commands.
    pub ran_tools: bool,
    /// Why the tool checks are `NotRun`, when they are. `None` when they ran.
    pub not_run_reason: Option<String>,
    /// Files actually read by the secret scan, and how many were skipped.
    pub files_scanned: usize,
    pub files_skipped: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeclaredEntry {
    pub slug: String,
    pub command: String,
    pub cwd: Option<String>,
}

/// Reads `.instrument/checks.json`.
///
/// Returns the parse error rather than swallowing it: a file that exists but
/// cannot be read is a fact the person needs, not a silent fallback to "nothing
/// declared" — those two look identical on screen and mean opposite things.
fn read_declared(root: &Path) -> (DeclaredChecks, Option<String>) {
    let path = root.join(".instrument").join("checks.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return (
            DeclaredChecks::default(),
            Some(
                "nenhum comando declarado em .instrument/checks.json — build, testes e tipos \
                 não foram executados"
                    .to_string(),
            ),
        );
    };
    match serde_json::from_str::<DeclaredChecks>(&raw) {
        Ok(parsed) => (parsed, None),
        Err(error) => (
            DeclaredChecks::default(),
            Some(format!(
                ".instrument/checks.json existe mas não pôde ser lido ({error}) — \
                 build, testes e tipos não foram executados"
            )),
        ),
    }
}

/// Runs one declared command and reports what was observed.
///
/// A command that cannot even be spawned is `Inconclusive`, not `Failed`: "the
/// tool is missing" and "the tool ran and said no" are different facts, and
/// `ide_harness` renders them differently on purpose.
fn run_declared(root: &Path, declared: &DeclaredCommand) -> ToolOutcome {
    let cwd = match &declared.cwd {
        Some(rel) => root.join(rel),
        None => root.to_path_buf(),
    };
    let shown = match &declared.cwd {
        Some(rel) => format!("`{}` (cwd {rel})", declared.command),
        None => format!("`{}`", declared.command),
    };

    // Declared commands are shell lines ("yarn build && tsc"), so they run
    // through a shell rather than being naively split on spaces.
    let output = Command::new("sh")
        .arg("-c")
        .arg(&declared.command)
        .current_dir(&cwd)
        .output();

    match output {
        Err(error) => ToolOutcome {
            status: ToolStatus::Inconclusive,
            detail: format!("{shown} não pôde ser executado: {error}"),
        },
        Ok(out) => {
            let code = out
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "encerrado por sinal".to_string());
            if out.status.success() {
                ToolOutcome {
                    status: ToolStatus::Succeeded,
                    detail: format!("{shown} saiu com código {code}"),
                }
            } else {
                let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
                combined.push_str(&String::from_utf8_lossy(&out.stderr));
                let tail = tail_of(&combined);
                ToolOutcome {
                    status: ToolStatus::Failed,
                    detail: format!("{shown} saiu com código {code}. Fim da saída: {tail}"),
                }
            }
        }
    }
}

/// Last `MAX_OUTPUT_TAIL` characters of a command's output, on a char boundary.
fn tail_of(text: &str) -> String {
    let trimmed = text.trim_end();
    if trimmed.len() <= MAX_OUTPUT_TAIL {
        return trimmed.to_string();
    }
    let mut start = trimmed.len() - MAX_OUTPUT_TAIL;
    while start < trimmed.len() && !trimmed.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &trimmed[start..])
}

/// `git status --porcelain`, or `None` when the root is not a repository.
///
/// `--no-optional-locks` so a read-only check never fights the user's own git.
fn git_porcelain(root: &Path) -> Option<String> {
    if !root.join(".git").exists() {
        return None;
    }
    let output = Command::new("git")
        .args(["--no-optional-locks", "status", "--porcelain"])
        .current_dir(root)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Walks the project for text files the secret scan can read.
///
/// Returns `(files, skipped)` — skipped counts files that matched a text
/// extension but were too large or unreadable, so the panel can say the scan
/// was partial instead of implying it covered everything.
fn scan_files(root: &Path) -> (Vec<(String, String)>, usize) {
    let mut files = Vec::new();
    let mut skipped = 0usize;
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(path);
                }
                continue;
            }
            let is_text = path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| TEXT_EXTENSIONS.contains(&e));
            if !is_text {
                continue;
            }
            if files.len() >= MAX_FILES {
                skipped += 1;
                continue;
            }
            let too_big = entry
                .metadata()
                .map(|m| m.len() > MAX_FILE_BYTES)
                .unwrap_or(true);
            if too_big {
                skipped += 1;
                continue;
            }
            match std::fs::read_to_string(&path) {
                Ok(content) => {
                    let rel = path
                        .strip_prefix(root)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .into_owned();
                    files.push((rel, content));
                }
                Err(_) => skipped += 1,
            }
        }
    }
    (files, skipped)
}

/// Manifest/lock pairs present in the project.
///
/// ONE lock per manifest, deliberately. `ide_harness` keys each finding by the
/// manifest (`layer0:deps:package.json`), so emitting a second pair for the same
/// manifest produces two findings claiming the same id — and, worse, a
/// yarn project would get a "package-lock.json is missing" finding that is
/// simply false. So for a manifest with several conventional locks, the one
/// actually on disk wins; when none is there, the conventional default is
/// reported as the missing one.
fn dependency_locks(root: &Path) -> Vec<DependencyLock> {
    const CANDIDATES: [(&str, &[&str]); 3] = [
        ("Cargo.toml", &["Cargo.lock"]),
        (
            "package.json",
            &["package-lock.json", "yarn.lock", "pnpm-lock.yaml"],
        ),
        ("pyproject.toml", &["poetry.lock", "uv.lock", "pdm.lock"]),
    ];

    CANDIDATES
        .into_iter()
        .filter(|(manifest, _)| root.join(manifest).is_file())
        .map(|(manifest, locks)| {
            let present = locks.iter().find(|lock| root.join(lock).is_file());
            DependencyLock {
                manifest: manifest.to_owned(),
                // Naming the conventional lock when none exists keeps the
                // remediation actionable instead of vague.
                lock: present.unwrap_or(&locks[0]).to_string(),
                lock_present: present.is_some(),
            }
        })
        .collect()
}

/// Gathers every observed fact and hands it to the engine.
///
/// `pending_effects` comes from the caller because the broker lives there; this
/// module never opens one.
pub fn run(root: &Path, pending_effects: usize, run_tools: bool) -> HarnessRun {
    let (declared, config_problem) = read_declared(root);
    let (files, files_skipped) = scan_files(root);
    let files_scanned = files.len();

    let entries = [
        ("build", declared.build.as_ref()),
        ("test", declared.test.as_ref()),
        ("typecheck", declared.typecheck.as_ref()),
    ];
    let declared_entries: Vec<DeclaredEntry> = entries
        .iter()
        .filter_map(|(slug, cmd)| {
            cmd.map(|c| DeclaredEntry {
                slug: (*slug).to_string(),
                command: c.command.clone(),
                cwd: c.cwd.clone(),
            })
        })
        .collect();

    // Three different reasons a tool check can be `NotRun`, and the panel has to
    // be able to tell them apart — "not run" with no reason is the shape of a
    // check that looks unfinished when it is actually unconfigured.
    let undeclared: Vec<&str> = entries
        .iter()
        .filter(|(_, cmd)| cmd.is_none())
        .map(|(slug, _)| *slug)
        .collect();
    let not_run_reason = if let Some(problem) = config_problem {
        // No config, or an unreadable one: nothing could have run, whether or
        // not running was asked for.
        Some(problem)
    } else if !run_tools {
        Some(
            "comandos declarados, mas os checks de build/testes/tipos não foram executados \
             nesta passagem"
                .to_string(),
        )
    } else if !undeclared.is_empty() {
        // Partially declared: say exactly which ones have no command, instead of
        // leaving them looking merely unfinished.
        Some(format!(
            "sem comando declarado para {} em .instrument/checks.json — {} não {} executado{}",
            undeclared.join(", "),
            if undeclared.len() == 1 {
                "esse check"
            } else {
                "esses checks"
            },
            if undeclared.len() == 1 {
                "foi"
            } else {
                "foram"
            },
            if undeclared.len() == 1 { "" } else { "s" }
        ))
    } else {
        None
    };

    let execute = |cmd: Option<&DeclaredCommand>| -> Option<ToolOutcome> {
        match (run_tools, cmd) {
            (true, Some(c)) => Some(run_declared(root, c)),
            _ => None,
        }
    };

    let inputs = HarnessInputs {
        git_porcelain: git_porcelain(root),
        files,
        dependency_locks: dependency_locks(root),
        pending_effects,
        build: execute(declared.build.as_ref()),
        test: execute(declared.test.as_ref()),
        typecheck: execute(declared.typecheck.as_ref()),
    };

    let mut report = ide_harness::run_layer0(&inputs);
    // §15 — a camada semântica que PODE ser avaliada sem inferência paga, e a
    // declaração explícita das que não podem. Sem isto o relatório dizia "tudo
    // passou" com ambiguidade, risco e divergência nunca olhados.
    append_semantic_layer(root, &mut report);
    recount(&mut report);

    HarnessRun {
        report,
        declared: declared_entries,
        ran_tools: run_tools,
        not_run_reason,
        files_scanned,
        files_skipped,
    }
}

/// Acrescenta ao relatório a camada 1 — semântica determinística — e diz o que
/// dela ficou de fora.
///
/// Duas dimensões dão para avaliar aqui sem gastar inferência:
///
///   • **divergência** (§4): declarado × observado já está gravado, e uma
///     divergência ABERTA é uma falha do projeto que o harness estava ignorando.
///   • **ambiguidade e contradição na intenção** (§8): a intenção durável do
///     projeto é texto declarado, e os avaliadores do `ide-semantic` rodam sobre
///     ela sem chamar modelo nenhum.
///
/// **Risco** e **decisão** não são avaliados: precisam de julgamento que este
/// harness não faz de graça, e prometer que foram olhados seria pior do que
/// dizer que não foram.
fn append_semantic_layer(root: &Path, report: &mut ide_harness::HarnessReport) {
    use ide_harness::{CheckState, CoverageRow, Finding, Severity};

    // ── divergência declarado × observado ─────────────────────────────────
    let snapshot = crate::reconcile::scan(root);
    let abertas: Vec<_> = snapshot
        .divergences
        .iter()
        .filter(|view| view.reconciliation.is_none())
        .collect();
    let (state, summary, remediation) = if !abertas.is_empty() {
        let quais = abertas
            .iter()
            .map(|view| view.divergence.subject.clone())
            .collect::<Vec<_>>()
            .join(", ");
        (
            CheckState::Failed,
            format!(
                "{} divergência(s) aberta(s) entre declarado e observado: {quais}",
                abertas.len()
            ),
            Some(
                "Decida cada divergência em Declarado × observado: mudar a implementação, \
                 aceitar o observado como intenção, ou registrar exceção escopada."
                    .to_owned(),
            ),
        )
    } else if snapshot.nothing_to_compare.is_some() {
        (
            CheckState::NotRun,
            snapshot
                .nothing_to_compare
                .clone()
                .unwrap_or_else(|| "nada a comparar".to_owned()),
            Some(
                "Declare a expectativa (url de saúde em .instrument/preview.json ou \
                 .instrument/intents.json) e observe o preview para haver o que comparar."
                    .to_owned(),
            ),
        )
    } else {
        (
            CheckState::Passed,
            "nenhuma divergência aberta entre o que foi declarado e o que foi observado".to_owned(),
            None,
        )
    };
    report.findings.push(Finding {
        id: "layer1:divergence".to_owned(),
        check_id: "divergence".to_owned(),
        layer: 1,
        title: "Divergência declarado × observado".to_owned(),
        state,
        severity: if state == CheckState::Failed {
            Severity::High
        } else {
            Severity::Info
        },
        claim: "o que o projeto declara sobre si é o que foi observado dele".to_owned(),
        evidence: summary,
        remediation,
    });

    // ── ambiguidade e contradição na intenção durável ─────────────────────
    let intent = crate::project::snapshot(root)
        .ok()
        .and_then(|project| project.project.map(|p| p.intent))
        .filter(|intent| !intent.trim().is_empty());
    let (intent_state, intent_evidence, intent_remediation) = match intent.as_deref() {
        None => (
            CheckState::NotRun,
            "este projeto não tem intenção durável registrada — não há texto para avaliar"
                .to_owned(),
            Some(
                "Registre título e intenção do projeto: é o que sobrevive sem transcript."
                    .to_owned(),
            ),
        ),
        Some(text) => match crate::intent::review_snapshot(root, text, None) {
            Err(error) => (
                CheckState::Unknown,
                format!("a avaliação da intenção não pôde ser feita: {error}"),
                Some(
                    "Tente de novo; enquanto isso, isto NÃO conta como intenção aprovada."
                        .to_owned(),
                ),
            ),
            Ok(review) => {
                let abertos = review
                    .reviewed
                    .iter()
                    .filter(|finding| finding.decision.is_none())
                    .count();
                if abertos == 0 {
                    (
                        CheckState::Passed,
                        format!(
                            "{} avaliador(es) rodaram sobre a intenção e nada ficou sem decisão",
                            review.report.evaluators_run.len()
                        ),
                        None,
                    )
                } else {
                    (
                        CheckState::Failed,
                        format!(
                            "{abertos} hipótese(s) sobre a intenção sem decisão — avaliadores: {}",
                            review.report.evaluators_run.join(", ")
                        ),
                        Some(
                            "Abra a intenção e decida cada hipótese: aceitar, recusar ou \
                             reescrever o texto. Hipótese sem decisão não é aprovação."
                                .to_owned(),
                        ),
                    )
                }
            }
        },
    };
    report.findings.push(Finding {
        id: "layer1:intent".to_owned(),
        check_id: "intent-ambiguity".to_owned(),
        layer: 1,
        title: "Ambiguidade e contradição na intenção".to_owned(),
        state: intent_state,
        severity: if intent_state == CheckState::Failed {
            Severity::Medium
        } else {
            Severity::Info
        },
        claim: "a intenção declarada do projeto não é ambígua nem se contradiz".to_owned(),
        evidence: intent_evidence,
        remediation: intent_remediation,
    });

    let row = |id: &str, label: &str, evaluated: bool, detail: &str| CoverageRow {
        id: id.to_owned(),
        label: label.to_owned(),
        evaluated,
        detail: detail.to_owned(),
    };
    report.coverage.push(row(
        "divergence",
        "Divergência declarado × observado",
        state != CheckState::NotRun,
        match state {
            CheckState::NotRun => "não havia o que comparar nesta execução",
            _ => "as divergências gravadas deste projeto foram lidas",
        },
    ));
    report.coverage.push(row(
        "intent",
        "Ambiguidade e contradição na intenção",
        intent_state == CheckState::Passed || intent_state == CheckState::Failed,
        match intent_state {
            CheckState::NotRun => "sem intenção durável registrada, não há texto para avaliar",
            CheckState::Unknown => "a avaliação falhou nesta execução",
            _ => "os avaliadores determinísticos rodaram sobre a intenção declarada",
        },
    ));
    report.coverage.push(row(
        "risk",
        "Risco",
        false,
        "não avaliado: exige julgamento que este harness não faz sem inferência paga",
    ));
    report.coverage.push(row(
        "decisions",
        "Qualidade das decisões",
        false,
        "não avaliado: exige julgamento que este harness não faz sem inferência paga",
    ));
}

/// Recontagem depois de acrescentar findings fora da camada 0.
fn recount(report: &mut ide_harness::HarnessReport) {
    use ide_harness::CheckState;
    report.passed = 0;
    report.failed = 0;
    report.unknown = 0;
    report.not_run = 0;
    for finding in &report.findings {
        match finding.state {
            CheckState::Passed => report.passed += 1,
            CheckState::Failed => report.failed += 1,
            CheckState::Unknown => report.unknown += 1,
            CheckState::NotRun => report.not_run += 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// §15 — o relatório tem de explicar a PRÓPRIA cobertura.
    ///
    /// Antes ele contava passou/falhou/desconhecido/não-executado, e com os
    /// quatro determinísticos passando a tela dizia "tudo passou" — enquanto
    /// risco, decisões, divergência e ambiguidade nunca tinham sido olhados.
    /// "Sem falhas" parecendo "está bom" é a conflação que este harness existe
    /// para não fazer.
    #[test]
    fn relatorio_declara_o_que_nao_verificou() {
        let dir = project();

        let run = run(dir.path(), 0, false);

        let por_id = |id: &str| {
            run.report
                .coverage
                .iter()
                .find(|row| row.id == id)
                .unwrap_or_else(|| panic!("cobertura sem a dimensão {id}"))
        };

        // As dimensões que o §15 nomeia estão TODAS na cobertura, avaliadas ou não.
        for id in [
            "git",
            "secrets",
            "deps",
            "effects",
            "build",
            "test",
            "typecheck",
            "divergence",
            "intent",
            "risk",
            "decisions",
        ] {
            let row = por_id(id);
            assert!(
                !row.detail.trim().is_empty(),
                "cobertura de {id} sem motivo dito — silêncio aqui é o defeito"
            );
        }

        // Sem rodar comandos, ferramenta declarada não conta como avaliada.
        assert!(!por_id("build").evaluated);
        assert!(!por_id("test").evaluated);

        // O que exige julgamento é dito como não avaliado, nunca omitido.
        assert!(!por_id("risk").evaluated);
        assert!(!por_id("decisions").evaluated);
        assert!(
            por_id("risk").detail.contains("inferência paga"),
            "o motivo de não avaliar risco é dito, não escondido"
        );

        // E a camada semântica entrou no relatório como finding de verdade.
        assert!(
            run.report
                .findings
                .iter()
                .any(|f| f.check_id == "divergence" && f.layer == 1),
            "divergência declarado × observado é parte do harness, não um cartão à parte"
        );
        assert!(
            run.report
                .findings
                .iter()
                .any(|f| f.check_id == "intent-ambiguity" && f.layer == 1),
            "ambiguidade da intenção é parte do harness"
        );
    }

    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("a.rs"), "fn main() {}").unwrap();
        dir
    }

    /// No declared file must not read as "everything is fine": the tool checks
    /// come back NotRun with the reason on screen.
    #[test]
    fn without_a_declared_file_the_tool_checks_are_not_run_and_say_why() {
        let dir = project();
        let run = run(dir.path(), 0, true);

        assert!(run
            .not_run_reason
            .as_deref()
            .unwrap()
            .contains("checks.json"));
        assert!(run.declared.is_empty());
        let tool_states: Vec<_> = run
            .report
            .findings
            .iter()
            .filter(|f| ["build", "test", "typecheck"].contains(&f.check_id.as_str()))
            .map(|f| f.state)
            .collect();
        assert_eq!(tool_states.len(), 3);
        assert!(tool_states
            .iter()
            .all(|s| *s == ide_harness::CheckState::NotRun));
    }

    /// Declared-but-not-run and nothing-declared are different facts, and the
    /// reason must distinguish them.
    #[test]
    fn declared_but_not_executed_reports_a_different_reason() {
        let dir = project();
        write_checks(dir.path(), r#"{"test":{"command":"true"}}"#);

        let run = run(dir.path(), 0, false);

        assert!(!run.ran_tools);
        assert_eq!(run.declared.len(), 1);
        assert_eq!(run.declared[0].command, "true");
        let reason = run.not_run_reason.unwrap();
        assert!(reason.contains("não foram executados"), "{reason}");
        assert!(!reason.contains("checks.json"), "{reason}");
    }

    #[test]
    fn a_declared_command_that_succeeds_passes_and_carries_the_raw_command() {
        let dir = project();
        write_checks(dir.path(), r#"{"test":{"command":"true"}}"#);

        let run = run(dir.path(), 0, true);

        let finding = tool_finding(&run, "test");
        assert_eq!(finding.state, ide_harness::CheckState::Passed);
        // The promise §4 makes: a green check shows what produced it.
        assert!(finding.evidence.contains("`true`"), "{}", finding.evidence);
        assert!(
            finding.evidence.contains("código 0"),
            "{}",
            finding.evidence
        );
    }

    #[test]
    fn a_failing_command_fails_and_keeps_the_end_of_its_output() {
        let dir = project();
        write_checks(
            dir.path(),
            r#"{"build":{"command":"echo estourou aqui; exit 3"}}"#,
        );

        let run = run(dir.path(), 0, true);

        let finding = tool_finding(&run, "build");
        assert_eq!(finding.state, ide_harness::CheckState::Failed);
        assert!(
            finding.evidence.contains("código 3"),
            "{}",
            finding.evidence
        );
        assert!(
            finding.evidence.contains("estourou aqui"),
            "{}",
            finding.evidence
        );
    }

    /// "The tool is missing" is not "the tool said no". `Inconclusive` maps to
    /// `Unknown`, which is never an approval and never a failure either.
    #[test]
    fn a_command_that_cannot_run_is_inconclusive_not_failed() {
        let dir = project();
        write_checks(
            dir.path(),
            r#"{"typecheck":{"command":"x","cwd":"nao-existe"}}"#,
        );

        let run = run(dir.path(), 0, true);

        assert_eq!(
            tool_finding(&run, "typecheck").state,
            ide_harness::CheckState::Unknown
        );
    }

    /// A broken config must not hide the deterministic checks that need no
    /// commands at all.
    #[test]
    fn a_malformed_config_is_reported_without_losing_the_other_checks() {
        let dir = project();
        write_checks(dir.path(), "{ isto não é json");

        let run = run(dir.path(), 0, true);

        assert!(run
            .not_run_reason
            .as_deref()
            .unwrap()
            .contains("não pôde ser lido"));
        assert!(
            run.report
                .findings
                .iter()
                .any(|f| f.check_id == "secret-scan"
                    || f.check_id == "git-clean"
                    || f.check_id == "pending-effects"),
            "os checks determinísticos continuam rodando"
        );
    }

    /// Partially declared is its own case: the ones with no command must be
    /// named, not left looking merely unfinished.
    #[test]
    fn undeclared_slugs_are_named_when_the_others_ran() {
        let dir = project();
        write_checks(dir.path(), r#"{"test":{"command":"true"}}"#);

        let run = run(dir.path(), 0, true);

        assert_eq!(
            tool_finding(&run, "test").state,
            ide_harness::CheckState::Passed
        );
        let reason = run
            .not_run_reason
            .expect("build e typecheck não têm comando");
        assert!(reason.contains("build"), "{reason}");
        assert!(reason.contains("typecheck"), "{reason}");
        assert!(!reason.contains("test,"), "{reason}");
    }

    /// One manifest yields exactly one lock finding. Two would collide on the
    /// engine's per-manifest id, and one of them would be a false claim.
    #[test]
    fn a_manifest_with_several_possible_locks_yields_one_finding() {
        let dir = project();
        std::fs::write(dir.path().join("package.json"), "{}").unwrap();
        std::fs::write(dir.path().join("yarn.lock"), "").unwrap();

        let locks = dependency_locks(dir.path());

        assert_eq!(locks.len(), 1);
        assert_eq!(locks[0].lock, "yarn.lock", "o lock que existe é o que vale");
        assert!(locks[0].lock_present);

        let run = run(dir.path(), 0, false);
        let ids: Vec<_> = run.report.findings.iter().map(|f| f.id.clone()).collect();
        let mut unique = ids.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(ids.len(), unique.len(), "nenhum finding pode repetir id");
    }

    /// With no lock at all, the conventional one is named so the remediation is
    /// actionable rather than vague.
    #[test]
    fn a_manifest_with_no_lock_names_the_conventional_one() {
        let dir = project();
        std::fs::write(dir.path().join("package.json"), "{}").unwrap();

        let locks = dependency_locks(dir.path());

        assert_eq!(locks[0].lock, "package-lock.json");
        assert!(!locks[0].lock_present);
    }

    #[test]
    fn build_output_directories_are_not_scanned() {
        let dir = project();
        std::fs::create_dir_all(dir.path().join("node_modules")).unwrap();
        std::fs::write(dir.path().join("node_modules/big.js"), "x").unwrap();

        let run = run(dir.path(), 0, false);

        assert_eq!(run.files_scanned, 1, "só a.rs");
    }

    fn write_checks(root: &Path, body: &str) {
        std::fs::create_dir_all(root.join(".instrument")).unwrap();
        std::fs::write(root.join(".instrument/checks.json"), body).unwrap();
    }

    fn tool_finding<'a>(run: &'a HarnessRun, slug: &str) -> &'a ide_harness::Finding {
        run.report
            .findings
            .iter()
            .find(|f| f.check_id == slug)
            .expect("finding")
    }
}
