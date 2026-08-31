//! Optional, degradable AAG navigation provider.
//!
//! AAG is a navigation provider only: it observes what already exists and never
//! decides intent or authority. Its absence must remain an explicit `unknown`,
//! never an empty-but-successful graph. This module runs the external `aag`
//! binary when present and defers every honesty rule to
//! [`ide_reconciliation::relations_from_aag`].

use ide_reconciliation::{relations_from_aag, AagAvailability, AagRelations};
use std::process::Command;

/// Upper bound on related references surfaced from a single query. AAG output is
/// navigation context, not authority, so a large result is truncated rather than
/// flooded into the renderer.
const MAX_RELATED: usize = 20;
/// Upper bound on an `explore` query length — caps the argv and rejects pathological input.
const MAX_QUERY_LEN: usize = 512;

/// Probes AAG availability and, when present, asks it for the references related
/// to `query`. A missing binary, a failing probe, or an empty result all degrade
/// to an explicit unknown instead of a fabricated relation set.
pub fn relations_for(query: &str) -> AagRelations {
    let availability = probe_availability();
    if matches!(availability, AagAvailability::Unavailable { .. }) {
        return relations_from_aag(&availability, None);
    }
    relations_from_aag(&availability, explore(query))
}

fn probe_availability() -> AagAvailability {
    match Command::new("aag").arg("--version").output() {
        Ok(output) if output.status.success() => AagAvailability::Available,
        Ok(output) => AagAvailability::Unavailable {
            reason: format!(
                "aag --version failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        },
        Err(error) => AagAvailability::Unavailable {
            reason: format!("aag is not runnable on this host: {error}"),
        },
    }
}

fn explore(query: &str) -> Option<Vec<String>> {
    // Reject anything that could be smuggled in as a flag: a leading dash would let the query
    // masquerade as an `aag` option (argument injection). Also bound the length so a pathological
    // input can't blow up the argv. Belt-and-suspenders with the `--` end-of-options marker below,
    // which stops `aag` from treating any later value as a flag regardless.
    let query = query.trim();
    if query.is_empty() || query.starts_with('-') || query.len() > MAX_QUERY_LEN {
        return None;
    }
    let output = Command::new("aag")
        .arg("explore")
        .arg("--")
        .arg(query)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let related: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(MAX_RELATED)
        .map(str::to_owned)
        .collect();
    if related.is_empty() {
        None
    } else {
        Some(related)
    }
}
