// Shared contract for the M3 GOVERNED WRITE loop (the product thesis, made real
// on real files). The frontend proposes a write over a real workspace file; the
// backend snapshots the current bytes and computes the diff via the EXISTING
// Rust `ide-diff` sidecar, but does NOT write until `approve`. `rollback`
// restores the snapshot.
//
// HONEST BOUNDARY (see governed-write-service.ts): the governance here — the
// awaiting-approval gate + snapshot/restore — runs in the Node backend service
// as a STAND-IN. The real `ide-domain` `WorkspaceEffectBroker` (Rust, with
// capability + policy gates) is wired in M4. M3 proves the UX loop end-to-end on
// real files.

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
}
