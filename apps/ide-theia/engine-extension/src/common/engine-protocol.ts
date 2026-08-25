// Shared contract between the Theia frontend proxy and the backend service.
// Both sides import ENGINE_SERVICE_PATH + the EngineService type from here.

/** JSON-RPC path the backend service is exposed on and the frontend proxies to. */
export const ENGINE_SERVICE_PATH = '/services/engine-diff';

/** DI symbol; merges with the interface below so the name serves as both. */
export const EngineService = Symbol('EngineService');

/** Mirrors `ide_diff::LineTag` (serde `snake_case`). */
export type LineTag = 'context' | 'added' | 'removed';

/** Mirrors `ide_diff::DiffLine` (serde `camelCase`). */
export interface DiffLine {
    tag: LineTag;
    text: string;
}

/** Mirrors `ide_diff::Hunk` (serde `camelCase`). */
export interface Hunk {
    id: number;
    oldStart: number;
    newStart: number;
    lines: DiffLine[];
}

/**
 * One broker activity entry. Mirrors `ide_domain::BrokerActivity` (serde tagged
 * `kind` in snake_case): the audit trail the real broker records as an effect
 * moves through propose → snapshot → execute → rollback.
 */
export interface BrokerActivity {
    kind: 'proposed' | 'awaiting_approval' | 'snapshot_created' | 'executed' | 'rolled_back';
    effect_id: string;
    path?: string;
}

/**
 * Backend service proxied to the frontend over JSON-RPC. Served by the Rust
 * sidecar child process, which now hosts TWO real engines: `ide-diff` (diff /
 * merge) and `ide-domain`'s `WorkspaceEffectBroker` (the governed-write broker).
 */
export interface EngineService {
    /** Health check — confirms the Rust sidecar spawned and is responding. */
    ping(): Promise<{ pong: boolean; engine: string }>;

    /** Real `ide_diff::diff` — line-level hunks between original and proposed. */
    diff(original: string, proposed: string): Promise<Hunk[]>;

    /** Real `ide_diff::merge_selected` — rebuild content applying only the given hunk ids. */
    mergeSelected(original: string, proposed: string, selected: number[]): Promise<string>;

    // ── Real governed-write broker (ide-domain WorkspaceEffectBroker) ──────────
    // One live broker per (owner, root) in the sidecar. First `brokerPropose`
    // QUEUES the effect (nothing written); `brokerApprove` grants the
    // SqliteApprovalGate; a second identical `brokerPropose` EXECUTES the write
    // and records a snapshot; `brokerRollback` restores it.

    /** Propose a governed write. Queues on first call, executes once approved. */
    brokerPropose(
        root: string,
        owner: string,
        effectId: string,
        relativePath: string,
        content: string
    ): Promise<{ awaiting_approval?: boolean; written?: boolean; path?: string }>;

    /** Approve the next pending effect for this (owner, root). */
    brokerApprove(root: string, owner: string): Promise<{ approved_id: number }>;

    /** Restore the snapshot taken when the effect executed. */
    brokerRollback(root: string, owner: string, effectId: string): Promise<{ rolledback: boolean }>;

    /** The broker's honest audit trail for this (owner, root). */
    brokerActivity(root: string, owner: string): Promise<{ activity: BrokerActivity[] }>;
}
