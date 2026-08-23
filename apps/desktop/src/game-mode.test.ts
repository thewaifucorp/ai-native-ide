import { describe, expect, it } from "vitest";
import {
  createGameModeState,
  readArchetypes,
  recordOutcome,
  setGameModeEnabled,
  verifiedProgress,
  type OutcomeCandidate,
} from "./game-mode";

const independentOutcome: OutcomeCandidate = {
  id: "feature:checkout",
  category: "feature-validated",
  summary: "Checkout completes in an observed preview probe.",
  proposedBy: "agent:builder",
  evidence: [
    {
      id: "probe:checkout-1",
      source: "preview-probe",
      verifiedBy: "host:preview",
      observedAt: "2026-08-23T12:00:00.000Z",
      summary: "Preview probe completed checkout successfully.",
    },
  ],
};

describe("Game Mode outcome ledger", () => {
  it("awards cosmetic progress and a receipt only for an independently verified outcome", () => {
    const result = recordOutcome(createGameModeState(), independentOutcome, "2026-08-23T12:01:00.000Z");

    expect(result.receipt).toMatchObject({
      id: "outcome-receipt:feature:checkout",
      status: "OutcomeVerified",
      progressGranted: 1,
    });
    expect(verifiedProgress(result.state)).toBe(1);
    expect(readArchetypes(result.state)).toEqual([
      expect.objectContaining({ archetype: "Explorer", outcomeIds: ["feature:checkout"] }),
    ]);
  });

  it("never turns a prompt, token count, elapsed time, clicks, or lines into progress", () => {
    const unverified: OutcomeCandidate = {
      ...independentOutcome,
      id: "feature:claimed-only",
      summary: "Prompt #12, 9,000 tokens, 30 minutes, 20 clicks and 180 lines changed.",
      evidence: [],
    };
    const result = recordOutcome(createGameModeState(), unverified, "2026-08-23T12:01:00.000Z");

    expect(result.receipt).toMatchObject({
      status: "Rejected",
      reason: "missing-independent-evidence",
      progressGranted: 0,
    });
    expect(verifiedProgress(result.state)).toBe(0);
  });

  it("rejects an agent or person verifying its own claimed outcome", () => {
    const selfReviewed: OutcomeCandidate = {
      ...independentOutcome,
      evidence: [{ ...independentOutcome.evidence[0], verifiedBy: "agent:builder" }],
    };
    const result = recordOutcome(createGameModeState(), selfReviewed, "2026-08-23T12:01:00.000Z");

    expect(result.receipt).toMatchObject({
      status: "Rejected",
      reason: "self-verified-evidence",
      progressGranted: 0,
    });
  });

  it("does not double-award a receipt for the same outcome", () => {
    const first = recordOutcome(createGameModeState(), independentOutcome, "2026-08-23T12:01:00.000Z");
    const duplicate = recordOutcome(first.state, independentOutcome, "2026-08-23T12:02:00.000Z");

    expect(duplicate.receipt).toMatchObject({ reason: "already-receipted", progressGranted: 0 });
    expect(verifiedProgress(duplicate.state)).toBe(1);
  });

  it("keeps verification and receipts working when Game Mode is disabled", () => {
    const hidden = setGameModeEnabled(createGameModeState(), false);
    const result = recordOutcome(hidden, independentOutcome, "2026-08-23T12:01:00.000Z");

    expect(result.state.enabled).toBe(false);
    expect(result.receipt.status).toBe("OutcomeVerified");
    expect(verifiedProgress(result.state)).toBe(1);
  });
});
