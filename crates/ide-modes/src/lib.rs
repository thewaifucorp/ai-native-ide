//! Build-mode interruption policy and prototype promotion.
//!
//! Full Vibes, Spec and Hybrid operate over the same project and switch without
//! migration: the mode changes *when* the IDE pauses for a decision, never the
//! artifacts, evidence or compatibility. This crate keeps that policy
//! deterministic and shell-neutral so every mode decision is testable and the
//! host applies it before a durable effect.

use ide_config::BuildMode;
use serde::{Deserialize, Serialize};

/// Whether an effect targets a throwaway prototype or durable project state.
/// Hybrid distinguishes the two; the other modes treat both by their mode rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectClass {
    Prototype,
    Durable,
}

/// What the mode requires before a controllable effect proceeds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InterruptionDecision {
    /// Proceed without pausing.
    Proceed,
    /// Proceed but record a reviewable hypothesis/debt (Full Vibes).
    ProceedRecordingHypothesis,
    /// Take a checkpoint the user can reconcile before promotion (Hybrid durable).
    RequireCheckpoint,
    /// Resolve the relevant contract/spec before the durable effect (Spec).
    ResolveContractFirst,
}

/// Deterministic interruption policy. A prototype is never blocked; durable
/// effects follow the mode's rule. Nothing here migrates state between modes.
pub fn interruption_policy(mode: BuildMode, class: EffectClass) -> InterruptionDecision {
    match (mode, class) {
        (_, EffectClass::Prototype) => InterruptionDecision::Proceed,
        (BuildMode::FullVibes, EffectClass::Durable) => {
            InterruptionDecision::ProceedRecordingHypothesis
        }
        (BuildMode::Hybrid, EffectClass::Durable) => InterruptionDecision::RequireCheckpoint,
        (BuildMode::Spec, EffectClass::Durable) => InterruptionDecision::ResolveContractFirst,
    }
}

/// A prototype promotion that must carry a reconciliation before it is durable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotionRecord {
    pub prototype_effect_id: String,
    pub checkpoint_effect_id: String,
    pub reconciled: bool,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromotionError {
    /// Promotion outside Hybrid is meaningless: the other modes have no
    /// throwaway-vs-durable distinction to reconcile.
    NotHybrid,
    MissingCheckpoint,
}

impl std::fmt::Display for PromotionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotHybrid => {
                write!(formatter, "prototype promotion only applies in Hybrid mode")
            }
            Self::MissingCheckpoint => {
                write!(formatter, "promotion requires a checkpoint effect id")
            }
        }
    }
}

impl std::error::Error for PromotionError {}

/// Promotes a Hybrid prototype to durable state. The promotion is only valid in
/// Hybrid, must reference a real checkpoint, and starts unreconciled so the user
/// resolves the divergence between prototype and durable intent explicitly.
pub fn promote_prototype(
    mode: BuildMode,
    prototype_effect_id: &str,
    checkpoint_effect_id: &str,
    note: &str,
) -> Result<PromotionRecord, PromotionError> {
    if mode != BuildMode::Hybrid {
        return Err(PromotionError::NotHybrid);
    }
    if checkpoint_effect_id.trim().is_empty() {
        return Err(PromotionError::MissingCheckpoint);
    }
    Ok(PromotionRecord {
        prototype_effect_id: prototype_effect_id.to_owned(),
        checkpoint_effect_id: checkpoint_effect_id.to_owned(),
        reconciled: false,
        note: note.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prototypes_never_interrupt_in_any_mode() {
        for mode in [BuildMode::FullVibes, BuildMode::Hybrid, BuildMode::Spec] {
            assert_eq!(
                interruption_policy(mode, EffectClass::Prototype),
                InterruptionDecision::Proceed
            );
        }
    }

    #[test]
    fn durable_effects_follow_the_mode_rule() {
        assert_eq!(
            interruption_policy(BuildMode::FullVibes, EffectClass::Durable),
            InterruptionDecision::ProceedRecordingHypothesis
        );
        assert_eq!(
            interruption_policy(BuildMode::Hybrid, EffectClass::Durable),
            InterruptionDecision::RequireCheckpoint
        );
        assert_eq!(
            interruption_policy(BuildMode::Spec, EffectClass::Durable),
            InterruptionDecision::ResolveContractFirst
        );
    }

    #[test]
    fn promotion_requires_hybrid_and_a_checkpoint() {
        assert_eq!(
            promote_prototype(BuildMode::Spec, "proto", "check", "n"),
            Err(PromotionError::NotHybrid)
        );
        assert_eq!(
            promote_prototype(BuildMode::Hybrid, "proto", "  ", "n"),
            Err(PromotionError::MissingCheckpoint)
        );
        let record = promote_prototype(BuildMode::Hybrid, "proto", "check", "promoveu").unwrap();
        assert!(!record.reconciled);
        assert_eq!(record.checkpoint_effect_id, "check");
    }
}
