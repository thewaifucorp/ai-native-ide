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
            extensions: vec!["process", "pty", "preview", "filesystem-watch", "surface"],
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

#[derive(Debug, Clone, Copy, Serialize)]
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
                    assertion: "The renderer reaches native features only through typed, allowlisted commands and observable events.",
                    failure_is_structural_blocker: true,
                    status: ViabilityGateStatus::PassingByConstruction,
                },
                ViabilityGate {
                    id: "TAURI-HOST-02",
                    assertion: "A packaged Linux artifact can create dedicated Preview, Terminal, and Raw Evidence surfaces without a second host.",
                    failure_is_structural_blocker: true,
                    status: ViabilityGateStatus::PendingArtifactMeasurement,
                },
                ViabilityGate {
                    id: "TAURI-RUNTIME-03",
                    assertion: "A trusted extension can supervise a PTY, subprocess output, preview lifecycle, and filesystem-watch event stream without orphaning child processes.",
                    failure_is_structural_blocker: true,
                    status: ViabilityGateStatus::PendingArtifactMeasurement,
                },
                ViabilityGate {
                    id: "TAURI-ERGONOMICS-04",
                    assertion: "The host remains a single Rust process and permits a shell-neutral React UI; maintenance cost is reviewed against CI evidence.",
                    failure_is_structural_blocker: false,
                    status: ViabilityGateStatus::PassingByConstruction,
                },
            ],
        }
    }
}
