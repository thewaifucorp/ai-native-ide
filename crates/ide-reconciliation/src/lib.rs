//! Deterministic, shell-neutral preview and reconciliation domain.
//!
//! This crate deliberately does not start a process, inspect a repository, or call
//! AAG. Hosts provide observed facts and causal identifiers; this core keeps their
//! provenance intact and never upgrades an unavailable provider into confidence.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewHealth {
    Starting,
    Healthy,
    Stale,
    Broken,
    Reconnecting,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewState {
    pub health: PreviewHealth,
    pub changed_at_ms: u64,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviewTransitionError {
    Invalid {
        from: PreviewHealth,
        to: PreviewHealth,
    },
    TimeWentBackwards {
        previous: u64,
        next: u64,
    },
}

impl std::fmt::Display for PreviewTransitionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid { from, to } => {
                write!(formatter, "invalid preview transition {from:?} -> {to:?}")
            }
            Self::TimeWentBackwards { previous, next } => {
                write!(
                    formatter,
                    "preview time went backwards: {next} < {previous}"
                )
            }
        }
    }
}

impl std::error::Error for PreviewTransitionError {}

/// The lifecycle owner (Tauri host in production) supplies monotonic timestamps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewSupervisor {
    state: PreviewState,
}

impl PreviewSupervisor {
    pub fn starting(at_ms: u64) -> Self {
        Self {
            state: PreviewState {
                health: PreviewHealth::Starting,
                changed_at_ms: at_ms,
                detail: None,
            },
        }
    }

    pub fn state(&self) -> &PreviewState {
        &self.state
    }

    pub fn transition(
        &mut self,
        next: PreviewHealth,
        at_ms: u64,
        detail: Option<String>,
    ) -> Result<&PreviewState, PreviewTransitionError> {
        if at_ms < self.state.changed_at_ms {
            return Err(PreviewTransitionError::TimeWentBackwards {
                previous: self.state.changed_at_ms,
                next: at_ms,
            });
        }
        if !allows_transition(&self.state.health, &next) {
            return Err(PreviewTransitionError::Invalid {
                from: self.state.health.clone(),
                to: next,
            });
        }
        self.state = PreviewState {
            health: next,
            changed_at_ms: at_ms,
            detail,
        };
        Ok(&self.state)
    }
}

fn allows_transition(from: &PreviewHealth, to: &PreviewHealth) -> bool {
    use PreviewHealth::*;
    matches!(
        (from, to),
        (Starting, Healthy | Broken | Stale)
            | (Healthy, Stale | Broken)
            | (Stale, Reconnecting | Broken | Healthy)
            | (Broken, Reconnecting | Starting)
            | (Reconnecting, Healthy | Broken | Stale)
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CausalLinks {
    /// IDs are intentionally opaque: the activity/effect brokers remain owners.
    pub effect_ids: Vec<String>,
    pub activity_ids: Vec<String>,
    pub file_paths: Vec<String>,
}

impl CausalLinks {
    pub fn is_empty(&self) -> bool {
        self.effect_ids.is_empty() && self.activity_ids.is_empty() && self.file_paths.is_empty()
    }

    /// Causal identifiers come from independent owners, but a host must not turn
    /// empty or whitespace-only values into a traceable failure.
    pub fn validate(&self) -> Result<(), PreviewEvidenceError> {
        let values = self
            .effect_ids
            .iter()
            .chain(self.activity_ids.iter())
            .chain(self.file_paths.iter());

        if self.is_empty() {
            return Err(PreviewEvidenceError::MissingCausalLinks);
        }
        if values.into_iter().any(|value| value.trim().is_empty()) {
            return Err(PreviewEvidenceError::InvalidCausalLink);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewFailure {
    pub id: String,
    pub preview_id: String,
    pub evidence_id: String,
    pub message: String,
    pub kind: PreviewFailureKind,
    pub causal_links: CausalLinks,
    pub observed_at_ms: u64,
}

/// The source of a preview failure is deliberately explicit. In particular, a
/// process exit is evidence only when its exit code is non-zero; a host cannot
/// manufacture a failed preview from a clean exit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum PreviewFailureKind {
    ProcessExited { process_id: String, exit_code: i32 },
    HealthCheckFailed { url: String, detail: String },
}

impl PreviewFailure {
    /// Converts a persisted failure into an observation that can participate in
    /// literal intent-vs-behavior reconciliation. The evidence id, rather than a
    /// host assertion, is what makes the observation eligible for detection.
    pub fn as_observation(
        &self,
        id: impl Into<String>,
        subject: impl Into<String>,
        actual: Value,
    ) -> ObservedBehavior {
        ObservedBehavior {
            id: id.into(),
            subject: subject.into(),
            actual,
            evidence_ids: vec![self.evidence_id.clone()],
            observed_at_ms: self.observed_at_ms,
        }
    }
}

/// In-memory deterministic evidence ledger. Persistence belongs to the host's
/// project store; keeping this type shell- and network-neutral makes the causal
/// rules directly testable and prevents a preview failure from becoming a UI-only
/// message.
#[derive(Debug, Default)]
pub struct PreviewEvidenceLedger {
    failures: BTreeMap<String, PreviewFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewProcessExit {
    pub id: String,
    pub preview_id: String,
    pub evidence_id: String,
    pub process_id: String,
    pub exit_code: i32,
    pub message: String,
    pub causal_links: CausalLinks,
    pub observed_at_ms: u64,
}

/// An observation supplied by the host after it actually runs a health check.
/// This separates a clean response from a failed probe before either can become
/// evidence in the ledger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "outcome")]
pub enum PreviewHealthCheckObservation {
    Healthy,
    Failed { detail: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewHealthCheck {
    pub id: String,
    pub preview_id: String,
    pub evidence_id: String,
    pub url: String,
    pub observation: PreviewHealthCheckObservation,
    pub causal_links: CausalLinks,
    pub observed_at_ms: u64,
}

impl PreviewEvidenceLedger {
    pub fn record_nonzero_process_exit(
        &mut self,
        exit: PreviewProcessExit,
    ) -> Result<&PreviewFailure, PreviewEvidenceError> {
        if exit.id.trim().is_empty()
            || exit.preview_id.trim().is_empty()
            || exit.evidence_id.trim().is_empty()
            || exit.process_id.trim().is_empty()
            || exit.message.trim().is_empty()
        {
            return Err(PreviewEvidenceError::MissingRequiredField);
        }
        if exit.exit_code == 0 {
            return Err(PreviewEvidenceError::CleanProcessExit);
        }
        exit.causal_links.validate()?;
        if self.failures.contains_key(&exit.id) {
            return Err(PreviewEvidenceError::DuplicateFailure(exit.id));
        }

        self.failures.insert(
            exit.id.clone(),
            PreviewFailure {
                id: exit.id.clone(),
                preview_id: exit.preview_id,
                evidence_id: exit.evidence_id,
                message: exit.message,
                kind: PreviewFailureKind::ProcessExited {
                    process_id: exit.process_id,
                    exit_code: exit.exit_code,
                },
                causal_links: exit.causal_links,
                observed_at_ms: exit.observed_at_ms,
            },
        );
        Ok(self
            .failures
            .get(&exit.id)
            .expect("failure was inserted into this ledger"))
    }

    /// Records a failed health observation without making any claim about the
    /// preview process. A process can still be alive while its HTTP health check
    /// fails, so callers must use this distinct evidence kind.
    pub fn record_failed_health_check(
        &mut self,
        check: PreviewHealthCheck,
    ) -> Result<&PreviewFailure, PreviewEvidenceError> {
        if check.id.trim().is_empty()
            || check.preview_id.trim().is_empty()
            || check.evidence_id.trim().is_empty()
            || check.url.trim().is_empty()
        {
            return Err(PreviewEvidenceError::MissingRequiredField);
        }
        let PreviewHealthCheckObservation::Failed { detail } = check.observation else {
            return Err(PreviewEvidenceError::HealthyHealthCheck);
        };
        if detail.trim().is_empty() {
            return Err(PreviewEvidenceError::MissingRequiredField);
        }
        check.causal_links.validate()?;
        if self.failures.contains_key(&check.id) {
            return Err(PreviewEvidenceError::DuplicateFailure(check.id));
        }

        self.failures.insert(
            check.id.clone(),
            PreviewFailure {
                id: check.id.clone(),
                preview_id: check.preview_id,
                evidence_id: check.evidence_id,
                message: format!("health check failed for {}: {detail}", check.url),
                kind: PreviewFailureKind::HealthCheckFailed {
                    url: check.url,
                    detail,
                },
                causal_links: check.causal_links,
                observed_at_ms: check.observed_at_ms,
            },
        );
        Ok(self
            .failures
            .get(&check.id)
            .expect("failure was inserted into this ledger"))
    }

    pub fn failure(&self, id: &str) -> Option<&PreviewFailure> {
        self.failures.get(id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviewEvidenceError {
    MissingRequiredField,
    MissingCausalLinks,
    InvalidCausalLink,
    CleanProcessExit,
    HealthyHealthCheck,
    DuplicateFailure(String),
}

impl std::fmt::Display for PreviewEvidenceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingRequiredField => {
                write!(formatter, "preview evidence has a required empty field")
            }
            Self::MissingCausalLinks => write!(formatter, "preview failure requires causal links"),
            Self::InvalidCausalLink => write!(formatter, "preview causal link cannot be blank"),
            Self::CleanProcessExit => {
                write!(formatter, "a clean process exit is not a preview failure")
            }
            Self::HealthyHealthCheck => {
                write!(formatter, "a healthy health check is not a preview failure")
            }
            Self::DuplicateFailure(id) => write!(formatter, "preview failure already exists: {id}"),
        }
    }
}

impl std::error::Error for PreviewEvidenceError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AagAvailability {
    Available,
    Unavailable { reason: String },
}

/// AAG is a navigation provider only. Its absence must remain an explicit unknown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AagRelations {
    Known { related_symbols: Vec<String> },
    Unknown { reason: String },
}

pub fn relations_from_aag(
    availability: &AagAvailability,
    provider_result: Option<Vec<String>>,
) -> AagRelations {
    match (availability, provider_result) {
        (AagAvailability::Available, Some(related_symbols)) => {
            AagRelations::Known { related_symbols }
        }
        (AagAvailability::Available, None) => AagRelations::Unknown {
            reason: "AAG returned no relation result".to_owned(),
        },
        (AagAvailability::Unavailable { reason }, _) => AagRelations::Unknown {
            reason: format!("AAG unavailable: {reason}"),
        },
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IntentSpecRecord {
    pub id: String,
    pub subject: String,
    pub expected: Value,
    pub source_path: String,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ObservedBehavior {
    pub id: String,
    pub subject: String,
    pub actual: Value,
    /// Evidence belongs to the host; an observation without it is never verified.
    pub evidence_ids: Vec<String>,
    pub observed_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Divergence {
    pub id: String,
    pub intent_id: String,
    pub observation_id: String,
    pub subject: String,
    pub expected: Value,
    pub actual: Value,
    pub evidence_ids: Vec<String>,
}

/// Detect only literal declared-vs-observed disagreement. Semantic inference belongs
/// to the later budgeted evaluator, so this layer has no hidden confidence claim.
pub fn detect_divergence(
    intent: &IntentSpecRecord,
    observation: &ObservedBehavior,
) -> Option<Divergence> {
    if intent.subject != observation.subject
        || intent.expected == observation.actual
        || observation.evidence_ids.is_empty()
    {
        return None;
    }

    Some(Divergence {
        id: format!("{}::{}", intent.id, observation.id),
        intent_id: intent.id.clone(),
        observation_id: observation.id.clone(),
        subject: intent.subject.clone(),
        expected: intent.expected.clone(),
        actual: observation.actual.clone(),
        evidence_ids: observation.evidence_ids.clone(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionScope {
    Project { project_id: String },
    Resource { resource_id: String },
    Path { path: String },
    Preview { preview_id: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ReconciliationChoice {
    /// A host must subsequently execute a governed implementation change and attach
    /// fresh evidence before this becomes resolved.
    ChangeImplementation { proposed_effect_id: String },
    /// The human-editable intent/spec is deliberately changed to the observed fact.
    ChangeIntent { revised_expected: Value },
    /// An exception is valid only for the declared scope and justification.
    AcceptScopedException {
        scope: ExceptionScope,
        justification: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconciliationStatus {
    PendingVerification,
    AcceptedScopedException,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reconciliation {
    pub divergence_id: String,
    pub choice: ReconciliationChoice,
    pub status: ReconciliationStatus,
}

#[derive(Debug, Default)]
pub struct ReconciliationStore {
    intents: BTreeMap<String, IntentSpecRecord>,
    observations: BTreeMap<String, ObservedBehavior>,
    divergences: BTreeMap<String, Divergence>,
    reconciliations: BTreeMap<String, Reconciliation>,
}

impl ReconciliationStore {
    pub fn record_intent(&mut self, intent: IntentSpecRecord) {
        self.intents.insert(intent.id.clone(), intent);
    }

    pub fn record_observation(&mut self, observation: ObservedBehavior) {
        self.observations
            .insert(observation.id.clone(), observation);
    }

    pub fn detect(&mut self, intent_id: &str, observation_id: &str) -> Option<&Divergence> {
        let divergence = detect_divergence(
            self.intents.get(intent_id)?,
            self.observations.get(observation_id)?,
        )?;
        let id = divergence.id.clone();
        self.divergences.insert(id.clone(), divergence);
        self.divergences.get(&id)
    }

    pub fn reconcile(
        &mut self,
        divergence_id: &str,
        choice: ReconciliationChoice,
    ) -> Result<&Reconciliation, ReconciliationError> {
        let divergence = self
            .divergences
            .get(divergence_id)
            .ok_or_else(|| ReconciliationError::UnknownDivergence(divergence_id.to_owned()))?
            .clone();

        let status = match &choice {
            ReconciliationChoice::ChangeImplementation { proposed_effect_id }
                if proposed_effect_id.is_empty() =>
            {
                return Err(ReconciliationError::MissingImplementationEffect)
            }
            ReconciliationChoice::ChangeImplementation { .. } => {
                ReconciliationStatus::PendingVerification
            }
            ReconciliationChoice::ChangeIntent { revised_expected } => {
                let intent = self
                    .intents
                    .get_mut(&divergence.intent_id)
                    .expect("divergence keeps intent id");
                intent.expected = revised_expected.clone();
                ReconciliationStatus::PendingVerification
            }
            ReconciliationChoice::AcceptScopedException {
                scope,
                justification,
            } if justification.trim().is_empty() || invalid_scope(scope) => {
                return Err(ReconciliationError::InvalidException)
            }
            ReconciliationChoice::AcceptScopedException { .. } => {
                ReconciliationStatus::AcceptedScopedException
            }
        };

        let reconciliation = Reconciliation {
            divergence_id: divergence_id.to_owned(),
            choice,
            status,
        };
        self.reconciliations
            .insert(divergence_id.to_owned(), reconciliation);
        Ok(self
            .reconciliations
            .get(divergence_id)
            .expect("just inserted"))
    }

    pub fn intent(&self, id: &str) -> Option<&IntentSpecRecord> {
        self.intents.get(id)
    }
}

fn invalid_scope(scope: &ExceptionScope) -> bool {
    match scope {
        ExceptionScope::Project { project_id } => project_id.trim().is_empty(),
        ExceptionScope::Resource { resource_id } => resource_id.trim().is_empty(),
        ExceptionScope::Path { path } => path.trim().is_empty(),
        ExceptionScope::Preview { preview_id } => preview_id.trim().is_empty(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconciliationError {
    UnknownDivergence(String),
    MissingImplementationEffect,
    InvalidException,
}

impl std::fmt::Display for ReconciliationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownDivergence(id) => write!(formatter, "unknown divergence: {id}"),
            Self::MissingImplementationEffect => write!(
                formatter,
                "implementation reconciliation requires a proposed effect"
            ),
            Self::InvalidException => write!(
                formatter,
                "exception requires a non-empty scope and justification"
            ),
        }
    }
}

impl std::error::Error for ReconciliationError {}
