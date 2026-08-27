//! §13 — the Guidance Library and the Truth Registry, made durable.
//!
//! `ide_guidance` is the whole engine: it owns the guidance model, the lifecycle
//! (candidate → active → suspended/superseded/archived), the deterministic
//! `applied_now` compilation, the hygiene findings, the authority declarations
//! and their conflicts. Unlike the other engines wired so far, this one DOES own
//! its persistence — `registry.json` plus a regenerated Markdown mirror per set,
//! and `truth.json`. So this module is thin on purpose: resolve the root, carry
//! the clock, and hand back what the panel needs.
//!
//! # Where it lives, and why not through the broker
//!
//! `.guidance/` at the project root, versioned, exactly as the crate documents.
//! It does NOT go through the effect broker, and that line is worth stating
//! because §5 draws it the other way for `.product/`:
//!
//!  * The broker exists to stop a write the person did not author — an agent's
//!    edit, a provider's effect, a detector's proposal. The diff is how you check
//!    somebody else's work before it lands.
//!  * A captured guidance is text the person typed, filed where they said to file
//!    it. A diff of your own sentence, seconds after you wrote it, is ceremony,
//!    not review.
//!
//! The protection for the OTHER case — guidance that came from a file or from a
//! detector — is held by the engine's lifecycle instead: `import_steering` lands
//! `Candidate`, `applied_now` compiles only `Active`, and nothing but an explicit
//! `activate` crosses that line. An inference-produced rule cannot steer an agent
//! without somebody promoting it.
//!
//! # Who stamps `last_used_ms`
//!
//! Not this module. `last_used_ms` only moves when a host says "this was actually
//! compiled into a context", and the only place that knows is §6's context
//! compiler — it stamps exactly the guidance the package carried, after the
//! budget decided what survived. Without that stamp every active rule reads as
//! obsolete in the staleness report, and a hygiene report that flags everything
//! says nothing.

use ide_guidance::{
    ActivityContext, AppliedGuidance, CaptureDestination, Guidance, GuidanceApplication,
    GuidanceDraft, GuidanceRegistry, GuidanceScope, GuidanceStrength, GuidanceType, HygieneFinding,
    SyncProposal, TruthDeclaration, TruthFinding, TruthRegistry,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Versioned, human-editable home of both registries.
pub const LIBRARY_REL: &str = ".guidance";

/// Staleness window for the hygiene report: guidance untouched for longer than
/// this is SURFACED for review. Never acted on — nothing is removed silently.
const STALENESS_WINDOW_MS: u64 = 30 * 24 * 60 * 60 * 1_000;

pub fn library_root(root: &Path) -> PathBuf {
    root.join(LIBRARY_REL)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Everything the Guidance/Truth panel renders, in one read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshot {
    pub guidance: Vec<Guidance>,
    /// What WOULD be compiled for the given activity, in order, with reasons.
    pub applied_now: Vec<AppliedGuidance>,
    pub hygiene: Vec<HygieneFinding>,
    pub truth: Vec<TruthDeclaration>,
    pub conflicts: Vec<TruthFinding>,
    /// Where the two registries live, relative to the project.
    pub library_path: String,
    /// The staleness window behind the obsolescence findings, so the panel can
    /// say "idle for longer than 30 days" instead of an unexplained badge.
    pub staleness_window_ms: u64,
}

/// A capture request from the UI. Mirrors `GuidanceDraft` plus the destination,
/// which is what decides state, duration and set — never an inference.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    pub name: String,
    pub text: String,
    #[serde(default)]
    pub guidance_type: Option<String>,
    #[serde(default)]
    pub application: Option<String>,
    #[serde(default)]
    pub strength: Option<String>,
    /// Scope as the engine models it. Absent means the open project.
    #[serde(default)]
    pub scope: Option<GuidanceScope>,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub provenance: Option<String>,
    /// `use_now`, `incorporate:<set>`, `create_stable` or `record_decision`.
    pub destination: String,
}

fn guidance_type_of(value: Option<&str>) -> GuidanceType {
    match value {
        Some("policy") => GuidanceType::Policy,
        Some("rule") => GuidanceType::Rule,
        Some("applicable_decision") => GuidanceType::ApplicableDecision,
        Some("preference") => GuidanceType::Preference,
        _ => GuidanceType::Convention,
    }
}

fn application_of(value: Option<&str>) -> GuidanceApplication {
    match value {
        Some("writing") => GuidanceApplication::Writing,
        Some("code") => GuidanceApplication::Code,
        Some("design") => GuidanceApplication::Design,
        Some("tool") => GuidanceApplication::Tool,
        Some("agent") => GuidanceApplication::Agent,
        Some("effect") => GuidanceApplication::Effect,
        _ => GuidanceApplication::General,
    }
}

/// Strength as the CALLER declares it.
///
/// Unrecognized degrades to `suggestion` instead of being promoted — the same
/// rule §5 holds for detected guidance, kept here so a typo in a payload cannot
/// mint a blocking rule.
fn strength_of(value: Option<&str>) -> GuidanceStrength {
    match value {
        Some("blocking") => GuidanceStrength::Blocking,
        Some("required") => GuidanceStrength::Required,
        Some("default") => GuidanceStrength::Default,
        _ => GuidanceStrength::Suggestion,
    }
}

fn destination_of(value: &str) -> Result<CaptureDestination, String> {
    match value {
        "use_now" => Ok(CaptureDestination::UseNow),
        "create_stable" => Ok(CaptureDestination::CreateStable),
        "record_decision" => Ok(CaptureDestination::RecordDecision),
        other => match other.strip_prefix("incorporate:") {
            Some(set) if !set.trim().is_empty() => Ok(CaptureDestination::Incorporate {
                set: set.to_string(),
            }),
            // No default destination on purpose: the destination is what decides
            // whether a pointwise note becomes a permanent rule, so a malformed
            // one has to fail instead of picking for the person.
            _ => Err(format!(
                "destino de captura desconhecido: {other} (use use_now, create_stable, \
                 record_decision ou incorporate:<set>)"
            )),
        },
    }
}

fn project_scope(root: &Path) -> GuidanceScope {
    GuidanceScope::Project {
        project_id: root.to_string_lossy().into_owned(),
    }
}

fn registry(root: &Path) -> Result<GuidanceRegistry, String> {
    GuidanceRegistry::open(library_root(root)).map_err(|error| format!("{error:#}"))
}

fn truth(root: &Path) -> Result<TruthRegistry, String> {
    TruthRegistry::open(library_root(root)).map_err(|error| format!("{error:#}"))
}

/// Reads both registries and compiles `applied_now` for the given activity.
pub fn snapshot(root: &Path, context: ActivityContext) -> Result<LibrarySnapshot, String> {
    let registry = registry(root)?;
    let truth = truth(root)?;
    // Default the activity to the open project when the caller sent nothing,
    // so project-scoped guidance is not silently invisible.
    let context = if context == ActivityContext::default() {
        ActivityContext {
            project_id: Some(root.to_string_lossy().into_owned()),
            ..ActivityContext::default()
        }
    } else {
        context
    };
    Ok(LibrarySnapshot {
        guidance: registry.list(),
        applied_now: registry.applied_now(&context),
        hygiene: registry.hygiene_with_staleness(now_ms(), STALENESS_WINDOW_MS),
        truth: truth.list(),
        conflicts: truth.conflicts(),
        library_path: LIBRARY_REL.to_string(),
        staleness_window_ms: STALENESS_WINDOW_MS,
    })
}

pub fn capture(root: &Path, request: CaptureRequest) -> Result<LibrarySnapshot, String> {
    if request.name.trim().is_empty() || request.text.trim().is_empty() {
        return Err("guidance sem nome ou sem texto não é guidance".to_string());
    }
    let destination = destination_of(&request.destination)?;
    let draft = GuidanceDraft {
        name: request.name,
        text: request.text,
        guidance_type: guidance_type_of(request.guidance_type.as_deref()),
        scope: request.scope.unwrap_or_else(|| project_scope(root)),
        application: application_of(request.application.as_deref()),
        strength: strength_of(request.strength.as_deref()),
        owner: request.owner.unwrap_or_else(|| "pessoa".to_string()),
        provenance: request
            .provenance
            .unwrap_or_else(|| "capturada no IDE".to_string()),
    };
    let mut registry = registry(root)?;
    registry
        .capture(draft, destination)
        .map_err(|error| format!("{error:#}"))?;
    snapshot(root, ActivityContext::default())
}

/// Imports a steering file (or a §5-detected instruction) as a CANDIDATE.
///
/// Never active, never dumped whole into context. This is the seam that keeps a
/// detector from minting a rule: promotion is a separate, explicit act.
pub fn import(
    root: &Path,
    name: &str,
    text: &str,
    owner: Option<&str>,
    provenance: Option<&str>,
) -> Result<Guidance, String> {
    if name.trim().is_empty() || text.trim().is_empty() {
        return Err("importação sem nome ou sem texto não é guidance".to_string());
    }
    let mut registry = registry(root)?;
    let imported = registry
        .import_steering(name, text, project_scope(root), owner.unwrap_or("projeto"))
        .map_err(|error| format!("{error:#}"))?;
    // The crate stamps its own provenance ("imported steering file: <name>"); a
    // caller-supplied one (a file and line, from §5) is strictly better, so it
    // replaces it — and only when it actually says something.
    match provenance {
        Some(detail) if !detail.trim().is_empty() => {
            let mut registry = registry;
            registry
                .set_provenance(&imported.id, detail)
                .map_err(|error| format!("{error:#}"))
        }
        _ => Ok(imported),
    }
}

/// Lifecycle transition. `to` is `active`, `suspended`, `archived` or
/// `superseded` (which requires `by`).
pub fn lifecycle(
    root: &Path,
    id: &str,
    to: &str,
    by: Option<&str>,
) -> Result<LibrarySnapshot, String> {
    let mut registry = registry(root)?;
    let result = match to {
        "active" => registry.activate(id),
        "suspended" => registry.suspend(id),
        "archived" => registry.archive(id),
        "superseded" => match by {
            Some(replacement) => registry.supersede(id, replacement),
            // Refused rather than degraded to archiving: superseded with nothing
            // pointing forward hides what replaced it.
            None => return Err("substituir exige dizer por qual guidance".to_string()),
        },
        other => return Err(format!("transição desconhecida: {other}")),
    };
    result.map_err(|error| format!("{error:#}"))?;
    snapshot(root, ActivityContext::default())
}

/// Declares an authority over a subject.
pub fn declare_truth(
    root: &Path,
    subject: &str,
    authority_path: &str,
    precedence: i64,
    provenance: &str,
    scope: Option<GuidanceScope>,
) -> Result<LibrarySnapshot, String> {
    if subject.trim().is_empty() || authority_path.trim().is_empty() {
        return Err("autoridade precisa de assunto e de arquivo".to_string());
    }
    let mut truth = truth(root)?;
    truth
        .declare(
            subject,
            scope.unwrap_or_else(|| project_scope(root)),
            authority_path,
            precedence,
            provenance,
        )
        .map_err(|error| format!("{error:#}"))?;
    snapshot(root, ActivityContext::default())
}

pub fn add_consumer(root: &Path, id: &str, consumer: &str) -> Result<LibrarySnapshot, String> {
    if consumer.trim().is_empty() {
        return Err("consumidor sem nome".to_string());
    }
    let mut truth = truth(root)?;
    truth
        .add_consumer(id, consumer)
        .map_err(|error| format!("{error:#}"))?;
    snapshot(root, ActivityContext::default())
}

/// Proposes synchronizing the consumers of a subject with its authority.
///
/// Describes the work and performs none of it — the crate is explicit that
/// nothing downstream is changed by asking.
pub fn propose_sync(
    root: &Path,
    id: &str,
    up_to_date: &[String],
) -> Result<SyncProposal, String> {
    let truth = truth(root)?;
    truth
        .propose_sync(id, up_to_date)
        .map_err(|error| format!("{error:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_guidance::GuidanceState;

    fn project() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn capture_request(name: &str, destination: &str) -> CaptureRequest {
        CaptureRequest {
            name: name.to_string(),
            text: "não resolver empate por ordem de criação".to_string(),
            guidance_type: None,
            application: None,
            strength: None,
            scope: None,
            owner: None,
            provenance: None,
            destination: destination.to_string(),
        }
    }

    /// An empty library is empty, and says where it would live.
    #[test]
    fn an_empty_library_reports_nothing_and_names_its_home() {
        let dir = project();

        let snapshot = snapshot(dir.path(), ActivityContext::default()).expect("snapshot");

        assert!(snapshot.guidance.is_empty());
        assert!(snapshot.applied_now.is_empty());
        assert_eq!(snapshot.library_path, ".guidance");
    }

    /// Captured guidance is active and lands in `applied_now` for this project.
    #[test]
    fn captured_guidance_steers_the_open_project() {
        let dir = project();

        let snapshot =
            capture(dir.path(), capture_request("Desempate", "create_stable")).expect("capture");

        assert_eq!(snapshot.guidance.len(), 1);
        assert_eq!(snapshot.guidance[0].state, GuidanceState::Active);
        assert_eq!(snapshot.applied_now.len(), 1, "projeto ativo corresponde");
        assert!(snapshot.applied_now[0].reason.contains("sugestão"));
        // And it persisted: reopening reads the same library.
        let again = snapshot_of(dir.path());
        assert_eq!(again.guidance.len(), 1);
    }

    fn snapshot_of(root: &Path) -> LibrarySnapshot {
        snapshot(root, ActivityContext::default()).expect("snapshot")
    }

    /// A malformed destination FAILS. It is what decides whether a pointwise note
    /// becomes a permanent rule, so it must never be picked for the person.
    #[test]
    fn a_malformed_destination_is_refused() {
        let dir = project();

        let error = capture(dir.path(), capture_request("X", "talvez")).expect_err("recusa");

        assert!(error.contains("destino de captura desconhecido"), "{error}");
        assert!(snapshot_of(dir.path()).guidance.is_empty());
    }

    /// An imported instruction is a CANDIDATE: it does not steer anything until
    /// somebody promotes it.
    #[test]
    fn imported_guidance_is_a_candidate_until_activated() {
        let dir = project();

        let imported = import(
            dir.path(),
            "AGENTS.md — Desempate",
            "exceder estritamente o atual",
            Some("projeto"),
            Some("AGENTS.md:6"),
        )
        .expect("import");

        assert_eq!(imported.state, GuidanceState::Candidate);
        assert_eq!(imported.provenance, "AGENTS.md:6", "a procedência do §5 vale mais");
        let before = snapshot_of(dir.path());
        assert!(
            before.applied_now.is_empty(),
            "candidata não pode entrar em contexto de agente"
        );

        let after = lifecycle(dir.path(), &imported.id, "active", None).expect("activate");
        assert_eq!(after.applied_now.len(), 1);
    }

    /// Superseding without naming the replacement is refused here too, not
    /// quietly downgraded to archiving.
    #[test]
    fn superseding_without_a_replacement_is_refused() {
        let dir = project();
        let snapshot =
            capture(dir.path(), capture_request("Antiga", "create_stable")).expect("capture");
        let id = snapshot.guidance[0].id.clone();

        let error = lifecycle(dir.path(), &id, "superseded", None).expect_err("recusa");

        assert!(error.contains("por qual guidance"), "{error}");
    }

    /// `use_now` is task-scoped and ephemeral by destination, and the hygiene
    /// report is what makes that visible instead of silent.
    #[test]
    fn a_point_rule_is_not_filed_as_permanent() {
        let dir = project();

        let snapshot = capture(dir.path(), capture_request("Só agora", "use_now")).expect("capture");

        let entry = &snapshot.guidance[0];
        assert_eq!(entry.set, "temporary");
        assert!(
            matches!(entry.duration, ide_guidance::GuidanceDuration::Task),
            "{:?}",
            entry.duration
        );
    }

    /// An authority declaration and its consumers persist, and two authorities
    /// over the same subject in the same scope are reported as a conflict.
    #[test]
    fn authority_and_conflicts_persist() {
        let dir = project();

        declare_truth(
            dir.path(),
            "ranking",
            "docs/product-intent.md",
            100,
            "declarado no IDE",
            None,
        )
        .expect("declare");
        let snapshot = declare_truth(
            dir.path(),
            "ranking",
            "docs/outro.md",
            50,
            "declarado no IDE",
            None,
        )
        .expect("declare");

        assert_eq!(snapshot.truth.len(), 2);
        assert_eq!(snapshot.conflicts.len(), 1, "duas autoridades, um assunto");

        let id = snapshot.truth[0].id.clone();
        let with_consumer = add_consumer(dir.path(), &id, "src/auction.ts").expect("consumer");
        assert!(with_consumer
            .truth
            .iter()
            .any(|entry| entry.consumers.iter().any(|c| c == "src/auction.ts")));

        // Proposing a sync describes the work and performs none of it.
        let proposal = propose_sync(dir.path(), &id, &[]).expect("proposal");
        assert_eq!(proposal.consumers_to_update, vec!["src/auction.ts"]);
        assert!(proposal.reason.contains("out of sync"), "{}", proposal.reason);
    }
}
