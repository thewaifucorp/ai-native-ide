use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub host: &'static str,
    pub event_channel: &'static str,
    pub renderer_privileges: &'static str,
    pub extensions: Vec<&'static str>,
}

impl HostStatus {
    pub fn current() -> Self {
        Self {
            host: "tauri",
            event_channel: "ide://host-event",
            renderer_privileges: "typed IPC only; no direct filesystem/process/network APIs",
            extensions: vec![
                "process",
                "pty",
                "preview",
                "benchmark-preview",
                "filesystem-watch",
                "surface",
            ],
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostSurface {
    Preview,
    Terminal,
    RawEvidence,
}

impl HostSurface {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Preview => "ide-preview",
            Self::Terminal => "ide-terminal",
            Self::RawEvidence => "ide-raw-evidence",
        }
    }

    pub const fn route(self) -> &'static str {
        match self {
            Self::Preview => "index.html?surface=preview",
            Self::Terminal => "index.html?surface=terminal",
            Self::RawEvidence => "index.html?surface=raw-evidence",
        }
    }

    pub const fn title(self) -> &'static str {
        match self {
            Self::Preview => "AI-Native IDE — Preview",
            Self::Terminal => "AI-Native IDE — Terminal",
            Self::RawEvidence => "AI-Native IDE — Raw Evidence",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviewHealth {
    Starting,
    Healthy,
    Stale,
    Broken,
    Reconnecting,
    Stopped,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ViabilityGateStatus {
    PendingArtifactMeasurement,
    PassingByConstruction,
    /// Measured passing by a CI artifact test (build + smoke + golden journey),
    /// not merely asserted by construction.
    MeasuredPassing,
    Blocker,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViabilityGate {
    pub id: &'static str,
    pub assertion: &'static str,
    pub failure_is_structural_blocker: bool,
    pub status: ViabilityGateStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TauriViabilityReport {
    pub host: &'static str,
    pub fallback: &'static str,
    pub gates: Vec<ViabilityGate>,
}

impl TauriViabilityReport {
    pub fn current() -> Self {
        Self {
            host: "tauri",
            fallback: "Electron is considered only after a documented structural blocker.",
            gates: vec![
                ViabilityGate {
                    id: "TAURI-IPC-01",
                    assertion: "The renderer reaches native features only through typed, allowlisted commands and observable events; measured in CI by scripts/measure-host-security.sh, which asserts the shipped capability set stays within the allowlist and the CSP forbids eval and wildcard remote origins.",
                    failure_is_structural_blocker: true,
                    status: ViabilityGateStatus::MeasuredPassing,
                },
                ViabilityGate {
                    id: "TAURI-HOST-02",
                    assertion: "A packaged Linux artifact opens and focuses the Preview, Terminal, and Raw Evidence surfaces without a second host; measured by the CI bundle build and the installed-artifact smoke test.",
                    failure_is_structural_blocker: true,
                    status: ViabilityGateStatus::MeasuredPassing,
                },
                ViabilityGate {
                    id: "TAURI-RUNTIME-03",
                    assertion: "A trusted extension supervises a PTY, subprocess output, preview lifecycle, and filesystem-watch stream without orphaning children; measured by the golden-journey integration test that runs in CI.",
                    failure_is_structural_blocker: true,
                    status: ViabilityGateStatus::MeasuredPassing,
                },
                ViabilityGate {
                    id: "TAURI-ERGONOMICS-04",
                    assertion: "The host remains a single Rust process and permits a shell-neutral React UI; measured in CI by the installed-artifact smoke test, which bounds the Linux bundle size, counts the host processes, and asserts a clean shutdown with no orphans.",
                    failure_is_structural_blocker: false,
                    status: ViabilityGateStatus::MeasuredPassing,
                },
                ViabilityGate {
                    id: "TAURI-RESOURCE-05",
                    assertion: "The packaged host stays within a bounded memory and process budget while idle; measured in CI by the installed-artifact smoke test, which samples peak resident memory and the live process shape against a ceiling.",
                    failure_is_structural_blocker: false,
                    status: ViabilityGateStatus::MeasuredPassing,
                },
            ],
        }
    }
}
