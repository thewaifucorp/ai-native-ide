//! §13 — configuration: one schema behind the simple UI and the file.
//!
//! `ide_config` is the engine and it owns `config.json`: every field carries WHERE
//! its current value came from (`default`, `detected`, `user`), so a detected
//! default can be explained and reset, and a user choice is never overwritten by
//! detection. It also carries the plain-language consequence of each field, which
//! is the difference between a settings panel and a wall of switches.
//!
//! This module resolves the root, turns the typed config into rows a panel can
//! render without re-deriving anything, and passes edits through.
//!
//! # Why the config lives in `.instrument/`
//!
//! Same line §4 and §5 draw: this is IDE runtime state for the project, not
//! project content. It is not reviewed as a diff and it does not belong in the
//! project's history — unlike `.guidance/`, which is versioned because it is the
//! project's own steering.
//!
//! # One honest omission, stated
//!
//! `harnessLayers` and `localAag` are shown and resettable, but nothing consumes
//! them yet: the §4 checks always run layer 0 and the AAG capability is detected
//! by §1 rather than switched here. They are rendered as declared-not-wired
//! instead of being hidden, because hiding them would make the file and the panel
//! disagree — which is the exact thing this crate exists to prevent.

use ide_config::{
    available_profiles, explain, BuildMode, ConfigField, ConfigPatch, ConfigStore, Depth,
    DetectedEnvironment, IdeConfig, Layout, Permissions, ValueSource,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Where the config file lives, relative to the project.
const CONFIG_DIR_REL: &str = ".instrument";

/// Fields the panel renders, in presentation order.
const FIELDS: [(&str, ConfigField, &str); 8] = [
    ("mode", ConfigField::Mode, "Modo de construção"),
    ("depth", ConfigField::Depth, "Profundidade da informação"),
    ("layout", ConfigField::Layout, "Layout dos painéis"),
    (
        "permissions",
        ConfigField::Permissions,
        "Permissões de efeito",
    ),
    (
        "harnessLayers",
        ConfigField::HarnessLayers,
        "Camadas do harness",
    ),
    (
        "automaticCheckpoints",
        ConfigField::AutomaticCheckpoints,
        "Checkpoints automáticos",
    ),
    (
        "idlePaidInference",
        ConfigField::IdlePaidInference,
        "Inferência paga em idle",
    ),
    ("localAag", ConfigField::LocalAag, "Grafo local (aag)"),
];

/// Fields whose value nothing reads yet. Named here so the panel can say so
/// rather than implying they take effect.
const DECLARED_NOT_WIRED: [&str; 2] = ["harnessLayers", "localAag"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingRow {
    /// Field id, as the JSON file spells it.
    pub field: String,
    pub label: String,
    /// Current value, rendered for display. The typed value is in `config`.
    pub value: String,
    /// `default`, `detected` or `user`.
    pub source: String,
    /// Plain-language consequence, from the engine.
    pub explain: String,
    /// True when nothing consumes this value yet.
    pub declared_not_wired: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRow {
    pub name: String,
    pub layout: String,
    pub depth: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    /// The typed config, exactly as the file holds it.
    pub config: IdeConfig,
    pub rows: Vec<SettingRow>,
    pub profiles: Vec<ProfileRow>,
    /// Path of the file the panel is editing, so the two surfaces are visibly
    /// the same thing.
    pub path: String,
}

/// A patch from the UI. Every provided field becomes a USER value.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchRequest {
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub depth: Option<String>,
    #[serde(default)]
    pub layout: Option<String>,
    #[serde(default)]
    pub permissions: Option<String>,
    #[serde(default)]
    pub harness_layers: Option<Vec<u8>>,
    #[serde(default)]
    pub automatic_checkpoints: Option<bool>,
    #[serde(default)]
    pub idle_paid_inference: Option<bool>,
}

fn store(root: &Path) -> Result<ConfigStore, String> {
    ConfigStore::open(root.join(CONFIG_DIR_REL)).map_err(|error| format!("{error:#}"))
}

fn source_of(source: ValueSource) -> String {
    match source {
        ValueSource::Default => "default",
        ValueSource::Detected => "detected",
        ValueSource::User => "user",
    }
    .to_string()
}

fn mode_of(value: &str) -> Result<BuildMode, String> {
    match value {
        "full_vibes" => Ok(BuildMode::FullVibes),
        "hybrid" => Ok(BuildMode::Hybrid),
        "spec" => Ok(BuildMode::Spec),
        other => Err(format!("modo desconhecido: {other}")),
    }
}

fn depth_of(value: &str) -> Result<Depth, String> {
    match value {
        "essential" => Ok(Depth::Essential),
        "detailed" => Ok(Depth::Detailed),
        "raw" => Ok(Depth::Raw),
        other => Err(format!("profundidade desconhecida: {other}")),
    }
}

fn layout_of(value: &str) -> Result<Layout, String> {
    match value {
        "focused" => Ok(Layout::Focused),
        "balanced" => Ok(Layout::Balanced),
        "expanded" => Ok(Layout::Expanded),
        other => Err(format!("layout desconhecido: {other}")),
    }
}

fn permissions_of(value: &str) -> Result<Permissions, String> {
    match value {
        "cautious" => Ok(Permissions::Cautious),
        "balanced" => Ok(Permissions::Balanced),
        "yolo" => Ok(Permissions::Yolo),
        other => Err(format!("permissão desconhecida: {other}")),
    }
}

fn field_of(value: &str) -> Result<ConfigField, String> {
    FIELDS
        .iter()
        .find(|(id, _, _)| *id == value)
        .map(|(_, field, _)| *field)
        .ok_or_else(|| format!("campo de configuração desconhecido: {value}"))
}

/// Renders every field with its value, its origin and its consequence.
fn rows(config: &IdeConfig) -> Vec<SettingRow> {
    FIELDS
        .iter()
        .map(|(id, field, label)| {
            let (value, source) = match field {
                ConfigField::Mode => (format!("{:?}", config.mode.value), config.mode.source),
                ConfigField::Depth => (format!("{:?}", config.depth.value), config.depth.source),
                ConfigField::Layout => (format!("{:?}", config.layout.value), config.layout.source),
                ConfigField::Permissions => (
                    format!("{:?}", config.permissions.value),
                    config.permissions.source,
                ),
                ConfigField::HarnessLayers => (
                    format!("{:?}", config.harness_layers.value),
                    config.harness_layers.source,
                ),
                ConfigField::AutomaticCheckpoints => (
                    config.automatic_checkpoints.value.to_string(),
                    config.automatic_checkpoints.source,
                ),
                ConfigField::IdlePaidInference => (
                    config.idle_paid_inference.value.to_string(),
                    config.idle_paid_inference.source,
                ),
                ConfigField::LocalAag => {
                    (config.local_aag.value.to_string(), config.local_aag.source)
                }
            };
            SettingRow {
                field: (*id).to_string(),
                label: (*label).to_string(),
                value,
                source: source_of(source),
                explain: explain(*field).to_string(),
                declared_not_wired: DECLARED_NOT_WIRED.contains(id),
            }
        })
        .collect()
}

fn snapshot_of(config: &IdeConfig) -> SettingsSnapshot {
    SettingsSnapshot {
        config: config.clone(),
        rows: rows(config),
        profiles: available_profiles()
            .iter()
            .map(|profile| ProfileRow {
                name: profile.name.to_string(),
                layout: format!("{:?}", profile.layout),
                depth: format!("{:?}", profile.depth),
            })
            .collect(),
        path: format!("{CONFIG_DIR_REL}/config.json"),
    }
}

pub fn snapshot(root: &Path) -> Result<SettingsSnapshot, String> {
    let store = store(root)?;
    Ok(snapshot_of(store.config()))
}

/// Applies edits from the UI. An unknown value FAILS instead of falling back to
/// a default — silently storing something the caller did not ask for is how a
/// settings panel starts lying about the file.
pub fn patch(root: &Path, request: PatchRequest) -> Result<SettingsSnapshot, String> {
    let patch = ConfigPatch {
        mode: request.mode.as_deref().map(mode_of).transpose()?,
        depth: request.depth.as_deref().map(depth_of).transpose()?,
        layout: request.layout.as_deref().map(layout_of).transpose()?,
        permissions: request
            .permissions
            .as_deref()
            .map(permissions_of)
            .transpose()?,
        harness_layers: request.harness_layers,
        automatic_checkpoints: request.automatic_checkpoints,
        idle_paid_inference: request.idle_paid_inference,
    };
    let mut store = store(root)?;
    let config = store
        .apply_patch(patch)
        .map_err(|error| format!("{error:#}"))?
        .clone();
    Ok(snapshot_of(&config))
}

pub fn profile(root: &Path, name: &str) -> Result<SettingsSnapshot, String> {
    let mut store = store(root)?;
    let config = store
        .apply_profile(name)
        .map_err(|error| format!("{error:#}"))?
        .clone();
    Ok(snapshot_of(&config))
}

/// Resets one field to its reversible default, source included.
pub fn reset(root: &Path, field: &str) -> Result<SettingsSnapshot, String> {
    let field = field_of(field)?;
    let mut store = store(root)?;
    let config = store
        .reset_field(field)
        .map_err(|error| format!("{error:#}"))?
        .clone();
    Ok(snapshot_of(&config))
}

/// Applies reversible defaults from what §1's capability detection observed.
///
/// The engine only touches settings still at `default`/`detected`; a user choice
/// survives detection, which is the whole reason the source is recorded.
pub fn detected(
    root: &Path,
    git: bool,
    agent: bool,
    aag: bool,
) -> Result<SettingsSnapshot, String> {
    let mut store = store(root)?;
    let config = store
        .apply_detected_defaults(DetectedEnvironment { git, agent, aag })
        .map_err(|error| format!("{error:#}"))?
        .clone();
    Ok(snapshot_of(&config))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    /// A fresh project reports every field as a reversible DEFAULT, with the
    /// consequence text and the path of the file the panel edits.
    #[test]
    fn a_fresh_config_is_all_defaults_and_says_where_it_lives() {
        let dir = project();

        let snapshot = snapshot(dir.path()).expect("snapshot");

        assert_eq!(snapshot.rows.len(), 8);
        assert!(snapshot.rows.iter().all(|row| row.source == "default"));
        assert!(snapshot.rows.iter().all(|row| !row.explain.is_empty()));
        assert_eq!(snapshot.path, ".instrument/config.json");
        assert_eq!(snapshot.profiles.len(), 3);
    }

    /// An edit becomes a USER value, and detection afterwards does not take it
    /// back — that is what recording the source is for.
    #[test]
    fn a_user_choice_survives_detection() {
        let dir = project();
        patch(
            dir.path(),
            PatchRequest {
                permissions: Some("yolo".to_string()),
                ..PatchRequest::default()
            },
        )
        .expect("patch");

        let after = detected(dir.path(), true, false, false).expect("detected");

        let permissions = after
            .rows
            .iter()
            .find(|row| row.field == "permissions")
            .expect("linha de permissões");
        assert_eq!(permissions.source, "user");
        assert_eq!(permissions.value, "Yolo", "detecção não desfaz escolha");
    }

    /// With no agent detected, the cautious default is applied AS DETECTED, so it
    /// can be explained and reset.
    #[test]
    fn detection_lowers_permissions_and_stays_resettable() {
        let dir = project();

        let after = detected(dir.path(), true, false, true).expect("detected");
        let permissions = after
            .rows
            .iter()
            .find(|row| row.field == "permissions")
            .unwrap();
        assert_eq!(permissions.value, "Cautious");
        assert_eq!(permissions.source, "detected");

        let reset_back = reset(dir.path(), "permissions").expect("reset");
        let permissions = reset_back
            .rows
            .iter()
            .find(|row| row.field == "permissions")
            .unwrap();
        assert_eq!(permissions.value, "Balanced");
        assert_eq!(permissions.source, "default");
    }

    /// An unknown value fails instead of storing something nobody asked for.
    #[test]
    fn an_unknown_value_is_refused() {
        let dir = project();

        let error = patch(
            dir.path(),
            PatchRequest {
                mode: Some("turbo".to_string()),
                ..PatchRequest::default()
            },
        )
        .expect_err("recusa");

        assert!(error.contains("modo desconhecido"), "{error}");
        // And nothing was written: the config is still all defaults.
        assert!(snapshot(dir.path())
            .unwrap()
            .rows
            .iter()
            .all(|row| row.source == "default"));
    }

    /// The panel and the file are the same thing: an edit through the panel is
    /// visible in `config.json`, and an unknown field name is refused.
    #[test]
    fn the_panel_edits_the_same_file_the_person_can_edit() {
        let dir = project();

        profile(dir.path(), "amplo").expect("profile");

        let raw = std::fs::read_to_string(dir.path().join(".instrument/config.json"))
            .expect("config.json existe");
        assert!(raw.contains("\"expanded\""), "{raw}");
        assert!(raw.contains("\"user\""), "perfil grava valor de pessoa");
        assert!(reset(dir.path(), "nao-existe").is_err());
    }

    /// Fields nothing consumes yet are marked, not hidden — hiding them would
    /// make the panel and the file disagree.
    #[test]
    fn declared_but_unwired_fields_are_marked() {
        let dir = project();

        let snapshot = snapshot(dir.path()).expect("snapshot");

        let wired: Vec<&str> = snapshot
            .rows
            .iter()
            .filter(|row| row.declared_not_wired)
            .map(|row| row.field.as_str())
            .collect();
        assert_eq!(wired, vec!["harnessLayers", "localAag"]);
    }
}
