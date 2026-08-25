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

/// Panel density and spread of the workspace. Layout only rearranges panels; it
/// never changes what the IDE can do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Layout {
    /// A single working panel with everything else collapsed, for a distraction-free view.
    Focused,
    /// A moderate split that keeps the main panel plus the most useful side panels.
    Balanced,
    /// Every panel spread out at once, maximizing visible context.
    Expanded,
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

/// A scope that a permission override applies to. Each field is optional; a
/// `None` field means "any", so an empty scope matches every context. More
/// `Some` fields matched means a more specific scope.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PolicyScope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
}

impl PolicyScope {
    /// Whether this scope applies to the given context. A `Some` field must
    /// equal the corresponding context value; a `None` field matches anything.
    fn matches(&self, project: Option<&str>, resource: Option<&str>, tool: Option<&str>) -> bool {
        field_matches(self.project.as_deref(), project)
            && field_matches(self.resource.as_deref(), resource)
            && field_matches(self.tool.as_deref(), tool)
    }

    /// How specific this scope is: the number of constrained (`Some`) fields.
    fn specificity(&self) -> usize {
        self.project.is_some() as usize
            + self.resource.is_some() as usize
            + self.tool.is_some() as usize
    }
}

/// A permission value scoped to a specific project, resource and/or tool. This
/// is an additive overlay on top of the global `permissions` setting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedPermission {
    pub scope: PolicyScope,
    pub permissions: Permissions,
}

/// Returns whether a scope field (`Some` = constrained, `None` = any) matches a
/// context field. A constrained field only matches an equal, present context.
fn field_matches(scope_field: Option<&str>, context_field: Option<&str>) -> bool {
    match scope_field {
        None => true,
        Some(expected) => context_field == Some(expected),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeConfig {
    pub mode: Setting<BuildMode>,
    pub depth: Setting<Depth>,
    pub layout: Setting<Layout>,
    pub permissions: Setting<Permissions>,
    pub harness_layers: Setting<Vec<u8>>,
    pub automatic_checkpoints: Setting<bool>,
    pub idle_paid_inference: Setting<bool>,
    pub local_aag: Setting<bool>,
    /// Scoped permission overrides, applied on top of the global `permissions`
    /// value. Empty by default; old snapshots without this field still parse.
    #[serde(default)]
    pub scoped_permissions: Vec<ScopedPermission>,
}

impl Default for IdeConfig {
    fn default() -> Self {
        Self {
            mode: Setting::default_value(BuildMode::Hybrid),
            depth: Setting::default_value(Depth::Essential),
            layout: Setting::default_value(Layout::Balanced),
            permissions: Setting::default_value(Permissions::Balanced),
            harness_layers: Setting::default_value(vec![0, 1]),
            automatic_checkpoints: Setting::default_value(true),
            idle_paid_inference: Setting::default_value(false),
            local_aag: Setting::default_value(false),
            scoped_permissions: Vec::new(),
        }
    }
}

impl IdeConfig {
    /// Resolves the effective permission for a context by picking the most
    /// specific matching scoped override (more constrained fields matched wins),
    /// falling back to the global `permissions` value when nothing matches. Ties
    /// on specificity resolve to the last matching override, so a later
    /// `set_scoped_permission` overrides an earlier equally-specific one.
    pub fn resolve_permissions(
        &self,
        project: Option<&str>,
        resource: Option<&str>,
        tool: Option<&str>,
    ) -> Permissions {
        let mut best: Option<(usize, Permissions)> = None;
        for scoped in &self.scoped_permissions {
            if scoped.scope.matches(project, resource, tool) {
                let specificity = scoped.scope.specificity();
                if best.is_none_or(|(current, _)| specificity >= current) {
                    best = Some((specificity, scoped.permissions));
                }
            }
        }
        best.map_or(self.permissions.value, |(_, permissions)| permissions)
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
    pub layout: Option<Layout>,
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
    Layout,
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
        if let Some(layout) = patch.layout {
            self.config.layout = user(layout);
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

    /// Applies a named layout profile, setting both `layout` and `depth` as user
    /// values (so each stays resettable). An unknown name is an error, not a panic.
    pub fn apply_profile(&mut self, name: &str) -> anyhow::Result<&IdeConfig> {
        let profile = LayoutProfile::builtin(name)
            .with_context(|| format!("unknown layout profile {name:?}"))?;
        self.config.layout = user(profile.layout);
        self.config.depth = user(profile.depth);
        self.persist()?;
        Ok(&self.config)
    }

    /// Resets one field to its reversible default source and value.
    pub fn reset_field(&mut self, field: ConfigField) -> anyhow::Result<&IdeConfig> {
        let defaults = IdeConfig::default();
        match field {
            ConfigField::Mode => self.config.mode = defaults.mode,
            ConfigField::Depth => self.config.depth = defaults.depth,
            ConfigField::Layout => self.config.layout = defaults.layout,
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

    /// Sets a scoped permission override, replacing any existing override with
    /// the exact same scope so the newest value wins for that scope.
    pub fn set_scoped_permission(
        &mut self,
        scope: PolicyScope,
        permissions: Permissions,
    ) -> anyhow::Result<&IdeConfig> {
        if let Some(existing) = self
            .config
            .scoped_permissions
            .iter_mut()
            .find(|s| s.scope == scope)
        {
            existing.permissions = permissions;
        } else {
            self.config
                .scoped_permissions
                .push(ScopedPermission { scope, permissions });
        }
        self.persist()?;
        Ok(&self.config)
    }

    /// Removes the scoped permission override with the exact given scope, if any.
    /// Removing a missing scope is a no-op, not an error.
    pub fn clear_scoped_permission(&mut self, scope: &PolicyScope) -> anyhow::Result<&IdeConfig> {
        self.config.scoped_permissions.retain(|s| &s.scope != scope);
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

/// A named bundle that pairs a `Layout` with a `Depth`, so one choice sets both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutProfile {
    /// Stable identifier used to select the profile.
    pub name: &'static str,
    pub layout: Layout,
    pub depth: Depth,
}

/// Built-in layout profiles, in presentation order.
const BUILTIN_PROFILES: &[LayoutProfile] = &[
    LayoutProfile {
        name: "foco",
        layout: Layout::Focused,
        depth: Depth::Essential,
    },
    LayoutProfile {
        name: "equilibrio",
        layout: Layout::Balanced,
        depth: Depth::Detailed,
    },
    LayoutProfile {
        name: "amplo",
        layout: Layout::Expanded,
        depth: Depth::Raw,
    },
];

impl LayoutProfile {
    /// Looks up a built-in profile by name, returning `None` for an unknown name.
    pub fn builtin(name: &str) -> Option<LayoutProfile> {
        BUILTIN_PROFILES.iter().copied().find(|p| p.name == name)
    }
}

/// The built-in layout profiles available to select.
pub fn available_profiles() -> &'static [LayoutProfile] {
    BUILTIN_PROFILES
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
        ConfigField::Layout => {
            "O layout só reorganiza os painéis na tela, sem mudar o que a IDE consegue fazer."
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
        assert_eq!(config.layout.value, Layout::Balanced);
        assert_eq!(config.layout.source, ValueSource::Default);
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
    fn default_layout_is_resettable() {
        let root = temp_root("layout-reset");
        let _ = fs::remove_dir_all(&root);
        let mut store = ConfigStore::open(&root).unwrap();
        store
            .apply_patch(ConfigPatch {
                layout: Some(Layout::Expanded),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(store.config().layout.source, ValueSource::User);
        let config = store.reset_field(ConfigField::Layout).unwrap();
        assert_eq!(config.layout.value, Layout::Balanced);
        assert_eq!(config.layout.source, ValueSource::Default);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn apply_profile_sets_layout_and_depth_as_user() {
        let root = temp_root("profile-apply");
        let _ = fs::remove_dir_all(&root);
        let mut store = ConfigStore::open(&root).unwrap();
        let config = store.apply_profile("amplo").unwrap();
        assert_eq!(config.layout.value, Layout::Expanded);
        assert_eq!(config.layout.source, ValueSource::User);
        assert_eq!(config.depth.value, Depth::Raw);
        assert_eq!(config.depth.source, ValueSource::User);
        // Both stay resettable to their reversible defaults.
        store.reset_field(ConfigField::Layout).unwrap();
        let config = store.reset_field(ConfigField::Depth).unwrap();
        assert_eq!(config.layout.source, ValueSource::Default);
        assert_eq!(config.depth.source, ValueSource::Default);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn unknown_profile_returns_err_without_panic() {
        let root = temp_root("profile-unknown");
        let _ = fs::remove_dir_all(&root);
        let mut store = ConfigStore::open(&root).unwrap();
        assert!(store.apply_profile("nao-existe").is_err());
        // Config is untouched by the failed lookup.
        assert_eq!(store.config().layout.value, Layout::Balanced);
        assert_eq!(store.config().layout.source, ValueSource::Default);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn available_profiles_lists_the_three_builtins() {
        let names: Vec<&str> = available_profiles().iter().map(|p| p.name).collect();
        assert_eq!(names, vec!["foco", "equilibrio", "amplo"]);
    }

    #[test]
    fn explain_covers_the_layout_field() {
        let text = explain(ConfigField::Layout);
        assert!(!text.is_empty());
        assert!(text.contains("layout"));
    }

    fn scope(project: Option<&str>, resource: Option<&str>, tool: Option<&str>) -> PolicyScope {
        PolicyScope {
            project: project.map(str::to_owned),
            resource: resource.map(str::to_owned),
            tool: tool.map(str::to_owned),
        }
    }

    #[test]
    fn resolve_permissions_falls_back_to_global_when_no_scope_matches() {
        let config = IdeConfig::default();
        assert_eq!(
            config.resolve_permissions(Some("proj"), Some("res"), Some("tool")),
            Permissions::Balanced
        );
    }

    #[test]
    fn per_tool_override_wins_over_global() {
        let root = temp_root("scope-tool");
        let _ = fs::remove_dir_all(&root);
        let mut store = ConfigStore::open(&root).unwrap();
        store
            .set_scoped_permission(scope(None, None, Some("shell")), Permissions::Cautious)
            .unwrap();
        // Matching tool takes the override; a different tool falls back to global.
        assert_eq!(
            store
                .config()
                .resolve_permissions(Some("proj"), None, Some("shell")),
            Permissions::Cautious
        );
        assert_eq!(
            store
                .config()
                .resolve_permissions(Some("proj"), None, Some("editor")),
            Permissions::Balanced
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn more_specific_scope_beats_project_only() {
        let root = temp_root("scope-specific");
        let _ = fs::remove_dir_all(&root);
        let mut store = ConfigStore::open(&root).unwrap();
        store
            .set_scoped_permission(scope(Some("proj"), None, None), Permissions::Cautious)
            .unwrap();
        store
            .set_scoped_permission(
                scope(Some("proj"), Some("db"), Some("shell")),
                Permissions::Yolo,
            )
            .unwrap();
        // The full project+resource+tool match wins over the project-only one.
        assert_eq!(
            store
                .config()
                .resolve_permissions(Some("proj"), Some("db"), Some("shell")),
            Permissions::Yolo
        );
        // A context that only matches the project-only override still resolves it.
        assert_eq!(
            store
                .config()
                .resolve_permissions(Some("proj"), Some("cache"), Some("editor")),
            Permissions::Cautious
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn clear_scoped_permission_restores_fallback() {
        let root = temp_root("scope-clear");
        let _ = fs::remove_dir_all(&root);
        let mut store = ConfigStore::open(&root).unwrap();
        let tool_scope = scope(None, None, Some("shell"));
        store
            .set_scoped_permission(tool_scope.clone(), Permissions::Yolo)
            .unwrap();
        assert_eq!(
            store.config().resolve_permissions(None, None, Some("shell")),
            Permissions::Yolo
        );
        let config = store.clear_scoped_permission(&tool_scope).unwrap();
        assert!(config.scoped_permissions.is_empty());
        assert_eq!(
            store.config().resolve_permissions(None, None, Some("shell")),
            Permissions::Balanced
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn old_snapshots_without_scoped_permissions_still_parse() {
        let json = r#"{
            "mode": {"value": "hybrid", "source": "default"},
            "depth": {"value": "essential", "source": "default"},
            "layout": {"value": "balanced", "source": "default"},
            "permissions": {"value": "balanced", "source": "default"},
            "harnessLayers": {"value": [0, 1], "source": "default"},
            "automaticCheckpoints": {"value": true, "source": "default"},
            "idlePaidInference": {"value": false, "source": "default"},
            "localAag": {"value": false, "source": "default"}
        }"#;
        let config: IdeConfig = serde_json::from_str(json).unwrap();
        assert!(config.scoped_permissions.is_empty());
        assert_eq!(
            config.resolve_permissions(None, None, None),
            Permissions::Balanced
        );
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
