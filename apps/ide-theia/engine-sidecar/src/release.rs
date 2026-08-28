//! §16 — publicar de verdade, pelo primeiro destino real: Git.
//!
//! Consolidar congela a versão no registro local. Este módulo é o outro lado: o
//! que leva a versão para fora da máquina. São TRÊS atos, e a separação é o
//! ponto:
//!
//!  1. **Criar a tag** — local. `git tag -a`. Apagar é undo de verdade.
//!  2. **Empurrar a tag** — externo. Primeiro efeito real da IDE para fora.
//!     Apagar no remoto MITIGA (quem já buscou continua com ela); não desfaz.
//!  3. **Criar a release no GitHub** — externo, e depende de `gh` autenticado.
//!
//! # O que este módulo se recusa a fingir
//!
//! * **Ferramenta que existe não é ferramenta que funciona.** `gh` instalado e
//!   `gh` autenticado são estados diferentes, e o segundo é o que permite criar
//!   release. A detecção pergunta pelos dois — mesma lição do shim do
//!   `rust-analyzer`, que existia, respondia e não servia.
//! * **A tag aponta para um COMMIT, não para a tela.** Com a árvore suja, o que
//!   entra na tag é o último commit; o que está aberto no editor fica de fora. O
//!   snapshot diz que a árvore está suja para que ninguém descubra depois.
//! * **Uma versão só é publicável se foi consolidada.** Publicar uma versão que
//!   o projeto nunca congelou seria publicar um número.
//!
//! Nenhum comando daqui roda sozinho: cada um é um ato explícito da pessoa, a
//! mesma regra do §4.

use ide_lifecycle::{
    compensation_for, confirmation_for, CompensationPlan, ConfirmationDecision, Deployment,
    LifecycleEffect, PublishRecord, Reversibility,
};
use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// Onde a publicação de cada versão fica anotada, junto do resto do registro.
const TARGET_TAG: &str = "git-tag";
const TARGET_RELEASE: &str = "github-release";

/// Uma ferramenta externa, dita pelo que ela consegue fazer AQUI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolState {
    /// O binário respondeu.
    pub present: bool,
    /// Ele está pronto para o que este caminho precisa (para o `gh`: autenticado).
    pub usable: bool,
    /// A frase que explica o estado, sempre preenchida.
    pub detail: String,
    /// O que a pessoa faria para resolver, quando há o que fazer.
    pub remediation: Option<String>,
}

/// Uma versão consolidada, vista do lado do release.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasableVersion {
    pub version: String,
    /// O nome da tag que esta versão teria: `v0.0.4`.
    pub tag: String,
    /// A tag existe localmente.
    pub tagged: bool,
    /// O commit que a tag local aponta, quando ela existe.
    pub tag_commit: Option<String>,
    /// A tag existe no remoto.
    pub pushed: bool,
    /// A release do GitHub, quando o registro anotou uma.
    pub release_url: Option<String>,
    /// O problema que esta versão corrige, do registro.
    pub problem: Option<String>,
    /// As notas geradas para a tag e para a release.
    pub notes: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseSnapshot {
    pub git: ToolState,
    pub gh: ToolState,
    /// O remoto usado para empurrar, quando existe exatamente um caminho óbvio.
    pub remote: Option<String>,
    /// O commit em que a tag cairia.
    pub head_commit: Option<String>,
    /// Árvore suja: a tag pega o último commit, não o que está na tela.
    pub dirty: bool,
    pub versions: Vec<ReleasableVersion>,
    /// Por que este caminho não está disponível agora, quando não está.
    pub blocked_reason: Option<String>,
}

/// O que uma tentativa de tag/push/release devolveu.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseAttempt {
    pub needs_confirmation: bool,
    pub reversibility: Reversibility,
    pub compensation: Option<CompensationPlan>,
    /// Frase para o diálogo e para o recibo. Nunca vazia.
    pub explain: String,
    /// O registro da versão depois do ato, quando ele aconteceu.
    pub record: Option<PublishRecord>,
    pub snapshot: ReleaseSnapshot,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Roda um comando no projeto e devolve `(sucesso, stdout, stderr)`.
///
/// Um binário ausente não é erro deste módulo: é um estado que a detecção
/// reporta. Por isso a falha de spawn vira `(false, "", mensagem)` em vez de
/// derrubar a chamada inteira.
fn run(root: &Path, program: &str, args: &[&str]) -> (bool, String, String) {
    match Command::new(program).args(args).current_dir(root).output() {
        Ok(output) => (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).trim().to_string(),
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ),
        Err(error) => (false, String::new(), error.to_string()),
    }
}

fn git_state(root: &Path) -> (ToolState, Option<String>, Option<String>, bool) {
    let (ok, version, _) = run(root, "git", &["--version"]);
    if !ok {
        return (
            ToolState {
                present: false,
                usable: false,
                detail: "git não respondeu nesta máquina".to_string(),
                remediation: Some(
                    "Instale o git pelo gerenciador de pacotes do seu sistema.".to_string(),
                ),
            },
            None,
            None,
            false,
        );
    }
    if !root.join(".git").exists() {
        return (
            ToolState {
                present: true,
                usable: false,
                detail: format!("{version}, mas esta pasta não é um repositório git"),
                remediation: Some(
                    "Inicie um repositório (`git init`) e faça o primeiro commit: a tag \
                     precisa de um commit para apontar."
                        .to_string(),
                ),
            },
            None,
            None,
            false,
        );
    }

    let (head_ok, head, _) = run(root, "git", &["rev-parse", "--short", "HEAD"]);
    let head_commit = head_ok.then_some(head);
    let (_, porcelain, _) = run(
        root,
        "git",
        &["--no-optional-locks", "status", "--porcelain"],
    );
    let dirty = !porcelain.trim().is_empty();

    // Um remoto só é "o" remoto quando não há dúvida: com dois configurados,
    // escolher por conta própria empurraria para um lugar que ninguém pediu.
    let (_, remotes_raw, _) = run(root, "git", &["remote"]);
    let remotes: Vec<&str> = remotes_raw
        .lines()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .collect();
    let remote = match remotes.as_slice() {
        [] => None,
        [único] => Some((*único).to_string()),
        many => many
            .iter()
            .find(|name| **name == "origin")
            .map(|name| (*name).to_string()),
    };

    let detail = match (&head_commit, &remote) {
        (None, _) => format!("{version}, repositório sem nenhum commit ainda"),
        (Some(commit), Some(remote)) => format!("{version} · HEAD {commit} · remoto {remote}"),
        (Some(commit), None) => {
            format!("{version} · HEAD {commit} · nenhum remoto configurado")
        }
    };
    let usable = head_commit.is_some();
    let remediation = if head_commit.is_none() {
        Some("Faça o primeiro commit: uma tag aponta para um commit.".to_string())
    } else if remote.is_none() {
        Some(
            "Sem remoto, a tag fica só nesta máquina. `git remote add origin <url>` \
             habilita empurrar."
                .to_string(),
        )
    } else {
        None
    };

    (
        ToolState {
            present: true,
            usable,
            detail,
            remediation,
        },
        head_commit,
        remote,
        dirty,
    )
}

/// `gh` instalado e `gh` autenticado são estados diferentes.
///
/// Instalado e deslogado, `gh release create` falha na hora de valer. A detecção
/// pergunta pelas duas coisas para que a tela ofereça o que existe — a mesma
/// lição do shim do `rust-analyzer`, que existia e não servia.
fn gh_state(root: &Path) -> ToolState {
    let (ok, version, _) = run(root, "gh", &["--version"]);
    if !ok {
        return ToolState {
            present: false,
            usable: false,
            detail: "gh (GitHub CLI) não respondeu nesta máquina".to_string(),
            remediation: Some(
                "Instale o GitHub CLI (https://cli.github.com) para criar releases; \
                 a tag e o push não dependem dele."
                    .to_string(),
            ),
        };
    }
    let primeira = version.lines().next().unwrap_or("gh").to_string();
    let (auth_ok, _, auth_err) = run(root, "gh", &["auth", "status"]);
    if !auth_ok {
        return ToolState {
            present: true,
            usable: false,
            detail: format!(
                "{primeira}, mas sem conta autenticada — {}",
                auth_err.lines().next().unwrap_or("gh auth status falhou")
            ),
            remediation: Some("Rode `gh auth login` no terminal do projeto.".to_string()),
        };
    }
    ToolState {
        present: true,
        usable: true,
        detail: format!("{primeira} · conta autenticada"),
        remediation: None,
    }
}

fn tag_of(version: &str) -> String {
    format!("v{version}")
}

/// As notas da tag e da release, tiradas do próprio registro.
///
/// O que a versão corrige e o que ela tocou já estão gravados; escrever notas à
/// mão duplicaria — e as duas cópias divergiriam.
///
/// ── DEFEITO QUE SÓ APARECEU EMPURRANDO ────────────────────────────────────
/// A primeira versão disto abria as notas com o `project_id`, que é
/// `project:<caminho canônico>`. A tag anotada carregava `/home/<alguém>/…`
/// para dentro do repositório, e o `git push` levava isso para o remoto — em
/// repositório público, para todo mundo. O export já tinha aprendido essa lição
/// e resolvido com `portable_id`; o release nasceu sem ela. Agora as notas
/// abrem pelo TÍTULO do projeto, que é o que uma nota de release quer dizer, e
/// o id, quando aparece, é o portátil.
pub fn notes_for(record: &PublishRecord, title: &str) -> String {
    let mut linhas = vec![format!("{title} {}", record.version)];
    match &record.problem {
        Some(problem) => linhas.push(format!("Corrige: {problem}")),
        None => linhas.push(record.note.clone()),
    }
    if !record.related_resources.is_empty() {
        linhas.push(format!(
            "Recursos ligados ao problema: {}",
            record
                .related_resources
                .iter()
                .map(|id| crate::lifecycle::portable_id(id))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    linhas.join("\n")
}

fn local_tags(root: &Path) -> Vec<String> {
    let (ok, out, _) = run(root, "git", &["tag", "--list"]);
    if !ok {
        return Vec::new();
    }
    out.lines().map(|line| line.trim().to_string()).collect()
}

fn remote_has_tag(record: &PublishRecord) -> bool {
    record
        .deployments
        .iter()
        .any(|entry| entry.target == TARGET_TAG)
}

fn release_url(record: &PublishRecord) -> Option<String> {
    record
        .deployments
        .iter()
        .find(|entry| entry.target == TARGET_RELEASE)
        .map(|entry| entry.reference.clone())
}

pub fn snapshot(root: &Path) -> Result<ReleaseSnapshot, String> {
    let history = crate::lifecycle::snapshot(root)?;
    // O título é o que uma nota de release quer dizer; o id do projeto carrega o
    // caminho da máquina e não entra em nada que possa ir para um remoto.
    let title = history
        .title
        .clone()
        .unwrap_or_else(|| "projeto".to_string());
    let (git, head_commit, remote, dirty) = git_state(root);
    let gh = gh_state(root);
    let tags = if git.usable {
        local_tags(root)
    } else {
        Vec::new()
    };

    let versions = history
        .history
        .iter()
        .map(|record| {
            let tag = tag_of(&record.version);
            let tagged = tags.iter().any(|existing| existing == &tag);
            let tag_commit = tagged
                .then(|| {
                    run(
                        root,
                        "git",
                        &["rev-list", "-n", "1", "--abbrev-commit", &tag],
                    )
                })
                .and_then(|(ok, out, _)| ok.then_some(out));
            ReleasableVersion {
                version: record.version.clone(),
                tag,
                tagged,
                tag_commit,
                pushed: remote_has_tag(record),
                release_url: release_url(record),
                problem: record.problem.clone(),
                notes: notes_for(record, &title),
            }
        })
        .collect();

    Ok(ReleaseSnapshot {
        blocked_reason: history.blocked_reason.clone().or_else(|| {
            if history.history.is_empty() {
                Some(
                    "nenhuma versão consolidada ainda: publicar exige uma versão congelada \
                     no registro, senão publicaria um número"
                        .to_string(),
                )
            } else {
                None
            }
        }),
        git,
        gh,
        remote,
        head_commit,
        dirty,
        versions,
    })
}

/// A versão consolidada, o título do projeto, ou o erro que diz por que ela não
/// serve.
fn record_for(root: &Path, version: &str) -> Result<(String, String, PublishRecord), String> {
    let history = crate::lifecycle::snapshot(root)?;
    let project_id = history
        .project_id
        .clone()
        .ok_or_else(|| history.blocked_reason.clone().unwrap_or_default())?;
    let record = history
        .history
        .iter()
        .find(|entry| entry.version == version)
        .cloned()
        .ok_or_else(|| {
            format!("a versão {version} não está consolidada: publicar publicaria um número")
        })?;
    let title = history
        .title
        .clone()
        .unwrap_or_else(|| "projeto".to_string());
    Ok((project_id, title, record))
}

/// Cria a tag anotada, LOCALMENTE. Nada sai da máquina.
pub fn create_tag(root: &Path, version: &str) -> Result<ReleaseAttempt, String> {
    let (_, title, record) = record_for(root, version)?;
    let tag = tag_of(version);
    let (git, _, _, dirty) = git_state(root);
    if !git.usable {
        return Err(git.detail);
    }
    if local_tags(root).iter().any(|existing| existing == &tag) {
        return Err(format!(
            "{tag} já existe nesta máquina. Apague-a antes de recriar — mover uma tag em \
             silêncio faria dois commits diferentes atenderem pelo mesmo nome."
        ));
    }

    let notes = notes_for(&record, &title);
    let (ok, _, erro) = run(root, "git", &["tag", "-a", &tag, "-m", &notes]);
    if !ok {
        return Err(format!("git tag falhou: {erro}"));
    }

    let effect = LifecycleEffect::CreateLocalTag { tag: tag.clone() };
    Ok(ReleaseAttempt {
        needs_confirmation: false,
        reversibility: effect.reversibility(),
        compensation: compensation_for(&effect),
        explain: format!(
            "Tag {tag} criada nesta máquina{}. Nada saiu daqui; apagar desfaz por completo.",
            if dirty {
                " — atenção: a árvore está suja, e a tag aponta para o último COMMIT, não \
                 para o que está aberto no editor"
            } else {
                ""
            }
        ),
        record: Some(record),
        snapshot: snapshot(root)?,
    })
}

/// A compensação da tag local, executada: apagar.
pub fn delete_tag(root: &Path, version: &str) -> Result<ReleaseSnapshot, String> {
    let tag = tag_of(version);
    let (ok, _, erro) = run(root, "git", &["tag", "-d", &tag]);
    if !ok {
        return Err(format!("apagar {tag} falhou: {erro}"));
    }
    snapshot(root)
}

/// Empurra a tag para o remoto — o primeiro efeito externo real deste caminho.
///
/// Pede confirmação porque não tem undo: apagar no remoto mitiga, e quem já
/// buscou a tag continua com ela.
pub fn push_tag(root: &Path, version: &str, confirmed: bool) -> Result<ReleaseAttempt, String> {
    let (project_id, _, record) = record_for(root, version)?;
    let tag = tag_of(version);
    let (git, _, remote, _) = git_state(root);
    if !git.usable {
        return Err(git.detail);
    }
    let remote = remote.ok_or_else(|| {
        "nenhum remoto configurado: `git remote add origin <url>` antes de empurrar".to_string()
    })?;
    if !local_tags(root).iter().any(|existing| existing == &tag) {
        return Err(format!(
            "{tag} não existe nesta máquina: crie a tag antes de empurrá-la"
        ));
    }

    let effect = LifecycleEffect::PushTag {
        tag: tag.clone(),
        remote: remote.clone(),
    };
    let compensation = compensation_for(&effect);
    let explain = format!(
        "Empurrar {tag} para {remote} é efeito externo: não tem undo. {}",
        compensation
            .as_ref()
            .map(|plan| plan.note.clone())
            .unwrap_or_else(|| "Sem compensação conhecida.".to_string())
    );

    if confirmation_for(true, confirmed) == ConfirmationDecision::ConfirmFirst {
        return Ok(ReleaseAttempt {
            needs_confirmation: true,
            reversibility: effect.reversibility(),
            compensation,
            explain,
            record: None,
            snapshot: snapshot(root)?,
        });
    }

    let (ok, _, erro) = run(root, "git", &["push", &remote, &tag]);
    if !ok {
        return Err(format!("git push falhou: {erro}"));
    }

    let mut log = crate::lifecycle::open_log(root)?;
    let atualizado = log
        .record_deployment(
            &project_id,
            version,
            Deployment {
                target: TARGET_TAG.to_string(),
                reference: format!("{remote}/{tag}"),
                at_epoch_secs: now_secs(),
                compensation: compensation.clone(),
            },
        )
        .map_err(|error| format!("{error:#}"))?;

    Ok(ReleaseAttempt {
        needs_confirmation: false,
        reversibility: effect.reversibility(),
        compensation,
        explain: format!("{tag} está em {remote}. {}", explain_suffix(&record)),
        record: Some(atualizado),
        snapshot: snapshot(root)?,
    })
}

fn explain_suffix(record: &PublishRecord) -> String {
    match &record.problem {
        Some(problem) => format!("As notas dizem o que ela corrige: {problem}"),
        None => "As notas saíram do registro da versão.".to_string(),
    }
}

/// Cria a release no GitHub para uma tag JÁ empurrada.
///
/// Exige `gh` autenticado, e a tag no remoto: criar release de tag que ninguém
/// tem produziria uma página apontando para o nada.
pub fn github_release(
    root: &Path,
    version: &str,
    confirmed: bool,
) -> Result<ReleaseAttempt, String> {
    let (project_id, title, record) = record_for(root, version)?;
    let tag = tag_of(version);
    let gh = gh_state(root);
    if !gh.usable {
        return Err(match gh.remediation {
            Some(hint) => format!("{} — {hint}", gh.detail),
            None => gh.detail,
        });
    }
    if !remote_has_tag(&record) {
        return Err(format!(
            "{tag} não está no remoto: empurre a tag antes, senão a release apontaria \
             para uma tag que ninguém tem"
        ));
    }

    let effect = LifecycleEffect::CreateGithubRelease { tag: tag.clone() };
    let compensation = compensation_for(&effect);
    let explain = format!(
        "Criar a release de {tag} no GitHub é efeito externo e público. {}",
        compensation
            .as_ref()
            .map(|plan| plan.note.clone())
            .unwrap_or_else(|| "Sem compensação conhecida.".to_string())
    );

    if confirmation_for(true, confirmed) == ConfirmationDecision::ConfirmFirst {
        return Ok(ReleaseAttempt {
            needs_confirmation: true,
            reversibility: effect.reversibility(),
            compensation,
            explain,
            record: None,
            snapshot: snapshot(root)?,
        });
    }

    let notes = notes_for(&record, &title);
    let (ok, url, erro) = run(
        root,
        "gh",
        &[
            "release", "create", &tag, "--title", &tag, "--notes", &notes,
        ],
    );
    if !ok {
        return Err(format!("gh release create falhou: {erro}"));
    }

    let mut log = crate::lifecycle::open_log(root)?;
    let atualizado = log
        .record_deployment(
            &project_id,
            version,
            Deployment {
                target: TARGET_RELEASE.to_string(),
                reference: url.clone(),
                at_epoch_secs: now_secs(),
                compensation: compensation.clone(),
            },
        )
        .map_err(|error| format!("{error:#}"))?;

    Ok(ReleaseAttempt {
        needs_confirmation: false,
        reversibility: effect.reversibility(),
        compensation,
        explain: format!("Release publicada: {url}"),
        record: Some(atualizado),
        snapshot: snapshot(root)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Um projeto com repositório git de verdade e uma versão consolidada.
    fn projeto_com_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        crate::project::register(root, "Lista", "Anotar itens e ver de dois telefones")
            .expect("registro");
        fs::write(root.join("README.md"), "lista\n").expect("arquivo");
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "teste@exemplo"],
            vec!["config", "user.name", "Teste"],
            vec!["add", "."],
            vec!["commit", "-q", "-m", "primeiro"],
        ] {
            let (ok, _, erro) = run(root, "git", &args);
            assert!(ok, "git {args:?} falhou: {erro}");
        }
        crate::lifecycle::consolidate(root, true, None, vec![]).expect("consolidar");
        dir
    }

    /// As notas saem do registro. Escrevê-las à mão criaria uma segunda verdade
    /// sobre a mesma versão, e as duas divergiriam.
    #[test]
    fn as_notas_saem_do_registro_da_versao() {
        let dir = projeto_com_repo();
        let historico = crate::lifecycle::snapshot(dir.path()).expect("snapshot");

        let notas = notes_for(&historico.history[0], "Lista");

        assert!(notas.contains("Lista 0.0.1"));
        assert!(
            !notas.contains("/home/") && !notas.contains("/tmp/"),
            "a tag vai para o remoto: caminho de máquina dentro dela vaza para todo mundo — {notas}"
        );
    }

    /// Criar a tag é local: não pergunta nada e tem undo de verdade.
    #[test]
    fn criar_tag_e_local_e_apagar_desfaz_por_completo() {
        let dir = projeto_com_repo();
        let root = dir.path();

        let feito = create_tag(root, "0.0.1").expect("tag");

        assert!(!feito.needs_confirmation, "tag local não sai da máquina");
        assert_eq!(feito.reversibility, Reversibility::Reversible);
        assert!(local_tags(root).iter().any(|tag| tag == "v0.0.1"));

        delete_tag(root, "0.0.1").expect("apagar");

        assert!(
            !local_tags(root).iter().any(|tag| tag == "v0.0.1"),
            "apagar a tag local é undo de verdade"
        );
    }

    /// Mover uma tag em silêncio faria dois commits atenderem pelo mesmo nome.
    #[test]
    fn recriar_uma_tag_existente_e_recusado() {
        let dir = projeto_com_repo();
        create_tag(dir.path(), "0.0.1").expect("tag");

        let erro = create_tag(dir.path(), "0.0.1").expect_err("deve recusar");

        assert!(erro.contains("já existe"));
    }

    /// Publicar uma versão que ninguém consolidou seria publicar um número.
    #[test]
    fn taguear_versao_nao_consolidada_e_recusado() {
        let dir = projeto_com_repo();

        let erro = create_tag(dir.path(), "9.9.9").expect_err("deve recusar");

        assert!(erro.contains("não está consolidada"));
    }

    /// Empurrar PERGUNTA antes, e enquanto pergunta não empurra nada.
    #[test]
    fn empurrar_pergunta_antes_e_nao_registra_destino_sem_confirmacao() {
        let dir = projeto_com_repo();
        let root = dir.path();
        // Um remoto local basta: o teste mede a decisão do motor, não a rede.
        let remoto = tempfile::tempdir().expect("remoto");
        let (ok, _, erro) = run(remoto.path(), "git", &["init", "--bare", "-q"]);
        assert!(ok, "remoto: {erro}");
        let (ok, _, erro) = run(
            root,
            "git",
            &[
                "remote",
                "add",
                "origin",
                &remoto.path().display().to_string(),
            ],
        );
        assert!(ok, "remote add: {erro}");
        create_tag(root, "0.0.1").expect("tag");

        let perguntou = push_tag(root, "0.0.1", false).expect("attempt");

        assert!(perguntou.needs_confirmation);
        assert_eq!(perguntou.reversibility, Reversibility::CompensationOnly);
        assert!(
            perguntou.explain.contains("não desfaz"),
            "a frase tem de dizer que apagar no remoto mitiga: {}",
            perguntou.explain
        );
        assert!(
            crate::lifecycle::snapshot(root).expect("snapshot").history[0]
                .deployments
                .is_empty(),
            "enquanto pergunta, nada foi registrado como publicado"
        );

        let feito = push_tag(root, "0.0.1", true).expect("push");

        let registro = feito.record.expect("registro");
        assert_eq!(registro.deployments.len(), 1);
        assert_eq!(registro.deployments[0].target, TARGET_TAG);
        assert!(registro.deployments[0].reference.ends_with("v0.0.1"));
    }

    /// Sem remoto, empurrar não tem para onde — e a recusa diz o comando.
    #[test]
    fn empurrar_sem_remoto_recusa_dizendo_o_que_falta() {
        let dir = projeto_com_repo();
        create_tag(dir.path(), "0.0.1").expect("tag");

        let erro = push_tag(dir.path(), "0.0.1", true).expect_err("deve recusar");

        assert!(erro.contains("git remote add"));
    }

    /// Release de uma tag que ninguém tem apontaria para o nada.
    #[test]
    fn release_de_tag_nao_empurrada_e_recusada() {
        let dir = projeto_com_repo();
        create_tag(dir.path(), "0.0.1").expect("tag");

        let erro = github_release(dir.path(), "0.0.1", true).expect_err("deve recusar");

        // Sem `gh` utilizável, a recusa é a do gh; com ele, a da tag ausente. As
        // duas são verdadeiras e nenhuma delas cria release.
        assert!(
            erro.contains("não está no remoto") || erro.contains("gh"),
            "recusa inesperada: {erro}"
        );
    }
}
