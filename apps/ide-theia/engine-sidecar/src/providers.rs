//! §16 — publicar num provider, sem a IDE virar dona da conta de ninguém.
//!
//! Netlify, Vercel, Render e Heroku têm cada um o seu arquivo de configuração e
//! o seu jeito de subir. O que a IDE faz aqui é o que ela pode fazer com
//! honestidade:
//!
//!  1. **Gera o arquivo de configuração** do provider escolhido, a partir do que
//!     o projeto DECLAROU (o comando de build do `.instrument/checks.json`) e do
//!     diretório publicável que a pessoa confirmou.
//!  2. **Diz os passos** — os comandos que ela roda no terminal, na conta dela.
//!  3. **Confere depois**: um GET no endereço. Respondeu, está no ar e a versão
//!     ganha o destino no registro; não respondeu, está dito que não está.
//!
//! # O que a IDE deliberadamente NÃO faz
//!
//! * **Não guarda token nem faz o deploy pela pessoa.** Sem credencial nossa não
//!   há lock-in, não há segredo nosso para vazar, e a conta continua sendo dela.
//! * **Não adivinha o diretório publicável.** Um `publish` errado quebra o deploy
//!   longe daqui, e a mensagem que a pessoa vê é do provider, não nossa. As
//!   sugestões saem dos diretórios que EXISTEM no projeto.
//! * **Não sobrescreve configuração que já existe.** Se o arquivo está lá, ele é
//!   de alguém — a resposta é dizer que existe, não passar por cima.
//!
//! O mesmo contrato serve para um provider organizacional depois (uma Katsui
//! Cloud, por exemplo): ele entra como mais um item do catálogo, sem virar
//! obrigatório para ninguém.

use ide_lifecycle::Deployment;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// Diretórios que costumam ser o resultado de build. Só entram na sugestão se
/// existirem de verdade no projeto.
const CANDIDATOS: [&str; 6] = ["dist", "build", "out", "public", "_site", ".output/public"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolState {
    pub present: bool,
    pub detail: String,
    pub remediation: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCard {
    /// `netlify` | `vercel` | `render` | `heroku`.
    pub id: String,
    pub name: String,
    /// O arquivo que a IDE gera, relativo à raiz.
    pub config_path: String,
    /// Ele já existe — e então nada é sobrescrito.
    pub config_exists: bool,
    /// A CLI daquele provider, quando ela está na máquina.
    pub cli: ToolState,
    /// Os passos que a pessoa roda, na conta dela.
    pub steps: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersSnapshot {
    pub providers: Vec<ProviderCard>,
    /// O comando de build declarado em `.instrument/checks.json`, quando existe.
    pub build_command: Option<String>,
    /// O comando do processo web declarado em `.instrument/preview.json`. É o
    /// que o Heroku precisa, e o que ele NÃO pode inventar do build.
    pub web_command: Option<String>,
    /// Diretórios publicáveis que EXISTEM no projeto agora.
    pub publish_candidates: Vec<String>,
    /// `curl`, que é como a conferência é feita.
    pub curl: ToolState,
    /// As versões consolidadas — publicar sempre publica uma delas.
    pub versions: Vec<String>,
    pub blocked_reason: Option<String>,
}

/// O que a geração produziu.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedConfig {
    pub provider: String,
    pub path: String,
    pub contents: String,
    /// Frase para o recibo: o que existe agora e o que desfaz.
    pub explain: String,
    pub steps: Vec<String>,
}

/// O resultado de conferir um endereço.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    pub url: String,
    /// O código HTTP observado, quando houve resposta.
    pub status: Option<u16>,
    /// Está no ar de verdade (2xx/3xx).
    pub live: bool,
    /// Frase honesta sobre o que foi observado. Nunca vazia.
    pub explain: String,
    /// Registrado como destino alcançado, quando estava no ar.
    pub recorded: bool,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn tool(program: &str, args: &[&str], falta: &str) -> ToolState {
    match Command::new(program).args(args).output() {
        Ok(output) if output.status.success() => ToolState {
            present: true,
            detail: String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or(program)
                .trim()
                .to_string(),
            remediation: None,
        },
        _ => ToolState {
            present: false,
            detail: format!("{program} não respondeu nesta máquina"),
            remediation: Some(falta.to_string()),
        },
    }
}

/// O comando de build que o projeto declarou. Nunca detectado por palpite: o §4
/// já exige declaração, e inventar um build aqui poria no arquivo do provider um
/// comando que ninguém escreveu.
fn declared_build(root: &Path) -> Option<String> {
    let raw = fs::read(root.join(".instrument/checks.json")).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    value
        .get("build")?
        .get("command")?
        .as_str()
        .map(str::to_string)
}

/// O comando do processo web que o projeto declarou para o preview (§4).
///
/// É a MESMA declaração que o preview supervisiona: o processo que fica de pé
/// servindo. Deduzir isso de outro lugar seria inventar o que roda em produção.
fn web_process(root: &Path) -> Option<String> {
    let raw = fs::read(root.join(".instrument/preview.json")).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    value
        .get("command")?
        .as_str()
        .map(str::to_string)
        .filter(|command| !command.trim().is_empty())
}

fn publish_candidates(root: &Path) -> Vec<String> {
    CANDIDATOS
        .iter()
        .filter(|dir| root.join(dir).is_dir())
        .map(|dir| (*dir).to_string())
        .collect()
}

/// O conteúdo do arquivo de cada provider.
///
/// Público para o teste poder cobrar o formato sem depender de nenhuma CLI
/// instalada: o que quebra o deploy é o conteúdo, não a nossa vontade.
pub fn config_for(
    provider: &str,
    build: &str,
    publish: &str,
    web: Option<&str>,
) -> Result<(String, String), String> {
    match provider {
        "netlify" => Ok((
            "netlify.toml".to_string(),
            format!(
                "# Gerado pelo IDE a partir do build declarado do projeto.\n\
                 [build]\n  command = \"{build}\"\n  publish = \"{publish}\"\n"
            ),
        )),
        "vercel" => Ok((
            "vercel.json".to_string(),
            format!(
                "{{\n  \"$schema\": \"https://openapi.vercel.sh/vercel.json\",\n  \
                 \"buildCommand\": \"{build}\",\n  \"outputDirectory\": \"{publish}\"\n}}\n"
            ),
        )),
        "render" => Ok((
            "render.yaml".to_string(),
            // `runtime: static`, e não `env: static`: o Render renomeou a chave, e
            // um blueprint com a antiga é recusado na hora de valer — longe daqui,
            // com mensagem deles. Conferido na especificação de blueprint atual.
            format!(
                "# Gerado pelo IDE a partir do build declarado do projeto.\n\
                 services:\n  - type: web\n    name: site\n    runtime: static\n    \
                 buildCommand: {build}\n    staticPublishPath: {publish}\n"
            ),
        )),
        "heroku" => {
            // ── DEFEITO DE DESENHO, NÃO SÓ DE PROVA ───────────────────────
            // A primeira versão escrevia `web: <comando de BUILD>`. Build não é
            // processo web: `npm run build` compila e SAI, e um dyno cujo
            // processo termina é derrubado pelo Heroku. Para app estático não
            // sobe de jeito nenhum. O Procfile precisa do comando que FICA de
            // pé, e esse o projeto já declara em `.instrument/preview.json` —
            // é o mesmo processo que o §4 supervisiona. Sem essa declaração, a
            // resposta é recusar; escrever o build ali produziria um deploy que
            // falha longe daqui, com mensagem do Heroku e não nossa.
            let web = web.ok_or_else(|| {
                "o Heroku precisa do comando do PROCESSO WEB (o que fica de pé servindo), \
                 e ele não é o comando de build. O projeto declara esse processo em \
                 .instrument/preview.json — declare o preview e gere de novo"
                    .to_string()
            })?;
            // O Heroku ATRIBUI a porta por `$PORT`, e um processo que escuta numa
            // porta fixa nunca é considerado saudável lá — o deploy sobe e o dyno
            // é derrubado por timeout de bind. O comando do preview é local, então
            // quase sempre tem porta fixa: dizer isso aqui é a diferença entre a
            // pessoa ajustar em dez segundos e perder a tarde lendo log do Heroku.
            let aviso = if web.contains("$PORT") {
                String::new()
            } else {
                "# ATENÇÃO: este comando não usa $PORT. O Heroku decide a porta e a\n\
                 # passa nessa variável; um processo com porta fixa não fica saudável\n\
                 # lá. Ajuste o comando para escutar em $PORT antes de subir.\n"
                    .to_string()
            };
            Ok((
                "Procfile".to_string(),
                format!(
                    "# Gerado pelo IDE a partir do processo web declarado em \
                     .instrument/preview.json.\n{aviso}web: {web}\n"
                ),
            ))
        }
        other => Err(format!("provider desconhecido: {other}")),
    }
}

fn steps_for(provider: &str) -> Vec<String> {
    match provider {
        "netlify" => vec![
            "npm i -g netlify-cli (uma vez)".to_string(),
            "netlify login — abre o navegador, na SUA conta".to_string(),
            "netlify deploy --build --prod".to_string(),
            "copie a URL que ele imprimir e confira aqui".to_string(),
        ],
        "vercel" => vec![
            "npm i -g vercel (uma vez)".to_string(),
            "vercel login".to_string(),
            "vercel --prod".to_string(),
            "copie a URL que ele imprimir e confira aqui".to_string(),
        ],
        "render" => vec![
            "commit e push do render.yaml no repositório".to_string(),
            "no painel do Render: New → Blueprint, apontando para o repositório".to_string(),
            "copie a URL do serviço e confira aqui".to_string(),
        ],
        "heroku" => vec![
            "declare o processo web em .instrument/preview.json (é o que vai no Procfile)"
                .to_string(),
            "heroku login".to_string(),
            "heroku create <nome> (uma vez)".to_string(),
            "git push heroku HEAD:main".to_string(),
            "copie a URL do app e confira aqui".to_string(),
        ],
        _ => Vec::new(),
    }
}

fn cli_for(provider: &str) -> ToolState {
    match provider {
        "netlify" => tool(
            "netlify",
            &["--version"],
            "npm i -g netlify-cli — a IDE gera a configuração; o deploy é você, na sua conta",
        ),
        "vercel" => tool(
            "vercel",
            &["--version"],
            "npm i -g vercel — a IDE gera a configuração; o deploy é você, na sua conta",
        ),
        "render" => ToolState {
            // Render não tem CLI obrigatória: o caminho é o repositório + painel.
            present: true,
            detail: "não exige CLI: o Render lê o render.yaml do repositório".to_string(),
            remediation: None,
        },
        _ => tool(
            "heroku",
            &["--version"],
            "instale a CLI do Heroku (https://devcenter.heroku.com/articles/heroku-cli)",
        ),
    }
}

pub fn snapshot(root: &Path) -> Result<ProvidersSnapshot, String> {
    let historico = crate::lifecycle::snapshot(root)?;
    let providers = ["netlify", "vercel", "render", "heroku"]
        .iter()
        .map(|id| {
            let (path, _) = config_for(id, "…", "…", Some("…")).unwrap_or_default_pair();
            ProviderCard {
                id: (*id).to_string(),
                name: match *id {
                    "netlify" => "Netlify",
                    "vercel" => "Vercel",
                    "render" => "Render",
                    _ => "Heroku",
                }
                .to_string(),
                config_exists: root.join(&path).exists(),
                config_path: path,
                cli: cli_for(id),
                steps: steps_for(id),
            }
        })
        .collect();

    Ok(ProvidersSnapshot {
        providers,
        build_command: declared_build(root),
        web_command: web_process(root),
        publish_candidates: publish_candidates(root),
        curl: tool(
            "curl",
            &["--version"],
            "instale o curl: a conferência do que está no ar é um GET, e sem ele a IDE não \
             consegue dizer se subiu",
        ),
        versions: historico
            .history
            .iter()
            .map(|record| record.version.clone())
            .collect(),
        blocked_reason: historico.blocked_reason.clone().or_else(|| {
            if historico.history.is_empty() {
                Some(
                    "nenhuma versão consolidada ainda: sem versão, o que estivesse no ar não \
                     teria a que ser ligado"
                        .to_string(),
                )
            } else {
                None
            }
        }),
    })
}

/// Pequeno auxílio para o snapshot não precisar tratar erro de provider fixo.
trait DefaultPair {
    fn unwrap_or_default_pair(self) -> (String, String);
}

impl DefaultPair for Result<(String, String), String> {
    fn unwrap_or_default_pair(self) -> (String, String) {
        self.unwrap_or_else(|_| (String::new(), String::new()))
    }
}

/// Gera o arquivo de configuração do provider.
///
/// Recusa sobrescrever: um `netlify.toml` que já existe é de alguém, e passar por
/// cima trocaria a configuração real do projeto por uma derivada de palpite.
pub fn generate(root: &Path, provider: &str, publish: &str) -> Result<GeneratedConfig, String> {
    let build = declared_build(root).ok_or_else(|| {
        "o projeto não declarou comando de build em .instrument/checks.json — gerar a \
         configuração sem ele poria no arquivo um comando que ninguém escreveu"
            .to_string()
    })?;
    if publish.trim().is_empty() && provider != "heroku" {
        return Err(
            "diga qual diretório é publicável: adivinhar quebra o deploy longe daqui, e a \
             mensagem de erro que aparece é do provider, não nossa"
                .to_string(),
        );
    }
    let (nome, conteudo) = config_for(provider, &build, publish, web_process(root).as_deref())?;
    let destino = root.join(&nome);
    if destino.exists() {
        return Err(format!(
            "{nome} já existe neste projeto: ele é de alguém, e sobrescrever trocaria a \
             configuração real por uma derivada daqui"
        ));
    }
    fs::write(&destino, &conteudo).map_err(|error| format!("gravar {nome}: {error}"))?;

    Ok(GeneratedConfig {
        provider: provider.to_string(),
        explain: format!(
            "{nome} gerado a partir do build declarado (`{build}`). É arquivo local do \
             projeto: apagar desfaz. O deploy é seu, na sua conta — a IDE não guarda token."
        ),
        path: nome,
        contents: conteudo,
        steps: steps_for(provider),
    })
}

/// Confere um endereço com `curl` e devolve o código HTTP observado.
fn probe_with_curl(url: &str) -> Result<u16, String> {
    let saida = Command::new("curl")
        .args([
            "-s",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            "--max-time",
            "15",
            url,
        ])
        .output()
        .map_err(|error| format!("curl não rodou: {error}"))?;
    let codigo = String::from_utf8_lossy(&saida.stdout).trim().to_string();
    codigo
        .parse::<u16>()
        .map_err(|_| format!("curl não devolveu código HTTP para {url}: {codigo}"))
}

/// Confere se a versão está no ar naquele endereço e, quando está, registra o
/// destino alcançado na linha dela.
pub fn verify(
    root: &Path,
    provider: &str,
    version: &str,
    url: &str,
) -> Result<VerifyResult, String> {
    verify_with(root, provider, version, url, probe_with_curl)
}

/// A conferência, com a sonda injetada.
///
/// O teste passa a própria sonda: o que precisa ser provado é que 2xx registra e
/// que qualquer outra coisa NÃO registra — e isso não pode depender de rede.
fn verify_with(
    root: &Path,
    provider: &str,
    version: &str,
    url: &str,
    probe: impl Fn(&str) -> Result<u16, String>,
) -> Result<VerifyResult, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("{url} não é um endereço http(s)"));
    }
    let historico = crate::lifecycle::snapshot(root)?;
    let project_id = historico
        .project_id
        .clone()
        .ok_or_else(|| historico.blocked_reason.clone().unwrap_or_default())?;
    if !historico
        .history
        .iter()
        .any(|record| record.version == version)
    {
        return Err(format!(
            "a versão {version} não está consolidada: sem ela, o que está no ar não tem a \
             que ser ligado"
        ));
    }

    match probe(url) {
        Ok(status) => {
            let live = (200..400).contains(&status);
            let mut recorded = false;
            if live {
                let mut log = crate::lifecycle::open_log(root)?;
                log.record_deployment(
                    &project_id,
                    version,
                    Deployment {
                        target: provider.to_string(),
                        reference: url.to_string(),
                        at_epoch_secs: now_secs(),
                        // O provider é quem desfaz: a IDE não tem a conta, então
                        // prometer uma compensação executável aqui seria mentira.
                        compensation: None,
                    },
                )
                .map_err(|error| format!("{error:#}"))?;
                recorded = true;
            }
            Ok(VerifyResult {
                url: url.to_string(),
                status: Some(status),
                live,
                explain: if live {
                    format!(
                        "{url} respondeu {status}: a versão {version} está no ar e ficou \
                         ligada a este endereço. Tirar do ar é no painel do provider — a IDE \
                         não tem a sua conta."
                    )
                } else {
                    format!(
                        "{url} respondeu {status}: isso não é estar no ar, e nada foi \
                         registrado como publicado."
                    )
                },
                recorded,
            })
        }
        Err(erro) => Ok(VerifyResult {
            url: url.to_string(),
            status: None,
            live: false,
            explain: format!("não deu para conferir {url}: {erro}. Nada foi registrado."),
            recorded: false,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn projeto_com_versao() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        crate::project::register(root, "Lista", "Anotar itens e ver de dois telefones")
            .expect("registro");
        fs::write(
            root.join(".instrument/checks.json"),
            r#"{"build": {"command": "npm run build"}}"#,
        )
        .expect("checks");
        crate::lifecycle::consolidate(root, true, None, vec![]).expect("consolidar");
        dir
    }

    /// O que quebra o deploy é o conteúdo do arquivo, então é ele que o teste
    /// cobra — sem depender de nenhuma CLI instalada.
    #[test]
    fn cada_provider_gera_o_seu_formato() {
        let (nome, netlify) = config_for("netlify", "npm run build", "dist", None).unwrap();
        assert_eq!(nome, "netlify.toml");
        assert!(netlify.contains("command = \"npm run build\""));
        assert!(netlify.contains("publish = \"dist\""));

        let (nome, vercel) = config_for("vercel", "npm run build", "dist", None).unwrap();
        assert_eq!(nome, "vercel.json");
        let json: serde_json::Value = serde_json::from_str(&vercel).expect("vercel.json é JSON");
        assert_eq!(json["outputDirectory"], "dist");

        let (nome, render) = config_for("render", "npm run build", "dist", None).unwrap();
        assert_eq!(nome, "render.yaml");
        // A chave é `runtime`. `env: static` é a forma antiga e o Render recusa o
        // blueprint — o erro apareceria no painel deles, não aqui.
        assert!(render.contains("runtime: static"));
        assert!(!render.contains("env: static"));
        assert!(render.contains("staticPublishPath: dist"));

        assert!(config_for("provider-que-nao-existe", "x", "y", None).is_err());
    }

    /// `web: npm run build` derruba o dyno: build compila e SAI, e o Heroku
    /// mata um processo web que termina. O Procfile precisa do que FICA de pé.
    #[test]
    fn heroku_usa_o_processo_web_declarado_e_nunca_o_build() {
        let (nome, procfile) = config_for(
            "heroku",
            "npm run build",
            "dist",
            Some("node server.js --port $PORT"),
        )
        .expect("com processo web declarado");

        assert_eq!(nome, "Procfile");
        assert!(procfile.contains("web: node server.js --port $PORT"));
        assert!(
            !procfile.contains("npm run build"),
            "o comando de build no Procfile produz um deploy que morre: {procfile}"
        );

        let erro = config_for("heroku", "npm run build", "dist", None)
            .expect_err("sem processo web declarado, recusa");
        assert!(erro.contains("preview.json"));

        // Porta fixa no comando: o Heroku decide a porta por $PORT, e um processo
        // que a ignora é derrubado por timeout de bind. O arquivo tem de avisar.
        let (_, fixa) = config_for(
            "heroku",
            "npm run build",
            "dist",
            Some("python3 -m http.server 8124"),
        )
        .expect("gera com aviso");
        assert!(
            fixa.contains("$PORT"),
            "o aviso da porta tem de estar lá: {fixa}"
        );

        let (_, dinamica) = config_for(
            "heroku",
            "npm run build",
            "dist",
            Some("node server.js --port $PORT"),
        )
        .expect("gera sem aviso");
        assert!(
            !dinamica.contains("ATENÇÃO"),
            "quem já usa $PORT não precisa de aviso: {dinamica}"
        );
    }

    /// E a recusa chega pelo caminho de verdade, não só pela função pura.
    #[test]
    fn gerar_procfile_sem_preview_declarado_e_recusado() {
        let dir = projeto_com_versao();

        let erro = generate(dir.path(), "heroku", "dist").expect_err("deve recusar");

        assert!(erro.contains("PROCESSO WEB"));
        assert!(!dir.path().join("Procfile").exists());
    }

    /// Com o preview declarado, o Procfile sai com ele.
    #[test]
    fn gerar_procfile_usa_o_comando_do_preview() {
        let dir = projeto_com_versao();
        fs::write(
            dir.path().join(".instrument/preview.json"),
            r#"{"command": "node server.js", "url": "http://127.0.0.1:8124/"}"#,
        )
        .expect("preview");

        generate(dir.path(), "heroku", "").expect("gerar");

        let procfile = fs::read_to_string(dir.path().join("Procfile")).expect("Procfile");
        assert_eq!(procfile.lines().last(), Some("web: node server.js"));
    }

    /// Sem build declarado, o arquivo teria um comando que ninguém escreveu.
    #[test]
    fn gerar_sem_build_declarado_e_recusado() {
        let dir = tempfile::tempdir().expect("tempdir");
        crate::project::register(dir.path(), "Lista", "Anotar itens").expect("registro");

        let erro = generate(dir.path(), "netlify", "dist").expect_err("deve recusar");

        assert!(erro.contains("checks.json"));
    }

    /// Configuração que já existe é de alguém.
    #[test]
    fn gerar_nao_sobrescreve_configuracao_existente() {
        let dir = projeto_com_versao();
        fs::write(
            dir.path().join("netlify.toml"),
            "[build]\n  command = \"meu\"\n",
        )
        .unwrap();

        let erro = generate(dir.path(), "netlify", "dist").expect_err("deve recusar");

        assert!(erro.contains("já existe"));
        assert!(fs::read_to_string(dir.path().join("netlify.toml"))
            .unwrap()
            .contains("meu"));
    }

    #[test]
    fn gerar_escreve_o_arquivo_e_diz_o_que_desfaz() {
        let dir = projeto_com_versao();

        let feito = generate(dir.path(), "netlify", "dist").expect("gerar");

        assert!(dir.path().join("netlify.toml").exists());
        assert!(feito.explain.contains("apagar desfaz"));
        assert!(
            !feito.steps.is_empty(),
            "sem os passos, o arquivo sozinho não publica nada"
        );
    }

    /// 2xx liga o endereço à versão; qualquer outra coisa NÃO registra nada.
    #[test]
    fn so_o_que_responde_no_ar_vira_destino_registrado() {
        let dir = projeto_com_versao();

        let vivo = verify_with(
            dir.path(),
            "netlify",
            "0.0.1",
            "https://x.netlify.app",
            |_| Ok(200),
        )
        .expect("verify");
        assert!(vivo.live && vivo.recorded);

        let historico = crate::lifecycle::snapshot(dir.path()).expect("snapshot");
        assert_eq!(historico.history[0].deployments.len(), 1);
        assert_eq!(historico.history[0].deployments[0].target, "netlify");

        let morto = verify_with(
            dir.path(),
            "netlify",
            "0.0.1",
            "https://x.netlify.app",
            |_| Ok(404),
        )
        .expect("verify");
        assert!(!morto.live && !morto.recorded);
        assert!(morto.explain.contains("não é estar no ar"));
        assert_eq!(
            crate::lifecycle::snapshot(dir.path())
                .expect("snapshot")
                .history[0]
                .deployments
                .len(),
            1,
            "404 não pode acrescentar destino nenhum"
        );
    }

    /// Falha de sonda não é "está fora do ar": é não saber, e a frase diz isso.
    #[test]
    fn sonda_que_nao_roda_diz_que_nao_sabe() {
        let dir = projeto_com_versao();

        let resultado = verify_with(
            dir.path(),
            "vercel",
            "0.0.1",
            "https://x.vercel.app",
            |_| Err("curl não rodou".to_string()),
        )
        .expect("verify");

        assert!(resultado.status.is_none());
        assert!(!resultado.recorded);
        assert!(resultado.explain.contains("não deu para conferir"));
    }

    #[test]
    fn conferir_versao_nao_consolidada_e_recusado() {
        let dir = projeto_com_versao();

        let erro = verify_with(dir.path(), "netlify", "9.9.9", "https://x", |_| Ok(200))
            .expect_err("deve recusar");

        assert!(erro.contains("não está consolidada"));
    }
}
