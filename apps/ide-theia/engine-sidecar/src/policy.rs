//! §14 — modes and permissions are POLICY, not decoration.
//!
//! `ide_modes` already decided, deterministically, what a mode and a permission
//! level require before a controllable effect runs. Nothing consumed it: the
//! governed-write path always asked for approval, so `Cautious`, `Balanced` and
//! `Yolo` produced the same behaviour and the config file described a rule that
//! did not exist. This module is the consumer.
//!
//! # What it does NOT do
//!
//! It never executes anything and it never lets an effect skip the broker. `Yolo`
//! changes WHEN the IDE asks, never whether the effect is proposed, snapshotted
//! and recorded — an auto-approved write still crosses `WorkspaceEffectBroker`
//! and still has a rollback. A mode that could bypass the broker would make the
//! whole receipt trail a lie, which is the opposite of what modes are for.
//!
//! # Where the values come from
//!
//! `.instrument/config.json`, through `ide_config` — the same file and schema the
//! §13 panel edits. Scoped overrides (project/resource/tool) resolve here too, so
//! "this one tool is trusted" is a real rule and not a second settings system.

use ide_config::{BuildMode, ConfigStore, Permissions};
use ide_modes::{
    effect_policy, interruption_policy, EffectClass, EffectPolicyDecision, InterruptionDecision,
};
use serde::Serialize;
use std::path::Path;

const CONFIG_DIR_REL: &str = ".instrument";

/// One policy answer, ready for a decision card: what decided, what it decided,
/// and the sentence that explains it to the person who has to live with it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDecision {
    /// `full_vibes` | `hybrid` | `spec`.
    pub mode: String,
    /// The EFFECTIVE permission for this context, override included.
    pub permissions: String,
    /// True when a scoped override — not the global value — decided this.
    pub scoped: bool,
    /// `prototype` | `durable`.
    pub class: String,
    /// `require_approval` | `auto_approve_recorded`.
    pub effect: String,
    /// What the MODE asks around the effect: `proceed`, `proceed_recording_hypothesis`,
    /// `require_checkpoint` or `resolve_contract_first`.
    pub interruption: String,
    /// Plain sentence naming what decided and what follows from it.
    pub explain: String,
}

fn class_of(value: &str) -> Result<EffectClass, String> {
    match value {
        "prototype" => Ok(EffectClass::Prototype),
        "durable" => Ok(EffectClass::Durable),
        other => Err(format!("classe de efeito desconhecida: {other}")),
    }
}

fn mode_name(mode: BuildMode) -> &'static str {
    match mode {
        BuildMode::FullVibes => "full_vibes",
        BuildMode::Hybrid => "hybrid",
        BuildMode::Spec => "spec",
    }
}

fn mode_label(mode: BuildMode) -> &'static str {
    match mode {
        BuildMode::FullVibes => "Full Vibes",
        BuildMode::Hybrid => "Hybrid",
        BuildMode::Spec => "Spec",
    }
}

fn permissions_name(permissions: Permissions) -> &'static str {
    match permissions {
        Permissions::Cautious => "cautious",
        Permissions::Balanced => "balanced",
        Permissions::Yolo => "yolo",
    }
}

fn interruption_name(decision: InterruptionDecision) -> &'static str {
    match decision {
        InterruptionDecision::Proceed => "proceed",
        InterruptionDecision::ProceedRecordingHypothesis => "proceed_recording_hypothesis",
        InterruptionDecision::RequireCheckpoint => "require_checkpoint",
        InterruptionDecision::ResolveContractFirst => "resolve_contract_first",
    }
}

/// What the mode asks AROUND the effect. Said out loud even where the IDE does
/// not enforce it yet: a rule nobody applies is still a rule the person should
/// see, and pretending it is enforced would be worse than saying it is not.
fn interruption_sentence(decision: InterruptionDecision) -> &'static str {
    match decision {
        InterruptionDecision::Proceed => "não pede nada em volta do efeito",
        InterruptionDecision::ProceedRecordingHypothesis => {
            "segue registrando hipótese revisável em vez de parar"
        }
        InterruptionDecision::RequireCheckpoint => "pede checkpoint antes de promover",
        InterruptionDecision::ResolveContractFirst => "pede o contrato resolvido antes",
    }
}

fn explain(
    mode: BuildMode,
    permissions: Permissions,
    class: EffectClass,
    effect: EffectPolicyDecision,
    interruption: InterruptionDecision,
    scoped: bool,
) -> String {
    let source = if scoped {
        "permissão com escopo próprio"
    } else {
        "permissão do projeto"
    };
    let head = match (effect, class) {
        (EffectPolicyDecision::RequireApproval, _) => format!(
            "{} ({source} {}): efeito durável exige sua aprovação explícita",
            mode_label(mode),
            permissions_name(permissions)
        ),
        (EffectPolicyDecision::AutoApproveRecorded, EffectClass::Durable) => format!(
            "{} ({source} yolo): aprovado sem perguntar — mas o efeito passou pelo broker, \
             tem snapshot e recibo, e Reverter continua disponível",
            mode_label(mode)
        ),
        (EffectPolicyDecision::AutoApproveRecorded, EffectClass::Prototype) => format!(
            "{}: efeito de protótipo não pergunta — e mesmo assim passa pelo broker, \
             com snapshot e recibo",
            mode_label(mode)
        ),
    };
    format!("{head} · o modo {}", interruption_sentence(interruption))
}

/// Resolves the effective policy for one effect in one context.
///
/// `resource` and `tool` are what scoped overrides match on: a write names the
/// file it touches, an agent effect names the tool that asked. Passing them keeps
/// "trust this tool here" a real, resolvable rule.
pub fn decide(
    root: &Path,
    class: &str,
    project: Option<&str>,
    resource: Option<&str>,
    tool: Option<&str>,
) -> Result<PolicyDecision, String> {
    let class = class_of(class)?;
    let store =
        ConfigStore::open(root.join(CONFIG_DIR_REL)).map_err(|error| format!("{error:#}"))?;
    let config = store.config();
    let mode = config.mode.value;
    let permissions = config.resolve_permissions(project, resource, tool);
    let scoped = permissions != config.permissions.value;
    let effect = effect_policy(permissions, class);
    let interruption = interruption_policy(mode, class);
    Ok(PolicyDecision {
        mode: mode_name(mode).to_string(),
        permissions: permissions_name(permissions).to_string(),
        scoped,
        class: match class {
            EffectClass::Prototype => "prototype".to_string(),
            EffectClass::Durable => "durable".to_string(),
        },
        effect: match effect {
            EffectPolicyDecision::RequireApproval => "require_approval".to_string(),
            EffectPolicyDecision::AutoApproveRecorded => "auto_approve_recorded".to_string(),
        },
        interruption: interruption_name(interruption).to_string(),
        explain: explain(mode, permissions, class, effect, interruption, scoped),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_config::{ConfigPatch, PolicyScope};

    fn project_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn set_permissions(root: &Path, permissions: Permissions) {
        let mut store = ConfigStore::open(root.join(CONFIG_DIR_REL)).expect("store");
        store
            .apply_patch(ConfigPatch {
                permissions: Some(permissions),
                ..ConfigPatch::default()
            })
            .expect("patch");
    }

    /// The default project asks. This is the invariant everything else is
    /// measured against: nothing auto-approves until someone chose Yolo.
    #[test]
    fn a_fresh_project_requires_approval_for_a_durable_effect() {
        let dir = project_dir();

        let decision = decide(dir.path(), "durable", None, Some("README.md"), None).expect("decide");

        assert_eq!(decision.effect, "require_approval");
        assert_eq!(decision.permissions, "balanced");
        assert_eq!(decision.mode, "hybrid");
        assert!(!decision.scoped);
    }

    #[test]
    fn yolo_auto_approves_and_the_sentence_says_the_receipt_survives() {
        let dir = project_dir();
        set_permissions(dir.path(), Permissions::Yolo);

        let decision = decide(dir.path(), "durable", None, Some("README.md"), None).expect("decide");

        assert_eq!(decision.effect, "auto_approve_recorded");
        assert!(decision.explain.contains("snapshot"));
        assert!(decision.explain.contains("Reverter"));
    }

    #[test]
    fn cautious_still_requires_approval() {
        let dir = project_dir();
        set_permissions(dir.path(), Permissions::Cautious);

        let decision = decide(dir.path(), "durable", None, None, None).expect("decide");

        assert_eq!(decision.effect, "require_approval");
    }

    /// A scoped override is a real rule, and the answer says the override — not
    /// the project-wide value — is what decided.
    #[test]
    fn a_scoped_override_decides_and_is_reported_as_scoped() {
        let dir = project_dir();
        let mut store = ConfigStore::open(dir.path().join(CONFIG_DIR_REL)).expect("store");
        store
            .set_scoped_permission(
                PolicyScope {
                    tool: Some("preview".to_string()),
                    ..PolicyScope::default()
                },
                Permissions::Yolo,
            )
            .expect("scoped");

        let scoped = decide(dir.path(), "durable", None, None, Some("preview")).expect("decide");
        let global = decide(dir.path(), "durable", None, None, Some("outro")).expect("decide");

        assert_eq!(scoped.effect, "auto_approve_recorded");
        assert!(scoped.scoped);
        assert_eq!(global.effect, "require_approval");
        assert!(!global.scoped);
    }

    #[test]
    fn the_mode_travels_with_the_answer_even_when_it_changes_nothing_here() {
        let dir = project_dir();
        let mut store = ConfigStore::open(dir.path().join(CONFIG_DIR_REL)).expect("store");
        store
            .apply_patch(ConfigPatch {
                mode: Some(BuildMode::Spec),
                ..ConfigPatch::default()
            })
            .expect("patch");

        let decision = decide(dir.path(), "durable", None, None, None).expect("decide");

        assert_eq!(decision.mode, "spec");
        assert_eq!(decision.interruption, "resolve_contract_first");
        assert!(decision.explain.contains("contrato"));
    }

    #[test]
    fn an_unknown_class_fails_instead_of_defaulting_to_the_permissive_one() {
        let dir = project_dir();

        let error = decide(dir.path(), "qualquer", None, None, None).expect_err("deve falhar");

        assert!(error.contains("classe de efeito desconhecida"));
    }
}
