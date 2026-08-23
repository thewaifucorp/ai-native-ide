# Tauri host boundary and viability gates

Tauri is the only implemented desktop host. Electron remains a fallback decision,
not a parallel codebase: it can be considered only when a gate below fails in a
packaged artifact and the failure is demonstrably structural rather than a missing
IDE feature.

## Boundary

The renderer has a deliberately small IPC surface:

- `host_status` reports the host's available extension points;
- `host_viability_report` exposes the current gates and their honest state;
- `open_surface` accepts only the `Preview`, `Terminal`, or `RawEvidence` enum;
- `emit_host_probe` verifies the event bridge without performing an effect.

There is no renderer command for an executable, shell text, arbitrary path, URL,
or network request. The Content Security Policy disallows remote scripts and a
Tauri capability manifest grants only core window behavior plus the opener plugin.

Future project/resource services create `WatchScope`; policy-approved IDE
extensions create `TrustedProcessSpec`. That keeps filesystem watching, PTYs,
agent subprocesses, and previews behind the privileged host rather than turning
the WebView into a second process manager. T05 binds the PTY extension to the
terminal UI, and T06 binds all mutable effects to `CapabilityRegistry` approvals.

## Extension points proven in this slice

| Extension | Host implementation | Renderer exposure now | Later owner |
|---|---|---|---|
| Process/agent stream | captured stdout/stderr, poll/stop lifecycle, typed events | none | T05 adapter runtime |
| PTY | native PTY, write, resize, stop, typed stream | none | T05 terminal surface |
| Preview | `PreviewHealth` lifecycle vocabulary and isolated Preview surface | status/surface only | T08 preview supervisor |
| Filesystem watch | scoped `notify` watcher and typed change events | none | T04 resources/activity |
| Multiple surfaces | native Preview, Terminal and Raw Evidence WebViews | named enum only | T02 work surface |
| Shortcuts | native `CmdOrCtrl+Shift+P/T/E` menu accelerators open the named surfaces | none | T02 interaction shell |

The PTY/process tests use `/bin/sh` only under Unix test configuration. It is a
test fixture, never a renderer API or a production launch policy.

## Structural blocker gates

`TAURI-IPC-01` is passing by construction: the compiled command list contains no
untyped filesystem, process, or network operation. `TAURI-ERGONOMICS-04` is also
passing by construction: the host is a single Rust crate with a shell-neutral
frontend.

The CI artifact must measure the two runtime gates before T03 can be marked done:

1. `TAURI-HOST-02`: packaged Linux artifact opens and focuses all three named
   surfaces without a second host process or frontend origin.
2. `TAURI-RUNTIME-03`: trusted extension fixture completes process stream,
   filesystem watch, PTY resize/input/stop, preview health transition, and leaves
   no child after stop.

A blocker exists only if the same requirement cannot be fulfilled through a
maintainable Tauri/Rust host extension in the artifact after a reproducible
investigation. Missing domain wiring, an absent UI, a dependency bug with an
upgrade path, or unavailable local Linux headers are not structural blockers.

## Artifact evidence protocol

CI is the retained build authority. Each T03 candidate must retain its Linux
bundle and record: bundle size, cold-start observation, RAM observation at idle,
surface probe result, process/PTY/watch fixture result, and the commit SHA. The
first two runtime gates remain `pendingArtifactMeasurement` until that evidence
is recorded; the app must not present them as passed.
