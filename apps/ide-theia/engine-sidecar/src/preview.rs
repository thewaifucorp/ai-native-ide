//! §4 — the preview: supervising the process the project declares for itself.
//!
//! `ide_reconciliation` is shell-neutral the same way `ide_harness` is: it owns
//! the preview lifecycle (which health transitions are legal, when a fact becomes
//! evidence) and it never spawns a process or opens a socket. So the other half —
//! actually starting the command, watching it die, probing the URL — is this
//! module's job, and it is the only place in the preview path allowed to touch
//! the operating system.
//!
//! # Where the preview comes from
//!
//! Declared, never detected, in `.instrument/preview.json`:
//!
//! ```json
//! {
//!   "command": "node src/server.ts",
//!   "cwd": "apps/web",
//!   "url": "http://127.0.0.1:8787/health",
//!   "readyTimeoutMs": 15000
//! }
//! ```
//!
//! Same reason §4's checks are declared: guessing "this looks like a dev server"
//! would have the IDE start a process nobody wrote down. §5 detects `start`
//! scripts WITH provenance and can propose this file; it does not write it.
//!
//! # What the engine refuses to let this module claim
//!
//! Two refusals come from `ide_reconciliation` itself and are load-bearing here:
//!
//!  * A **clean exit is not a failure.** `record_nonzero_process_exit` rejects
//!    exit code 0, so a command that simply finished cannot be dressed up as a
//!    broken preview. It still moves the state off `healthy` — with the honest
//!    detail that the process ended on its own.
//!  * A **failure needs causal links.** Every recorded failure points at the
//!    declaration and the log that produced it; there is no path here that
//!    records a message with nothing behind it.
//!
//! And one refusal of this module's own: a health probe that cannot even be
//! attempted (an `https://` URL the raw probe does not speak) is reported as
//! exactly that. It never counts as healthy, and it never counts as a failure of
//! the project either — it is a limit of the prober, and it says so.

use ide_reconciliation::{
    CausalLinks, PreviewEvidenceLedger, PreviewFailure, PreviewHealth, PreviewHealthCheck,
    PreviewHealthCheckObservation, PreviewProcessExit, PreviewState, PreviewSupervisor,
};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Relative path of the declaration, and of the log the supervisor writes.
const DECLARATION_REL: &str = ".instrument/preview.json";
const LOG_REL: &str = ".instrument/preview.log";

/// How long a start waits for the first healthy answer before giving up.
const DEFAULT_READY_TIMEOUT_MS: u64 = 15_000;

/// Gap between health probes while waiting for the first healthy answer.
const PROBE_INTERVAL_MS: u64 = 300;

/// Socket budgets. Small on purpose: a preview that needs more than this to
/// answer its own health URL is not healthy yet, and saying so early beats
/// blocking the sidecar.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(1_500);
const READ_TIMEOUT: Duration = Duration::from_millis(2_000);

/// How much of the preview log is kept as evidence.
const MAX_LOG_TAIL: usize = 600;

/// One declared preview, as read from `.instrument/preview.json`.
#[derive(Debug, Clone, serde::Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredPreview {
    pub command: String,
    #[serde(default)]
    pub cwd: Option<String>,
    /// Health URL. Absent means there is nothing to probe, and the preview can
    /// only ever be reported as `starting` while the process is alive — never
    /// `healthy`, which would be a claim nobody measured.
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub ready_timeout_ms: Option<u64>,
}

/// What the panel needs to render the preview honestly.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapshot {
    /// The declaration, or `None` when the project declares no preview.
    pub declared: Option<DeclaredPreview>,
    /// Why there is no declaration (or why the file could not be read).
    pub not_declared_reason: Option<String>,
    /// `None` until a start was asked for: not started is not broken.
    pub state: Option<PreviewState>,
    /// True while the child process is alive.
    pub running: bool,
    /// Set once someone stopped it, so "broken" is not read as a crash.
    pub stopped: bool,
    /// Failures recorded by the engine's ledger, newest last.
    pub failures: Vec<PreviewFailure>,
    /// Last probe attempt, verbatim: the URL and what came back.
    pub last_probe: Option<String>,
    /// Tail of the process log, when there is one.
    pub log_tail: Option<String>,
    pub log_path: Option<String>,
}

/// Live runtime for one project root. Kept in a process-wide registry because a
/// preview outlives the request that started it.
struct PreviewRuntime {
    supervisor: PreviewSupervisor,
    child: Option<Child>,
    ledger: PreviewEvidenceLedger,
    /// Ids in the order they were recorded — the ledger is keyed, not ordered.
    failure_ids: Vec<String>,
    seq: u64,
    stopped: bool,
    last_probe: Option<String>,
}

type Registry = Mutex<HashMap<String, PreviewRuntime>>;

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Reads `.instrument/preview.json`.
///
/// A file that exists but cannot be parsed is reported as such: "no preview
/// declared" and "the declaration is broken" look identical on a panel and mean
/// opposite things.
fn read_declaration(root: &Path) -> (Option<DeclaredPreview>, Option<String>) {
    let path = root.join(DECLARATION_REL);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return (
            None,
            Some(format!(
                "nenhum preview declarado em {DECLARATION_REL} — nada foi iniciado"
            )),
        );
    };
    match serde_json::from_str::<DeclaredPreview>(&raw) {
        Ok(parsed) if parsed.command.trim().is_empty() => (
            None,
            Some(format!(
                "{DECLARATION_REL} existe mas não declara comando — nada foi iniciado"
            )),
        ),
        Ok(parsed) => (Some(parsed), None),
        Err(error) => (
            None,
            Some(format!(
                "{DECLARATION_REL} existe mas não pôde ser lido ({error}) — nada foi iniciado"
            )),
        ),
    }
}

/// Outcome of one raw HTTP probe.
#[derive(Debug)]
enum Probe {
    /// The endpoint answered with a status the prober accepts.
    Healthy(String),
    /// The endpoint answered, or refused, in a way that is a real failure.
    Failed(String),
    /// The probe could not be attempted at all. NOT a project failure, and not
    /// health either — a stated limit of this prober.
    Unsupported(String),
}

/// Raw HTTP GET, no dependency, no redirects, no TLS.
///
/// TLS is deliberately absent rather than faked: a preview on `https://` is
/// reported as unprobeable instead of being guessed at from a TCP handshake.
fn probe(url: &str) -> Probe {
    let rest = match url.strip_prefix("http://") {
        Some(rest) => rest,
        None if url.starts_with("https://") => {
            return Probe::Unsupported(format!(
                "a sonda de saúde só fala http:// — {url} não foi consultada"
            ))
        }
        None => {
            return Probe::Unsupported(format!(
                "url de saúde sem esquema http:// — {url} não foi consultada"
            ))
        }
    };
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    if authority.is_empty() {
        return Probe::Unsupported(format!("url de saúde sem host — {url} não foi consultada"));
    }
    let with_port = if authority.contains(':') {
        authority.to_string()
    } else {
        format!("{authority}:80")
    };
    let host = authority.split(':').next().unwrap_or(authority);

    let Ok(mut addrs) = with_port.to_socket_addrs() else {
        return Probe::Failed(format!("{url}: host não resolveu"));
    };
    let Some(addr) = addrs.next() else {
        return Probe::Failed(format!("{url}: host não resolveu"));
    };
    let mut stream = match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
        Ok(stream) => stream,
        Err(error) => return Probe::Failed(format!("{url}: {error}")),
    };
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\
         User-Agent: instrument-preview\r\nAccept: */*\r\n\r\n"
    );
    if let Err(error) = stream.write_all(request.as_bytes()) {
        return Probe::Failed(format!("{url}: {error}"));
    }
    let mut buffer = [0u8; 512];
    let read = match stream.read(&mut buffer) {
        Ok(0) => return Probe::Failed(format!("{url}: conexão fechada sem resposta")),
        Ok(read) => read,
        Err(error) => return Probe::Failed(format!("{url}: {error}")),
    };
    let head = String::from_utf8_lossy(&buffer[..read]);
    let status_line = head.lines().next().unwrap_or("").trim().to_string();
    let code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok());
    match code {
        // ── RESPONDER NÃO É ESTAR SAUDÁVEL ──────────────────────────────────
        // Antes, qualquer status que não fosse 5xx contava como saudável, "porque
        // o servidor respondeu". Achado num projeto cru: a url de saúde declarada
        // era `/`, o app só serve `/itens`, e o painel mostrava
        // "SAUDÁVEL · HTTP/1.1 404 Not Found" — uma contradição na mesma linha, e
        // exatamente o tipo de saúde inventada que o §4 existe para não fazer.
        //
        // 2xx e 3xx são a url declarada funcionando. 4xx é o servidor dizendo que
        // ela NÃO existe — o processo está de pé, e é isso que a mensagem diz, sem
        // chamar de saúde.
        Some(code) if code >= 500 => Probe::Failed(format!("{url}: {status_line}")),
        Some(code) if code >= 400 => Probe::Failed(format!(
            "{url}: {status_line} — o processo respondeu, mas a url declarada como saúde não \
             existe nele; corrija a url em {DECLARATION_REL} ou a rota no projeto"
        )),
        Some(_) => Probe::Healthy(format!("{url}: {status_line}")),
        None => Probe::Failed(format!("{url}: resposta sem linha de status")),
    }
}

/// Last `MAX_LOG_TAIL` characters of the preview log, on a char boundary.
/// Onde as falhas observadas ficam depois que o processo que as produziu morreu.
const OBSERVED_REL: &str = ".instrument/observed.jsonl";

/// Quantas observações o arquivo guarda antes de descartar as mais antigas.
const OBSERVED_CAP: usize = 1000;

/// Acrescenta uma falha observada ao histórico do projeto.
///
/// ── POR QUE ISTO EXISTE ───────────────────────────────────────────────────
/// As observações vinham só do runtime em memória. Então observar uma falha,
/// reiniciar o preview para tentar consertar, e voltar para reconciliar deixava
/// "0 comportamento observado" — a evidência sumia junto com o processo, e a
/// decisão que tinha sido tomada citava um id que já não existia. Evidência tem
/// de sobreviver ao processo que a produziu, senão a reconciliação do §4 só vale
/// dentro de uma execução.
///
/// Falha ao gravar NÃO derruba o preview: perder o histórico é ruim, deixar de
/// subir o projeto por causa do histórico é pior. O erro volta como recusa do
/// ledger, que é onde as recusas já aparecem.
fn append_observed(root: &Path, failure: &PreviewFailure) -> Option<String> {
    let file = root.join(OBSERVED_REL);
    if let Some(parent) = file.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            return Some(error.to_string());
        }
    }
    let line = match serde_json::to_string(failure) {
        Ok(line) => line,
        Err(error) => return Some(error.to_string()),
    };
    let mut linhas: Vec<String> = std::fs::read_to_string(&file)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .filter(|l| !l.trim().is_empty())
        .collect();
    linhas.push(line);
    // Corta as mais antigas. O corte é registrado no próprio arquivo pela
    // ausência: quem lê recebe `descartadas` contado na leitura, e a tela diz.
    let descartadas = linhas.len().saturating_sub(OBSERVED_CAP);
    if descartadas > 0 {
        linhas.drain(0..descartadas);
    }
    match std::fs::write(&file, format!("{}\n", linhas.join("\n"))) {
        Ok(()) => None,
        Err(error) => Some(error.to_string()),
    }
}

/// As falhas que este projeto já observou, incluindo execuções anteriores.
fn observed_history(root: &Path) -> Vec<PreviewFailure> {
    std::fs::read_to_string(root.join(OBSERVED_REL))
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<PreviewFailure>(line).ok())
        .collect()
}

/// A linha do log que explica uma morte precoce, citada literalmente.
///
/// Prefere a primeira linha que se parece com um erro; sem nenhuma, usa a última
/// linha não vazia. Nunca reescreve, nunca interpreta: cortar em 200 caracteres é
/// o único tratamento, e o corte é marcado.
fn decisive_log_line(root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(root.join(LOG_REL)).ok()?;
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    const PISTAS: [&str; 8] = [
        "Error",
        "error:",
        "Cannot find",
        "not found",
        "EADDRINUSE",
        "Permission denied",
        "command not found",
        "Traceback",
    ];
    let escolhida = lines
        .iter()
        .find(|line| PISTAS.iter().any(|pista| line.contains(pista)))
        .or_else(|| lines.last())?;
    let mut cortada: String = escolhida.chars().take(200).collect();
    if escolhida.chars().count() > 200 {
        cortada.push('…');
    }
    Some(cortada)
}

fn log_tail(root: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(root.join(LOG_REL)).ok()?;
    let trimmed = raw.trim_end();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() <= MAX_LOG_TAIL {
        return Some(trimmed.to_string());
    }
    let mut start = trimmed.len() - MAX_LOG_TAIL;
    while start < trimmed.len() && !trimmed.is_char_boundary(start) {
        start += 1;
    }
    Some(format!("…{}", &trimmed[start..]))
}

impl PreviewRuntime {
    fn links() -> CausalLinks {
        CausalLinks {
            effect_ids: Vec::new(),
            activity_ids: Vec::new(),
            file_paths: vec![DECLARATION_REL.to_string(), LOG_REL.to_string()],
        }
    }

    /// Id of one recorded failure, unique to the OCCURRENCE.
    ///
    /// The observation timestamp is part of it on purpose. A per-session counter
    /// alone restarts at 1, so a decision taken about yesterday's failure would
    /// silently attach to today's — the reconciliation store keys decisions by
    /// divergence id, and the divergence id is built from this one. An exception
    /// accepted for a failure somebody looked at must not quietly cover the next
    /// one that happens to have the same shape.
    fn next_id(&mut self, kind: &str) -> (String, String) {
        // Process-wide counter, not per-runtime: a restarted preview gets a fresh
        // runtime, and a counter that restarted with it could repeat an id inside
        // the same millisecond.
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        self.seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        let at = now_ms();
        (
            format!("preview-failure:{kind}:{at}:{}", self.seq),
            format!("evidence:{LOG_REL}#{at}:{}", self.seq),
        )
    }

    /// Records a non-zero exit. A clean exit is refused by the engine, and that
    /// refusal is reported rather than worked around.
    fn record_exit(&mut self, root: &Path, exit_code: i32, detail: &str) -> Option<String> {
        let (id, evidence_id) = self.next_id("exit");
        let exit = PreviewProcessExit {
            id: id.clone(),
            preview_id: "preview".to_string(),
            evidence_id,
            process_id: "preview-child".to_string(),
            exit_code,
            message: detail.to_string(),
            causal_links: Self::links(),
            observed_at_ms: now_ms(),
        };
        match self.ledger.record_nonzero_process_exit(exit) {
            Ok(_) => {
                self.failure_ids.push(id.clone());
                // A evidência tem de sobreviver ao processo: ver `append_observed`.
                self.ledger
                    .failure(&id)
                    .cloned()
                    .and_then(|failure| append_observed(root, &failure))
            }
            Err(error) => Some(error.to_string()),
        }
    }

    fn record_health_failure(&mut self, root: &Path, url: &str, detail: &str) -> Option<String> {
        let (id, evidence_id) = self.next_id("health");
        let check = PreviewHealthCheck {
            id: id.clone(),
            preview_id: "preview".to_string(),
            evidence_id,
            url: url.to_string(),
            observation: PreviewHealthCheckObservation::Failed {
                detail: detail.to_string(),
            },
            causal_links: Self::links(),
            observed_at_ms: now_ms(),
        };
        match self.ledger.record_failed_health_check(check) {
            Ok(_) => {
                self.failure_ids.push(id.clone());
                self.ledger
                    .failure(&id)
                    .cloned()
                    .and_then(|failure| append_observed(root, &failure))
            }
            Err(error) => Some(error.to_string()),
        }
    }

    /// Moves the supervisor, tolerating a transition the engine calls illegal.
    ///
    /// The engine is the authority on the lifecycle; a host that "fixed" a
    /// refused transition by overwriting the state would be inventing one. So a
    /// refusal is kept as the state's detail instead.
    fn move_to(&mut self, next: PreviewHealth, detail: Option<String>) {
        if self.supervisor.state().health == next {
            // Same health: only the detail is news, and the engine rejects
            // self-transitions on purpose.
            return;
        }
        if let Err(error) = self.supervisor.transition(next, now_ms(), detail) {
            self.last_probe = Some(format!("transição recusada pelo motor: {error}"));
        }
    }

    fn failures(&self) -> Vec<PreviewFailure> {
        self.failure_ids
            .iter()
            .filter_map(|id| self.ledger.failure(id).cloned())
            .collect()
    }

    /// `Some(exit_code)` when the child is gone, `None` while it is alive.
    fn child_exit(&mut self) -> Option<Option<i32>> {
        let child = self.child.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => Some(status.code()),
            Ok(None) => None,
            // An unwaitable child is not a live one; treat it as gone with an
            // unknown code rather than reporting a running preview.
            Err(_) => Some(None),
        }
    }
}

/// Starts the declared preview and waits for its first honest verdict.
///
/// Blocking on purpose (spawn, sleep, socket): the caller runs it off the async
/// worker, exactly like the §4 checks.
pub fn start(root: &Path) -> Result<PreviewSnapshot, String> {
    let (declared, reason) = read_declaration(root);
    let Some(declaration) = declared else {
        return Err(reason.unwrap_or_else(|| format!("{DECLARATION_REL} não pôde ser lido")));
    };

    let key = root.to_string_lossy().into_owned();
    {
        let mut map = registry().lock().map_err(|e| e.to_string())?;
        if let Some(existing) = map.get_mut(&key) {
            if existing.child_exit().is_none() && existing.child.is_some() && !existing.stopped {
                // Already running: starting twice would leak a process and lie
                // about which one the panel is showing.
                return Ok(snapshot_from(root, Some(existing), Some(declaration), None));
            }
            map.remove(&key);
        }
    }

    let cwd = match &declaration.cwd {
        Some(rel) => root.join(rel),
        None => root.to_path_buf(),
    };
    let log_path = root.join(LOG_REL);
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;

    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(&declaration.command)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    // O comando declarado roda sob um `sh`, então o processo do servidor é NETO
    // deste sidecar. Num grupo próprio, `stop` consegue derrubar a árvore
    // inteira; sem isso, matar o `sh` deixa o servidor vivo (ver `stop`).
    #[cfg(unix)]
    command.process_group(0);
    let child = command
        .spawn()
        .map_err(|error| format!("`{}` não pôde ser iniciado: {error}", declaration.command))?;

    let mut runtime = PreviewRuntime {
        supervisor: PreviewSupervisor::starting(now_ms()),
        child: Some(child),
        ledger: PreviewEvidenceLedger::default(),
        failure_ids: Vec::new(),
        seq: 0,
        stopped: false,
        last_probe: None,
    };

    let timeout = declaration
        .ready_timeout_ms
        .unwrap_or(DEFAULT_READY_TIMEOUT_MS);
    let deadline = now_ms() + timeout;
    let mut ledger_refusal: Option<String> = None;

    loop {
        // The process dying is the strongest fact available; check it first.
        if let Some(code) = runtime.child_exit() {
            let code_shown = code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "encerrado por sinal".to_string());
            // A causa fica no log, e "código 1" não é causa.
            //
            // Achado subindo um projeto cru sem `node_modules`: a tela dizia
            // "`npm run start` terminou (código 1) antes de responder" e o motivo
            // real — `Cannot find module 'express'` — ficava atrás de um clique,
            // dentro da saída crua. A linha decisiva vem verbatim na mensagem, e
            // dita como o que é: uma linha do log, não um diagnóstico do IDE.
            let detail = match decisive_log_line(root) {
                Some(line) => format!(
                    "`{}` terminou (código {code_shown}) antes de responder · log: {line}",
                    declaration.command
                ),
                None => format!(
                    "`{}` terminou (código {code_shown}) antes de responder",
                    declaration.command
                ),
            };
            match code {
                Some(0) => {
                    // A clean exit is not evidence of failure — the engine says
                    // so — but it is not a running preview either.
                    runtime.move_to(
                        PreviewHealth::Broken,
                        Some(format!(
                            "`{}` terminou sozinho com código 0 — não é falha, mas também não há \
                             preview de pé",
                            declaration.command
                        )),
                    );
                }
                other => {
                    ledger_refusal = runtime
                        .record_exit(root, other.unwrap_or(-1), &detail)
                        .or(ledger_refusal);
                    runtime.move_to(PreviewHealth::Broken, Some(detail));
                }
            }
            break;
        }

        match declaration.url.as_deref() {
            None => {
                // Nothing to probe. The process is alive and that is all anyone
                // knows: `starting` stands, and it says why it cannot become
                // healthy.
                runtime.last_probe = Some(format!(
                    "{DECLARATION_REL} não declara url — sem sonda, o preview nunca passa de \
                     iniciando"
                ));
                break;
            }
            Some(url) => match probe(url) {
                Probe::Healthy(detail) => {
                    runtime.last_probe = Some(detail.clone());
                    runtime.move_to(PreviewHealth::Healthy, Some(detail));
                    break;
                }
                Probe::Unsupported(detail) => {
                    // A limit of the prober is not a verdict about the project.
                    runtime.last_probe = Some(detail);
                    break;
                }
                Probe::Failed(detail) => {
                    runtime.last_probe = Some(detail.clone());
                    if now_ms() >= deadline {
                        ledger_refusal = runtime
                            .record_health_failure(root, url, &detail)
                            .or(ledger_refusal);
                        runtime.move_to(
                            PreviewHealth::Broken,
                            Some(format!(
                                "sem resposta saudável em {timeout} ms — última tentativa: {detail}"
                            )),
                        );
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(PROBE_INTERVAL_MS));
                }
            },
        }
    }

    let mut map = registry().lock().map_err(|e| e.to_string())?;
    map.insert(key.clone(), runtime);
    let runtime = map.get_mut(&key);
    Ok(snapshot_from(
        root,
        runtime,
        Some(declaration),
        ledger_refusal,
    ))
}

/// Re-reads the preview: is the child still alive, does the URL still answer.
///
/// Never starts anything. A project with no preview running comes back with
/// `state: null` — not started is a different fact from broken.
pub fn status(root: &Path) -> Result<PreviewSnapshot, String> {
    let (declared, reason) = read_declaration(root);
    let key = root.to_string_lossy().into_owned();
    let mut map = registry().lock().map_err(|e| e.to_string())?;
    let Some(runtime) = map.get_mut(&key) else {
        return Ok(PreviewSnapshot {
            declared,
            not_declared_reason: reason,
            state: None,
            running: false,
            stopped: false,
            failures: Vec::new(),
            last_probe: None,
            log_tail: log_tail(root),
            log_path: Some(LOG_REL.to_string()),
        });
    };

    let mut refusal: Option<String> = None;
    if !runtime.stopped {
        if let Some(code) = runtime.child_exit() {
            let code_shown = code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "encerrado por sinal".to_string());
            let detail = format!("o processo do preview terminou (código {code_shown})");
            if code != Some(0) {
                refusal = runtime.record_exit(root, code.unwrap_or(-1), &detail);
            }
            // The last probe now describes a process that no longer exists. Left
            // unlabelled next to a broken state it reads as a contradiction —
            // "HTTP/1.1 200 OK" under "quebrado" — so it is marked as being from
            // before the death. This branch runs once: the child is cleared here.
            runtime.last_probe = runtime
                .last_probe
                .take()
                .map(|probe| format!("antes de terminar: {probe}"));
            runtime.child = None;
            runtime.move_to(PreviewHealth::Broken, Some(detail));
        } else if let Some(url) = declared.as_ref().and_then(|d| d.url.as_deref()) {
            match probe(url) {
                Probe::Healthy(detail) => {
                    runtime.last_probe = Some(detail.clone());
                    runtime.move_to(PreviewHealth::Healthy, Some(detail));
                }
                Probe::Unsupported(detail) => runtime.last_probe = Some(detail),
                Probe::Failed(detail) => {
                    runtime.last_probe = Some(detail.clone());
                    // A preview that WAS healthy and stopped answering is stale,
                    // not broken: the engine keeps those apart, and `stale` is
                    // the state that can still recover.
                    let next = if runtime.supervisor.state().health == PreviewHealth::Healthy {
                        PreviewHealth::Stale
                    } else {
                        PreviewHealth::Broken
                    };
                    refusal = runtime.record_health_failure(root, url, &detail);
                    runtime.move_to(next, Some(detail));
                }
            }
        }
    }

    Ok(snapshot_from(root, Some(runtime), declared, refusal))
}

/// Stops the preview, if one is running.
///
/// The state is kept (with `stopped: true`) instead of erased, so the failures
/// recorded while it ran stay inspectable and "broken" is not misread as a crash.
/// Para o preview e sobe de novo, na mesma chamada.
///
/// Existe porque o botão da UI dizia "Reiniciar" e chamava `start`, e `start`,
/// vendo o filho vivo, devolve o runtime existente. O clique não fazia nada: o
/// processo velho seguia de pé e o painel mostrava a saúde DELE. Quem tinha
/// acabado de mudar o código lia "SAUDÁVEL" do código antigo — o preview
/// respondendo por um processo que não é o que a pessoa pensa que é.
pub fn restart(root: &Path) -> Result<PreviewSnapshot, String> {
    // `stop` espera o filho ser recolhido antes de voltar, então a porta já
    // está livre aqui: o `start` seguinte sobe processo novo, não reaproveita.
    let _ = stop(root)?;
    start(root)
}

pub fn stop(root: &Path) -> Result<PreviewSnapshot, String> {
    let (declared, _) = read_declaration(root);
    let key = root.to_string_lossy().into_owned();
    let mut map = registry().lock().map_err(|e| e.to_string())?;
    let Some(runtime) = map.get_mut(&key) else {
        return status_unstarted(root, declared);
    };
    if let Some(child) = runtime.child.as_mut() {
        // ── DEFEITO QUE A JORNADA DO §12 ACHOU ──────────────────────────────
        // `child` é o `sh -c`; quem escuta a porta é o processo que ELE criou.
        // Matar só o `sh` deixava o servidor vivo — e a consequência não era
        // "sobrou processo": a próxima execução do preview sondava o ZUMBI e o
        // via saudável. Um preview que reporta a saúde de outro processo é pior
        // do que um preview quebrado.
        //
        // Com o grupo próprio criado no `start`, o sinal vai para a árvore toda.
        #[cfg(unix)]
        {
            // O sinal só pode ir para o grupo se o filho for LÍDER do próprio
            // grupo. Sem esta checagem, um filho que herdou o grupo do pai faz
            // `kill -- -pid` acertar o grupo de quem iniciou o sidecar — ou
            // seja, derruba o terminal e o backend do IDE junto. Aconteceu.
            let pid = child.id() as i32;
            let leader = Command::new("ps")
                .args(["-o", "pgid=", "-p", &pid.to_string()])
                .output()
                .ok()
                .and_then(|out| String::from_utf8(out.stdout).ok())
                .and_then(|text| text.trim().parse::<i32>().ok())
                .is_some_and(|pgid| pgid == pid);
            if leader {
                // `-<pid>` é "o grupo", e o `--` NÃO é enfeite: sem ele o
                // /bin/kill lê `-2093347` como opção, não faz nada — e sai com
                // código 0. Foi essa falha silenciosa que fez `stop` responder
                // "parado" de consciência limpa enquanto o servidor seguia de pé
                // segurando a porta. Medido: sem `--`, porta ocupada; com `--`,
                // liberada.
                let signal_group = |sig: &str| {
                    let _ = Command::new("kill")
                        .args(["-s", sig, "--", &format!("-{pid}")])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                };
                let group_alive = || {
                    Command::new("kill")
                        .args(["-s", "0", "--", &format!("-{pid}")])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .map(|status| status.success())
                        .unwrap_or(false)
                };

                signal_group("TERM");
                // Esperar a ÁRVORE morrer, não só o `sh`.
                //
                // A jornada do §12 pegou isto no CI: `stop` fazia `child.wait()`,
                // que espera o SHELL. O servidor que o shell criou ainda estava
                // liberando a porta quando `stop` já tinha respondido "parado" —
                // e o start seguinte então sondava o processo velho e o via
                // saudável. Um `stop` só pode voltar quando parou de verdade.
                let mut waited = Duration::ZERO;
                let step = Duration::from_millis(50);
                while group_alive() && waited < Duration::from_secs(3) {
                    std::thread::sleep(step);
                    waited += step;
                }
                // Quem ignora SIGTERM não decide continuar de pé: a pessoa mandou
                // parar.
                if group_alive() {
                    signal_group("KILL");
                }
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    runtime.child = None;
    runtime.stopped = true;
    runtime.move_to(
        PreviewHealth::Broken,
        Some("preview parado por você".to_string()),
    );
    Ok(snapshot_from(root, Some(runtime), declared, None))
}

fn status_unstarted(
    root: &Path,
    declared: Option<DeclaredPreview>,
) -> Result<PreviewSnapshot, String> {
    let (_, reason) = read_declaration(root);
    Ok(PreviewSnapshot {
        declared,
        not_declared_reason: reason,
        state: None,
        running: false,
        stopped: false,
        failures: Vec::new(),
        last_probe: None,
        log_tail: log_tail(root),
        log_path: Some(LOG_REL.to_string()),
    })
}

fn snapshot_from(
    root: &Path,
    runtime: Option<&mut PreviewRuntime>,
    declared: Option<DeclaredPreview>,
    ledger_refusal: Option<String>,
) -> PreviewSnapshot {
    let (_, reason) = read_declaration(root);
    match runtime {
        None => PreviewSnapshot {
            declared,
            not_declared_reason: reason,
            state: None,
            running: false,
            stopped: false,
            failures: Vec::new(),
            last_probe: None,
            log_tail: log_tail(root),
            log_path: Some(LOG_REL.to_string()),
        },
        Some(runtime) => {
            let running = runtime.child_exit().is_none() && runtime.child.is_some();
            // A ledger refusal is a fact about this run, and it belongs on screen
            // next to the state rather than in a log nobody reads.
            let last_probe = match (&runtime.last_probe, ledger_refusal) {
                (Some(probe), Some(refusal)) => Some(format!("{probe} · {refusal}")),
                (Some(probe), None) => Some(probe.clone()),
                (None, Some(refusal)) => Some(refusal),
                (None, None) => None,
            };
            PreviewSnapshot {
                declared,
                not_declared_reason: reason,
                state: Some(runtime.supervisor.state().clone()),
                running,
                stopped: runtime.stopped,
                failures: runtime.failures(),
                last_probe,
                log_tail: log_tail(root),
                log_path: Some(LOG_REL.to_string()),
            }
        }
    }
}

/// The observations §4's reconciliation reads: every recorded preview failure,
/// as an `ObservedBehavior` about the subject `preview:health`.
///
/// Deliberately derived from the LEDGER, not from the live state: an observation
/// is only eligible for divergence detection when it carries an evidence id, and
/// the ledger is what mints those.
pub fn observations(root: &Path) -> Vec<ide_reconciliation::ObservedBehavior> {
    let key = root.to_string_lossy().into_owned();
    let Ok(mut map) = registry().lock() else {
        return observed_history(root)
            .iter()
            .map(|failure| {
                failure.as_observation(
                    format!("observed:{}", failure.id),
                    crate::reconcile::PREVIEW_SUBJECT,
                    serde_json::json!("broken"),
                )
            })
            .collect();
    };
    let vivas = map
        .get_mut(&key)
        .map(|runtime| runtime.failures())
        .unwrap_or_default();
    drop(map);
    // Histórico primeiro, execução atual depois: a evidência de uma execução
    // anterior continua valendo, e é justamente ela que a pessoa reinicia o
    // preview para tentar consertar. Deduplicado por id, para a mesma falha não
    // inflar a reconciliação.
    let mut falhas = observed_history(root);
    for falha in vivas {
        if !falhas.iter().any(|existente| existente.id == falha.id) {
            falhas.push(falha);
        }
    }
    falhas
        .iter()
        .map(|failure| {
            failure.as_observation(
                format!("observed:{}", failure.id),
                crate::reconcile::PREVIEW_SUBJECT,
                serde_json::json!("broken"),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(declaration: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        if let Some(body) = declaration {
            std::fs::create_dir_all(dir.path().join(".instrument")).unwrap();
            std::fs::write(dir.path().join(DECLARATION_REL), body).unwrap();
        }
        dir
    }

    /// Not declared is not broken, and it is not started either.
    #[test]
    fn without_a_declaration_nothing_starts_and_the_reason_is_stated() {
        let dir = project(None);

        let error = start(dir.path()).expect_err("não há o que iniciar");
        assert!(error.contains("preview.json"), "{error}");

        let snapshot = status(dir.path()).expect("status");
        assert!(snapshot.state.is_none(), "não iniciado não tem estado");
        assert!(snapshot.declared.is_none());
        assert!(snapshot
            .not_declared_reason
            .as_deref()
            .unwrap()
            .contains("nenhum preview declarado"));
    }

    /// A declaration that exists but cannot be parsed says so, instead of looking
    /// like a project that declared nothing.
    #[test]
    fn a_malformed_declaration_is_reported_as_malformed() {
        let dir = project(Some("{ isto não é json"));

        let error = start(dir.path()).expect_err("declaração ilegível");
        assert!(error.contains("não pôde ser lido"), "{error}");
    }

    /// A command that finishes cleanly is NOT a failure — the engine refuses to
    /// record one — but it is also not a preview that is up.
    #[test]
    fn a_clean_exit_is_not_recorded_as_a_failure() {
        let dir = project(Some(
            r#"{"command":"true","url":"http://127.0.0.1:1/","readyTimeoutMs":400}"#,
        ));

        let snapshot = start(dir.path()).expect("start");

        assert_eq!(snapshot.state.unwrap().health, PreviewHealth::Broken);
        assert!(
            snapshot.failures.is_empty(),
            "saída limpa não pode virar evidência de falha"
        );
        assert!(!snapshot.running);
    }

    /// A evidência sobrevive ao processo que a produziu, e ao reinício.
    ///
    /// Achado num projeto cru: observei a falha, reiniciei o preview para tentar
    /// consertar, e a reconciliação passou a dizer "0 comportamento observado" —
    /// a evidência morria com o runtime, e a decisão já tomada citava um id que
    /// não existia mais.
    #[test]
    fn observacao_sobrevive_ao_reinicio_do_preview() {
        let dir = project(Some(
            r#"{"command":"exit 7","url":"http://127.0.0.1:1/","readyTimeoutMs":300}"#,
        ));

        start(dir.path()).expect("start");
        let primeira = observations(dir.path());
        assert_eq!(
            primeira.len(),
            1,
            "a falha observada entra na reconciliação"
        );

        // Reinício: runtime novo, memória zerada.
        restart(dir.path()).expect("restart");
        registry()
            .lock()
            .unwrap()
            .remove(&dir.path().to_string_lossy().into_owned());

        let depois = observations(dir.path());
        assert!(
            !depois.is_empty(),
            "o que foi observado continua observado depois do reinício"
        );
        assert!(
            depois.iter().any(|o| o.id == primeira[0].id),
            "e é a MESMA observação, com o id que a decisão citou"
        );
    }

    /// 404 na url de saúde não é saúde.
    ///
    /// Achado num projeto cru: a url declarada era `/`, o app servia só `/itens`,
    /// e o painel dizia "SAUDÁVEL · HTTP/1.1 404 Not Found" — contradição na
    /// mesma linha. O processo estar de pé é um fato; a url declarada responder é
    /// outro, e é esse que a palavra "saudável" promete.
    #[test]
    fn quatrocentos_e_quatro_na_url_de_saude_nao_conta_como_saude() {
        let porta = 21_000 + (std::process::id() % 900) as u16;
        let escuta = std::net::TcpListener::bind(("127.0.0.1", porta)).expect("bind");
        // Servidor mínimo que responde 404 uma vez: é o que o projeto cru fazia.
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = escuta.accept() {
                use std::io::Write;
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
            }
        });

        let resultado = probe(&format!("http://127.0.0.1:{porta}/"));

        match resultado {
            Probe::Failed(detail) => {
                assert!(detail.contains("404"), "o status vem literal: {detail}");
                assert!(
                    detail.contains("não existe nele"),
                    "e a mensagem diz o que fazer, sem chamar de saúde: {detail}"
                );
            }
            outro => panic!("404 na url de saúde não pode virar saúde: {outro:?}"),
        }
    }

    /// "código 1" não é causa: a linha do log é.
    ///
    /// Achado num projeto cru sem `node_modules` — a tela dizia só o código de
    /// saída e o `Cannot find module 'express'` ficava escondido na saída crua.
    #[test]
    fn morte_precoce_cita_a_linha_do_log_que_explica() {
        let dir = project(Some(
            r#"{"command":"echo \"Error: Cannot find module 'express'\" >&2 ; exit 1","url":"http://127.0.0.1:1/","readyTimeoutMs":500}"#,
        ));

        let snapshot = start(dir.path()).expect("start");

        let detail = snapshot
            .state
            .as_ref()
            .and_then(|state| state.detail.clone())
            .unwrap_or_default();
        assert!(
            detail.contains("código 1"),
            "o código de saída continua dito: {detail}"
        );
        assert!(
            detail.contains("Cannot find module 'express'"),
            "a causa tem de vir na mensagem, não só na saída crua: {detail}"
        );
    }

    /// `stop` matava o `sh` e deixava vivo o processo que o `sh` criou — que é
    /// quem segura a porta. Pior: o `kill` de grupo sem `--` sai com código 0
    /// sem fazer nada, então `stop` respondia "parado" e o servidor seguia no ar;
    /// o start seguinte então sondava o processo velho e o via saudável.
    #[test]
    fn stop_derruba_o_neto_que_segura_a_porta_nao_so_o_shell() {
        let dir = project(None);
        std::fs::create_dir_all(dir.path().join(".instrument")).expect("dir");
        let pidfile = dir.path().join("neto.pid");
        // O comando declarado roda sob `sh`; este `sh` interno grava o pid do
        // NETO e dorme. É esse pid que precisa estar morto no fim.
        std::fs::write(
            dir.path().join(".instrument/preview.json"),
            format!(
                r#"{{"command":"sh -c 'echo $$ > {} ; sleep 30'","url":"http://127.0.0.1:1/","readyTimeoutMs":300}}"#,
                pidfile.display()
            ),
        )
        .expect("declaração");

        start(dir.path()).expect("start");
        let neto: i32 = std::fs::read_to_string(&pidfile)
            .expect("o neto tem de ter subido")
            .trim()
            .parse()
            .expect("pid");

        stop(dir.path()).expect("stop");

        let vivo = std::process::Command::new("kill")
            .args(["-s", "0", "--", &neto.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(
            !vivo,
            "parar o preview tem de derrubar o processo que segura a porta (pid {neto}), não só o shell"
        );
    }

    /// O botão "Reiniciar" da UI chamava `start`, e `start` num preview vivo
    /// devolve o que JÁ está rodando. O clique não trocava processo nenhum, e o
    /// painel seguia mostrando a saúde do processo antigo — quem tinha acabado
    /// de mudar o código lia a saúde do código velho. `restart` tem de derrubar
    /// e subir outro.
    #[test]
    fn restart_troca_o_processo_em_vez_de_devolver_o_que_ja_rodava() {
        let dir = project(None);
        // `project(None)` não declara preview e não cria `.instrument/`: a
        // declaração abaixo é escrita à mão, então o diretório é por conta dela.
        std::fs::create_dir_all(dir.path().join(".instrument")).expect("dir");
        let marca = dir.path().join("subiu.txt");
        // Cada processo que sobe acrescenta uma linha: contar linhas conta
        // quantas vezes um processo NOVO realmente rodou.
        std::fs::write(
            dir.path().join(".instrument/preview.json"),
            format!(
                r#"{{"command":"echo subiu >> {} && sleep 30","url":"http://127.0.0.1:1/","readyTimeoutMs":300}}"#,
                marca.display()
            ),
        )
        .expect("declaração");

        start(dir.path()).expect("start");
        let depois_do_start = std::fs::read_to_string(&marca).unwrap_or_default();
        assert_eq!(
            depois_do_start.lines().count(),
            1,
            "o primeiro start sobe um"
        );

        restart(dir.path()).expect("restart");
        let depois_do_restart = std::fs::read_to_string(&marca).unwrap_or_default();
        assert_eq!(
            depois_do_restart.lines().count(),
            2,
            "reiniciar tem de subir processo NOVO, não devolver o que já rodava"
        );

        stop(dir.path()).expect("stop");
    }

    /// Two failures recorded in different sessions must not share an id: a
    /// decision taken about one would silently cover the other.
    #[test]
    fn failure_ids_are_unique_per_occurrence() {
        let dir = project(Some(
            r#"{"command":"exit 3","url":"http://127.0.0.1:1/","readyTimeoutMs":200}"#,
        ));

        let first = start(dir.path()).expect("start");
        let id_first = first.failures[0].id.clone();
        // A restart resets the per-session counter; the id must still differ.
        stop(dir.path()).expect("stop");
        registry()
            .lock()
            .unwrap()
            .remove(&dir.path().to_string_lossy().into_owned());
        let second = start(dir.path()).expect("restart");
        let id_second = second.failures[0].id.clone();

        assert_ne!(
            id_first, id_second,
            "contador por sessão sozinho reinicia em 1 e cola decisão antiga em falha nova"
        );
    }

    /// A command that dies with a non-zero code IS evidence, and the evidence
    /// carries causal links plus the exit code.
    #[test]
    fn a_nonzero_exit_becomes_evidence_with_causal_links() {
        let dir = project(Some(
            r#"{"command":"echo estourou aqui; exit 3","url":"http://127.0.0.1:1/","readyTimeoutMs":400}"#,
        ));

        let snapshot = start(dir.path()).expect("start");

        assert_eq!(snapshot.state.unwrap().health, PreviewHealth::Broken);
        assert_eq!(snapshot.failures.len(), 1, "uma falha registrada");
        let failure = &snapshot.failures[0];
        assert!(!failure.causal_links.is_empty(), "falha sem rastro é opaca");
        assert!(matches!(
            failure.kind,
            ide_reconciliation::PreviewFailureKind::ProcessExited { exit_code: 3, .. }
        ));
        // The log the evidence points at really holds the process output.
        assert!(snapshot.log_tail.unwrap().contains("estourou aqui"));
    }

    /// A live process with no URL to probe can never be reported healthy, and the
    /// snapshot says why rather than leaving it looking merely slow.
    #[test]
    fn without_a_url_the_preview_never_claims_health() {
        let dir = project(Some(r#"{"command":"sleep 5","readyTimeoutMs":300}"#));

        let snapshot = start(dir.path()).expect("start");

        assert_eq!(snapshot.state.unwrap().health, PreviewHealth::Starting);
        assert!(snapshot.running);
        assert!(snapshot
            .last_probe
            .as_deref()
            .unwrap()
            .contains("não declara url"));

        let stopped = stop(dir.path()).expect("stop");
        assert!(stopped.stopped);
        assert!(!stopped.running);
    }

    /// An `https://` URL is not probed and not guessed at: the limit is the
    /// prober's, and it is reported as such rather than as a project failure.
    #[test]
    fn an_https_url_is_reported_as_unprobeable_not_as_broken() {
        match probe("https://example.invalid/health") {
            Probe::Unsupported(detail) => assert!(detail.contains("só fala http://"), "{detail}"),
            _ => panic!("https tem de ser recusado pela sonda, não sondado"),
        }
    }

    /// A refused connection is a real failure of the endpoint, not a prober limit.
    #[test]
    fn a_closed_port_is_a_probe_failure() {
        // Port 1 on loopback: nothing listens there in CI.
        match probe("http://127.0.0.1:1/health") {
            Probe::Failed(detail) => assert!(detail.contains("127.0.0.1:1"), "{detail}"),
            _ => panic!("porta fechada é falha de sonda"),
        }
    }
}
