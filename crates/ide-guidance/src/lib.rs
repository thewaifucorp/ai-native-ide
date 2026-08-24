//! Local, versionable Guidance and Truth registries for the AI-Native IDE.
//!
//! Guidance is the persistent steering layer — how to act, write and build from
//! now on — kept distinct from historical decisions, factual memory and
//! authority (Truth). This crate keeps the model, lifecycle and deterministic
//! "applied now" compilation shell-neutral so the host and renderer share one
//! honest state. A pointwise instruction never becomes a permanent rule
//! silently, and an unapplied scope never enters the agent context.

use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// The nature of a piece of guidance, from a soft preference to an enforceable
/// policy. Kept separate from [`GuidanceStrength`], which is how hard it binds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuidanceType {
    Preference,
    Convention,
    ApplicableDecision,
    Rule,
    Policy,
}

/// Where a piece of guidance applies. Only the scopes matching the current
/// activity are compiled into context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum GuidanceScope {
    Person,
    Project { project_id: String },
    Resource { resource_id: String },
    Path { path: String },
    Task { session_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuidanceApplication {
    Writing,
    Code,
    Design,
    Tool,
    Agent,
    Effect,
    General,
}

/// How hard the guidance binds. `Ord` places softer strengths first so a
/// descending sort surfaces blocking and required guidance ahead of preferences.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuidanceStrength {
    Suggestion,
    Default,
    Required,
    Blocking,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuidanceOrigin {
    Created,
    Imported,
    Suggested,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum GuidanceDuration {
    Session,
    Task,
    Until { date: String },
    Permanent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuidanceState {
    Candidate,
    Active,
    Suspended,
    Superseded,
    Archived,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Guidance {
    pub id: String,
    pub name: String,
    pub guidance_type: GuidanceType,
    pub scope: GuidanceScope,
    pub application: GuidanceApplication,
    pub strength: GuidanceStrength,
    pub origin: GuidanceOrigin,
    pub duration: GuidanceDuration,
    pub priority: i64,
    pub owner: String,
    pub provenance: String,
    /// The stable set (`.guidance/<set>.md`) this guidance belongs to.
    pub set: String,
    pub text: String,
    pub state: GuidanceState,
    pub last_used_ms: u64,
}

/// A new instruction to capture, before its destination decides its lifecycle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuidanceDraft {
    pub name: String,
    pub text: String,
    pub guidance_type: GuidanceType,
    pub scope: GuidanceScope,
    pub application: GuidanceApplication,
    pub strength: GuidanceStrength,
    pub owner: String,
    pub provenance: String,
}

/// The four honest destinations for a captured instruction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum CaptureDestination {
    /// Use only in this task/session; active but ephemeral.
    UseNow,
    /// Incorporate into an existing stable set; active and permanent.
    Incorporate { set: String },
    /// Create a stable guidance in its own set; active and permanent.
    CreateStable,
    /// Record as a historical decision only; archived and never steers agents.
    RecordDecision,
}

/// The current activity, used to compile only the applicable guidance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActivityContext {
    pub project_id: Option<String>,
    pub resource_id: Option<String>,
    pub path: Option<String>,
    pub session_id: Option<String>,
    pub application: Option<GuidanceApplication>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedGuidance {
    pub guidance: Guidance,
    /// Why this guidance was compiled for the current activity.
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum HygieneFinding {
    /// Same name and scope active more than once.
    Duplicate { ids: Vec<String>, name: String },
    /// A task/session-scoped instruction saved as permanent.
    PointRuleAsPermanent { id: String, name: String },
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RegistrySnapshot {
    entries: Vec<Guidance>,
    next_seq: u64,
}

/// The Guidance registry. `registry.json` is the source of truth; the per-set
/// Markdown files are regenerated from it so the human surface and the machine
/// state never disagree.
pub struct GuidanceRegistry {
    root: PathBuf,
    entries: BTreeMap<String, Guidance>,
    next_seq: u64,
}

impl GuidanceRegistry {
    pub fn open(root: impl AsRef<Path>) -> anyhow::Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root)
            .with_context(|| format!("create guidance directory {}", root.display()))?;
        let registry_path = root.join("registry.json");
        let snapshot = if registry_path.exists() {
            let bytes = fs::read(&registry_path)
                .with_context(|| format!("read {}", registry_path.display()))?;
            serde_json::from_slice::<RegistrySnapshot>(&bytes)
                .with_context(|| format!("parse {}", registry_path.display()))?
        } else {
            RegistrySnapshot::default()
        };
        let entries = snapshot
            .entries
            .into_iter()
            .map(|guidance| (guidance.id.clone(), guidance))
            .collect();
        Ok(Self {
            root,
            entries,
            next_seq: snapshot.next_seq,
        })
    }

    pub fn list(&self) -> Vec<Guidance> {
        self.entries.values().cloned().collect()
    }

    /// Captures a drafted instruction according to its destination. The
    /// destination — not an inference — decides state, duration and set, so a
    /// pointwise note never becomes a permanent rule silently.
    pub fn capture(
        &mut self,
        draft: GuidanceDraft,
        destination: CaptureDestination,
    ) -> anyhow::Result<Guidance> {
        let id = format!("guidance-{:06}", self.next_seq);
        self.next_seq += 1;
        let (state, duration, set) = match &destination {
            CaptureDestination::UseNow => (
                GuidanceState::Active,
                GuidanceDuration::Task,
                "temporary".to_owned(),
            ),
            CaptureDestination::Incorporate { set } => (
                GuidanceState::Active,
                GuidanceDuration::Permanent,
                set.clone(),
            ),
            CaptureDestination::CreateStable => (
                GuidanceState::Active,
                GuidanceDuration::Permanent,
                set_for(&draft),
            ),
            CaptureDestination::RecordDecision => (
                GuidanceState::Archived,
                GuidanceDuration::Permanent,
                "decisions".to_owned(),
            ),
        };
        let guidance = Guidance {
            id: id.clone(),
            name: draft.name,
            guidance_type: draft.guidance_type,
            scope: draft.scope,
            application: draft.application,
            strength: draft.strength,
            origin: GuidanceOrigin::Created,
            duration,
            priority: 0,
            owner: draft.owner,
            provenance: draft.provenance,
            set,
            text: draft.text,
            state,
            last_used_ms: 0,
        };
        self.entries.insert(id.clone(), guidance.clone());
        self.persist()?;
        Ok(guidance)
    }

    /// Imports an external steering file (`AGENTS.md`, `CLAUDE.md`, a Kiro
    /// steering file) as a reviewable candidate, never as active guidance and
    /// never dumped whole into context.
    pub fn import_steering(
        &mut self,
        name: &str,
        text: &str,
        scope: GuidanceScope,
        owner: &str,
    ) -> anyhow::Result<Guidance> {
        let id = format!("guidance-{:06}", self.next_seq);
        self.next_seq += 1;
        let guidance = Guidance {
            id: id.clone(),
            name: name.to_owned(),
            guidance_type: GuidanceType::Convention,
            scope,
            application: GuidanceApplication::General,
            strength: GuidanceStrength::Suggestion,
            origin: GuidanceOrigin::Imported,
            duration: GuidanceDuration::Permanent,
            priority: 0,
            owner: owner.to_owned(),
            provenance: format!("imported steering file: {name}"),
            set: "imported".to_owned(),
            text: text.to_owned(),
            state: GuidanceState::Candidate,
            last_used_ms: 0,
        };
        self.entries.insert(id.clone(), guidance.clone());
        self.persist()?;
        Ok(guidance)
    }

    /// Promotes a reviewed candidate to active guidance. Nothing an inference
    /// produced becomes active without this explicit review.
    pub fn activate(&mut self, id: &str) -> anyhow::Result<Guidance> {
        let guidance = self
            .entries
            .get_mut(id)
            .with_context(|| format!("unknown guidance {id}"))?;
        guidance.state = GuidanceState::Active;
        let updated = guidance.clone();
        self.persist()?;
        Ok(updated)
    }

    /// Deterministically compiles the guidance applicable to the current
    /// activity, strongest and most specific first. Only active guidance whose
    /// scope and application match is included, each with an explicit reason.
    pub fn applied_now(&self, context: &ActivityContext) -> Vec<AppliedGuidance> {
        let mut applicable: Vec<(&Guidance, &'static str)> = self
            .entries
            .values()
            .filter(|guidance| guidance.state == GuidanceState::Active)
            .filter(|guidance| application_matches(guidance.application, context.application))
            .filter_map(|guidance| {
                scope_reason(&guidance.scope, context).map(|reason| (guidance, reason))
            })
            .collect();
        applicable.sort_by(|left, right| {
            right
                .0
                .strength
                .cmp(&left.0.strength)
                .then_with(|| right.0.priority.cmp(&left.0.priority))
                .then_with(|| specificity(&right.0.scope).cmp(&specificity(&left.0.scope)))
                .then_with(|| left.0.id.cmp(&right.0.id))
        });
        applicable
            .into_iter()
            .map(|(guidance, reason)| AppliedGuidance {
                guidance: guidance.clone(),
                reason: format!("{} · {reason}", strength_label(guidance.strength)),
            })
            .collect()
    }

    /// Detects the hygiene problems this slice can prove deterministically:
    /// duplicate name+scope, and a task/session rule saved as permanent.
    pub fn hygiene(&self) -> Vec<HygieneFinding> {
        let mut findings = Vec::new();
        let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for guidance in self.entries.values() {
            if guidance.state != GuidanceState::Active {
                continue;
            }
            let key = format!("{}::{}", guidance.name, scope_key(&guidance.scope));
            groups.entry(key).or_default().push(guidance.id.clone());
            if matches!(guidance.scope, GuidanceScope::Task { .. })
                && guidance.duration == GuidanceDuration::Permanent
            {
                findings.push(HygieneFinding::PointRuleAsPermanent {
                    id: guidance.id.clone(),
                    name: guidance.name.clone(),
                });
            }
        }
        for (key, mut ids) in groups {
            if ids.len() > 1 {
                ids.sort();
                let name = key.split("::").next().unwrap_or_default().to_owned();
                findings.push(HygieneFinding::Duplicate { ids, name });
            }
        }
        findings
    }

    fn persist(&self) -> anyhow::Result<()> {
        let snapshot = RegistrySnapshot {
            entries: self.entries.values().cloned().collect(),
            next_seq: self.next_seq,
        };
        let json = serde_json::to_vec_pretty(&snapshot)?;
        fs::write(self.root.join("registry.json"), json)
            .with_context(|| format!("write guidance registry in {}", self.root.display()))?;
        self.write_markdown_mirror()?;
        Ok(())
    }

    /// Regenerates one Markdown file per set so the files always represent the
    /// same state the registry holds (GUID-09).
    fn write_markdown_mirror(&self) -> anyhow::Result<()> {
        let mut by_set: BTreeMap<String, Vec<&Guidance>> = BTreeMap::new();
        for guidance in self.entries.values() {
            by_set
                .entry(guidance.set.clone())
                .or_default()
                .push(guidance);
        }
        for (set, items) in by_set {
            let mut body = format!("# Guidance — {set}\n\n");
            for guidance in items {
                body.push_str(&format!(
                    "## {}\n\n- id: {}\n- estado: {:?}\n- força: {:?}\n- escopo: {}\n- duração: {:?}\n\n{}\n\n",
                    guidance.name,
                    guidance.id,
                    guidance.state,
                    guidance.strength,
                    scope_key(&guidance.scope),
                    guidance.duration,
                    guidance.text,
                ));
            }
            fs::write(self.root.join(format!("{set}.md")), body)
                .with_context(|| format!("write guidance set {set}"))?;
        }
        Ok(())
    }
}

fn set_for(draft: &GuidanceDraft) -> String {
    match draft.application {
        GuidanceApplication::Writing => "writing",
        GuidanceApplication::Code => "development",
        GuidanceApplication::Design => "design",
        GuidanceApplication::Tool | GuidanceApplication::Agent => "agents",
        GuidanceApplication::Effect => "policies",
        GuidanceApplication::General => "project",
    }
    .to_owned()
}

fn application_matches(
    guidance: GuidanceApplication,
    context: Option<GuidanceApplication>,
) -> bool {
    guidance == GuidanceApplication::General
        || match context {
            None => true,
            Some(active) => active == guidance,
        }
}

fn scope_reason(scope: &GuidanceScope, context: &ActivityContext) -> Option<&'static str> {
    match scope {
        GuidanceScope::Person => Some("escopo pessoal aplica a toda atividade"),
        GuidanceScope::Project { project_id } => match &context.project_id {
            Some(active) if active == project_id => Some("projeto ativo corresponde"),
            _ => None,
        },
        GuidanceScope::Resource { resource_id } => match &context.resource_id {
            Some(active) if active == resource_id => Some("recurso ativo corresponde"),
            _ => None,
        },
        GuidanceScope::Path { path } => match &context.path {
            Some(active) if active == path || active.starts_with(path.as_str()) => {
                Some("caminho ativo corresponde")
            }
            _ => None,
        },
        GuidanceScope::Task { session_id } => match &context.session_id {
            Some(active) if active == session_id => Some("sessão ativa corresponde"),
            _ => None,
        },
    }
}

fn specificity(scope: &GuidanceScope) -> u8 {
    match scope {
        GuidanceScope::Person => 0,
        GuidanceScope::Project { .. } => 1,
        GuidanceScope::Resource { .. } => 2,
        GuidanceScope::Path { .. } => 3,
        GuidanceScope::Task { .. } => 4,
    }
}

fn scope_key(scope: &GuidanceScope) -> String {
    match scope {
        GuidanceScope::Person => "person".to_owned(),
        GuidanceScope::Project { project_id } => format!("project:{project_id}"),
        GuidanceScope::Resource { resource_id } => format!("resource:{resource_id}"),
        GuidanceScope::Path { path } => format!("path:{path}"),
        GuidanceScope::Task { session_id } => format!("task:{session_id}"),
    }
}

fn strength_label(strength: GuidanceStrength) -> &'static str {
    match strength {
        GuidanceStrength::Suggestion => "sugestão",
        GuidanceStrength::Default => "default",
        GuidanceStrength::Required => "obrigatória",
        GuidanceStrength::Blocking => "bloqueante",
    }
}

// --- Local Truth Registry -------------------------------------------------

/// An authority declaration: which file owns a subject, in what scope, with what
/// precedence, and who consumes it. Sources stay human-editable files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TruthDeclaration {
    pub id: String,
    pub subject: String,
    pub scope: GuidanceScope,
    pub authority_path: String,
    pub precedence: i64,
    pub consumers: Vec<String>,
    pub provenance: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TruthFinding {
    /// Two authorities claim the same subject in an overlapping scope.
    AuthorityConflict { ids: Vec<String>, subject: String },
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct TruthSnapshot {
    entries: Vec<TruthDeclaration>,
    next_seq: u64,
}

pub struct TruthRegistry {
    path: PathBuf,
    entries: BTreeMap<String, TruthDeclaration>,
    next_seq: u64,
}

impl TruthRegistry {
    pub fn open(root: impl AsRef<Path>) -> anyhow::Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root)
            .with_context(|| format!("create truth directory {}", root.display()))?;
        let path = root.join("truth.json");
        let snapshot = if path.exists() {
            let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
            serde_json::from_slice::<TruthSnapshot>(&bytes)
                .with_context(|| format!("parse {}", path.display()))?
        } else {
            TruthSnapshot::default()
        };
        let entries = snapshot
            .entries
            .into_iter()
            .map(|entry| (entry.id.clone(), entry))
            .collect();
        Ok(Self {
            path,
            entries,
            next_seq: snapshot.next_seq,
        })
    }

    pub fn declare(
        &mut self,
        subject: &str,
        scope: GuidanceScope,
        authority_path: &str,
        precedence: i64,
        provenance: &str,
    ) -> anyhow::Result<TruthDeclaration> {
        let id = format!("truth-{:06}", self.next_seq);
        self.next_seq += 1;
        let declaration = TruthDeclaration {
            id: id.clone(),
            subject: subject.to_owned(),
            scope,
            authority_path: authority_path.to_owned(),
            precedence,
            consumers: Vec::new(),
            provenance: provenance.to_owned(),
        };
        self.entries.insert(id.clone(), declaration.clone());
        self.persist()?;
        Ok(declaration)
    }

    pub fn add_consumer(&mut self, id: &str, consumer: &str) -> anyhow::Result<()> {
        let declaration = self
            .entries
            .get_mut(id)
            .with_context(|| format!("unknown truth declaration {id}"))?;
        if !declaration.consumers.iter().any(|entry| entry == consumer) {
            declaration.consumers.push(consumer.to_owned());
        }
        self.persist()
    }

    pub fn list(&self) -> Vec<TruthDeclaration> {
        self.entries.values().cloned().collect()
    }

    /// Consumers of a subject, so a change can propose synchronization.
    pub fn consumers_of(&self, subject: &str) -> Vec<String> {
        let mut consumers: Vec<String> = self
            .entries
            .values()
            .filter(|entry| entry.subject == subject)
            .flat_map(|entry| entry.consumers.clone())
            .collect();
        consumers.sort();
        consumers.dedup();
        consumers
    }

    /// A conflict is two authorities over one subject in an overlapping scope.
    pub fn conflicts(&self) -> Vec<TruthFinding> {
        let mut by_subject: BTreeMap<String, Vec<&TruthDeclaration>> = BTreeMap::new();
        for entry in self.entries.values() {
            by_subject
                .entry(entry.subject.clone())
                .or_default()
                .push(entry);
        }
        let mut findings = Vec::new();
        for (subject, declarations) in by_subject {
            for (index, first) in declarations.iter().enumerate() {
                for second in declarations.iter().skip(index + 1) {
                    if scopes_overlap(&first.scope, &second.scope) {
                        let mut ids = vec![first.id.clone(), second.id.clone()];
                        ids.sort();
                        findings.push(TruthFinding::AuthorityConflict {
                            ids,
                            subject: subject.clone(),
                        });
                    }
                }
            }
        }
        findings
    }

    fn persist(&self) -> anyhow::Result<()> {
        let snapshot = TruthSnapshot {
            entries: self.entries.values().cloned().collect(),
            next_seq: self.next_seq,
        };
        let json = serde_json::to_vec_pretty(&snapshot)?;
        fs::write(&self.path, json).with_context(|| format!("write {}", self.path.display()))?;
        Ok(())
    }
}

fn scopes_overlap(left: &GuidanceScope, right: &GuidanceScope) -> bool {
    scope_key(left) == scope_key(right)
        || matches!(left, GuidanceScope::Person)
        || matches!(right, GuidanceScope::Person)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ide-guidance-{tag}-{}", std::process::id()))
    }

    fn draft(name: &str, scope: GuidanceScope) -> GuidanceDraft {
        GuidanceDraft {
            name: name.to_owned(),
            text: "corpo".to_owned(),
            guidance_type: GuidanceType::Preference,
            scope,
            application: GuidanceApplication::General,
            strength: GuidanceStrength::Default,
            owner: "local.owner".to_owned(),
            provenance: "test".to_owned(),
        }
    }

    #[test]
    fn use_now_is_active_and_task_scoped_duration() {
        let root = temp_root("usenow");
        let _ = fs::remove_dir_all(&root);
        let mut registry = GuidanceRegistry::open(&root).unwrap();
        let guidance = registry
            .capture(
                draft("tom de voz", GuidanceScope::Person),
                CaptureDestination::UseNow,
            )
            .unwrap();
        assert_eq!(guidance.state, GuidanceState::Active);
        assert_eq!(guidance.duration, GuidanceDuration::Task);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn record_decision_never_steers() {
        let root = temp_root("decision");
        let _ = fs::remove_dir_all(&root);
        let mut registry = GuidanceRegistry::open(&root).unwrap();
        registry
            .capture(
                draft("escolhemos axum", GuidanceScope::Person),
                CaptureDestination::RecordDecision,
            )
            .unwrap();
        // Archived guidance is not compiled into the agent context.
        let applied = registry.applied_now(&ActivityContext::default());
        assert!(applied.is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn imported_steering_stays_a_candidate_until_reviewed() {
        let root = temp_root("import");
        let _ = fs::remove_dir_all(&root);
        let mut registry = GuidanceRegistry::open(&root).unwrap();
        let candidate = registry
            .import_steering(
                "AGENTS.md",
                "sempre rode testes",
                GuidanceScope::Person,
                "local",
            )
            .unwrap();
        assert_eq!(candidate.state, GuidanceState::Candidate);
        assert!(registry.applied_now(&ActivityContext::default()).is_empty());
        registry.activate(&candidate.id).unwrap();
        assert_eq!(registry.applied_now(&ActivityContext::default()).len(), 1);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn applied_now_scopes_and_orders_by_strength() {
        let root = temp_root("applied");
        let _ = fs::remove_dir_all(&root);
        let mut registry = GuidanceRegistry::open(&root).unwrap();
        registry
            .capture(
                draft("pessoal", GuidanceScope::Person),
                CaptureDestination::CreateStable,
            )
            .unwrap();
        let mut blocking = draft(
            "projeto",
            GuidanceScope::Project {
                project_id: "p1".to_owned(),
            },
        );
        blocking.strength = GuidanceStrength::Blocking;
        registry
            .capture(blocking, CaptureDestination::CreateStable)
            .unwrap();
        registry
            .capture(
                draft(
                    "outro projeto",
                    GuidanceScope::Project {
                        project_id: "outro".to_owned(),
                    },
                ),
                CaptureDestination::CreateStable,
            )
            .unwrap();

        let applied = registry.applied_now(&ActivityContext {
            project_id: Some("p1".to_owned()),
            ..Default::default()
        });
        // Person + Project p1 apply; project "outro" does not.
        assert_eq!(applied.len(), 2);
        // Blocking project guidance is compiled ahead of the personal default.
        assert_eq!(applied[0].guidance.name, "projeto");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn hygiene_flags_point_rule_saved_as_permanent() {
        let root = temp_root("hygiene");
        let _ = fs::remove_dir_all(&root);
        let mut registry = GuidanceRegistry::open(&root).unwrap();
        registry
            .capture(
                draft(
                    "só desta vez",
                    GuidanceScope::Task {
                        session_id: "s1".to_owned(),
                    },
                ),
                CaptureDestination::CreateStable,
            )
            .unwrap();
        let findings = registry.hygiene();
        assert!(findings
            .iter()
            .any(|finding| matches!(finding, HygieneFinding::PointRuleAsPermanent { .. })));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn registry_reloads_persisted_state() {
        let root = temp_root("reload");
        let _ = fs::remove_dir_all(&root);
        {
            let mut registry = GuidanceRegistry::open(&root).unwrap();
            registry
                .capture(
                    draft("persistida", GuidanceScope::Person),
                    CaptureDestination::CreateStable,
                )
                .unwrap();
        }
        let reopened = GuidanceRegistry::open(&root).unwrap();
        assert_eq!(reopened.list().len(), 1);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn truth_registry_detects_authority_conflict_and_consumers() {
        let root = temp_root("truth");
        let _ = fs::remove_dir_all(&root);
        let mut registry = TruthRegistry::open(&root).unwrap();
        let first = registry
            .declare(
                "checkout",
                GuidanceScope::Person,
                "docs/checkout.md",
                10,
                "test",
            )
            .unwrap();
        registry
            .declare(
                "checkout",
                GuidanceScope::Person,
                "docs/other.md",
                5,
                "test",
            )
            .unwrap();
        registry.add_consumer(&first.id, "cart-service").unwrap();
        assert_eq!(registry.consumers_of("checkout"), vec!["cart-service"]);
        assert!(registry
            .conflicts()
            .iter()
            .any(|finding| matches!(finding, TruthFinding::AuthorityConflict { .. })));
        fs::remove_dir_all(&root).unwrap();
    }
}
