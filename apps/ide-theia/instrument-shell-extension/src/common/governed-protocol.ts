// Shared contract for the GOVERNED WRITE loop (the product thesis, made real on
// real files). The frontend proposes a write over a real workspace file; the
// backend computes the diff via the Rust `ide-diff` sidecar and queues the effect
// in the real broker, but nothing is written until `approve`. `rollback` restores
// the broker's snapshot.
//
// GOVERNANCE IS REAL (M4, see governed-write-service.ts): the awaiting-approval
// gate, the write, and the snapshot/restore all live in Rust — `ide-domain`'s
// `WorkspaceEffectBroker` (capability registry + SqliteApprovalGate + snapshot
// store), reached through the engine sidecar. The Node service is a thin adapter:
// it reads the pre-image for the diff preview and maps this protocol onto the
// broker's propose → approve → propose-executes → rollback lifecycle.

import { BrokerActivity } from 'engine-extension';

/** JSON-RPC path the governed-write backend service is exposed on. */
export const GOVERNED_SERVICE_PATH = '/services/governed-write';

/** DI symbol; merges with the interface below so the name serves as both. */
export const GovernedWriteService = Symbol('GovernedWriteService');

/** One diff line for the dock preview. Mirrors `ide_diff` line tags. */
export interface DiffLinePreview {
    tag: 'context' | 'added' | 'removed';
    text: string;
}

/** Lifecycle of a single governed write. */
export type WriteState = 'awaiting' | 'approved' | 'rolledback';

/** An awaiting-approval (or resolved) governed write over a real workspace file. */
export interface WriteProposal {
    /** Server-assigned id used to approve / rollback this exact proposal. */
    id: string;
    /** Path relative to the workspace root (what the user sees). */
    relPath: string;
    /** Lines the write would add / remove, per the real `ide-diff` engine. */
    addedLines: number;
    removedLines: number;
    /** Number of hunks the real engine computed. */
    hunkCount: number;
    /** Where in the lifecycle this proposal currently is. */
    state: WriteState;
    /** A capped slice of the real diff, for the dock decision card. */
    preview: DiffLinePreview[];
    /**
     * Set when the adapter had to recover from a governance anomaly while
     * producing this proposal. Shown to the user verbatim — a recovered anomaly
     * is still an anomaly, and hiding it would be the whole problem again.
     */
    warning?: string;
}

/**
 * Governed file write over the real workspace filesystem, proxied to the
 * frontend over JSON-RPC. Paths are confined to the workspace root (traversal
 * is rejected). `proposeWrite` never writes; `approve` writes the new bytes;
 * `rollback` restores the pre-write snapshot.
 */
export interface GovernedWriteService {
    /**
     * Snapshot the current bytes of `<rootUri>/<relPath>`, compute the diff to
     * `newContent` via the real Rust `ide-diff` sidecar, and return an
     * awaiting-approval record. Does NOT modify the file.
     */
    proposeWrite(rootUri: string, relPath: string, newContent: string): Promise<WriteProposal>;

    /** Apply the proposed bytes to the real file. */
    approve(id: string): Promise<WriteProposal>;

    /** Restore the snapshot taken at propose time. */
    rollback(id: string): Promise<WriteProposal>;

    /**
     * The broker's own raw audit trail for this project: every propose,
     * awaiting-approval, snapshot, execute and rollback it recorded. Read on
     * demand — this is the evidence that a governed write is inspectable, not a
     * claim the UI makes on the broker's behalf.
     */
    activity(rootUri: string): Promise<BrokerActivity[]>;
}
