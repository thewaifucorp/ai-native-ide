//! O caminho de VOLTA de um compartilhamento (§16, LIFE-05).
//!
//! Mostrar para alguém já funcionava: o preview sai por um proxy com senha, na
//! rede local ou por um túnel. O que não existia era o retorno. Quem abria o
//! link via a coisa, achava o problema, e então tinha de sair do link e contar
//! por outro canal — WhatsApp, recado, memória. O que chegava ao projeto era a
//! LEMBRANÇA de quem recebeu o recado, não a observação de quem viu.
//!
//! Este módulo é o mínimo para fechar isso: um receptor HTTP local, que só
//! existe enquanto o compartilhamento existe, servido pelo MESMO nginx e atrás
//! da MESMA senha. Ele faz duas coisas e nada mais — mostra um formulário e
//! grava o que foi escrito.
//!
//! ── O QUE A OBSERVAÇÃO CARREGA ────────────────────────────────────────────
//! O texto sozinho envelhece rápido: "o botão não funciona" não diz de qual
//! versão se fala. Então cada observação nasce grudada na VERSÃO que estava
//! sendo mostrada e no endereço por onde foi vista. É isso que permite ligá-la
//! a um problema e republicar dizendo o que foi consertado, em vez de começar a
//! conversa do zero.
//!
//! ── POR QUE HTTP NA MÃO, SEM FRAMEWORK ────────────────────────────────────
//! O que este servidor precisa saber fazer cabe em duas rotas e um formulário.
//! Trazer um framework web para o sidecar traria também o runtime dele, a
//! superfície dele e as atualizações dele — para servir uma página de uma caixa
//! de texto. Ele escuta em 127.0.0.1, com porta efêmera, e quem alcança de fora
//! só alcança pelo nginx, que já pede senha.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Onde as observações ficam.
///
/// Ao lado do registro de versões (`.instrument/lifecycle`), que é justamente o
/// que cada observação referencia — separar as duas coisas faria a observação
/// apontar para uma versão guardada noutro lugar.
///
/// Consequência dita, não escondida: `.instrument/` é o diretório que o IDE
/// propõe ignorar no Git, então isto é local de quem compartilhou. É o certo
/// para observação de demo — ela vale enquanto vira o problema da próxima
/// versão — mas quem quiser levá-la para o time tem de tirá-la daqui.
const OBSERVATIONS_REL: &str = ".instrument/observations.json";

/// Um texto maior que isto não é observação, é upload. O corpo é lido com este
/// teto para uma conexão aberta não conseguir encher a memória da máquina.
const MAX_BODY_BYTES: usize = 16 * 1024;

/// O que alguém que viu a coisa devolveu.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub at_epoch_secs: u64,
    pub text: String,
    /// A versão que estava sendo mostrada quando isto foi escrito. `None`
    /// quando o projeto ainda não consolidou nenhuma — e aí a tela diz isso,
    /// em vez de inventar uma.
    pub version: Option<String>,
    /// `lan` ou `tunnel`: por onde a pessoa alcançou.
    pub via: String,
}

struct Running {
    stop: Arc<AtomicBool>,
}

fn running() -> &'static Mutex<Option<Running>> {
    static RUNNING: OnceLock<Mutex<Option<Running>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(None))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn observations_path(root: &Path) -> PathBuf {
    root.join(OBSERVATIONS_REL)
}

/// Tudo que já voltou, mais antigo primeiro. Arquivo ausente é lista vazia;
/// arquivo ilegível é erro, porque perder observação em silêncio é o defeito
/// que este módulo existe para não ter.
pub fn read(root: &Path) -> Result<Vec<Observation>, String> {
    let path = observations_path(root);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw =
        fs::read_to_string(&path).map_err(|error| format!("ler {}: {error}", path.display()))?;
    serde_json::from_str(&raw).map_err(|error| format!("{} inválido: {error}", path.display()))
}

fn append(root: &Path, observation: Observation) -> Result<(), String> {
    let mut all = read(root)?;
    all.push(observation);
    let path = observations_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("criar {}: {error}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(&all).map_err(|error| error.to_string())?;
    fs::write(&path, format!("{text}\n"))
        .map_err(|error| format!("gravar {}: {error}", path.display()))
}

/// Sobe o receptor e devolve a porta local que o nginx tem de apontar.
///
/// Devolve erro em vez de seguir sem receptor: um compartilhamento que promete
/// "deixe uma observação" e não tem para onde mandar é pior do que um que não
/// promete nada.
pub fn start(root: &Path, version: Option<String>, via: &str) -> Result<u16, String> {
    stop();
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("abrir o receptor de observações: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;

    let stop_flag = Arc::new(AtomicBool::new(false));
    let flag = stop_flag.clone();
    let root = root.to_path_buf();
    let via = via.to_string();
    std::thread::spawn(move || {
        while !flag.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _)) => {
                    // Uma conexão de cada vez: o volume aqui é uma pessoa
                    // escrevendo um parágrafo, não tráfego.
                    let _ = stream.set_nonblocking(false);
                    let _ = serve(stream, &root, version.as_deref(), &via);
                }
                Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(120));
                }
                Err(_) => break,
            }
        }
    });

    *running().lock().map_err(|_| "estado travado".to_string())? =
        Some(Running { stop: stop_flag });
    Ok(port)
}

/// Fecha o receptor. Chamado quando o compartilhamento fecha — o retorno não
/// pode continuar aberto depois que a coisa parou de ser mostrada.
pub fn stop() {
    if let Ok(mut guard) = running().lock() {
        if let Some(atual) = guard.take() {
            atual.stop.store(true, Ordering::Relaxed);
        }
    }
}

fn serve(
    mut stream: TcpStream,
    root: &Path,
    version: Option<&str>,
    via: &str,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();

    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some(valor) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = valor.trim().parse().unwrap_or(0);
        }
    }

    if method == "POST" {
        let mut body = vec![0u8; content_length.min(MAX_BODY_BYTES)];
        reader.read_exact(&mut body)?;
        let texto = campo(&String::from_utf8_lossy(&body), "texto");
        if texto.trim().is_empty() {
            return responder(
                &mut stream,
                200,
                &pagina_form(
                    version,
                    Some("escreva alguma coisa — vazio não é observação"),
                ),
            );
        }
        let gravado = append(
            root,
            Observation {
                at_epoch_secs: now_secs(),
                text: texto.trim().to_string(),
                version: version.map(str::to_string),
                via: via.to_string(),
            },
        );
        return match gravado {
            Ok(()) => responder(&mut stream, 200, &pagina_obrigado(version)),
            // O erro aparece para quem escreveu. Dizer "obrigado" sobre uma
            // gravação que falhou é a mentira mais cara deste caminho: a pessoa
            // acha que contou, e ninguém do outro lado sabe de nada.
            Err(erro) => responder(
                &mut stream,
                500,
                &pagina_form(version, Some(&format!("não deu para guardar: {erro}"))),
            ),
        };
    }

    responder(&mut stream, 200, &pagina_form(version, None))
}

/// Um campo de `application/x-www-form-urlencoded`, decodificado.
fn campo(body: &str, nome: &str) -> String {
    body.split('&')
        .find_map(|par| par.split_once('=').filter(|(k, _)| *k == nome))
        .map(|(_, v)| percent_decode(v))
        .unwrap_or_default()
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut saida = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                saida.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        saida.push(byte);
                        i += 3;
                    }
                    Err(_) => {
                        saida.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            outro => {
                saida.push(outro);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&saida).into_owned()
}

/// Escapa o que vai para dentro do HTML. O texto vem de fora; sem isto, quem
/// escrever a observação escolhe o que a página faz.
fn escapar(raw: &str) -> String {
    raw.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn versao_dita(version: Option<&str>) -> String {
    match version {
        Some(v) => format!("sobre a versão <b>{}</b>", escapar(v)),
        None => "este projeto ainda não consolidou nenhuma versão — a observação fica sem versão, \
                 e a tela do dono vai dizer isso"
            .to_string(),
    }
}

fn pagina_form(version: Option<&str>, erro: Option<&str>) -> String {
    let aviso = erro
        .map(|e| format!("<p class=\"erro\">{}</p>", escapar(e)))
        .unwrap_or_default();
    format!(
        r#"<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deixar uma observação</title>
<style>
body{{font:16px/1.5 system-ui,sans-serif;margin:0;padding:2rem;background:#111;color:#eee}}
main{{max-width:34rem;margin:0 auto}}
textarea{{width:100%;min-height:9rem;font:inherit;padding:.75rem;border-radius:.5rem;
border:1px solid #444;background:#1a1a1a;color:inherit}}
button{{margin-top:1rem;font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:0;
background:#4a7;color:#062;font-weight:600;cursor:pointer}}
.erro{{color:#f88}} small{{color:#999;display:block;margin-top:1rem}}
</style></head><body><main>
<h1>O que você viu?</h1>
<p>{versao}</p>
{aviso}
<form method="post" action="">
<textarea name="texto" autofocus placeholder="o que aconteceu, e o que você esperava"></textarea>
<button type="submit">Mandar para quem fez</button>
</form>
<small>isto vai direto para o projeto de quem compartilhou o link, junto com a versão
que você está vendo. Nada mais é coletado.</small>
</main></body></html>"#,
        versao = versao_dita(version),
        aviso = aviso
    )
}

fn pagina_obrigado(version: Option<&str>) -> String {
    format!(
        r#"<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recebido</title>
<style>body{{font:16px/1.5 system-ui,sans-serif;margin:0;padding:2rem;background:#111;color:#eee}}
main{{max-width:34rem;margin:0 auto}} a{{color:#6cf}}</style></head><body><main>
<h1>Chegou.</h1>
<p>Sua observação foi guardada no projeto, {versao}.</p>
<p><a href="">Escrever outra</a> · <a href="/">Voltar para o app</a></p>
</main></body></html>"#,
        versao = versao_dita(version)
    )
}

fn responder(stream: &mut TcpStream, status: u16, corpo: &str) -> std::io::Result<()> {
    let texto = match status {
        200 => "OK",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let resposta = format!(
        "HTTP/1.1 {status} {texto}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{corpo}",
        corpo.len()
    );
    stream.write_all(resposta.as_bytes())?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Só existe UM receptor por vez, de propósito: só existe um
    /// compartilhamento por vez. Isso é contrato, não limitação de teste — mas
    /// faz dois testes em paralelo derrubarem o receptor um do outro, então eles
    /// se revezam aqui.
    fn sozinho() -> std::sync::MutexGuard<'static, ()> {
        static TURNO: OnceLock<Mutex<()>> = OnceLock::new();
        TURNO
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|envenenado| envenenado.into_inner())
    }

    fn pedir(port: u16, raw: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("conectar");
        stream.write_all(raw.as_bytes()).expect("enviar");
        let mut resposta = String::new();
        stream.read_to_string(&mut resposta).expect("ler");
        resposta
    }

    /// A prova que interessa: alguém de fora escreve, e o texto chega ao projeto
    /// COM a versão que estava sendo mostrada. Sem a versão, a observação vira
    /// um recado solto, que é exatamente o que existia antes deste módulo.
    #[test]
    fn a_observacao_chega_grudada_na_versao_mostrada() {
        let _turno = sozinho();
        let dir = tempfile::tempdir().expect("dir");
        let root = dir.path();

        let port = start(root, Some("v0.2.0".to_string()), "tunnel").expect("subir");

        let form = pedir(
            port,
            "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
        );
        assert!(
            form.contains("v0.2.0"),
            "o formulário diz de qual versão se fala"
        );

        let corpo = "texto=o+bot%C3%A3o+de+salvar+n%C3%A3o+faz+nada";
        let resposta = pedir(
            port,
            &format!(
                "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{corpo}",
                corpo.len()
            ),
        );
        assert!(resposta.contains("Chegou"), "quem escreveu vê que chegou");

        let guardadas = read(root).expect("ler");
        assert_eq!(guardadas.len(), 1);
        assert_eq!(guardadas[0].text, "o botão de salvar não faz nada");
        assert_eq!(guardadas[0].version.as_deref(), Some("v0.2.0"));
        assert_eq!(guardadas[0].via, "tunnel");

        stop();
    }

    /// Observação vazia não é observação, e gravar uma linha em branco faria a
    /// lista do dono encher de nada.
    #[test]
    fn texto_vazio_nao_vira_observacao() {
        let _turno = sozinho();
        let dir = tempfile::tempdir().expect("dir");
        let root = dir.path();
        let port = start(root, None, "lan").expect("subir");

        let corpo = "texto=%20%20";
        let resposta = pedir(
            port,
            &format!(
                "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{corpo}",
                corpo.len()
            ),
        );
        assert!(resposta.contains("vazio não é observação"));
        assert!(read(root).expect("ler").is_empty());

        stop();
    }

    /// O texto vem de fora. Sem escapar, quem escreve a observação escolhe o que
    /// a página do dono — e a de quem escrever depois — executa.
    #[test]
    fn texto_de_fora_nao_vira_html() {
        assert_eq!(
            escapar("<script>alert(1)</script>"),
            "&lt;script&gt;alert(1)&lt;/script&gt;"
        );
        assert!(versao_dita(Some("<b>x")).contains("&lt;b&gt;x"));
    }
}
