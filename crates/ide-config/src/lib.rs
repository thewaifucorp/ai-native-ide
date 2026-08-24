//! Local configuration for the AI-Native IDE.
//!
//! One schema backs both the simple UI and the full file: `config.json` is the
//! single source of truth and every field is the same value the UI edits. Each
//! setting records whether it came from a reversible default, from capability
//! detection, or from the user, so a detected default can always be explained
//! and reset. No paid inference runs in idle by default.

use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildMode {
    FullVibes,
    Hybrid,
    Spec,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Depth {
    Essential,
    Detailed,
    Raw,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permissions {
    Cautious,
    Balanced,
    Yolo,
}

/// Where a setting's current value came from. A detected or default value can be
/// explained and reset; a user value is never overwritten by detection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueSource {
    Default,
    Detected,
    User,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting<T> {
    pub value: T,
    pub source: ValueSource,
}

impl<T> Setting<T> {
    fn default_value(value: T) -> Self {
        Self {
            value,
            source: ValueSource::Default,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeConfig {
    pub mode: Setting<BuildMode>,
    pub depth: Setting<Depth>,
    pub permissions: Setting<Permissions>,
    pub harness_layers: Setting<Vec<u8>>,
    pub automatic_checkpoints: Setting<bool>,
    pub idle_paid_inference: Setting<bool>,
    pub local_aag: Setting<bool>,
}

impl Default for IdeConfig {
    fn default() -> Self {
        Self {
            mode: Setting::default_value(BuildMode::Hybrid),
            depth: Setting::default_value(Depth::Essential),
            permissions: Setting::default_value(Permissions::Balanced),
            harness_layers: Setting::default_value(vec![0, 1]),
            automatic_checkpoints: Setting::default_value(true),
            idle_paid_inference: Setting::default_value(false),
            local_aag: Setting::default_value(false),
        }
    }
}

/// Capabilities the host detected. They drive reversible defaults only; a user
/// value is never silently overwritten.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DetectedEnvironment {
    pub git: bool,
    pub agent: bool,
    pub aag: bool,
}

/// A partial update from the simple UI or the full file. Every provided field
/// becomes a user value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPatch {
    pub mode: Option<BuildMode>,
    pub depth: Option<Depth>,
    pub permissions: Option<Permissions>,
    pub harness_layers: Option<Vec<u8>>,
    pub automatic_checkpoints: Option<bool>,
    pub idle_paid_inference: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigField {
    Mode,
    Depth,
    Permissions,
    HarnessLayers,
    AutomaticCheckpoints,
    IdlePaidInference,
    LocalAag,
}

pub struct ConfigStore {
    path: PathBuf,
    config: IdeConfig,
}

impl ConfigStore {
    pub fn open(root: impl AsRef<Path>) -> anyhow::Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root)
            .with_context(|| format!("create config directory {}", root.display()))?;
        let path = root.join("config.json");
        let config = if path.exists() {
            let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
            serde_json::from_slice::<IdeConfig>(&bytes)
                .with_context(|| format!("parse {}", path.display()))?
        } else {
            IdeConfig::default()
        };
        Ok(Self { path, config })
    }

    pub fn config(&self) -> &IdeConfig {
        &self.config
    }

    /// Applies reversible defaults from detected capabilities. Only settings that
    /// are still at a default/detected source are touched; user choices are kept.
    pub fn apply_detected_defaults(
        &mut self,
        detected: DetectedEnvironment,
    ) -> anyhow::Result<&IdeConfig> {
        if self.config.local_aag.source != ValueSource::User {
            self.config.local_aag = Setting {
                value: detected.aag,
                source: ValueSource::Detected,
            };
        }
        // With no agent detected, a cautious default is safer, but never override
        // a user choice.
        if self.config.permissions.source != ValueSource::User && !detected.agent {
            self.config.permissions = Setting {
                value: Permissions::Cautious,
                source: ValueSource::Detected,
            };
        }
        self.persist()?;
        Ok(&self.config)
    }

    pub fn apply_patch(&mut self, patch: ConfigPatch) -> anyhow::Result<&IdeConfig> {
        if let Some(mode) = patch.mode {
            self.config.mode = user(mode);
        }
        if let Some(depth) = patch.depth {
            self.config.depth = user(depth);
        }
        if let Some(permissions) = patch.permissions {
            self.config.permissions = user(permissions);
        }
        if let Some(layers) = patch.harness_layers {
            self.config.harness_layers = user(layers);
        }
        if let Some(checkpoints) = patch.automatic_checkpoints {
            self.config.automatic_checkpoints = user(checkpoints);
        }
        if let Some(idle) = patch.idle_paid_inference {
            self.config.idle_paid_inference = user(idle);
        }
        self.persist()?;
        Ok(&self.config)
    }

    /// Resets one field to its reversible default source and value.
    pub fn reset_field(&mut self, field: ConfigField) -> anyhow::Result<&IdeConfig> {
        let defaults = IdeConfig::default();
        match field {
            ConfigField::Mode => self.config.mode = defaults.mode,
            ConfigField::Depth => self.config.depth = defaults.depth,
            ConfigField::Permissions => self.config.permissions = defaults.permissions,
            ConfigField::HarnessLayers => self.config.harness_layers = defaults.harness_layers,
            ConfigField::AutomaticCheckpoints => {
                self.config.automatic_checkpoints = defaults.automatic_checkpoints
            }
            ConfigField::IdlePaidInference => {
                self.config.idle_paid_inference = defaults.idle_paid_inference
            }
            ConfigField::LocalAag => self.config.local_aag = defaults.local_aag,
        }
        self.persist()?;
        Ok(&self.config)
    }

    fn persist(&self) -> anyhow::Result<()> {
        let json = serde_json::to_vec_pretty(&self.config)?;
        fs::write(&self.path, json).with_context(|| format!("write {}", self.path.display()))?;
        Ok(())
    }
}

fn user<T>(value: T) -> Setting<T> {
    Setting {
        value,
        source: ValueSource::User,
    }
}

/// Plain-language consequence of a setting, shown just-in-time.
pub fn explain(field: ConfigField) -> &'static str {
    match field {
        ConfigField::Mode => {
            "O modo muda quando a IDE pausa para decisões, sem migrar o projeto."
        }
        ConfigField::Depth => {
            "A profundidade muda quanto detalhe aparece, não o que a IDE consegue fazer."
        }
        ConfigField::Permissions => {
            "As permissões controlam quando um efeito exige aprovação explícita."
        }
        ConfigField::HarnessLayers => {
            "As camadas do harness escolhem quais checks rodam; a Camada 0 é determinística."
        }
        ConfigField::AutomaticCheckpoints => {
            "Checkpoints automáticos guardam um snapshot antes de cada mudança para permitir rollback."
        }
        ConfigField::IdlePaidInference => {
            "Inferência paga em idle fica desligada por padrão; nada pago roda sem você pedir."
        }
        ConfigField::LocalAag => {
            "AAG local melhora navegação quando presente; sua ausência vira unknown, sem quebrar nada."
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ide-config-{tag}-{}", std::process::id()))
    }

    #[test]
    fn defaults_are_hybrid_essential_balanced_no_idle_inference() {
        let config = IdeConfig::default();
        assert_eq!(config.mode.value, BuildMode::Hybrid);
        assert_eq!(config.depth.value, Depth::Essential);
        assert_eq!(config.permissions.value, Permissions::Balanced);
        assert_eq!(config.harness_layers.value, vec![0, 1]);
        assert!(config.automatic_checkpoints.value);
        assert!(!config.idle_paid_inference.value);
    }

    #[test]
    fn detection_sets_reversible_defaults_without_overriding_user() {
        let root = temp_root("detect");
        let _ = fs::remove_dir_all(&root);
        let mut store = ConfigStore::open(&root).unwrap();
        store
            .apply_patch(ConfigPatch {
                permissions: Some(Permissions::Yolo),
                ..Default::default()
            })
            .unwrap();
        let config = store
            .apply_detected_defaults(DetectedEnvironment {
                git: true,
                agent: false,
                aag: true,
            })
            .unwrap();
        // AAG detected → reversible default; permissions stay the user's YOLO.
        assert!(config.local_aag.value);
        assert_eq!(config.local_aag.source, ValueSource::Detected);
        assert_eq!(config.permissions.value, Permissions::Yolo);
        assert_eq!(config.permissions.source, ValueSource::User);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reset_returns_to_default_source() {
        let root = temp_root("reset");
        let _ = fs::remove_dir_all(&root);
        let mut store = ConfigStore::open(&root).unwrap();
        store
            .apply_patch(ConfigPatch {
                mode: Some(BuildMode::Spec),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(store.config().mode.source, ValueSource::User);
        let config = store.reset_field(ConfigField::Mode).unwrap();
        assert_eq!(config.mode.value, BuildMode::Hybrid);
        assert_eq!(config.mode.source, ValueSource::Default);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn config_reloads_the_same_state_from_file() {
        let root = temp_root("reload");
        let _ = fs::remove_dir_all(&root);
        {
            let mut store = ConfigStore::open(&root).unwrap();
            store
                .apply_patch(ConfigPatch {
                    depth: Some(Depth::Raw),
                    ..Default::default()
                })
                .unwrap();
        }
        let store = ConfigStore::open(&root).unwrap();
        assert_eq!(store.config().depth.value, Depth::Raw);
        assert_eq!(store.config().depth.source, ValueSource::User);
        fs::remove_dir_all(&root).unwrap();
    }
}
