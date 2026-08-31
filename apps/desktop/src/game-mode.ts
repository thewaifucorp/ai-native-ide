/**
 * UI-neutral Game Mode ledger.
 *
 * This deliberately accepts only independently observed outcomes. It never
 * receives prompts, token counts, elapsed time, clicks, or lines changed: they
 * are activity telemetry, not proof that somebody built something useful.
 */

export type OutcomeCategory =
  | "requirement-satisfied"
  | "finding-resolved"
  | "feature-validated"
  | "divergence-reconciled"
  | "publication-completed";

export type Archetype = "Explorer" | "Architect" | "Finisher" | "Guardian" | "Operator";

export type EvidenceSource =
  | "test-run"
  | "preview-probe"
  | "review"
  | "reconciliation-engine"
  | "deployment-provider";

export interface IndependentEvidence {
  id: string;
  source: EvidenceSource;
  /** The independent system or person that made the observation. */
  verifiedBy: string;
  observedAt: string;
  summary: string;
}

export interface OutcomeCandidate {
  id: string;
  category: OutcomeCategory;
  summary: string;
  proposedBy: string;
  evidence: readonly IndependentEvidence[];
}

export type RejectionReason =
  | "missing-independent-evidence"
  | "self-verified-evidence"
  | "already-receipted";

export interface OutcomeReceipt {
  id: string;
  outcomeId: string;
  category: OutcomeCategory;
  status: "OutcomeVerified" | "Rejected";
  reason?: RejectionReason;
  evidence: readonly IndependentEvidence[];
  /** One outcome point is a cosmetic record, never a product capability. */
  progressGranted: 0 | 1;
  recordedAt: string;
}

export interface ArchetypeReading {
  archetype: Archetype;
  outcomeIds: readonly string[];
  description: string;
}

export interface GameModeState {
  enabled: boolean;
  receipts: readonly OutcomeReceipt[];
}

export interface GameModeTransition {
  state: GameModeState;
  receipt: OutcomeReceipt;
}

const categoryArchetype: Record<OutcomeCategory, Archetype> = {
  "feature-validated": "Explorer",
  "divergence-reconciled": "Architect",
  "requirement-satisfied": "Finisher",
  "finding-resolved": "Guardian",
  "publication-completed": "Operator",
};

const archetypeDescription: Record<Archetype, string> = {
  Explorer: "Valida hipóteses com resultados observáveis.",
  Architect: "Esclarece contratos e reconcilia partes que divergiram.",
  Finisher: "Transforma intenções declaradas em entregas verificadas.",
  Guardian: "Remove riscos e findings sem regressão comprovada.",
  Operator: "Leva produtos verificados para uma operação publicada.",
};

export function createGameModeState(enabled = true): GameModeState {
  return { enabled, receipts: [] };
}

/**
 * Disablement changes presentation only. Outcome verification, receipts and
 * every non-game product workflow remain available while Game Mode is hidden.
 */
export function setGameModeEnabled(state: GameModeState, enabled: boolean): GameModeState {
  return { ...state, enabled };
}

/**
 * Records an independently verified outcome exactly once. The function is
 * deterministic and side-effect free, so hosts may persist receipts or render
 * them without coupling Game Mode to the rest of the IDE.
 */
export function recordOutcome(
  state: GameModeState,
  candidate: OutcomeCandidate,
  recordedAt: string,
): GameModeTransition {
  const duplicate = state.receipts.some((receipt) => receipt.outcomeId === candidate.id);
  const independentEvidence = candidate.evidence.filter((evidence) => evidence.verifiedBy !== candidate.proposedBy);
  const reason: RejectionReason | undefined = duplicate
    ? "already-receipted"
    : candidate.evidence.length === 0
      ? "missing-independent-evidence"
      : independentEvidence.length === 0
        ? "self-verified-evidence"
        : undefined;
  const verified = reason === undefined;
  const receipt: OutcomeReceipt = {
    id: `outcome-receipt:${candidate.id}`,
    outcomeId: candidate.id,
    category: candidate.category,
    status: verified ? "OutcomeVerified" : "Rejected",
    ...(reason ? { reason } : {}),
    evidence: independentEvidence,
    progressGranted: verified ? 1 : 0,
    recordedAt,
  };

  return { state: { ...state, receipts: [...state.receipts, receipt] }, receipt };
}

/** Progress is cosmetic; callers use `enabled` solely to decide whether to render it. */
export function verifiedProgress(state: GameModeState): number {
  return state.receipts.reduce((total, receipt) => total + receipt.progressGranted, 0);
}

/**
 * Descriptive, evidence-backed readings. They are not roles, permissions or
 * limits; the linked receipts let a person inspect or correct the conclusion.
 */
export function readArchetypes(state: GameModeState): readonly ArchetypeReading[] {
  return (Object.keys(archetypeDescription) as Archetype[])
    .map((archetype) => {
      const outcomeIds = state.receipts
        .filter(
          (receipt) =>
            receipt.status === "OutcomeVerified" && categoryArchetype[receipt.category] === archetype,
        )
        .map((receipt) => receipt.outcomeId);
      return { archetype, outcomeIds, description: archetypeDescription[archetype] };
    })
    .filter((reading) => reading.outcomeIds.length > 0);
}

