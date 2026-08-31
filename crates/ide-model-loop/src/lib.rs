//! IDE-controlled model loop.
//!
//! Unlike an external agent that owns its own loop, here the IDE drives the
//! iteration: it sets the turn budget, decides when to continue or stop, and can
//! cancel. A provider only answers one prompt at a time behind the
//! [`ModelProvider`] trait, so an API, a gateway, or a local server can plug in
//! without the loop changing. The bundled [`LocalEchoProvider`] is deterministic
//! and offline — no paid inference — so the loop is real and testable for free.

use serde::{Deserialize, Serialize};

/// A single-turn completion source. Real API/gateway providers implement this;
/// nothing about the loop control lives in the provider.
pub trait ModelProvider {
    fn complete(&self, prompt: &str) -> Result<String, String>;
}

/// A free, offline provider: it echoes a deterministic transform of the prompt.
/// It never calls a paid model, so it is safe as the default local loop.
pub struct LocalEchoProvider;

impl ModelProvider for LocalEchoProvider {
    fn complete(&self, prompt: &str) -> Result<String, String> {
        let last = prompt.lines().last().unwrap_or("").trim();
        Ok(format!("local-echo: {last}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopConfig {
    /// Hard cap on turns; the IDE, not the provider, owns this budget.
    pub max_turns: usize,
    /// A stop marker the loop watches for in a response to end early.
    pub stop_on_marker: Option<char>,
}

impl Default for LoopConfig {
    fn default() -> Self {
        Self {
            max_turns: 3,
            stop_on_marker: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopTurn {
    pub prompt: String,
    pub response: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    BudgetReached,
    MarkerFound,
    ProviderError,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopTranscript {
    pub turns: Vec<LoopTurn>,
    pub stopped: StopReason,
    pub error: Option<String>,
}

/// Runs the IDE-controlled loop. The IDE feeds each response back as the next
/// prompt, stopping at the turn budget, an optional marker, a provider error, or
/// when `cancelled` reports true — the loop never runs unbounded.
pub fn run_loop(
    provider: &dyn ModelProvider,
    initial_prompt: &str,
    config: LoopConfig,
    cancelled: &dyn Fn() -> bool,
) -> LoopTranscript {
    let mut turns = Vec::new();
    let mut prompt = initial_prompt.to_owned();
    for _ in 0..config.max_turns {
        if cancelled() {
            return LoopTranscript {
                turns,
                stopped: StopReason::Cancelled,
                error: None,
            };
        }
        match provider.complete(&prompt) {
            Ok(response) => {
                let found_marker = config
                    .stop_on_marker
                    .map(|marker| response.contains(marker))
                    .unwrap_or(false);
                turns.push(LoopTurn {
                    prompt: prompt.clone(),
                    response: response.clone(),
                });
                if found_marker {
                    return LoopTranscript {
                        turns,
                        stopped: StopReason::MarkerFound,
                        error: None,
                    };
                }
                prompt = response;
            }
            Err(error) => {
                return LoopTranscript {
                    turns,
                    stopped: StopReason::ProviderError,
                    error: Some(error),
                };
            }
        }
    }
    LoopTranscript {
        turns,
        stopped: StopReason::BudgetReached,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loop_respects_the_ide_turn_budget() {
        let transcript = run_loop(
            &LocalEchoProvider,
            "começa",
            LoopConfig {
                max_turns: 2,
                stop_on_marker: None,
            },
            &|| false,
        );
        assert_eq!(transcript.turns.len(), 2);
        assert_eq!(transcript.stopped, StopReason::BudgetReached);
    }

    #[test]
    fn loop_can_be_cancelled_by_the_ide() {
        let transcript = run_loop(&LocalEchoProvider, "x", LoopConfig::default(), &|| true);
        assert!(transcript.turns.is_empty());
        assert_eq!(transcript.stopped, StopReason::Cancelled);
    }

    #[test]
    fn provider_error_stops_the_loop_without_faking_success() {
        struct Failing;
        impl ModelProvider for Failing {
            fn complete(&self, _prompt: &str) -> Result<String, String> {
                Err("provider indisponível".to_owned())
            }
        }
        let transcript = run_loop(&Failing, "x", LoopConfig::default(), &|| false);
        assert_eq!(transcript.stopped, StopReason::ProviderError);
        assert_eq!(transcript.error.as_deref(), Some("provider indisponível"));
    }
}
