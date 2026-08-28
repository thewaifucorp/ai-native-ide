//! Deterministic Layer-0 harness checks for the AI-Native IDE.
//!
//! This layer is deterministic and evidence-first: it never runs paid inference
//! and never presents `unknown` or `not_run` as an approval. It evaluates facts
//! the host already observed (git status, workspace file contents, dependency
//! lockfiles, pending effects) into findings that carry an explicit state,
//! evidence and remediation. Keeping the evaluation shell-neutral makes each
//! rule directly testable and prevents a check from inventing confidence.

use serde::{Deserialize, Serialize};

/// A check's outcome. `Unknown` and `NotRun` are distinct absences of knowledge;
/// neither is ever an approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckState {
    Passed,
    Failed,
    Unknown,
    NotRun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Info,
    Low,
    Medium,
    High,
    Critical,
}

/// Uma dimensão que o harness ou verifica, ou declara que não verificou.
///
/// ── POR QUE ISTO EXISTE (o "Pronto" do §15) ───────────────────────────────
/// O relatório contava passou/falhou/desconhecido/não-executado, e com os quatro
/// determinísticos passando a tela dizia "tudo passou" — enquanto ambiguidade,
/// risco e divergência nunca tinham sido avaliados. Um relatório que não diz o
/// que ficou de fora deixa "sem falhas" parecer "está bom", que é a conflação
/// que este harness existe para não fazer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageRow {
    /// Id estável, para a tela agrupar sem depender do texto.
    pub id: String,
    /// Como uma pessoa chama isso.
    pub label: String,
    /// Foi avaliado NESTA execução.
    pub evaluated: bool,
    /// O que foi olhado, ou o que faltou para olhar. Nunca vazio.
    pub detail: String,
}

/// A single deterministic finding. Every field is required so a Layer-0 result
/// can never be a bare boolean without evidence and remediation.

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    pub check_id: String,
    pub layer: u8,
    pub title: String,
    pub state: CheckState,
    pub severity: Severity,
    /// The assertion being evaluated.
    pub claim: String,
    /// The observed fact that supports the state.
    pub evidence: String,
    pub remediation: Option<String>,
}

/// Raw facts the host observed, passed to the deterministic evaluators. `None`
/// means "not observed", which maps to `NotRun`/`Unknown` rather than success.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessInputs {
    /// `git status --porcelain` output; `None` when the resource is not a repo.
    pub git_porcelain: Option<String>,
    /// Workspace files as `(relative_path, content)` for the secret scan.
    pub files: Vec<(String, String)>,
    /// Manifest/lockfile pairs to check, as `(manifest, lock, lock_present)`.
    pub dependency_locks: Vec<DependencyLock>,
    /// Effects still awaiting approval at scan time.
    pub pending_effects: usize,
    /// Outcome of the host's build run, or `None` when it was not run.
    pub build: Option<ToolOutcome>,
    /// Outcome of the host's test run, or `None` when it was not run.
    pub test: Option<ToolOutcome>,
    /// Outcome of the host's typecheck run, or `None` when it was not run.
    pub typecheck: Option<ToolOutcome>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyLock {
    pub manifest: String,
    pub lock: String,
    pub lock_present: bool,
}

/// Whether a supplied build/test/typecheck run succeeded, failed or was
/// inconclusive. Layer-0 never executes the tool; it evaluates this reported
/// status. An absent outcome (`None`) is distinct and maps to `NotRun`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Succeeded,
    Failed,
    /// The run neither clearly passed nor failed (e.g. crashed, timed out).
    Inconclusive,
}

/// The outcome of an external build/test/typecheck run, observed by the host and
/// handed to the deterministic harness. The harness only classifies it; it never
/// shells out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutcome {
    pub status: ToolStatus,
    /// The observed fact backing the status (e.g. exit code or error summary).
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessReport {
    pub findings: Vec<Finding>,
    pub passed: usize,
    pub failed: usize,
    pub unknown: usize,
    pub not_run: usize,
    /// O que este relatório cobre, e o que ele NÃO cobre — ver `CoverageRow`.
    ///
    /// A camada 0 preenche as dimensões determinísticas; quem chama acrescenta as
    /// que só ele pode avaliar (divergência, intenção) antes de mostrar.
    #[serde(default)]
    pub coverage: Vec<CoverageRow>,
}

/// A cobertura da camada 0, dita a partir do que ela realmente olhou.
///
/// Cada linha responde "isto foi avaliado?" com o motivo. Um comando declarado
/// mas não executado não conta como avaliado — foi exatamente a confusão que
/// `not_run` já evita nos findings, e aqui ela também não pode aparecer.
fn layer0_coverage(inputs: &HarnessInputs) -> Vec<CoverageRow> {
    let row = |id: &str, label: &str, evaluated: bool, detail: String| CoverageRow {
        id: id.to_owned(),
        label: label.to_owned(),
        evaluated,
        detail,
    };
    let ferramenta = |nome: &str, outcome: Option<&ToolOutcome>| -> (bool, String) {
        match outcome {
            Some(_) => (
                true,
                format!("{nome} declarado foi executado nesta medição"),
            ),
            None => (
                false,
                format!(
                    "{nome} não foi executado: declare o comando em .instrument/checks.json e \
                     escolha medir rodando comandos"
                ),
            ),
        }
    };
    let (build_ok, build_why) = ferramenta("build", inputs.build.as_ref());
    let (test_ok, test_why) = ferramenta("testes", inputs.test.as_ref());
    let (types_ok, types_why) = ferramenta("verificação de tipos", inputs.typecheck.as_ref());

    vec![
        row(
            "git",
            "Estado do Git",
            inputs.git_porcelain.is_some(),
            match inputs.git_porcelain.as_deref() {
                Some(_) => "o status do repositório foi lido".to_owned(),
                None => "não foi possível ler o status do Git deste projeto".to_owned(),
            },
        ),
        row(
            "secrets",
            "Segredo em texto claro",
            true,
            format!(
                "{} arquivo(s) de texto varrido(s) por formas conhecidas de segredo",
                inputs.files.len()
            ),
        ),
        row(
            "deps",
            "Lockfile de dependências",
            true,
            format!(
                "{} manifesto(s) de dependência conferido(s)",
                inputs.dependency_locks.len()
            ),
        ),
        row(
            "effects",
            "Efeitos pendentes",
            true,
            "a fila de aprovação do broker foi consultada".to_owned(),
        ),
        row("build", "Build", build_ok, build_why),
        row("test", "Testes", test_ok, test_why),
        row("typecheck", "Verificação de tipos", types_ok, types_why),
    ]
}

/// Runs every Layer-0 check over the observed inputs and deduplicates findings.
pub fn run_layer0(inputs: &HarnessInputs) -> HarnessReport {
    let mut findings = Vec::new();
    findings.push(git_cleanliness(inputs.git_porcelain.as_deref()));
    findings.extend(secret_scan(&inputs.files));
    findings.extend(dependency_locks(&inputs.dependency_locks));
    findings.push(pending_effects(inputs.pending_effects));
    findings.extend(build_test_typecheck(inputs));
    let findings = dedup(findings);

    let mut report = HarnessReport {
        passed: 0,
        failed: 0,
        unknown: 0,
        not_run: 0,
        coverage: layer0_coverage(inputs),
        findings: Vec::new(),
    };
    for finding in &findings {
        match finding.state {
            CheckState::Passed => report.passed += 1,
            CheckState::Failed => report.failed += 1,
            CheckState::Unknown => report.unknown += 1,
            CheckState::NotRun => report.not_run += 1,
        }
    }
    report.findings = findings;
    report
}

/// Deduplicates findings sharing a `check_id` and evidence, keeping the first.
pub fn dedup(findings: Vec<Finding>) -> Vec<Finding> {
    let mut seen = Vec::new();
    let mut unique = Vec::new();
    for finding in findings {
        let key = format!("{}::{}", finding.check_id, finding.evidence);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        unique.push(finding);
    }
    unique
}

pub fn git_cleanliness(porcelain: Option<&str>) -> Finding {
    match porcelain {
        None => Finding {
            id: "layer0:git-clean".to_owned(),
            check_id: "git-clean".to_owned(),
            layer: 0,
            title: "Estado do Git".to_owned(),
            state: CheckState::NotRun,
            severity: Severity::Info,
            claim: "O recurso ativo é um repositório com estado inspecionável.".to_owned(),
            evidence: "O recurso não é um repositório Git.".to_owned(),
            remediation: None,
        },
        Some(output) if output.trim().is_empty() => Finding {
            id: "layer0:git-clean".to_owned(),
            check_id: "git-clean".to_owned(),
            layer: 0,
            title: "Estado do Git".to_owned(),
            state: CheckState::Passed,
            severity: Severity::Info,
            claim: "A árvore de trabalho não tem mudanças não confirmadas.".to_owned(),
            evidence: "git status --porcelain vazio.".to_owned(),
            remediation: None,
        },
        Some(output) => {
            let changed = output
                .lines()
                .filter(|line| !line.trim().is_empty())
                .count();
            Finding {
                id: "layer0:git-clean".to_owned(),
                check_id: "git-clean".to_owned(),
                layer: 0,
                title: "Estado do Git".to_owned(),
                state: CheckState::Failed,
                severity: Severity::Low,
                claim: "A árvore de trabalho não tem mudanças não confirmadas.".to_owned(),
                evidence: format!("{changed} caminho(s) com mudanças não confirmadas."),
                remediation: Some(
                    "Revise o diff do checkpoint e confirme ou reverta as mudanças.".to_owned(),
                ),
            }
        }
    }
}

/// Scans file contents for high-confidence secret shapes using only exact,
/// deterministic string rules — never a heuristic guess dressed as certainty.
pub fn secret_scan(files: &[(String, String)]) -> Vec<Finding> {
    let mut findings = Vec::new();
    for (path, content) in files {
        for (index, line) in content.lines().enumerate() {
            if let Some(kind) = secret_kind(line) {
                findings.push(Finding {
                    id: format!("layer0:secret:{path}:{}", index + 1),
                    check_id: "secret-scan".to_owned(),
                    layer: 0,
                    title: "Segredo em texto claro".to_owned(),
                    state: CheckState::Failed,
                    severity: Severity::Critical,
                    claim: "Nenhum segredo aparece em texto claro no workspace.".to_owned(),
                    evidence: format!("{kind} em {path}:{}", index + 1),
                    remediation: Some(
                        "Remova o segredo do arquivo e use uma referência secret:// ou variável de ambiente."
                            .to_owned(),
                    ),
                });
            }
        }
    }
    if findings.is_empty() {
        findings.push(Finding {
            id: "layer0:secret".to_owned(),
            check_id: "secret-scan".to_owned(),
            layer: 0,
            title: "Segredo em texto claro".to_owned(),
            state: CheckState::Passed,
            severity: Severity::Info,
            claim: "Nenhum segredo aparece em texto claro no workspace.".to_owned(),
            evidence: "Nenhuma linha correspondeu às formas de segredo verificadas.".to_owned(),
            remediation: None,
        });
    }
    findings
}

fn secret_kind(line: &str) -> Option<&'static str> {
    if line.contains("-----BEGIN") && line.contains("PRIVATE KEY") {
        return Some("chave privada");
    }
    if let Some(start) = line.find("AKIA") {
        let candidate = &line[start..];
        let token: String = candidate
            .chars()
            .take(20)
            .take_while(|character| character.is_ascii_uppercase() || character.is_ascii_digit())
            .collect();
        if token.len() == 20 {
            return Some("chave de acesso AWS");
        }
    }
    None
}

pub fn dependency_locks(locks: &[DependencyLock]) -> Vec<Finding> {
    if locks.is_empty() {
        return vec![Finding {
            id: "layer0:deps".to_owned(),
            check_id: "dependency-lock".to_owned(),
            layer: 0,
            title: "Lockfile de dependências".to_owned(),
            state: CheckState::NotRun,
            severity: Severity::Info,
            claim: "Manifestos de dependência têm lockfile reprodutível.".to_owned(),
            evidence: "Nenhum manifesto de dependência foi observado.".to_owned(),
            remediation: None,
        }];
    }
    locks
        .iter()
        .map(|lock| {
            if lock.lock_present {
                Finding {
                    id: format!("layer0:deps:{}", lock.manifest),
                    check_id: "dependency-lock".to_owned(),
                    layer: 0,
                    title: "Lockfile de dependências".to_owned(),
                    state: CheckState::Passed,
                    severity: Severity::Info,
                    claim: format!("{} tem lockfile reprodutível.", lock.manifest),
                    evidence: format!("{} presente.", lock.lock),
                    remediation: None,
                }
            } else {
                Finding {
                    id: format!("layer0:deps:{}", lock.manifest),
                    check_id: "dependency-lock".to_owned(),
                    layer: 0,
                    title: "Lockfile de dependências".to_owned(),
                    state: CheckState::Failed,
                    severity: Severity::Medium,
                    claim: format!("{} tem lockfile reprodutível.", lock.manifest),
                    evidence: format!("{} ausente para {}.", lock.lock, lock.manifest),
                    remediation: Some(format!(
                        "Gere e versiona {} para builds reprodutíveis.",
                        lock.lock
                    )),
                }
            }
        })
        .collect()
}

pub fn pending_effects(count: usize) -> Finding {
    if count == 0 {
        Finding {
            id: "layer0:effects".to_owned(),
            check_id: "pending-effects".to_owned(),
            layer: 0,
            title: "Efeitos pendentes".to_owned(),
            state: CheckState::Passed,
            severity: Severity::Info,
            claim: "Nenhum efeito ficou aguardando aprovação sem revisão.".to_owned(),
            evidence: "Fila de aprovação vazia.".to_owned(),
            remediation: None,
        }
    } else {
        Finding {
            id: "layer0:effects".to_owned(),
            check_id: "pending-effects".to_owned(),
            layer: 0,
            title: "Efeitos pendentes".to_owned(),
            state: CheckState::Unknown,
            severity: Severity::Medium,
            claim: "Nenhum efeito ficou aguardando aprovação sem revisão.".to_owned(),
            evidence: format!("{count} efeito(s) aguardando aprovação."),
            remediation: Some("Revise a fila de aprovação no Context Dock.".to_owned()),
        }
    }
}

/// Classifies the supplied build, test and typecheck outcomes into findings. The
/// harness never runs the tools; a missing outcome (`None`) is `NotRun`, an
/// inconclusive one is `Unknown`, and neither is ever reported as an approval.
pub fn build_test_typecheck(inputs: &HarnessInputs) -> Vec<Finding> {
    vec![
        tool_finding("build", "Build", inputs.build.as_ref()),
        tool_finding("test", "Testes", inputs.test.as_ref()),
        tool_finding(
            "typecheck",
            "Verificação de tipos",
            inputs.typecheck.as_ref(),
        ),
    ]
}

/// Maps one tool's optional outcome to a finding, preserving the shared
/// claim/evidence/remediation shape of the other Layer-0 checks.
fn tool_finding(slug: &str, title: &str, outcome: Option<&ToolOutcome>) -> Finding {
    let id = format!("layer0:{slug}");
    let claim = format!("{title}: a execução foi observada e teve sucesso.");
    match outcome {
        None => Finding {
            id,
            check_id: slug.to_owned(),
            layer: 0,
            title: title.to_owned(),
            state: CheckState::NotRun,
            severity: Severity::Info,
            claim,
            evidence: format!("Nenhum resultado de {title} foi observado."),
            remediation: None,
        },
        Some(ToolOutcome {
            status: ToolStatus::Succeeded,
            detail,
        }) => Finding {
            id,
            check_id: slug.to_owned(),
            layer: 0,
            title: title.to_owned(),
            state: CheckState::Passed,
            severity: Severity::Info,
            claim,
            evidence: format!("{title} concluiu com sucesso: {detail}"),
            remediation: None,
        },
        Some(ToolOutcome {
            status: ToolStatus::Failed,
            detail,
        }) => Finding {
            id,
            check_id: slug.to_owned(),
            layer: 0,
            title: title.to_owned(),
            state: CheckState::Failed,
            severity: Severity::High,
            claim,
            evidence: format!("{title} falhou: {detail}"),
            remediation: Some(format!(
                "Corrija a falha de {title} e reexecute a verificação antes de aprovar."
            )),
        },
        Some(ToolOutcome {
            status: ToolStatus::Inconclusive,
            detail,
        }) => Finding {
            id,
            check_id: slug.to_owned(),
            layer: 0,
            title: title.to_owned(),
            state: CheckState::Unknown,
            severity: Severity::Medium,
            claim,
            evidence: format!("{title} teve resultado inconclusivo: {detail}"),
            remediation: Some(format!(
                "Reexecute {title} até obter um resultado determinístico."
            )),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_repo_passes_and_dirty_repo_fails() {
        assert_eq!(git_cleanliness(Some("")).state, CheckState::Passed);
        assert_eq!(git_cleanliness(None).state, CheckState::NotRun);
        let dirty = git_cleanliness(Some(" M src/lib.rs\n?? new.txt\n"));
        assert_eq!(dirty.state, CheckState::Failed);
        assert!(dirty.evidence.contains('2'));
    }

    #[test]
    fn secret_scan_flags_private_key_and_aws_key() {
        let files = vec![(
            "config.env".to_owned(),
            "AWS=AKIAABCDEFGHIJKLMNOP\nok=value\n".to_owned(),
        )];
        let findings = secret_scan(&files);
        assert!(findings
            .iter()
            .any(|finding| finding.state == CheckState::Failed
                && finding.severity == Severity::Critical));
    }

    #[test]
    fn clean_files_pass_secret_scan() {
        let files = vec![("readme.md".to_owned(), "sem segredos aqui\n".to_owned())];
        let findings = secret_scan(&files);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].state, CheckState::Passed);
    }

    #[test]
    fn missing_lockfile_fails_and_present_passes() {
        let locks = vec![
            DependencyLock {
                manifest: "Cargo.toml".to_owned(),
                lock: "Cargo.lock".to_owned(),
                lock_present: true,
            },
            DependencyLock {
                manifest: "package.json".to_owned(),
                lock: "package-lock.json".to_owned(),
                lock_present: false,
            },
        ];
        let findings = dependency_locks(&locks);
        assert_eq!(findings[0].state, CheckState::Passed);
        assert_eq!(findings[1].state, CheckState::Failed);
    }

    #[test]
    fn pending_effect_is_unknown_never_passed() {
        assert_eq!(pending_effects(0).state, CheckState::Passed);
        assert_eq!(pending_effects(3).state, CheckState::Unknown);
    }

    #[test]
    fn report_counts_states_and_dedups() {
        let inputs = HarnessInputs {
            git_porcelain: Some(String::new()),
            files: vec![("a.txt".to_owned(), "limpo".to_owned())],
            dependency_locks: vec![DependencyLock {
                manifest: "Cargo.toml".to_owned(),
                lock: "Cargo.lock".to_owned(),
                lock_present: true,
            }],
            pending_effects: 0,
            build: Some(ToolOutcome {
                status: ToolStatus::Succeeded,
                detail: "exit 0".to_owned(),
            }),
            test: Some(ToolOutcome {
                status: ToolStatus::Succeeded,
                detail: "12 passed".to_owned(),
            }),
            typecheck: Some(ToolOutcome {
                status: ToolStatus::Succeeded,
                detail: "no errors".to_owned(),
            }),
        };
        let report = run_layer0(&inputs);
        assert_eq!(report.failed, 0);
        assert!(report.passed >= 3);
    }

    #[test]
    fn build_test_typecheck_all_not_run() {
        let inputs = HarnessInputs::default();
        let findings = build_test_typecheck(&inputs);
        assert_eq!(findings.len(), 3);
        assert!(findings
            .iter()
            .all(|finding| finding.state == CheckState::NotRun && finding.remediation.is_none()));
    }

    #[test]
    fn build_failed_reports_high_severity_failure() {
        let inputs = HarnessInputs {
            build: Some(ToolOutcome {
                status: ToolStatus::Failed,
                detail: "E0433".to_owned(),
            }),
            ..Default::default()
        };
        let build = build_test_typecheck(&inputs)
            .into_iter()
            .find(|finding| finding.check_id == "build")
            .expect("build finding present");
        assert_eq!(build.state, CheckState::Failed);
        assert_eq!(build.severity, Severity::High);
        assert!(build.remediation.is_some());
    }

    #[test]
    fn test_failed_reports_failure() {
        let inputs = HarnessInputs {
            test: Some(ToolOutcome {
                status: ToolStatus::Failed,
                detail: "2 failed".to_owned(),
            }),
            ..Default::default()
        };
        let test = build_test_typecheck(&inputs)
            .into_iter()
            .find(|finding| finding.check_id == "test")
            .expect("test finding present");
        assert_eq!(test.state, CheckState::Failed);
        assert!(test.evidence.contains("2 failed"));
    }

    #[test]
    fn typecheck_inconclusive_is_unknown_never_passed() {
        let inputs = HarnessInputs {
            typecheck: Some(ToolOutcome {
                status: ToolStatus::Inconclusive,
                detail: "tool crashed".to_owned(),
            }),
            ..Default::default()
        };
        let typecheck = build_test_typecheck(&inputs)
            .into_iter()
            .find(|finding| finding.check_id == "typecheck")
            .expect("typecheck finding present");
        assert_eq!(typecheck.state, CheckState::Unknown);
        assert_eq!(typecheck.severity, Severity::Medium);
    }

    #[test]
    fn all_passed_reports_three_passes() {
        let inputs = HarnessInputs {
            build: Some(ToolOutcome {
                status: ToolStatus::Succeeded,
                detail: "exit 0".to_owned(),
            }),
            test: Some(ToolOutcome {
                status: ToolStatus::Succeeded,
                detail: "12 passed".to_owned(),
            }),
            typecheck: Some(ToolOutcome {
                status: ToolStatus::Succeeded,
                detail: "no errors".to_owned(),
            }),
            ..Default::default()
        };
        let findings = build_test_typecheck(&inputs);
        assert!(findings
            .iter()
            .all(|finding| finding.state == CheckState::Passed));
    }
}
