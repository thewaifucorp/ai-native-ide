//! Native extension points owned by the Tauri host.
//!
//! `TrustedProcessSpec` is intentionally not deserializable. Future IDE domain
//! services (project resources, agent adapters and preview configuration) create
//! it after policy evaluation; Tauri commands only expose status and surfaces.

use std::{
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;

use crate::PreviewHealth;

pub type EventSink = Arc<dyn Fn(HostEvent) + Send + Sync>;

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
            root: root.as_ref().canonicalize()?,
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
        let program = program.as_ref().canonicalize()?;
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
            stream_lines(extension, OutputStream::Stdout, output, Arc::clone(&sink));
        }
        if let Some(output) = child.stderr.take() {
            stream_lines(extension, OutputStream::Stderr, output, Arc::clone(&sink));
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
    output: impl std::io::Read + Send + 'static,
    sink: EventSink,
) {
    thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            match line {
                Ok(line) => sink(HostEvent::ProcessOutput {
                    extension,
                    stream,
                    line,
                }),
                Err(_) => break,
            }
        }
    });
}

/// A real PTY host extension. It is not yet exposed as a renderer command: T05
/// will bind it to project-scoped terminal capabilities and cancellation UX.
pub struct ManagedPty {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    writer: Box<dyn std::io::Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    sink: EventSink,
    lifecycle: ProcessLifecycle,
}

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
        );
        sink(HostEvent::ProcessStarted {
            extension: HostExtension::Pty,
            pid: child.process_id().unwrap_or_default(),
        });
        Ok(Self {
            child,
            writer,
            master: pair.master,
            sink,
            lifecycle: ProcessLifecycle::Running,
        })
    }

    pub fn write(&mut self, input: &[u8]) -> std::io::Result<()> {
        use std::io::Write;
        self.writer.write_all(input)
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

    pub fn lifecycle(&self) -> ProcessLifecycle {
        self.lifecycle
    }
}

pub struct ActiveWatch {
    _watcher: RecommendedWatcher,
}

impl ActiveWatch {
    fn start(scope: WatchScope, sink: EventSink) -> notify::Result<Self> {
        let mut watcher = notify::recommended_watcher(move |result| match result {
            Ok(event) => {
                let detail = format!("{:?}", event.kind);
                for path in event.paths {
                    sink(HostEvent::FilesystemChanged {
                        path,
                        detail: detail.clone(),
                    });
                }
            }
            Err(error) => sink(HostEvent::HostProbe {
                message: format!("filesystem watch error: {error}"),
            }),
        })?;
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
        sync::{Arc, Mutex},
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
        let _watch = runtime.watch(scope).expect("start filesystem watch");
        fs::write(&watched_file, "observed").expect("write watched file");

        for _ in 0..50 {
            if events.lock().expect("events lock").iter().any(|event| {
                matches!(
                    event,
                    HostEvent::FilesystemChanged { path, .. } if path == &watched_file
                )
            }) {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("filesystem watcher did not report the scoped change");
    }
}
