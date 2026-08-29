//! §16 — mostrar para alguém: a rede local e o túnel.
//!
//! O §4 já sobe o processo que o projeto declara e sonda a saúde dele. Este
//! módulo é o passo seguinte, e só ele: **expor esse preview para outra pessoa**.
//! Não inicia servidor de aplicação nenhum e não substitui o preview — se não há
//! preview de pé, não há o que compartilhar, e a resposta é essa.
//!
//! # Duas coisas diferentes, com dois avisos diferentes
//!
//! * **Rede local** — quem está na MESMA rede alcança. Não é "só quem receber o
//!   link": é o café inteiro, o coworking, o hotel.
//! * **Túnel** — o endereço é público na internet e aponta para ESTA máquina.
//!   Enquanto estiver aberto, o computador de quem compartilhou é o servidor.
//!
//! Os dois morrem quando a IDE fecha, e os dois têm PRAZO. Compartilhamento que
//! não expira é o que fica aberto a noite toda depois que a demo acabou.
//!
//! # O que este módulo se recusa a fazer
//!
//! * **Servir a raiz do projeto.** O que vai para fora é o que o preview serve,
//!   por proxy. Apontar um servidor de arquivos para a pasta entregaria `.env` e
//!   `.git` — credencial e histórico inteiro — para quem abrisse o link.
//! * **Expor sem senha.** O túnel é público para quem tiver o endereço; sem
//!   autenticação, "mandei o link para um amigo" e "está na internet aberta" são
//!   a mesma coisa. A senha é gerada aqui e mostrada uma vez.
//! * **Fingir alcance.** Sem `nginx` não há proxy com senha, e sem `cloudflared`
//!   não há túnel. Cada ausência é dita com o comando que a resolve, em vez de um
//!   botão que falha depois.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Onde a configuração gerada e a senha ficam. Estado de runtime do IDE, não
/// conteúdo do projeto.
const SHARE_REL: &str = ".instrument/share";
/// Prazo padrão. Uma demo dura minutos; a exposição não pode durar a noite.
const DEFAULT_TTL_MINUTES: u64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShareMode {
    /// Alcançável por quem está na mesma rede.
    Lan,
    /// Endereço público na internet, apontando para esta máquina.
    Tunnel,
}

/// Uma ferramenta externa, dita pelo que ela permite AQUI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolState {
    pub present: bool,
    pub detail: String,
    pub remediation: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareSnapshot {
    pub nginx: ToolState,
    pub cloudflared: ToolState,
    /// O que o preview do §4 está servindo agora, quando está.
    pub preview_url: Option<String>,
    /// Por que não dá para compartilhar agora, quando não dá.
    pub blocked_reason: Option<String>,
    /// O compartilhamento em curso, quando existe.
    pub active: Option<ActiveShare>,
    /// O endereço desta máquina na rede local, para o modo `lan`.
    pub lan_address: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveShare {
    pub mode: ShareMode,
    /// O endereço que a outra pessoa abre.
    pub url: String,
    /// Usuário e senha gerados. Mostrados aqui porque só existem aqui.
    pub user: String,
    pub password: String,
    /// Quando fecha sozinho, em segundos desde a época.
    pub expires_at_epoch_secs: u64,
    /// O aviso que corresponde ao alcance real deste modo. Nunca vazio.
    pub warning: String,
}

struct ShareRuntime {
    mode: ShareMode,
    url: String,
    user: String,
    password: String,
    expires_at: u64,
    warning: String,
    /// nginx, quando ele é o proxy com senha.
    proxy: Option<Child>,
    /// cloudflared, no modo túnel.
    tunnel: Option<Child>,
}

type Registry = Mutex<HashMap<String, ShareRuntime>>;

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn tool(program: &str, args: &[&str], falta: &str) -> ToolState {
    match Command::new(program).args(args).output() {
        Ok(output) if output.status.success() => {
            let texto = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            ToolState {
                present: true,
                detail: texto.lines().next().unwrap_or(program).trim().to_string(),
                remediation: None,
            }
        }
        _ => ToolState {
            present: false,
            detail: format!("{program} não respondeu nesta máquina"),
            remediation: Some(falta.to_string()),
        },
    }
}

/// O endereço desta máquina na rede local.
///
/// Descoberto abrindo um socket UDP para fora — sem enviar nada e sem depender
/// de rede funcionando de verdade: é o roteamento local que responde qual
/// interface sairia. Ler `hostname -I` traria endereço de container e de VPN
/// misturados, e a tela mostraria um endereço que ninguém alcança.
fn lan_address() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.168.1.1:9").ok()?;
    socket.local_addr().ok().map(|addr| addr.ip().to_string())
}

/// A porta que o preview declarou, tirada da URL dele.
fn port_of(url: &str) -> Option<u16> {
    let sem_esquema = url.split("://").nth(1).unwrap_or(url);
    let autoridade = sem_esquema.split('/').next().unwrap_or("");
    autoridade.rsplit(':').next()?.parse().ok()
}

/// Uma porta livre para o proxy. Pedir 0 ao sistema e ler qual coube é o único
/// jeito que não chuta um número já ocupado.
fn free_port() -> Option<u16> {
    let listener = TcpListener::bind("0.0.0.0:0").ok()?;
    listener.local_addr().ok().map(|addr| addr.port())
}

/// Uma senha nova por compartilhamento, com 128 bits do sistema.
///
/// ── DEFEITO CORRIGIDO ANTES DE VALER ──────────────────────────────────────
/// A primeira versão derivava a senha do relógio + PID. Os dois são
/// OBSERVÁVEIS por quem recebe o link — a hora em que a página respondeu já
/// estreita o relógio, e PID é um número pequeno — então a senha do túnel, que
/// é o que separa "mandei para uma pessoa" de "está na internet aberta",
/// caberia numa busca curta. Agora vem de `getrandom`, que é a fonte do sistema
/// operacional.
///
/// Se o sistema não conseguir dar aleatoriedade, isto FALHA. Cair para uma
/// senha fraca em silêncio seria pior do que não compartilhar: a pessoa acharia
/// que o endereço está protegido.
fn generate_password() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| {
        format!(
            "o sistema não deu aleatoriedade para gerar a senha ({error}); compartilhar sem \
             senha forte deixaria o endereço aberto para quem tropeçasse nele"
        )
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// A configuração do nginx que expõe o preview com senha.
///
/// Pura de propósito: o teste lê o texto e cobra o que ele precisa negar, sem
/// depender de ter nginx instalado na máquina de quem roda o teste.
pub fn nginx_config(listen_port: u16, preview_port: u16, share_dir: &Path) -> String {
    let dir = share_dir.display();
    format!(
        r#"# Gerado pelo IDE para compartilhar o preview. Não editar à mão:
# cada compartilhamento reescreve este arquivo.
daemon off;
error_log {dir}/nginx-error.log;
pid {dir}/nginx.pid;
events {{ worker_connections 64; }}
http {{
    access_log {dir}/nginx-access.log;
    client_body_temp_path {dir}/body;
    proxy_temp_path {dir}/proxy;
    fastcgi_temp_path {dir}/fastcgi;
    uwsgi_temp_path {dir}/uwsgi;
    scgi_temp_path {dir}/scgi;
    server {{
        listen 0.0.0.0:{listen_port};
        server_name _;
        autoindex off;

        auth_basic "compartilhado pelo IDE";
        auth_basic_user_file {dir}/htpasswd;

        # Arquivo escondido nunca sai daqui: é onde moram .env e .git, e um
        # deles basta para entregar credencial e histórico inteiro.
        location ~ /\. {{ return 404; }}

        location / {{
            proxy_pass http://127.0.0.1:{preview_port};
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $remote_addr;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
        }}
    }}
}}
"#
    )
}

fn share_dir(root: &Path) -> PathBuf {
    root.join(SHARE_REL)
}

fn write_credentials(dir: &Path, user: &str, password: &str) -> Result<(), String> {
    let path = dir.join("htpasswd");
    // `{PLAIN}` é aceito pelo nginx e evita depender do `htpasswd` (apache2-utils)
    // estar instalado. O arquivo é local e fica 0600.
    fs::write(&path, format!("{user}:{{PLAIN}}{password}\n"))
        .map_err(|error| format!("gravar {}: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn aviso(mode: ShareMode, url: &str, minutos: u64) -> String {
    match mode {
        ShareMode::Lan => format!(
            "{url} é alcançável por QUALQUER PESSOA NA MESMA REDE — não é só quem receber o \
             link: é o café, o coworking, o hotel inteiro. A conexão é sem TLS: o que for \
             digitado aí passa em texto claro na rede. Fecha sozinho em {minutos} min."
        ),
        ShareMode::Tunnel => format!(
            "{url} é um endereço PÚBLICO na internet que aponta para ESTA máquina. Quem tiver \
             o link e a senha vê o que o app mostra e faz o que o app faz; enquanto estiver \
             aberto, seu computador é o servidor. Some quando você fechar. Fecha sozinho em \
             {minutos} min."
        ),
    }
}

pub fn snapshot(root: &Path) -> Result<ShareSnapshot, String> {
    expire_if_due(root);
    let preview = crate::preview::status(root)?;
    let preview_url = preview
        .declared
        .as_ref()
        .and_then(|declared| declared.url.clone())
        .filter(|_| preview.running);

    let key = root.display().to_string();
    let active = registry()
        .lock()
        .ok()
        .and_then(|map| map.get(&key).map(describe));

    Ok(ShareSnapshot {
        nginx: tool(
            "nginx",
            &["-v"],
            "Instale o nginx pelo gerenciador de pacotes do sistema. Sem ele não há \
             proxy com senha, e compartilhar sem senha é publicar.",
        ),
        cloudflared: tool(
            "cloudflared",
            &["--version"],
            "Instale o cloudflared (https://developers.cloudflare.com/cloudflare-one/\
             connections/connect-networks/downloads/). Sem ele o alcance é só a rede local.",
        ),
        blocked_reason: if preview_url.is_none() {
            Some(
                "não há preview de pé: compartilhar expõe o que o preview do §4 serve, e sem \
                 ele não há o que mostrar a ninguém"
                    .to_string(),
            )
        } else {
            None
        },
        preview_url,
        active,
        lan_address: lan_address(),
    })
}

fn describe(runtime: &ShareRuntime) -> ActiveShare {
    ActiveShare {
        mode: runtime.mode,
        url: runtime.url.clone(),
        user: runtime.user.clone(),
        password: runtime.password.clone(),
        expires_at_epoch_secs: runtime.expires_at,
        warning: runtime.warning.clone(),
    }
}

/// Fecha o compartilhamento cujo prazo venceu.
///
/// O prazo é checado a cada leitura E por uma thread que acorda no vencimento:
/// só a thread deixaria o estado mentir se ela morresse; só a leitura deixaria
/// aberto enquanto ninguém olhasse a tela.
fn expire_if_due(root: &Path) {
    let key = root.display().to_string();
    let vencido = registry()
        .lock()
        .ok()
        .map(|map| {
            map.get(&key)
                .map(|runtime| runtime.expires_at <= now_secs())
                .unwrap_or(false)
        })
        .unwrap_or(false);
    if vencido {
        let _ = stop(root);
    }
}

/// Começa a compartilhar. `minutes` = 0 usa o prazo padrão.
pub fn start(root: &Path, mode: ShareMode, minutes: u64) -> Result<ShareSnapshot, String> {
    let estado = snapshot(root)?;
    if let Some(reason) = estado.blocked_reason {
        return Err(reason);
    }
    if estado.active.is_some() {
        return Err(
            "já existe um compartilhamento aberto: pare o atual antes de abrir outro — dois \
             endereços para a mesma coisa é o jeito de esquecer um deles aberto"
                .to_string(),
        );
    }
    if !estado.nginx.present {
        return Err(format!(
            "{} — {}",
            estado.nginx.detail,
            estado.nginx.remediation.unwrap_or_default()
        ));
    }
    if mode == ShareMode::Tunnel && !estado.cloudflared.present {
        return Err(format!(
            "{} — {}",
            estado.cloudflared.detail,
            estado.cloudflared.remediation.unwrap_or_default()
        ));
    }

    let preview_url = estado
        .preview_url
        .ok_or_else(|| "o preview não declarou URL".to_string())?;
    let preview_port = port_of(&preview_url).ok_or_else(|| {
        format!(
            "não dá para descobrir a porta do preview em {preview_url}: compartilhar \
                 precisa saber para onde apontar o proxy"
        )
    })?;
    let listen = free_port().ok_or_else(|| "nenhuma porta livre para o proxy".to_string())?;

    let dir = share_dir(root);
    for sub in ["", "body", "proxy", "fastcgi", "uwsgi", "scgi"] {
        fs::create_dir_all(dir.join(sub))
            .map_err(|error| format!("criar {}: {error}", dir.display()))?;
    }
    let user = "convidado".to_string();
    let password = generate_password()?;
    write_credentials(&dir, &user, &password)?;
    let config = dir.join("nginx.conf");
    fs::write(&config, nginx_config(listen, preview_port, &dir))
        .map_err(|error| format!("gravar {}: {error}", config.display()))?;

    let mut nginx = Command::new("nginx");
    nginx
        .args([
            "-c",
            &config.display().to_string(),
            "-p",
            &dir.display().to_string(),
        ])
        .stdout(Stdio::null())
        // O erro do nginx já vai para o `error_log` da configuração gerada. Um
        // pipe que ninguém lê enche e trava quem escreve nele — foi assim que o
        // túnel morreu (ver `start_tunnel`).
        .stderr(Stdio::null());
    // MASTER + WORKERS: sem grupo próprio, parar o master deixa os workers
    // segurando a porta. Medido com um GET de fora depois de clicar em "parar
    // de mostrar": a tela dizia fechado e o endereço respondia 401. Ver `proc`.
    crate::proc::own_group(&mut nginx);
    let proxy = nginx
        .spawn()
        .map_err(|error| format!("nginx não subiu: {error}"))?;

    let minutos = if minutes == 0 {
        DEFAULT_TTL_MINUTES
    } else {
        minutes
    };
    let (url, tunnel) = match mode {
        ShareMode::Lan => {
            let host = estado
                .lan_address
                .clone()
                .unwrap_or_else(|| "127.0.0.1".to_string());
            (format!("http://{host}:{listen}"), None)
        }
        ShareMode::Tunnel => {
            let (endereco, filho) = start_tunnel(listen, &dir)?;
            (endereco, Some(filho))
        }
    };

    let expires_at = now_secs() + minutos * 60;
    let warning = aviso(mode, &url, minutos);
    let key = root.display().to_string();
    registry()
        .lock()
        .map_err(|_| "registro de compartilhamento indisponível".to_string())?
        .insert(
            key,
            ShareRuntime {
                mode,
                url,
                user,
                password,
                expires_at,
                warning,
                proxy: Some(proxy),
                tunnel,
            },
        );

    // O prazo também fecha sozinho, sem ninguém olhar a tela.
    let alvo = root.to_path_buf();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(minutos * 60));
        let _ = stop(&alvo);
    });

    snapshot(root)
}

/// Sobe o túnel e espera o endereço aparecer no log do cloudflared.
///
/// O endereço não é escolhido por nós: um quick tunnel recebe um nome sorteado
/// pelo serviço, e ele só existe na saída do processo. Esperar por ele é a única
/// forma honesta — inventar a URL daria um link que não abre.
///
/// ── POR QUE O LOG É ARQUIVO, E NÃO PIPE ───────────────────────────────────
/// A primeira versão lia o stderr por um pipe e PARAVA de ler assim que achava a
/// URL. O `cloudflared` continua escrevendo log; com a ponta de leitura fechada,
/// ele levava SIGPIPE e morria segundos depois de subir. O sintoma foi exato: a
/// tela dizia "aberto na internet", o endereço não resolvia em DNS nenhum, e o
/// processo aparecia como `<defunct>`. Arquivo não fecha, não enche e ainda
/// deixa o log para quem precisar entender por que um túnel não subiu.
fn start_tunnel(local_port: u16, dir: &Path) -> Result<(String, Child), String> {
    let log_path = dir.join("cloudflared.log");
    let log = fs::File::create(&log_path)
        .map_err(|error| format!("criar {}: {error}", log_path.display()))?;
    let log_err = log
        .try_clone()
        .map_err(|error| format!("duplicar o log do túnel: {error}"))?;

    let mut comando = Command::new("cloudflared");
    comando
        .args([
            "tunnel",
            "--no-autoupdate",
            "--url",
            &format!("http://127.0.0.1:{local_port}"),
        ])
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    crate::proc::own_group(&mut comando);
    let mut filho = comando
        .spawn()
        .map_err(|error| format!("cloudflared não subiu: {error}"))?;

    let limite = Duration::from_secs(30);
    let passo = Duration::from_millis(250);
    let mut esperou = Duration::ZERO;
    while esperou < limite {
        if let Some(url) = url_no_log(&log_path) {
            return Ok((url, filho));
        }
        // Um túnel que já morreu não vai imprimir endereço nenhum.
        if matches!(filho.try_wait(), Ok(Some(_))) {
            return Err(format!(
                "cloudflared saiu antes de dar um endereço; o log está em \
                 {SHARE_REL}/cloudflared.log"
            ));
        }
        std::thread::sleep(passo);
        esperou += passo;
    }
    crate::proc::kill_tree(filho.id(), Duration::from_secs(3));
    let _ = filho.kill();
    Err(format!(
        "cloudflared não devolveu um endereço em 30s: o túnel não subiu, e um link inventado \
         não abriria. O log está em {SHARE_REL}/cloudflared.log"
    ))
}

/// O primeiro endereço `*.trycloudflare.com` que aparecer no log.
fn url_no_log(path: &Path) -> Option<String> {
    let texto = fs::read_to_string(path).ok()?;
    texto.lines().find_map(|linha| {
        let inicio = linha.find("https://")?;
        let url: String = linha[inicio..]
            .chars()
            .take_while(|c| !c.is_whitespace() && *c != '|')
            .collect();
        url.contains("trycloudflare.com").then_some(url)
    })
}

/// Fecha o compartilhamento: derruba o túnel e o proxy, nesta ordem.
///
/// ── DEFEITO MEDIDO COM UM GET DE FORA ─────────────────────────────────────
/// A primeira versão fazia `child.kill()`. O nginx é master + workers: o master
/// morria, os WORKERS continuavam segurando a porta, e a tela dizia "fechado"
/// enquanto o endereço exposto na rede seguia respondendo 401/200. É a mesma
/// falha que o preview do §4 já tinha pago com o `sh -c`, e é por isso que ela
/// virou o módulo `proc`: parar tem de derrubar a ÁRVORE e só voltar quando ela
/// morreu.
pub fn stop(root: &Path) -> Result<ShareSnapshot, String> {
    let key = root.display().to_string();
    if let Ok(mut map) = registry().lock() {
        if let Some(mut runtime) = map.remove(&key) {
            if let Some(mut tunnel) = runtime.tunnel.take() {
                crate::proc::kill_tree(tunnel.id(), Duration::from_secs(3));
                let _ = tunnel.kill();
                let _ = tunnel.wait();
            }
            if let Some(mut proxy) = runtime.proxy.take() {
                crate::proc::kill_tree(proxy.id(), Duration::from_secs(3));
                let _ = proxy.kill();
                let _ = proxy.wait();
            }
        }
    }
    // A senha some junto: ela valia para aquele compartilhamento e mais nada.
    let _ = fs::remove_file(share_dir(root).join("htpasswd"));
    snapshot(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A configuração é o contrato de segurança deste caminho, e o teste cobra
    /// item por item — inclusive numa máquina sem nginx instalado.
    #[test]
    fn a_configuracao_nega_arquivo_escondido_e_exige_senha() {
        let dir = tempfile::tempdir().expect("dir");

        let config = nginx_config(8099, 5173, dir.path());

        assert!(
            config.contains("auth_basic_user_file"),
            "sem senha, mandar o link para um amigo é o mesmo que publicar"
        );
        assert!(
            config.contains("location ~ /\\."),
            ".env e .git não podem sair daqui: um deles entrega credencial e histórico"
        );
        assert!(
            config.contains("proxy_pass http://127.0.0.1:5173"),
            "o que sai é o que o preview serve, por proxy — nunca a pasta do projeto"
        );
        assert!(config.contains("autoindex off;"));
        assert!(config.contains("listen 0.0.0.0:8099;"));
    }

    /// A senha protege um endereço público: ela não pode caber numa busca curta,
    /// e duas nunca podem sair iguais.
    #[test]
    fn a_senha_tem_128_bits_do_sistema_e_nao_se_repete() {
        let primeira = generate_password().expect("aleatoriedade");
        let segunda = generate_password().expect("aleatoriedade");

        assert_eq!(primeira.len(), 32, "16 bytes em hex");
        assert!(primeira.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(
            primeira, segunda,
            "senha derivada de relógio/PID repetiria dentro do mesmo instante"
        );
    }

    #[test]
    fn a_senha_fica_so_para_o_dono_do_arquivo() {
        let dir = tempfile::tempdir().expect("dir");

        write_credentials(dir.path(), "convidado", "segredo").expect("gravar");

        let conteudo = fs::read_to_string(dir.path().join("htpasswd")).expect("ler");
        assert!(conteudo.starts_with("convidado:{PLAIN}"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let modo = fs::metadata(dir.path().join("htpasswd"))
                .expect("meta")
                .permissions()
                .mode();
            assert_eq!(modo & 0o777, 0o600, "senha legível por outros não é senha");
        }
    }

    /// Sem preview de pé não há o que mostrar — e a recusa diz isso em vez de
    /// abrir uma porta para o nada.
    #[test]
    fn sem_preview_de_pe_nao_ha_o_que_compartilhar() {
        let dir = tempfile::tempdir().expect("dir");

        let estado = snapshot(dir.path()).expect("snapshot");
        assert!(estado.blocked_reason.is_some());

        let erro = start(dir.path(), ShareMode::Lan, 0).expect_err("deve recusar");
        assert!(erro.contains("preview"));
    }

    /// Os dois avisos dizem coisas diferentes porque o alcance é diferente. Um
    /// aviso genérico faria a pessoa ler o da rede local e achar que o túnel é
    /// igual.
    #[test]
    fn cada_modo_avisa_o_alcance_que_ele_realmente_tem() {
        let lan = aviso(ShareMode::Lan, "http://192.168.0.10:8099", 30);
        let tunel = aviso(ShareMode::Tunnel, "https://x.trycloudflare.com", 30);

        assert!(lan.contains("MESMA REDE"));
        assert!(lan.contains("texto claro"));
        assert!(tunel.contains("PÚBLICO na internet"));
        assert!(tunel.contains("seu computador é o servidor"));
        assert!(lan.contains("30 min") && tunel.contains("30 min"));
    }

    /// A PROVA COM NGINX DE VERDADE.
    ///
    /// Os outros testes deste módulo leem texto e recusas; este sobe o proxy,
    /// bate nele de fora e derruba. Foi exatamente aqui que os dois defeitos
    /// sérios moravam — a senha não valendo e o `stop` mentindo — e nenhum teste
    /// de texto os pegaria.
    ///
    /// Sem nginx na máquina, ele NÃO passa calado: cobra a recusa honesta, que é
    /// o que a pessoa veria. Um teste que some quando a ferramenta falta ensina
    /// que a ausência é normal.
    #[test]
    fn com_nginx_o_compartilhamento_sobe_pede_senha_e_fecha_de_verdade() {
        let dir = tempfile::tempdir().expect("dir");
        let root = dir.path();
        crate::project::register(root, "Lista", "Anotar itens e ver de dois telefones")
            .expect("registro");

        let tem_nginx = tool("nginx", &["-v"], "").present;

        // O "preview" deste teste é um servidor de verdade, em porta livre.
        let porta = free_port().expect("porta livre");
        std::fs::create_dir_all(root.join("publico")).expect("dir");
        std::fs::write(root.join("publico/index.html"), "<h1>ok</h1>").expect("index");
        std::fs::write(
            root.join(".instrument/preview.json"),
            format!(
                r#"{{"command": "python3 -m http.server {porta} --bind 127.0.0.1", "cwd": "publico", "url": "http://127.0.0.1:{porta}/"}}"#
            ),
        )
        .expect("preview.json");
        crate::preview::start(root).expect("preview sobe");
        // O servidor precisa estar atendendo antes de alguém apontar para ele.
        for _ in 0..40 {
            if std::net::TcpStream::connect(("127.0.0.1", porta)).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        let resultado = start(root, ShareMode::Lan, 30);
        if !tem_nginx {
            let erro = resultado.expect_err("sem nginx, compartilhar tem de recusar");
            assert!(erro.contains("nginx"));
            let _ = crate::preview::stop(root);
            return;
        }

        let aberto = resultado.expect("compartilhamento");
        let ativo = aberto.active.expect("ativo");
        let porta_proxy = port_of(&ativo.url).expect("porta do proxy");

        // Sem senha: recusado. Com senha: o que o preview serve. Escondido: 404.
        let sem = http_status(porta_proxy, "/", None);
        let com = http_status(
            porta_proxy,
            "/",
            Some(&format!("{}:{}", ativo.user, ativo.password)),
        );
        let escondido = http_status(
            porta_proxy,
            "/.git/config",
            Some(&format!("{}:{}", ativo.user, ativo.password)),
        );
        assert_eq!(
            sem,
            Some(401),
            "endereço exposto sem senha é endereço público"
        );
        assert_eq!(com, Some(200));
        assert_eq!(escondido, Some(404), ".env e .git não podem sair daqui");

        stop(root).expect("fechar");

        // O defeito que isto existe para pegar: o `stop` voltava dizendo
        // "fechado" com os workers do nginx ainda segurando a porta.
        let mut ainda = None;
        for _ in 0..20 {
            ainda = http_status(porta_proxy, "/", None);
            if ainda.is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(
            ainda, None,
            "depois de parar, a porta continuou atendendo — foi assim que a tela mentiu"
        );
        let _ = crate::preview::stop(root);
    }

    /// Um GET cru, sem depender de `curl` estar instalado no CI.
    #[cfg(test)]
    fn http_status(port: u16, path: &str, auth: Option<&str>) -> Option<u16> {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).ok()?;
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
        // Basic auth em base64, à mão: uma dependência a menos num teste.
        let cabecalho = match auth {
            Some(credencial) => format!("Authorization: Basic {}\r\n", base64(credencial)),
            None => String::new(),
        };
        let pedido = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n{cabecalho}\r\n"
        );
        stream.write_all(pedido.as_bytes()).ok()?;
        let mut resposta = String::new();
        let _ = stream.read_to_string(&mut resposta);
        resposta.split_whitespace().nth(1)?.parse().ok()
    }

    #[cfg(test)]
    fn base64(texto: &str) -> String {
        const TABELA: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let bytes = texto.as_bytes();
        let mut saida = String::new();
        for pedaco in bytes.chunks(3) {
            let b = [
                pedaco[0],
                *pedaco.get(1).unwrap_or(&0),
                *pedaco.get(2).unwrap_or(&0),
            ];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            for i in 0..4 {
                if i <= pedaco.len() {
                    saida.push(TABELA[((n >> (18 - 6 * i)) & 0x3f) as usize] as char);
                } else {
                    saida.push('=');
                }
            }
        }
        saida
    }

    #[test]
    fn a_porta_do_preview_sai_da_url_declarada() {
        assert_eq!(port_of("http://127.0.0.1:5173/health"), Some(5173));
        assert_eq!(port_of("http://localhost:8787"), Some(8787));
        assert_eq!(port_of("http://localhost/health"), None);
    }
}
