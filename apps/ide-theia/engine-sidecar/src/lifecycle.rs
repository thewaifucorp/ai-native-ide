//! §16 — publicar e evoluir, sem exigir ShinAI nem Katsui.
//!
//! `ide_lifecycle` já modelava o ciclo inteiro e ninguém o chamava:
//! `build_export_manifest`, `confirmation_for`, `compensation_for` e o
//! `PublishLog`. Este módulo é o consumidor.
//!
//! # As três verdades que este caminho não pode borrar
//!
//! * **Export local é reversível de verdade.** Ele grava um arquivo em
//!   `.instrument/exports/` — estado de runtime do IDE, não conteúdo do projeto —
//!   e a compensação é apagar esse arquivo. É o único efeito daqui com undo real.
//! * **Publicação externa NÃO tem undo.** No máximo tem compensação: publicar
//!   retratação ou versão corrigida. Em destino imutável não tem nem isso, e aí
//!   a resposta é `compensation: null` em vez de um rollback inventado.
//! * **Confirmação é do motor.** Quem decide se pergunta é `confirmation_for`, e
//!   a pergunta é feita com a classe de reversibilidade na mão. A tela mostra
//!   essa decisão; não simula uma.
//!
//! # O que este módulo NÃO faz
//!
//! Não fala com serviço nenhum. "Publicar" aqui registra a publicação no log
//! local com a evidência do que ela é — o transporte para um destino real é o
//! próximo passo e não está fingido: `PublishTarget` diz qual classe de destino
//! foi declarada, e nada mais.

use ide_lifecycle::{
    build_export_manifest, compensation_for, confirmation_for, CompensationPlan,
    ConfirmationDecision, ExportInputs, ExportManifest, ExportedResource, LifecycleEffect,
    PublishLog, PublishRecord, PublishTarget, Reversibility,
};
use ide_semantic::content_hash;
use serde::Serialize;
use std::fs;
use std::path::Path;

use crate::project;

/// Where publications are recorded, and where exports land. Both are IDE runtime
/// state for the project: an export is deletable evidence, not project content.
const LOG_REL: &str = ".instrument/lifecycle";
const EXPORTS_REL: &str = ".instrument/exports";

/// One exported manifest on disk — the thing whose compensation is a real delete.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedFile {
    /// Path relative to the project root.
    pub path: String,
    pub bytes: u64,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleSnapshot {
    /// `None` while the folder is not a durable project yet — publishing
    /// something that has no registered intent would publish nothing at all.
    pub project_id: Option<String>,
    pub title: Option<String>,
    /// Latest recorded version, when there is one.
    pub latest_version: Option<String>,
    /// What the next publication would be called.
    pub next_version: String,
    pub history: Vec<PublishRecord>,
    pub exports: Vec<ExportedFile>,
    /// Why publishing is not available right now, when it is not.
    pub blocked_reason: Option<String>,
    pub log_path: String,
    pub exports_path: String,
}

/// What an attempted publication returned: either the question the engine says
/// must be asked first, or the record of what happened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishAttempt {
    /// True when nothing was published and a confirmation is required first.
    pub needs_confirmation: bool,
    /// The honest reversibility class of what is about to happen.
    pub reversibility: Reversibility,
    /// The concrete compensating action, or `None` when none exists.
    pub compensation: Option<CompensationPlan>,
    /// Sentence for the confirmation dialog / receipt.
    pub explain: String,
    /// The record, present only when the publication actually happened.
    pub record: Option<PublishRecord>,
    pub snapshot: LifecycleSnapshot,
    /// O que se sabia do projeto no momento da publicação — ver `PublishEvaluation`.
    pub evaluation: PublishEvaluation,
}

/// O veredito do harness no instante de publicar.
///
/// ── POR QUE ISTO EXISTE (§15) ─────────────────────────────────────────────
/// Publicar não consultava o harness. Dava para publicar com check vermelho e
/// com dimensões nunca avaliadas, e nada dizia — a publicação saía com a mesma
/// cara de uma publicação sobre um projeto medido. "Deep evaluation em
/// publicação" é isto: o que se sabia, e o que não se sabia, dito ANTES de
/// confirmar, e carregado junto do que aconteceu.
///
/// O harness roda aqui SEM executar comandos declarados: publicar não pode
/// disparar build ou teste por conta própria, que é o automático que o §4 proíbe.
/// Então build e testes aparecem como não avaliados, o que é a verdade.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishEvaluation {
    /// Checks falhando agora.
    pub failed: usize,
    /// Dimensões que esta medição não avaliou, por nome.
    pub unevaluated: Vec<String>,
    /// Uma frase para a tela e para o recibo. Nunca vazia.
    pub summary: String,
}

/// Roda o harness, sem executar comandos, e resume o que ele soube.
fn evaluate_before_publishing(root: &Path) -> PublishEvaluation {
    let run = crate::harness::run(root, 0, false);
    let unevaluated: Vec<String> = run
        .report
        .coverage
        .iter()
        .filter(|row| !row.evaluated)
        .map(|row| row.label.clone())
        .collect();
    let summary = match (run.report.failed, unevaluated.len()) {
        (0, 0) => "o harness não achou falha e avaliou todas as dimensões".to_string(),
        (0, n) => format!(
            "o harness não achou falha, e {n} dimensão(ões) não foram avaliadas: {}",
            unevaluated.join(", ")
        ),
        (f, 0) => format!("{f} check(s) falhando agora"),
        (f, n) => format!(
            "{f} check(s) falhando agora, e {n} dimensão(ões) não avaliadas: {}",
            unevaluated.join(", ")
        ),
    };
    PublishEvaluation {
        failed: run.report.failed,
        unevaluated,
        summary,
    }
}

fn target_of(value: &str) -> Result<PublishTarget, String> {
    match value {
        "compensable" => Ok(PublishTarget::ExternalCompensable),
        "immutable" => Ok(PublishTarget::ExternalImmutable),
        other => Err(format!("destino de publicação desconhecido: {other}")),
    }
}

fn log(root: &Path) -> Result<PublishLog, String> {
    PublishLog::open(root.join(LOG_REL)).map_err(|error| format!("{error:#}"))
}

/// Exports already on disk, newest name last. A listing failure is reported as an
/// empty list only when the directory does not exist; anything else is an error.
fn exports(root: &Path) -> Result<Vec<ExportedFile>, String> {
    let dir = root.join(EXPORTS_REL);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut found = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|error| format!("ler {}: {error}", dir.display()))? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let bytes = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        let version = fs::read(&path)
            .ok()
            .and_then(|raw| serde_json::from_slice::<ExportManifest>(&raw).ok())
            .map(|manifest| manifest.version);
        found.push(ExportedFile {
            path: format!(
                "{EXPORTS_REL}/{}",
                path.file_name().unwrap_or_default().to_string_lossy()
            ),
            bytes,
            version,
        });
    }
    found.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(found)
}

fn snapshot_of(root: &Path) -> Result<LifecycleSnapshot, String> {
    let project = project::snapshot(root)?;
    let log = log(root)?;
    let record = project.project.as_ref();
    let project_id = record.map(|p| p.id.0.clone());
    let history = project_id
        .as_deref()
        .map(|id| log.history(id))
        .unwrap_or_default();
    let latest_version = history.last().map(|entry| entry.version.clone());
    let next_version = latest_version
        .as_deref()
        .map(ide_lifecycle::bump_patch)
        .unwrap_or_else(|| "0.0.1".to_string());
    Ok(LifecycleSnapshot {
        blocked_reason: if project_id.is_none() {
            Some(
                "esta pasta ainda não é um projeto durável: publicar sem título e intenção \
                 registrados publicaria nada — registre o projeto primeiro"
                    .to_string(),
            )
        } else {
            None
        },
        project_id,
        title: record.map(|p| p.title.clone()),
        latest_version,
        next_version,
        history,
        exports: exports(root)?,
        log_path: format!("{LOG_REL}/publications.json"),
        exports_path: EXPORTS_REL.to_string(),
    })
}

pub fn snapshot(root: &Path) -> Result<LifecycleSnapshot, String> {
    snapshot_of(root)
}

/// Writes the portable manifest of the current project.
///
/// Resource labels are workspace-relative on purpose: an export that carried
/// `/home/alguem/projeto` would only reopen on that machine, which is the lock-in
/// this section exists to avoid.
pub fn export(root: &Path) -> Result<PublishAttempt, String> {
    let project = project::snapshot(root)?;
    let record = project
        .project
        .as_ref()
        .ok_or_else(|| "não há projeto durável para exportar".to_string())?;

    let resources = project
        .resources
        .iter()
        .map(|resource| ExportedResource {
            id: portable_id(&resource.id.0),
            kind: format!("{:?}", resource.kind).to_lowercase(),
            label: relative_label(root, &resource.canonical_path),
        })
        .collect();

    let snapshot = snapshot_of(root)?;
    let manifest = build_export_manifest(&ExportInputs {
        project_id: portable_id(&record.id.0),
        title: record.title.clone(),
        intent: record.intent.clone(),
        version: snapshot.next_version.clone(),
        resources,
        applied_guidance: active_guidance(root),
        applied_packs: applied_packs(root),
    });

    let dir = root.join(EXPORTS_REL);
    fs::create_dir_all(&dir).map_err(|error| format!("criar {}: {error}", dir.display()))?;
    let file = dir.join(format!("export-{}.json", manifest.version));
    let json = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    fs::write(&file, json).map_err(|error| format!("gravar {}: {error}", file.display()))?;

    let rel = format!("{EXPORTS_REL}/export-{}.json", manifest.version);
    let effect = LifecycleEffect::LocalExport { path: rel.clone() };
    Ok(PublishAttempt {
        // O export local também carrega o que se sabia: reabrir um export e
        // descobrir depois que ele saiu com check vermelho é a mesma surpresa.
        evaluation: evaluate_before_publishing(root),
        needs_confirmation: false,
        reversibility: effect.reversibility(),
        compensation: compensation_for(&effect),
        explain: format!(
            "Export local em {rel}. Nada saiu desta máquina e nenhuma infraestrutura é \
             obrigatória para reabrir; apagar o arquivo desfaz por completo."
        ),
        record: None,
        snapshot: snapshot_of(root)?,
    })
}

/// The compensation for a local export, performed: delete the exported file.
pub fn delete_export(root: &Path, relative: &str) -> Result<LifecycleSnapshot, String> {
    if !relative.starts_with(EXPORTS_REL) {
        return Err(format!(
            "só um arquivo de {EXPORTS_REL} pode ser apagado por aqui: {relative}"
        ));
    }
    let candidate = root.join(relative);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("{relative}: {error}"))?;
    let exports_root = root
        .join(EXPORTS_REL)
        .canonicalize()
        .map_err(|error| format!("{EXPORTS_REL}: {error}"))?;
    if !canonical.starts_with(&exports_root) {
        return Err(format!("{relative} sai de {EXPORTS_REL}"));
    }
    fs::remove_file(&canonical).map_err(|error| format!("apagar {relative}: {error}"))?;
    snapshot_of(root)
}

/// Publishes (or republishes) the next version.
///
/// `confirmed` is the person's explicit act. Whether it is required at all is
/// `confirmation_for`'s decision, asked with the honest reversibility of the
/// effect: an external publication has no rollback, so it counts as irreversible
/// for the purpose of that question even when a compensation exists. Nothing is
/// written to the log while a required confirmation is missing.
pub fn publish(
    root: &Path,
    target: &str,
    confirmed: bool,
    problem: Option<&str>,
    related_resources: Vec<String>,
) -> Result<PublishAttempt, String> {
    let target = target_of(target)?;
    let snapshot = snapshot_of(root)?;
    let evaluation = evaluate_before_publishing(root);
    let project_id = snapshot
        .project_id
        .clone()
        .ok_or_else(|| snapshot.blocked_reason.clone().unwrap_or_default())?;
    let republishing = snapshot.latest_version.is_some();
    if republishing && problem.map(str::trim).unwrap_or("").is_empty() {
        return Err(
            "republicar pede o problema observado que esta versão corrige — é o que liga a \
             correção ao que aconteceu"
                .to_string(),
        );
    }

    let planned = if republishing {
        LifecycleEffect::Republish {
            project_id: project_id.clone(),
            version: snapshot.next_version.clone(),
            target,
        }
    } else {
        LifecycleEffect::Publish {
            project_id: project_id.clone(),
            version: snapshot.next_version.clone(),
            target,
        }
    };
    let reversibility = planned.reversibility();
    let compensation = compensation_for(&planned);
    let explain = match (&reversibility, &compensation) {
        (Reversibility::Irreversible, _) => format!(
            "Publicar {} em destino imutável: não tem undo e não tem compensação. \
             Depois disto, nada nesta tela desfaz.",
            snapshot.next_version
        ),
        (_, Some(plan)) => format!(
            "Publicar {} é efeito externo: não tem rollback. O que existe é compensação — {}",
            snapshot.next_version, plan.note
        ),
        (_, None) => format!(
            "Publicar {} não tem compensação conhecida.",
            snapshot.next_version
        ),
    };

    // O motor decide se pergunta. `Reversible` seria o único caso que dispensa,
    // e publicação externa nunca é reversível.
    let irreversible = !matches!(reversibility, Reversibility::Reversible);
    // Check vermelho também pede confirmação, mesmo em alvo reversível: publicar
    // sobre falha conhecida pode ser uma escolha, mas não pode ser um acidente.
    let precisa_por_evidencia = evaluation.failed > 0;
    if confirmation_for(irreversible || precisa_por_evidencia, confirmed)
        == ConfirmationDecision::ConfirmFirst
    {
        return Ok(PublishAttempt {
            needs_confirmation: true,
            reversibility,
            compensation,
            explain,
            record: None,
            snapshot,
            evaluation,
        });
    }

    let mut log = log(root)?;
    let record = if republishing {
        log.republish_to(
            &project_id,
            problem.unwrap_or_default(),
            related_resources,
            target,
        )
    } else {
        log.publish_to(&project_id, target)
    }
    .map_err(|error| format!("{error:#}"))?;

    Ok(PublishAttempt {
        needs_confirmation: false,
        reversibility: record.reversibility,
        compensation: record.compensation.clone(),
        explain,
        record: Some(record),
        snapshot: snapshot_of(root)?,
        evaluation,
    })
}

/// Guidance in force at export time, by id. Only `Active`: a candidate or a
/// suspended rule is not steering anything, and listing it would describe a
/// project that never existed.
fn active_guidance(root: &Path) -> Vec<String> {
    ide_guidance::GuidanceRegistry::open(crate::library::library_root(root))
        .map(|registry| {
            let mut ids: Vec<String> = registry
                .list()
                .into_iter()
                .filter(|entry| entry.state == ide_guidance::GuidanceState::Active)
                .map(|entry| entry.id)
                .collect();
            ids.sort();
            ids
        })
        .unwrap_or_default()
}

/// Packs the project applied, so the manifest says what rules were in force.
/// A registry that cannot be opened yields an empty list rather than failing the
/// export — but it is the only field allowed to degrade that way, and it does so
/// because a pack registry is optional in a project.
fn applied_packs(root: &Path) -> Vec<String> {
    ide_packs::PackRegistry::open(root.join(".instrument/packs"))
        .map(|registry| registry.applied())
        .unwrap_or_default()
}

/// A local id, made portable.
///
/// ── DEFEITO QUE SÓ APARECEU RODANDO ───────────────────────────────────────
/// O id durável de um projeto é `project:<caminho canônico>`, e o de um recurso
/// é `resource:<caminho canônico>`. O manifesto prometia não levar caminho de
/// máquina e o `label` cumpria — mas os IDS iam inteiros, com `/home/<alguém>/…`
/// dentro. Um export desses só reabre onde foi feito, que é o lock-in que esta
/// seção existe para não ter, e ainda vaza o nome de usuário de quem exportou.
///
/// A parte depois do prefixo vira hash (o mesmo `content_hash` do §8), então o
/// id continua estável para o mesmo projeto e deixa de descrever a máquina.
fn portable_id(raw: &str) -> String {
    match raw.split_once(':') {
        Some((prefix, rest)) if rest.starts_with('/') || rest.contains('\\') => {
            format!("{prefix}:{}", content_hash(rest))
        }
        _ => raw.to_string(),
    }
}

/// A portable label for a resource: relative to the project when it lives inside
/// it, and the bare directory name when it does not. Never an absolute path.
fn relative_label(root: &Path, path: &Path) -> String {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    match path.strip_prefix(&root) {
        Ok(rel) if rel.as_os_str().is_empty() => ".".to_string(),
        Ok(rel) => rel.to_string_lossy().to_string(),
        Err(_) => path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "recurso".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// §15 — publicar carrega o que se sabia, e falha conhecida pede decisão.
    ///
    /// Publicar não consultava o harness: dava para publicar com check vermelho e
    /// com dimensões nunca avaliadas, e a publicação saía com a mesma cara de uma
    /// publicação sobre projeto medido.
    #[test]
    fn publicar_carrega_o_veredito_do_harness() {
        let dir = tempfile::tempdir().expect("dir");
        let root = dir.path();
        std::fs::create_dir_all(root.join(".instrument")).expect("instrument");
        // Projeto registrado é pré-requisito de publicar; sem isso o teste
        // mediria a recusa, não a avaliação.
        crate::project::register(root, "Lista", "Anotar itens e ver de dois telefones")
            .expect("registro");

        let tentativa = publish(root, "compensable", false, None, Vec::new()).expect("attempt");

        assert!(
            !tentativa.evaluation.summary.trim().is_empty(),
            "o veredito nunca vem vazio"
        );
        assert!(
            !tentativa.evaluation.unevaluated.is_empty(),
            "num projeto sem comandos declarados, há dimensões não avaliadas — e publicar tem \
             de dizer QUAIS"
        );
        assert!(
            tentativa.needs_confirmation,
            "publicação externa compensável pede confirmação antes de sair"
        );
    }

    fn registered_project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        project::register(dir.path(), "Leilão", "construir um leilão local").expect("register");
        dir
    }

    #[test]
    fn a_folder_without_a_durable_project_says_why_it_cannot_publish() {
        let dir = tempfile::tempdir().expect("tempdir");

        let snapshot = snapshot(dir.path()).expect("snapshot");

        assert!(snapshot.project_id.is_none());
        assert!(snapshot.blocked_reason.is_some());
        assert_eq!(snapshot.next_version, "0.0.1");
    }

    /// O export é o único efeito daqui com undo real, e o plano tem de dizer isso
    /// apontando para o arquivo que existe.
    #[test]
    fn export_writes_a_portable_manifest_with_a_real_delete_compensation() {
        let dir = registered_project();

        let attempt = export(dir.path()).expect("export");

        assert!(!attempt.needs_confirmation);
        assert_eq!(attempt.reversibility, Reversibility::Reversible);
        let plan = attempt.compensation.expect("export tem compensação real");
        assert!(plan.target.starts_with(EXPORTS_REL));
        let file = dir.path().join(&plan.target);
        assert!(file.exists(), "o manifesto tem de existir no disco");
        let manifest: ExportManifest =
            serde_json::from_slice(&fs::read(&file).unwrap()).expect("manifesto legível");
        assert_eq!(manifest.title, "Leilão");
        assert!(
            manifest.resources.iter().all(|r| !r.label.starts_with('/')),
            "export com caminho absoluto só reabre na máquina de quem exportou"
        );
    }

    /// O `label` já era relativo, mas os IDS levavam o caminho canônico inteiro —
    /// isto é, o export prometia portabilidade e vazava `/home/<alguém>/…`. O
    /// teste olha o JSON INTEIRO, não um campo escolhido a dedo.
    #[test]
    fn no_absolute_machine_path_survives_anywhere_in_the_manifest() {
        let dir = registered_project();

        let attempt = export(dir.path()).expect("export");
        let target = attempt.compensation.expect("plano").target;
        let raw = fs::read_to_string(dir.path().join(&target)).expect("manifesto");

        assert!(
            !raw.contains("/home/") && !raw.contains(&dir.path().display().to_string()),
            "export com caminho de máquina só reabre onde foi feito: {raw}"
        );
        let manifest: ExportManifest = serde_json::from_str(&raw).expect("manifesto legível");
        assert!(manifest.project_id.starts_with("project:"));
        assert!(!manifest.project_id.contains('/'));
    }

    #[test]
    fn deleting_the_export_is_the_compensation_and_it_actually_removes_the_file() {
        let dir = registered_project();
        let attempt = export(dir.path()).expect("export");
        let target = attempt.compensation.expect("plano").target;

        let snapshot = delete_export(dir.path(), &target).expect("apagar");

        assert!(!dir.path().join(&target).exists());
        assert!(snapshot.exports.is_empty());
    }

    #[test]
    fn deleting_outside_the_exports_directory_is_refused() {
        let dir = registered_project();
        fs::write(dir.path().join("alvo.md"), "x").unwrap();

        let error = delete_export(dir.path(), "alvo.md").expect_err("deve recusar");

        assert!(error.contains(EXPORTS_REL));
        assert!(dir.path().join("alvo.md").exists());
    }

    /// A primeira publicação PERGUNTA, e enquanto pergunta não grava nada.
    #[test]
    fn publishing_asks_first_and_records_nothing_until_confirmed() {
        let dir = registered_project();

        let asked = publish(dir.path(), "compensable", false, None, vec![]).expect("attempt");

        assert!(asked.needs_confirmation);
        assert!(asked.record.is_none());
        assert!(asked.snapshot.history.is_empty(), "nada foi registrado");
        assert_eq!(asked.reversibility, Reversibility::CompensationOnly);
        assert!(asked.explain.contains("não tem rollback"));

        let done = publish(dir.path(), "compensable", true, None, vec![]).expect("publish");

        assert!(!done.needs_confirmation);
        assert_eq!(done.record.expect("registro").version, "0.0.1");
        assert_eq!(done.snapshot.history.len(), 1);
    }

    #[test]
    fn an_immutable_target_says_there_is_no_compensation_at_all() {
        let dir = registered_project();

        let asked = publish(dir.path(), "immutable", false, None, vec![]).expect("attempt");

        assert!(asked.needs_confirmation);
        assert_eq!(asked.reversibility, Reversibility::Irreversible);
        assert!(asked.compensation.is_none());
        assert!(asked.explain.contains("não tem compensação"));
    }

    /// Republicar liga a correção ao problema observado — sem problema escrito,
    /// a republicação não é uma correção, é uma versão a mais sem história.
    #[test]
    fn republishing_requires_the_observed_problem_and_keeps_the_history() {
        let dir = registered_project();
        publish(dir.path(), "compensable", true, None, vec![]).expect("publish");

        let error = publish(dir.path(), "compensable", true, None, vec![])
            .expect_err("republicar sem problema deve falhar");
        assert!(error.contains("problema observado"));

        let done = publish(
            dir.path(),
            "compensable",
            true,
            Some("leaderboard vazava id"),
            vec!["r1".to_string()],
        )
        .expect("republish");

        let record = done.record.expect("registro");
        assert_eq!(record.version, "0.0.2");
        assert_eq!(record.problem.as_deref(), Some("leaderboard vazava id"));
        assert_eq!(
            done.snapshot.history.len(),
            2,
            "a versão anterior continua lá"
        );
    }

    #[test]
    fn an_unknown_target_fails_instead_of_falling_back_to_the_forgiving_one() {
        let dir = registered_project();

        let error = publish(dir.path(), "qualquer", true, None, vec![]).expect_err("deve falhar");

        assert!(error.contains("destino de publicação desconhecido"));
    }
}
