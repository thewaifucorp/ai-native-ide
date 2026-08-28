//! §16 — versões do projeto, sem exigir ShinAI nem Katsui.
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
//! * **Consolidar não é apagável.** O registro de versões é o que responde "o
//!   que aconteceu com este projeto"; apagar uma linha seria reescrever a
//!   história. A compensação é consolidar uma versão corrigida por cima.
//! * **Confirmação é do motor.** Quem decide se pergunta é `confirmation_for`.
//!   Aqui a pergunta tem um motivo só — evidência vermelha — porque nada deste
//!   módulo sai da máquina. A tela mostra essa decisão; não simula uma.
//!
//! # O que este módulo NÃO faz
//!
//! Não fala com serviço nenhum, e agora o nome do passo diz isso. O que existe
//! aqui é **consolidar** uma versão: congelar no registro local que esta é a
//! 0.0.3, qual problema ela corrige e o que ela tocou. **Publicar** — levar a
//! versão a um destino real — é outro passo, feito por adapter, e é o único com
//! efeito externo.
//!
//! Enquanto isto se chamava "publicar", a tela prometia um deploy que nunca
//! acontecia: a pessoa clicava e lia "meu produto foi para o ar" quando o que
//! saía era uma linha em `.instrument/lifecycle/publications.json`. Nenhum
//! adapter de destino existe ainda, e a tela diz isso em vez de oferecer um
//! botão que finge.

use ide_lifecycle::{
    build_export_manifest, compensation_for, confirmation_for, CompensationPlan,
    ConfirmationDecision, ExportInputs, ExportManifest, ExportedResource, LifecycleEffect,
    PublishLog, PublishRecord, Reversibility,
};
use ide_semantic::content_hash;
use serde::Serialize;
use std::fs;
use std::path::Path;

use crate::project;

/// Where versions are recorded, and where exports land. Both are IDE runtime
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
    /// `None` while the folder is not a durable project yet — a version of
    /// something with no registered intent would record nothing at all.
    pub project_id: Option<String>,
    pub title: Option<String>,
    /// Latest recorded version, when there is one.
    pub latest_version: Option<String>,
    /// What the next version would be called.
    pub next_version: String,
    pub history: Vec<PublishRecord>,
    pub exports: Vec<ExportedFile>,
    /// Why closing a version is not available right now, when it is not.
    pub blocked_reason: Option<String>,
    pub log_path: String,
    pub exports_path: String,
}

/// What an attempted version step returned: either the question the engine says
/// must be asked first, or the record of what happened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishAttempt {
    /// True when nothing was recorded and a confirmation is required first.
    pub needs_confirmation: bool,
    /// The honest reversibility class of what is about to happen.
    pub reversibility: Reversibility,
    /// The concrete compensating action, or `None` when none exists.
    pub compensation: Option<CompensationPlan>,
    /// Sentence for the confirmation dialog / receipt.
    pub explain: String,
    /// The record, present only when the version was actually consolidated.
    pub record: Option<PublishRecord>,
    pub snapshot: LifecycleSnapshot,
    /// O que se sabia do projeto no momento de fechar a versão — ver `PublishEvaluation`.
    pub evaluation: PublishEvaluation,
}

/// O veredito do harness no instante de fechar a versão.
///
/// ── POR QUE ISTO EXISTE (§15) ─────────────────────────────────────────────
/// O passo não consultava o harness. Dava para fechar uma versão com check
/// vermelho e com dimensões nunca avaliadas, e nada dizia — ela saía com a mesma
/// cara de uma versão sobre projeto medido. "Deep evaluation em publicação" é
/// isto: o que se sabia, e o que não se sabia, dito ANTES de confirmar, e
/// carregado junto do que aconteceu.
///
/// O harness roda aqui SEM executar comandos declarados: fechar versão não pode
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
fn evaluate_before_recording(root: &Path) -> PublishEvaluation {
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

fn log(root: &Path) -> Result<PublishLog, String> {
    PublishLog::open(root.join(LOG_REL)).map_err(|error| format!("{error:#}"))
}

/// O mesmo registro, para quem publica: o §16 anota o destino alcançado NA linha
/// da versão, e quem faz isso é o módulo de release.
pub fn open_log(root: &Path) -> Result<PublishLog, String> {
    log(root)
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
                "esta pasta ainda não é um projeto durável: fechar versão sem título e \
                 intenção registrados congelaria nada — registre o projeto primeiro"
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
        evaluation: evaluate_before_recording(root),
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

/// Resolves a path given by the screen into a real file inside `.instrument/exports`.
///
/// Both callers — apagar e reabrir — recebem um caminho vindo de fora, e os dois
/// precisam da mesma recusa: prefixo declarado, caminho canonizado e contido no
/// diretório de exports. Sem a canonização, `.instrument/exports/../../algo`
/// passaria pelo teste de prefixo.
fn resolve_export(root: &Path, relative: &str) -> Result<std::path::PathBuf, String> {
    if !relative.starts_with(EXPORTS_REL) {
        return Err(format!(
            "só um arquivo de {EXPORTS_REL} pode ser aberto ou apagado por aqui: {relative}"
        ));
    }
    let canonical = root
        .join(relative)
        .canonicalize()
        .map_err(|error| format!("{relative}: {error}"))?;
    let exports_root = root
        .join(EXPORTS_REL)
        .canonicalize()
        .map_err(|error| format!("{EXPORTS_REL}: {error}"))?;
    if !canonical.starts_with(&exports_root) {
        return Err(format!("{relative} sai de {EXPORTS_REL}"));
    }
    Ok(canonical)
}

/// The compensation for a local export, performed: delete the exported file.
pub fn delete_export(root: &Path, relative: &str) -> Result<LifecycleSnapshot, String> {
    let canonical = resolve_export(root, relative)?;
    fs::remove_file(&canonical).map_err(|error| format!("apagar {relative}: {error}"))?;
    snapshot_of(root)
}

/// Um recurso como o export o descreveu, dito contra o projeto de hoje.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReopenedResource {
    /// O id portátil, o mesmo que o manifesto carrega.
    pub id: String,
    pub kind: String,
    pub label: String,
    /// Se este recurso ainda existe no projeto como ele está agora.
    pub still_present: bool,
}

/// O produto publicado, reaberto: o que o export dizia, e o que mudou desde então.
///
/// ── POR QUE ISTO EXISTE (LIFE-03) ─────────────────────────────────────────
/// Reabrir só para ver de novo o que foi exportado não serve para nada: quem
/// reabre está atrás de um problema observado DEPOIS de publicar. O que a pessoa
/// precisa é da diferença — o recurso que sumiu, o que apareceu, a intenção que
/// foi reescrita, a guidance que entrou. Sem isso, ligar o problema ao projeto
/// vira adivinhação, e a republicação sai com um texto solto em vez de um
/// vínculo.
///
/// Nada aqui executa comando nem fala com serviço: é leitura do manifesto contra
/// o estado local.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReopenedExport {
    /// O arquivo reaberto, relativo à raiz.
    pub path: String,
    pub version: String,
    pub title: String,
    pub intent: String,
    pub portability_note: String,
    pub resources: Vec<ReopenedResource>,
    /// Rótulos que existem no projeto agora e não estavam no export.
    pub appeared: Vec<String>,
    /// Título de hoje, quando ele mudou desde o export.
    pub title_now: Option<String>,
    /// Intenção de hoje, quando ela mudou desde o export.
    pub intent_now: Option<String>,
    /// Guidance/packs que entraram ou saíram desde o export.
    pub guidance_added: Vec<String>,
    pub guidance_removed: Vec<String>,
    pub packs_added: Vec<String>,
    pub packs_removed: Vec<String>,
    /// A linha do registro com esta mesma versão, quando ela existe. Um export
    /// sem versão consolidada é um ensaio, não um marco do projeto, e a tela não
    /// pode tratar os dois igual.
    pub recorded: Option<PublishRecord>,
    /// Uma frase para a tela e para o recibo. Nunca vazia.
    pub summary: String,
}

/// Reabre um export e o compara com o projeto de agora.
pub fn reopen(root: &Path, relative: &str) -> Result<ReopenedExport, String> {
    let canonical = resolve_export(root, relative)?;
    let raw = fs::read(&canonical).map_err(|error| format!("ler {relative}: {error}"))?;
    let manifest: ExportManifest = serde_json::from_slice(&raw)
        .map_err(|error| format!("{relative} não é um manifesto de export legível: {error}"))?;

    let project = project::snapshot(root)?;
    // O manifesto guarda ids PORTÁTEIS; os do projeto são locais. Comparar os dois
    // sem passar pelo mesmo `portable_id` diria que todo recurso sumiu.
    let now: Vec<(String, String)> = project
        .resources
        .iter()
        .map(|resource| {
            (
                portable_id(&resource.id.0),
                relative_label(root, &resource.canonical_path),
            )
        })
        .collect();

    let resources: Vec<ReopenedResource> = manifest
        .resources
        .iter()
        .map(|resource| ReopenedResource {
            still_present: now.iter().any(|(id, _)| id == &resource.id),
            id: resource.id.clone(),
            kind: resource.kind.clone(),
            label: resource.label.clone(),
        })
        .collect();
    let missing = resources.iter().filter(|r| !r.still_present).count();

    let mut appeared: Vec<String> = now
        .iter()
        .filter(|(id, _)| !manifest.resources.iter().any(|r| &r.id == id))
        .map(|(_, label)| label.clone())
        .collect();
    appeared.sort();

    let record = project.project.as_ref();
    let title_now = record
        .map(|p| p.title.clone())
        .filter(|title| title != &manifest.title);
    let intent_now = record
        .map(|p| p.intent.clone())
        .filter(|intent| intent != &manifest.intent);

    let guidance_now = active_guidance(root);
    let packs_now = applied_packs(root);
    let guidance_added = missing_from(&guidance_now, &manifest.applied_guidance);
    let guidance_removed = missing_from(&manifest.applied_guidance, &guidance_now);
    let packs_added = missing_from(&packs_now, &manifest.applied_packs);
    let packs_removed = missing_from(&manifest.applied_packs, &packs_now);

    let recorded = log(root)?
        .history(&manifest.project_id)
        .into_iter()
        .find(|entry| entry.version == manifest.version)
        .or_else(|| {
            // O log guarda o id LOCAL do projeto; o manifesto, o portátil. Reabrir
            // um export feito nesta mesma máquina tem de encontrar a versão,
            // então a busca também tenta pelo id de hoje.
            record.and_then(|p| {
                log(root)
                    .ok()?
                    .history(&p.id.0)
                    .into_iter()
                    .find(|entry| entry.version == manifest.version)
            })
        });

    let mut mudancas: Vec<String> = Vec::new();
    if missing > 0 {
        mudancas.push(format!("{missing} recurso(s) do export não existe(m) mais"));
    }
    if !appeared.is_empty() {
        mudancas.push(format!("{} recurso(s) novo(s)", appeared.len()));
    }
    if title_now.is_some() {
        mudancas.push("o título mudou".to_string());
    }
    if intent_now.is_some() {
        mudancas.push("a intenção mudou".to_string());
    }
    let steering =
        guidance_added.len() + guidance_removed.len() + packs_added.len() + packs_removed.len();
    if steering > 0 {
        mudancas.push(format!("{steering} mudança(s) de guidance/packs"));
    }
    let estado = match &recorded {
        Some(entry) => format!("consolidada como {}", entry.version),
        None => "versão nunca consolidada — este export é um ensaio local".to_string(),
    };
    let summary = if mudancas.is_empty() {
        format!(
            "{} {} · {estado} · o projeto está como este export o descreve",
            manifest.title, manifest.version
        )
    } else {
        format!(
            "{} {} · {estado} · desde o export: {}",
            manifest.title,
            manifest.version,
            mudancas.join(", ")
        )
    };

    Ok(ReopenedExport {
        path: relative.to_string(),
        version: manifest.version,
        title: manifest.title,
        intent: manifest.intent,
        portability_note: manifest.portability_note,
        resources,
        appeared,
        title_now,
        intent_now,
        guidance_added,
        guidance_removed,
        packs_added,
        packs_removed,
        recorded,
        summary,
    })
}

/// O que está em `left` e não está em `right`.
fn missing_from(left: &[String], right: &[String]) -> Vec<String> {
    let mut out: Vec<String> = left
        .iter()
        .filter(|item| !right.contains(item))
        .cloned()
        .collect();
    out.sort();
    out
}

/// Consolida a próxima versão no registro LOCAL do projeto.
///
/// ── O PASSO SE CHAMAVA "PUBLICAR" E ISSO ERA UMA MENTIRA ─────────────────
/// Ele nunca falou com serviço nenhum: escrevia uma linha em
/// `.instrument/lifecycle/publications.json`. Quem clicava lia "meu produto foi
/// para o ar" e o que acontecia era um registro local. Agora o nome diz o ato:
/// consolidar congela "esta é a versão X, corrige tal problema, tocou tais
/// recursos". Levar isso a um destino real é PUBLICAR, é outro passo, e vai por
/// adapter — é lá que mora o efeito externo, com a confirmação que ele exige.
///
/// Duas consequências que não são cosméticas:
///
///  * **A confirmação muda de motivo.** Antes ela vinha de "publicação externa
///    não tem rollback". Consolidar não sai da máquina, então a única razão que
///    sobra para perguntar é evidência: consolidar sobre check vermelho pode ser
///    escolha, não pode ser acidente.
///  * **A compensação muda de forma.** Não é "publicar retratação": é consolidar
///    uma versão corrigida por cima, com a errada continuando no registro.
///
/// `confirmed` continua sendo o ato explícito da pessoa, e nada é gravado
/// enquanto uma confirmação exigida não chega.
pub fn consolidate(
    root: &Path,
    confirmed: bool,
    problem: Option<&str>,
    related_resources: Vec<String>,
) -> Result<PublishAttempt, String> {
    let snapshot = snapshot_of(root)?;
    let evaluation = evaluate_before_recording(root);
    let project_id = snapshot
        .project_id
        .clone()
        .ok_or_else(|| snapshot.blocked_reason.clone().unwrap_or_default())?;
    let succeeding = snapshot.latest_version.is_some();
    if succeeding && problem.map(str::trim).unwrap_or("").is_empty() {
        return Err(
            "consolidar uma versão sobre outra pede o problema observado que ela corrige — é o \
             que liga a correção ao que aconteceu"
                .to_string(),
        );
    }

    let planned = LifecycleEffect::ConsolidateVersion {
        project_id: project_id.clone(),
        version: snapshot.next_version.clone(),
    };
    let reversibility = planned.reversibility();
    let compensation = compensation_for(&planned);
    let explain = format!(
        "Consolidar {} é local: nada sai desta máquina e nada vai para o ar. \
         Publicar num destino real é outro passo. {}",
        snapshot.next_version,
        compensation
            .as_ref()
            .map(|plan| plan.note.clone())
            .unwrap_or_else(|| "Sem compensação conhecida.".to_string())
    );

    // A ÚNICA razão para perguntar aqui é evidência. Consolidar não sai da
    // máquina, então herdar a pergunta de "efeito externo" treinaria a pessoa a
    // clicar em confirmação que não protege nada — e a clicar depressa nas que
    // protegem.
    if confirmation_for(evaluation.failed > 0, confirmed) == ConfirmationDecision::ConfirmFirst {
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
    let record = log
        .consolidate(&project_id, problem, related_resources)
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
pub(crate) fn portable_id(raw: &str) -> String {
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
    use ide_lifecycle::RecordKind;

    /// §15 — consolidar carrega o que se sabia, e a pergunta vem da evidência.
    ///
    /// O passo não consultava o harness: dava para fechar uma versão com check
    /// vermelho e com dimensões nunca avaliadas, e ela saía com a mesma cara de
    /// uma versão sobre projeto medido.
    #[test]
    fn consolidar_carrega_o_veredito_do_harness() {
        let dir = projeto_medido_sem_falha();
        let root = dir.path();

        let tentativa = consolidate(root, false, None, Vec::new()).expect("attempt");

        assert!(
            !tentativa.evaluation.summary.trim().is_empty(),
            "o veredito nunca vem vazio"
        );
        assert!(
            !tentativa.evaluation.unevaluated.is_empty(),
            "num projeto sem comandos declarados, há dimensões não avaliadas — e o passo tem \
             de dizer QUAIS"
        );
        assert_eq!(
            tentativa.needs_confirmation,
            tentativa.evaluation.failed > 0,
            "a pergunta é da evidência: só falha conhecida faz consolidar perguntar"
        );
    }

    /// Projeto cuja intenção o harness mede SEM achar falha.
    ///
    /// A distinção importa e o teste não a inventa: a camada semântica do §15
    /// avalia a intenção durável, e a do `registered_project` ("construir um
    /// leilão local") sai vermelha. As duas existem de propósito — uma prova que
    /// verde não pergunta, a outra que vermelho pergunta.
    fn projeto_medido_sem_falha() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        project::register(dir.path(), "Lista", "Anotar itens e ver de dois telefones")
            .expect("register");
        dir
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

    /// Consolidar é local — e por isso NÃO pergunta por reversibilidade.
    ///
    /// Enquanto era "publicar", toda versão abria um "tem certeza?" por ser
    /// efeito externo. Não era: nada saía da máquina. Herdar essa pergunta
    /// treinaria a pessoa a clicar depressa nas confirmações que protegem algo.
    #[test]
    fn consolidar_projeto_verde_nao_pergunta_e_grava_a_primeira_versao() {
        let dir = projeto_medido_sem_falha();

        let done = consolidate(dir.path(), false, None, vec![]).expect("consolidar");

        assert_eq!(
            done.evaluation.failed, 0,
            "o fixture precisa estar verde para o teste medir o que quer medir"
        );
        assert!(
            !done.needs_confirmation,
            "consolidar não sai da máquina: perguntar aqui seria cerimônia vazia"
        );
        let record = done.record.expect("registro");
        assert_eq!(record.version, "0.0.1");
        assert_eq!(record.kind, RecordKind::Consolidated);
        assert_eq!(done.snapshot.history.len(), 1);
        assert!(
            done.explain.contains("local"),
            "a frase da tela tem de dizer que nada foi para o ar: {}",
            done.explain
        );
    }

    /// E o inverso, que é o motivo de a pergunta ainda existir: falha conhecida
    /// pede decisão, e enquanto ela não vem NADA é gravado.
    #[test]
    fn consolidar_com_check_vermelho_pergunta_e_nao_grava_ate_confirmar() {
        let dir = registered_project();

        let asked = consolidate(dir.path(), false, None, vec![]).expect("attempt");

        assert!(
            asked.evaluation.failed > 0,
            "este fixture existe justamente por sair vermelho na medição"
        );
        assert!(asked.needs_confirmation);
        assert!(asked.record.is_none());
        assert!(asked.snapshot.history.is_empty(), "nada foi registrado");

        let done = consolidate(dir.path(), true, None, vec![]).expect("consolidar");

        assert!(!done.needs_confirmation);
        assert_eq!(done.record.expect("registro").version, "0.0.1");
    }

    /// A segunda versão liga a correção ao problema observado — sem problema
    /// escrito, ela não é correção, é uma versão a mais sem história.
    #[test]
    fn consolidar_sobre_outra_versao_exige_o_problema_e_mantem_o_historico() {
        let dir = registered_project();
        consolidate(dir.path(), true, None, vec![]).expect("primeira");

        let error =
            consolidate(dir.path(), true, None, vec![]).expect_err("sem problema deve falhar");
        assert!(error.contains("problema observado"));

        let done = consolidate(
            dir.path(),
            true,
            Some("leaderboard vazava id"),
            vec!["r1".to_string()],
        )
        .expect("segunda");

        let record = done.record.expect("registro");
        assert_eq!(record.version, "0.0.2");
        assert_eq!(record.problem.as_deref(), Some("leaderboard vazava id"));
        assert_eq!(
            done.snapshot.history.len(),
            2,
            "a versão anterior continua lá"
        );
    }

    /// LIFE-03 — reabrir serve para achar o problema, e achar o problema é ver a
    /// DIFERENÇA. Um reabrir que só devolvesse o manifesto de volta não ajudaria
    /// ninguém a decidir o que corrigir.
    #[test]
    fn reabrir_um_export_mostra_o_que_mudou_desde_ele() {
        let dir = registered_project();
        let root = dir.path();
        let alvo = export(root)
            .expect("export")
            .compensation
            .expect("plano")
            .target;

        // O projeto segue vivo depois de exportado: a intenção é reescrita.
        project::set_intent(root, "construir um leilão local com lance mínimo")
            .expect("nova intenção");

        let reaberto = reopen(root, &alvo).expect("reabrir");

        assert_eq!(reaberto.version, "0.0.1");
        assert_eq!(reaberto.title, "Leilão");
        assert_eq!(
            reaberto.intent_now.as_deref(),
            Some("construir um leilão local com lance mínimo"),
            "a intenção de hoje é o que liga o problema observado ao projeto"
        );
        assert!(
            reaberto.recorded.is_none(),
            "exportar não consolida versão; dizer o contrário inventaria um marco"
        );
        assert!(reaberto.summary.contains("a intenção mudou"));
        assert!(reaberto.summary.contains("nunca consolidada"));
    }

    /// Reaberto DEPOIS de publicado, o mesmo caminho tem de encontrar a
    /// versão — senão a tela trata um marco do projeto como ensaio local.
    #[test]
    fn reabrir_encontra_a_versao_consolidada_correspondente() {
        let dir = registered_project();
        let root = dir.path();
        let alvo = export(root)
            .expect("export")
            .compensation
            .expect("plano")
            .target;
        consolidate(root, true, None, vec![]).expect("consolidar");

        let reaberto = reopen(root, &alvo).expect("reabrir");

        let registrada = reaberto.recorded.expect("a versão 0.0.1 foi consolidada");
        assert_eq!(registrada.version, "0.0.1");
        assert!(reaberto.summary.contains("consolidada como 0.0.1"));
    }

    /// A mesma recusa do apagar vale para o reabrir: caminho de fora não entra.
    #[test]
    fn reabrir_fora_do_diretorio_de_exports_e_recusado() {
        let dir = registered_project();
        fs::write(dir.path().join("alvo.json"), "{}").unwrap();

        let error = reopen(dir.path(), "alvo.json").expect_err("deve recusar");

        assert!(error.contains(EXPORTS_REL));
    }

    /// A versão que corrige carrega os recursos afetados: é o que transforma
    /// "corrige X" em vínculo com o projeto, em vez de texto solto no registro.
    #[test]
    fn consolidar_guarda_os_recursos_ligados_ao_problema() {
        let dir = registered_project();
        consolidate(dir.path(), true, None, vec![]).expect("primeira");

        let done = consolidate(
            dir.path(),
            true,
            Some("lance mínimo não era respeitado"),
            vec!["resource:abc".to_string(), "resource:def".to_string()],
        )
        .expect("segunda");

        let record = done.record.expect("registro");
        assert_eq!(record.related_resources.len(), 2);
        assert!(record
            .related_resources
            .contains(&"resource:abc".to_string()));
    }
}
