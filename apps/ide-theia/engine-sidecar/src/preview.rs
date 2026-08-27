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
use std::path::{Path, PathBuf};
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
        // 5xx is the server saying it is broken. Anything else that parsed is an
        // answer, which is what "responding" means for a preview.
        Some(code) if code >= 500 => Probe::Failed(format!("{url}: {status_line}")),
        Some(_) => Probe::Healthy(format!("{url}: {status_line}")),
        None => Probe::Failed(format!("{url}: resposta sem linha de status")),
    }
}

/// Last `MAX_LOG_TAIL` characters of the preview log, on a char boundary.
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

    fn next_id(&mut self, kind: &str) -> (String, String) {
        self.seq += 1;
        (
            format!("preview-failure:{kind}:{}", self.seq),
            format!("evidence:{LOG_REL}#{}", self.seq),
        )
    }

    /// Records a non-zero exit. A clean exit is refused by the engine, and that
    /// refusal is reported rather than worked around.
    fn record_exit(&mut self, exit_code: i32, detail: &str) -> Option<String> {
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
                self.failure_ids.push(id);
                None
            }
            Err(error) => Some(error.to_string()),
        }
    }

    fn record_health_failure(&mut self, url: &str, detail: &str) -> Option<String> {
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
                self.failure_ids.push(id);
                None
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

    let child = Command::new("sh")
        .arg("-c")
        .arg(&declaration.command)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
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
            let detail = format!(
                "`{}` terminou (código {code_shown}) antes de responder",
                declaration.command
            );
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
                    ledger_refusal =
                        runtime.record_exit(other.unwrap_or(-1), &detail).or(ledger_refusal);
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
                            .record_health_failure(url, &detail)
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
                refusal = runtime.record_exit(code.unwrap_or(-1), &detail);
            }
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
                    refusal = runtime.record_health_failure(url, &detail);
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
pub fn stop(root: &Path) -> Result<PreviewSnapshot, String> {
    let (declared, _) = read_declaration(root);
    let key = root.to_string_lossy().into_owned();
    let mut map = registry().lock().map_err(|e| e.to_string())?;
    let Some(runtime) = map.get_mut(&key) else {
        return status_unstarted(root, declared);
    };
    if let Some(child) = runtime.child.as_mut() {
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
        return Vec::new();
    };
    let Some(runtime) = map.get_mut(&key) else {
        return Vec::new();
    };
    runtime
        .failures()
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
        let dir = project(Some(r#"{"command":"true","url":"http://127.0.0.1:1/","readyTimeoutMs":400}"#));

        let snapshot = start(dir.path()).expect("start");

        assert_eq!(snapshot.state.unwrap().health, PreviewHealth::Broken);
        assert!(
            snapshot.failures.is_empty(),
            "saída limpa não pode virar evidência de falha"
        );
        assert!(!snapshot.running);
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
        assert!(snapshot.last_probe.as_deref().unwrap().contains("não declara url"));

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
