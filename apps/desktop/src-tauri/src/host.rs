//! Native extension points owned by the Tauri host.
//!
//! `TrustedProcessSpec` is intentionally not deserializable. Future IDE domain
//! services (project resources, agent adapters and preview configuration) create
//! it after policy evaluation; Tauri commands only expose status and surfaces.

use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};

#[cfg(windows)]
use std::{
    ffi::OsString,
    os::windows::ffi::{OsStrExt, OsStringExt},
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
#[cfg(not(windows))]
use portable_pty::{native_pty_system, CommandBuilder, PtySize, SlavePty};
use serde::Serialize;

use crate::PreviewHealth;

pub type EventSink = Arc<dyn Fn(HostEvent) + Send + Sync>;

/// Keep a runaway interactive program from making the host retain unbounded
/// terminal output. The renderer has a smaller display buffer; this protects
/// the native reader before events ever reach it.
const PTY_OUTPUT_BYTE_LIMIT: usize = 10 * 1024 * 1024;
const OUTPUT_EVENT_BYTE_LIMIT: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HostEvent {
    HostProbe {
        message: String,
    },
    ProcessStarted {
        extension: HostExtension,
        pid: u32,
    },
    ProcessOutput {
        extension: HostExtension,
        stream: OutputStream,
        line: String,
    },
    ProcessStreamError {
        extension: HostExtension,
        stream: OutputStream,
        detail: String,
    },
    ProcessExited {
        extension: HostExtension,
        exit_code: Option<i32>,
    },
    PreviewHealth {
        health: PreviewHealth,
    },
    FilesystemChanged {
        path: PathBuf,
        detail: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HostExtension {
    AgentSubprocess,
    Preview,
    Pty,
    FilesystemWatch,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OutputStream {
    Stdout,
    Stderr,
    Pty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessLifecycle {
    Starting,
    Running,
    Stopped,
}

/// A path scope is created by a trusted project/resource service, never by a
/// renderer payload. Canonicalization also rejects a missing root early.
#[derive(Debug, Clone)]
pub struct WatchScope {
    root: PathBuf,
}

impl WatchScope {
    pub fn from_project_resource(root: impl AsRef<Path>) -> std::io::Result<Self> {
        Ok(Self {
            root: host_canonical_path(root.as_ref())?,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

/// Process data which can only be supplied by host-owned extension code.
#[derive(Debug, Clone)]
pub struct TrustedProcessSpec {
    program: PathBuf,
    args: Vec<String>,
    working_directory: PathBuf,
}

impl TrustedProcessSpec {
    pub fn for_registered_extension(
        program: impl AsRef<Path>,
        args: impl IntoIterator<Item = impl Into<String>>,
        working_directory: &WatchScope,
    ) -> std::io::Result<Self> {
        let program = host_canonical_path(program.as_ref())?;
        if !program.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "trusted executable must be a file",
            ));
        }
        Ok(Self {
            program,
            args: args.into_iter().map(Into::into).collect(),
            working_directory: working_directory.root.clone(),
        })
    }
}

fn host_canonical_path(path: &Path) -> std::io::Result<PathBuf> {
    let canonical = path.canonicalize()?;
    #[cfg(windows)]
    {
        Ok(windows_command_path(canonical))
    }
    #[cfg(not(windows))]
    {
        Ok(canonical)
    }
}

/// Windows canonicalization returns verbatim `\\\\?\\` paths. They are correct
/// for Win32 file APIs, but `cmd.exe` treats them as unsupported UNC paths and
/// silently changes the current directory. Host-owned terminal commands need
/// the ordinary DOS spelling instead.
#[cfg(windows)]
fn windows_command_path(path: PathBuf) -> PathBuf {
    let units = path.as_os_str().encode_wide().collect::<Vec<_>>();
    const VERBATIM: [u16; 4] = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    const VERBATIM_UNC: [u16; 4] = [b'U' as u16, b'N' as u16, b'C' as u16, b'\\' as u16];

    if units.starts_with(&VERBATIM) {
        if units[VERBATIM.len()..].starts_with(&VERBATIM_UNC) {
            let mut unc = vec![b'\\' as u16, b'\\' as u16];
            unc.extend_from_slice(&units[VERBATIM.len() + VERBATIM_UNC.len()..]);
            return PathBuf::from(OsString::from_wide(&unc));
        }
        return PathBuf::from(OsString::from_wide(&units[VERBATIM.len()..]));
    }

    path
}

pub struct HostRuntime {
    sink: EventSink,
}

impl HostRuntime {
    pub fn new(sink: EventSink) -> Self {
        Self { sink }
    }

    pub fn publish(&self, event: HostEvent) {
        (self.sink)(event);
    }

    pub fn spawn_process(
        &self,
        extension: HostExtension,
        spec: TrustedProcessSpec,
    ) -> std::io::Result<ManagedProcess> {
        ManagedProcess::spawn(extension, spec, Arc::clone(&self.sink))
    }

    pub fn spawn_pty(
        &self,
        spec: TrustedProcessSpec,
        rows: u16,
        columns: u16,
    ) -> std::io::Result<ManagedPty> {
        ManagedPty::spawn(spec, rows, columns, Arc::clone(&self.sink))
    }

    pub fn watch(&self, scope: WatchScope) -> notify::Result<ActiveWatch> {
        ActiveWatch::start(scope, Arc::clone(&self.sink))
    }

    /// Starts a scoped native watch and lets the semantic-project service record
    /// the observation before the renderer is notified. The callback receives a
    /// filesystem path only; it cannot grant the renderer any capability.
    pub fn watch_with_observer(
        &self,
        scope: WatchScope,
        observer: impl Fn(&Path) + Send + Sync + 'static,
    ) -> notify::Result<ActiveWatch> {
        ActiveWatch::start_with_observer(scope, Arc::clone(&self.sink), Arc::new(observer))
    }

    pub fn start_preview(&self, spec: TrustedProcessSpec) -> std::io::Result<PreviewSupervisor> {
        PreviewSupervisor::start(spec, Arc::clone(&self.sink))
    }
}

/// Preview state is deliberately separate from a child exit status. A server
/// can run while stale or broken; T08 supplies the actual health observer.
pub struct PreviewSupervisor {
    process: ManagedProcess,
    health: PreviewHealth,
    sink: EventSink,
}

impl PreviewSupervisor {
    fn start(spec: TrustedProcessSpec, sink: EventSink) -> std::io::Result<Self> {
        sink(HostEvent::PreviewHealth {
            health: PreviewHealth::Starting,
        });
        let process = ManagedProcess::spawn(HostExtension::Preview, spec, Arc::clone(&sink))?;
        Ok(Self {
            process,
            health: PreviewHealth::Starting,
            sink,
        })
    }

    /// Called only by a trusted health observer, never by the renderer.
    pub fn observe_health(&mut self, health: PreviewHealth) {
        self.health = health;
        (self.sink)(HostEvent::PreviewHealth { health });
    }

    pub fn health(&self) -> PreviewHealth {
        self.health
    }

    pub fn stop(&mut self) -> std::io::Result<()> {
        self.process.stop()?;
        self.observe_health(PreviewHealth::Stopped);
        Ok(())
    }
}

pub struct ManagedProcess {
    extension: HostExtension,
    child: Arc<Mutex<Child>>,
    sink: EventSink,
    lifecycle: ProcessLifecycle,
}

impl ManagedProcess {
    fn spawn(
        extension: HostExtension,
        spec: TrustedProcessSpec,
        sink: EventSink,
    ) -> std::io::Result<Self> {
        let mut child = Command::new(spec.program)
            .args(spec.args)
            .current_dir(spec.working_directory)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let pid = child.id();

        if let Some(output) = child.stdout.take() {
            stream_lines(
                extension,
                OutputStream::Stdout,
                output,
                Arc::clone(&sink),
                None,
            );
        }
        if let Some(output) = child.stderr.take() {
            stream_lines(
                extension,
                OutputStream::Stderr,
                output,
                Arc::clone(&sink),
                None,
            );
        }
        sink(HostEvent::ProcessStarted { extension, pid });

        Ok(Self {
            extension,
            child: Arc::new(Mutex::new(child)),
            sink,
            lifecycle: ProcessLifecycle::Running,
        })
    }

    pub fn lifecycle(&self) -> ProcessLifecycle {
        self.lifecycle
    }

    /// Polling is explicit so the future activity domain can attach causal IDs
    /// before it emits an exit observation.
    pub fn poll(&mut self) -> std::io::Result<ProcessLifecycle> {
        let status = self
            .child
            .lock()
            .expect("process lock poisoned")
            .try_wait()?;
        if let Some(status) = status {
            self.lifecycle = ProcessLifecycle::Stopped;
            (self.sink)(HostEvent::ProcessExited {
                extension: self.extension,
                exit_code: status.code(),
            });
        }
        Ok(self.lifecycle)
    }

    pub fn stop(&mut self) -> std::io::Result<()> {
        let mut child = self.child.lock().expect("process lock poisoned");
        if child.try_wait()?.is_none() {
            child.kill()?;
        }
        let status = child.wait()?;
        self.lifecycle = ProcessLifecycle::Stopped;
        (self.sink)(HostEvent::ProcessExited {
            extension: self.extension,
            exit_code: status.code(),
        });
        Ok(())
    }
}

fn stream_lines(
    extension: HostExtension,
    stream: OutputStream,
    mut output: impl Read + Send + 'static,
    sink: EventSink,
    byte_limit: Option<usize>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8 * 1024];
        let mut pending = Vec::with_capacity(OUTPUT_EVENT_BYTE_LIMIT);
        let mut total_bytes = 0_usize;

        let emit = |pending: &mut Vec<u8>| {
            if pending.last() == Some(&b'\r') {
                pending.pop();
            }
            sink(HostEvent::ProcessOutput {
                extension,
                stream,
                line: String::from_utf8_lossy(pending).into_owned(),
            });
            pending.clear();
        };

        loop {
            let read = match output.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) => {
                    sink(HostEvent::ProcessStreamError {
                        extension,
                        stream,
                        detail: error.to_string(),
                    });
                    return;
                }
            };
            total_bytes = total_bytes.saturating_add(read);
            if let Some(limit) = byte_limit.filter(|limit| total_bytes > *limit) {
                sink(HostEvent::ProcessStreamError {
                    extension,
                    stream,
                    detail: format!("output exceeded the {limit}-byte host limit"),
                });
                return;
            }

            for byte in &buffer[..read] {
                if *byte == b'\n' {
                    emit(&mut pending);
                } else {
                    pending.push(*byte);
                    if pending.len() == OUTPUT_EVENT_BYTE_LIMIT {
                        emit(&mut pending);
                    }
                }
            }
        }

        if !pending.is_empty() {
            emit(&mut pending);
        }
    });
}

/// A real PTY host extension. It is not yet exposed as a renderer command: T05
/// will bind it to project-scoped terminal capabilities and cancellation UX.
#[cfg(not(windows))]
pub struct ManagedPty {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    writer: Box<dyn std::io::Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    // Unix keeps this endpoint alive for interactive input. ConPTY has a
    // separate implementation below and must release its slave after spawn.
    _slave: Box<dyn SlavePty + Send>,
    sink: EventSink,
    lifecycle: ProcessLifecycle,
}

#[cfg(not(windows))]
impl ManagedPty {
    fn spawn(
        spec: TrustedProcessSpec,
        rows: u16,
        columns: u16,
        sink: EventSink,
    ) -> std::io::Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(io_error)?;
        let mut command = CommandBuilder::new(spec.program);
        command.args(spec.args);
        command.cwd(spec.working_directory);
        let child = pair.slave.spawn_command(command).map_err(io_error)?;
        let reader = pair.master.try_clone_reader().map_err(io_error)?;
        let writer = pair.master.take_writer().map_err(io_error)?;
        stream_lines(
            HostExtension::Pty,
            OutputStream::Pty,
            reader,
            Arc::clone(&sink),
            Some(PTY_OUTPUT_BYTE_LIMIT),
        );
        sink(HostEvent::ProcessStarted {
            extension: HostExtension::Pty,
            pid: child.process_id().unwrap_or_default(),
        });
        Ok(Self {
            child,
            writer,
            master: pair.master,
            _slave: pair.slave,
            sink,
            lifecycle: ProcessLifecycle::Running,
        })
    }

    pub fn write(&mut self, input: &[u8]) -> std::io::Result<()> {
        use std::io::Write;
        self.writer.write_all(input)?;
        self.writer.flush()
    }

    pub fn resize(&self, rows: u16, columns: u16) -> std::io::Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(io_error)
    }

    pub fn stop(&mut self) -> std::io::Result<()> {
        self.child.kill().map_err(io_error)?;
        let status = self.child.wait().map_err(io_error)?;
        self.lifecycle = ProcessLifecycle::Stopped;
        (self.sink)(HostEvent::ProcessExited {
            extension: HostExtension::Pty,
            exit_code: Some(status.exit_code() as i32),
        });
        Ok(())
    }

    /// Polls the child without taking ownership of the PTY. This makes a
    /// short-lived command's exit observable even when a platform reader fails
    /// to yield output, which is essential for diagnosing ConPTY behavior.
    pub fn poll(&mut self) -> std::io::Result<ProcessLifecycle> {
        if self.lifecycle == ProcessLifecycle::Stopped {
            return Ok(self.lifecycle);
        }
        if let Some(status) = self.child.try_wait().map_err(io_error)? {
            self.lifecycle = ProcessLifecycle::Stopped;
            (self.sink)(HostEvent::ProcessExited {
                extension: HostExtension::Pty,
                exit_code: Some(status.exit_code() as i32),
            });
        }
        Ok(self.lifecycle)
    }

    pub fn lifecycle(&self) -> ProcessLifecycle {
        self.lifecycle
    }
}

/// Windows uses the direct ConPTY implementation instead of portable-pty.
///
/// portable-pty 0.9 can start a Windows child but leave its reader blocked
/// forever (including for a short `git status`). The direct implementation
/// owns the same Windows pseudo-console primitive while keeping its pipe
/// handles independent from the process lifecycle.
#[cfg(windows)]
pub struct ManagedPty {
    child: conpty::Process,
    writer: conpty::io::PipeWriter,
    sink: EventSink,
    lifecycle: ProcessLifecycle,
}

#[cfg(windows)]
impl ManagedPty {
    fn spawn(
        spec: TrustedProcessSpec,
        rows: u16,
        columns: u16,
        sink: EventSink,
    ) -> std::io::Result<Self> {
        let mut command = Command::new(spec.program);
        command.args(spec.args).current_dir(spec.working_directory);

        let mut options = conpty::ProcessOptions::default();
        options.set_console_size(Some((columns as i16, rows as i16)));
        let mut child = options.spawn(command).map_err(io_error)?;
        let reader = child.output().map_err(io_error)?;
        let writer = child.input().map_err(io_error)?;
        let pid = child.pid();

        stream_lines(
            HostExtension::Pty,
            OutputStream::Pty,
            reader,
            Arc::clone(&sink),
            Some(PTY_OUTPUT_BYTE_LIMIT),
        );
        sink(HostEvent::ProcessStarted {
            extension: HostExtension::Pty,
            pid,
        });

        Ok(Self {
            child,
            writer,
            sink,
            lifecycle: ProcessLifecycle::Running,
        })
    }

    pub fn write(&mut self, input: &[u8]) -> std::io::Result<()> {
        use std::io::Write;
        self.writer.write_all(input)?;
        self.writer.flush()
    }

    pub fn resize(&mut self, rows: u16, columns: u16) -> std::io::Result<()> {
        self.child
            .resize(columns as i16, rows as i16)
            .map_err(io_error)
    }

    pub fn stop(&mut self) -> std::io::Result<()> {
        if self.lifecycle == ProcessLifecycle::Stopped {
            return Ok(());
        }
        self.child.exit(1).map_err(io_error)?;
        let exit_code = self.child.wait(None).map_err(io_error)?;
        self.record_exit(exit_code as i32);
        Ok(())
    }

    pub fn poll(&mut self) -> std::io::Result<ProcessLifecycle> {
        if self.lifecycle == ProcessLifecycle::Running && !self.child.is_alive() {
            let exit_code = self.child.wait(Some(0)).map_err(io_error)?;
            self.record_exit(exit_code as i32);
        }
        Ok(self.lifecycle)
    }

    pub fn lifecycle(&self) -> ProcessLifecycle {
        self.lifecycle
    }

    fn record_exit(&mut self, exit_code: i32) {
        self.lifecycle = ProcessLifecycle::Stopped;
        (self.sink)(HostEvent::ProcessExited {
            extension: HostExtension::Pty,
            exit_code: Some(exit_code),
        });
    }
}

pub struct ActiveWatch {
    _watcher: RecommendedWatcher,
}

impl ActiveWatch {
    fn start(scope: WatchScope, sink: EventSink) -> notify::Result<Self> {
        Self::start_with_observer(scope, sink, Arc::new(|_| {}))
    }

    fn start_with_observer(
        scope: WatchScope,
        sink: EventSink,
        observer: Arc<dyn Fn(&Path) + Send + Sync>,
    ) -> notify::Result<Self> {
        let mut watcher = notify::recommended_watcher(
            move |result: notify::Result<notify::Event>| match result {
                Ok(event) => {
                    let detail = format!("{:?}", event.kind);
                    for path in event.paths {
                        observer(&path);
                        sink(HostEvent::FilesystemChanged {
                            path,
                            detail: detail.clone(),
                        });
                    }
                }
                Err(error) => sink(HostEvent::HostProbe {
                    message: format!("filesystem watch error: {error}"),
                }),
            },
        )?;
        watcher.watch(scope.root(), RecursiveMode::Recursive)?;
        Ok(Self { _watcher: watcher })
    }
}

fn io_error(error: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        fs,
        io::Cursor,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    use super::*;

    fn temporary_scope() -> WatchScope {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("ai-native-ide-host-{unique}"));
        fs::create_dir_all(&path).expect("create temporary project scope");
        WatchScope::from_project_resource(path).expect("scope")
    }

    #[cfg(unix)]
    fn shell_spec(scope: &WatchScope, script: &str) -> TrustedProcessSpec {
        TrustedProcessSpec::for_registered_extension("/bin/sh", ["-c", script], scope)
            .expect("trusted shell spec")
    }

    #[cfg(unix)]
    #[test]
    fn supervised_process_streams_output_and_exits() {
        let events = Arc::new(Mutex::new(VecDeque::new()));
        let sink_events = Arc::clone(&events);
        let runtime = HostRuntime::new(Arc::new(move |event| {
            sink_events.lock().expect("events lock").push_back(event);
        }));
        let scope = temporary_scope();
        let mut process = runtime
            .spawn_process(
                HostExtension::AgentSubprocess,
                shell_spec(&scope, "printf host-stream; exit 7"),
            )
            .expect("spawn process");

        for _ in 0..20 {
            if process.poll().expect("poll") == ProcessLifecycle::Stopped {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(process.lifecycle(), ProcessLifecycle::Stopped);
        thread::sleep(Duration::from_millis(10));
        assert!(events
            .lock()
            .expect("events lock")
            .iter()
            .any(|event| matches!(
                event,
                HostEvent::ProcessOutput { line, .. } if line == "host-stream"
            )));
    }

    #[test]
    fn output_reader_enforces_a_host_byte_limit_before_emitting_unbounded_data() {
        let events = Arc::new(Mutex::new(VecDeque::new()));
        let sink_events = Arc::clone(&events);
        stream_lines(
            HostExtension::Pty,
            OutputStream::Pty,
            Cursor::new(b"five!".to_vec()),
            Arc::new(move |event| {
                sink_events.lock().expect("events lock").push_back(event);
            }),
            Some(4),
        );

        for _ in 0..20 {
            if events.lock().expect("events lock").iter().any(|event| {
                matches!(
                    event,
                    HostEvent::ProcessStreamError { detail, .. }
                        if detail.contains("4-byte host limit")
                )
            }) {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("bounded PTY reader did not reject oversized output");
    }

    #[cfg(unix)]
    #[test]
    fn pty_can_stream_resize_and_stop() {
        let runtime = HostRuntime::new(Arc::new(|_| {}));
        let scope = temporary_scope();
        let mut pty = runtime
            .spawn_pty(shell_spec(&scope, "printf pty-ready; sleep 5"), 24, 80)
            .expect("spawn pty");
        pty.resize(30, 100).expect("resize pty");
        pty.write(b"ignored input\n").expect("write pty");
        pty.stop().expect("stop pty");
        assert_eq!(pty.lifecycle(), ProcessLifecycle::Stopped);
    }

    #[cfg(unix)]
    #[test]
    fn pty_accepts_input_streams_the_reply_and_reaps_on_cancel() {
        let events = Arc::new(Mutex::new(VecDeque::new()));
        let sink_events = Arc::clone(&events);
        let runtime = HostRuntime::new(Arc::new(move |event| {
            sink_events.lock().expect("events lock").push_back(event);
        }));
        let scope = temporary_scope();
        let mut pty = runtime
            .spawn_pty(
                shell_spec(
                    &scope,
                    "printf ready; read line; printf 'reply:%s\\n' \"$line\"; sleep 5",
                ),
                24,
                80,
            )
            .expect("spawn pty");
        thread::sleep(Duration::from_millis(100));
        pty.write(b"hello-terminal\n").expect("send terminal input");

        for _ in 0..50 {
            if events.lock().expect("events lock").iter().any(|event| {
                matches!(
                    event,
                    HostEvent::ProcessOutput {
                        extension: HostExtension::Pty,
                        line,
                        ..
                    } if line.contains("reply:hello-terminal")
                )
            }) {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let event_log = format!("{:?}", events.lock().expect("events lock"));
        assert!(
            events.lock().expect("events lock").iter().any(|event| {
                matches!(
                    event,
                    HostEvent::ProcessOutput {
                        extension: HostExtension::Pty,
                        line,
                        ..
                    } if line.contains("reply:hello-terminal")
                )
            }),
            "PTY input did not reach the shell; events: {event_log}"
        );

        pty.stop().expect("cancel pty");
        assert_eq!(pty.lifecycle(), ProcessLifecycle::Stopped);
        assert!(events.lock().expect("events lock").iter().any(|event| {
            matches!(
                event,
                HostEvent::ProcessExited {
                    extension: HostExtension::Pty,
                    ..
                }
            )
        }));
    }

    #[cfg(unix)]
    #[test]
    fn preview_keeps_lifecycle_separate_from_its_process() {
        let runtime = HostRuntime::new(Arc::new(|_| {}));
        let scope = temporary_scope();
        let mut preview = runtime
            .start_preview(shell_spec(&scope, "sleep 5"))
            .expect("start preview");
        preview.observe_health(PreviewHealth::Healthy);
        assert!(matches!(preview.health(), PreviewHealth::Healthy));
        preview.stop().expect("stop preview");
        assert!(matches!(preview.health(), PreviewHealth::Stopped));
    }

    #[test]
    fn scope_rejects_missing_project_root() {
        assert!(WatchScope::from_project_resource("/definitely/not/an/ide/resource").is_err());
    }

    #[test]
    fn filesystem_watch_emits_a_scoped_change() {
        let events = Arc::new(Mutex::new(VecDeque::new()));
        let sink_events = Arc::clone(&events);
        let runtime = HostRuntime::new(Arc::new(move |event| {
            sink_events.lock().expect("events lock").push_back(event);
        }));
        let scope = temporary_scope();
        let watched_file = scope.root().join("changed-by-outside-ide.txt");
        let observed = Arc::new(AtomicBool::new(false));
        let observer_seen = Arc::clone(&observed);
        let _watch = runtime
            .watch_with_observer(scope, move |path| {
                if path
                    .file_name()
                    .is_some_and(|name| name == "changed-by-outside-ide.txt")
                {
                    observer_seen.store(true, Ordering::SeqCst);
                }
            })
            .expect("start filesystem watch");
        fs::write(&watched_file, "observed").expect("write watched file");

        for _ in 0..50 {
            if events.lock().expect("events lock").iter().any(|event| {
                matches!(
                    event,
                    HostEvent::FilesystemChanged { path, .. } if path == &watched_file
                )
            }) && observed.load(Ordering::SeqCst)
            {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("filesystem watcher did not report the scoped change");
    }
}
