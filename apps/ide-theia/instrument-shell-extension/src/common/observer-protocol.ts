// EXTERNAL WRITE OBSERVER — shared contract (WORK-05, DESIGN "mudanças externas
// entram no mesmo fluxo de observação e reconciliação").
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
// The governed-write loop only governs writes that go THROUGH the IDE. But in
// agent-driven development the person's own agent (Claude Code, codex, a script,
// the terminal) writes project files with its own tools. Those writes are the
// normal case, not the exception — and until now the IDE could not see them: no
// snapshot, no receipt, no rollback, nothing in the dock.
//
// Demanding that every agent adopt an IDE-specific API is not a fix; the shared
// interface between a person and their agent is the FILESYSTEM. So the IDE
// observes it: it keeps a baseline of the project's text files, reports drift
// against that baseline with a real diff, and reconciles each drift one of two
// ways — accept it (new baseline + receipt) or revert it, where the revert is
// proposed through the SAME governed broker as any other write, so it is itself
// snapshotted, approvable and reversible.
//
// The observer never blocks a write and never edits a file on its own. It makes
// the invisible visible, and routes the decision through governance.
//
// It also SUBTRACTS itself: every write the IDE performs (an editor save, an
// approved effect, an MCP call, the harness writing artifacts) is recorded in the
// write-source ledger and folded into the baseline automatically. What is left in
// `drifts` is only what the IDE cannot account for — otherwise the person's own
// saves would fill the list and the surface would be noise.

/** JSON-RPC path the observer is exposed on. */
export const OBSERVER_SERVICE_PATH = '/services/observer';

/** DI symbol; merges with the interface below so the name serves as both. */
export const ObserverService = Symbol('ObserverService');

/** What happened to a file relative to the recorded baseline. */
export type DriftKind = 'created' | 'modified' | 'deleted';

/**
 * Who the IDE can PROVE performed a write, when it can.
 *
 *  editor   — the person saved it in the IDE
 *  governed — the broker executed an approved effect
 *  mcp      — a tool call through the agent surface
 *  harness  — the harness registry wrote its own artifacts
 *  unknown  — the IDE did not perform this write (an outside agent, a script,
 *             the terminal). This is the only kind that needs reconciling.
 */
export type WriteAttribution = 'editor' | 'governed' | 'mcp' | 'harness' | 'unknown';

/** One observed difference between the baseline and what is on disk now. */
export interface Drift {
    /** Path relative to the project root. */
    relPath: string;
    kind: DriftKind;
    /** Lines the external write added / removed, per the real diff engine. */
    addedLines: number;
    removedLines: number;
    /** True when the previous bytes are still recoverable from the baseline. */
    revertible: boolean;
    /** File modification time observed on disk, ISO. */
    observedAt: string;
    /** Honest note when the drift cannot be fully characterised. */
    detail?: string;
    /** Who wrote it, when the IDE can prove it. */
    source: WriteAttribution;
    /** Evidence behind a non-`unknown` source. */
    sourceDetail?: string;
}

/** One entry of the observer's own history. */
export interface ObserverReceipt {
    at: string;
    relPath: string;
    action: 'baseline' | 'accepted' | 'revert-proposed' | 'auto-reconciled';
    detail: string;
}

/** Everything the frontend renders about external writes. */
export interface ObserverReport {
    /** True once a baseline exists; before that, drift cannot be computed. */
    baselineExists: boolean;
    /** Number of files the baseline tracks. */
    trackedFiles: number;
    /** ISO timestamp of the last baseline update. */
    baselineAt?: string;
    /** Writes the IDE could NOT attribute to itself — what needs a decision. */
    drifts: Drift[];
    /**
     * Writes the IDE performed itself, folded into the baseline automatically in
     * this scan. Listed so the reconciliation is visible instead of silent.
     */
    reconciled: Drift[];
    receipts: ObserverReceipt[];
    /** Paths skipped and why (too large, binary, unreadable) — shown, not hidden. */
    skipped: { relPath: string; reason: string }[];
}

/**
 * Observation and reconciliation of writes the IDE did not perform.
 *
 * `scan` is read-only. `accept` records a decision without touching the file.
 * `revert` does NOT write either: it proposes the baseline bytes through the
 * governed broker and returns the resulting proposal id, so the restore lands on
 * the same decision card, with its own snapshot and rollback.
 */
export interface ObserverService {
    /**
     * Report a save the person performed in the IDE, so it is not mistaken for an
     * external write. Called by the frontend on every editor save.
     */
    noteEditorSave(rootUri: string, relPath: string): Promise<void>;

    /** Establish (or re-establish) the baseline for the whole project. */
    baseline(rootUri: string): Promise<ObserverReport>;

    /** Compare disk against the baseline. Creates the baseline on first use. */
    scan(rootUri: string): Promise<ObserverReport>;

    /** Adopt the current bytes of `relPath` as the new baseline. */
    accept(rootUri: string, relPath: string): Promise<ObserverReport>;

    /**
     * Propose restoring the baseline bytes of `relPath` through the governed
     * broker. Returns the proposal id awaiting a decision — nothing is written
     * by this call.
     */
    proposeRevert(rootUri: string, relPath: string): Promise<{ proposalId: string; relPath: string }>;
}
