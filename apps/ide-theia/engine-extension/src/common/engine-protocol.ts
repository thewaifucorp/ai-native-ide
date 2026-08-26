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
 * Real probe of an agent adapter via `ide-agent`'s `AcpxAgentFacade`
 * (descriptor + non-authenticated health check). `availability` is honest:
 * a missing `acpx`/agent binary reports `unavailable` with a `detail`, never a
 * fabricated `ready`.
 */
export interface AgentProbe {
    /** Adapter id probed (e.g. "codex"). */
    agent: string;
    /** True unless the adapter is unavailable. */
    available: boolean;
    availability: 'ready' | 'degraded' | 'unavailable';
    /** Human-readable reason when degraded/unavailable. */
    detail?: string;
    /** Version the health check detected, if any. */
    detectedVersion?: string;
    /** Descriptor facts (present only when the facade built). */
    transport?: string;
    adapterVersion?: string;
    targetVersion?: string;
    supportsResume?: boolean;
    supportsSteer?: boolean;
    /** Policy/capability surfaces the IDE does NOT enforce — shown, not hidden. */
    degradations: string[];
}

/**
 * Backend service proxied to the frontend over JSON-RPC. Served by the Rust
 * sidecar child process, which now hosts THREE real engines: `ide-diff` (diff /
 * merge), `ide-domain`'s `WorkspaceEffectBroker` (the governed-write broker), and
 * `ide-agent`'s `AcpxAgentFacade` (the agent probe).
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

    /** Real `ide-agent` probe: descriptor + honest health of an agent adapter. */
    agentProbe(agent: string): Promise<AgentProbe>;

    // ── Real ACP session (ide-agent AcpxAgentFacade over acpx) ────────────────
    // The facade lives in the sidecar and owns the ACPX session, so the id
    // returned here is what later calls resolve against.

    /** Open a session. `readOnly` defaults to true in the sidecar. */
    agentStartSession(params: {
        agent: string;
        owner: string;
        workspaceRoot: string;
        homeDir?: string;
        readOnly?: boolean;
        deniedPaths?: string[];
        sandbox?: 'isolated' | 'workspace-net' | 'trusted';
    }): Promise<{ session_id: string }>;

    /** Submit a task; returns the adapter's task id. */
    agentSubmitTask(
        agent: string,
        sessionId: string,
        prompt: string,
        expectation?: 'conversation' | 'code-change'
    ): Promise<{ task_id: number }>;

    /** Drain one event, or null when the session has nothing pending. */
    agentNextEvent(agent: string, sessionId: string): Promise<{ event: AgentEvent | null }>;

    agentCancel(agent: string, sessionId: string, graceful?: boolean): Promise<{ cancelled: boolean }>;
}

/**
 * One `ide_agent::IdeAgentEvent`, serde-tagged by variant name. Only the
 * variants the IDE renders are typed; the rest arrive and are shown raw.
 */
export type AgentEvent =
    | { Started: { session_id: string } }
    | { MessageDelta: { task_id: number; text: string } }
    | { Thinking: { task_id: number; summary: string } }
    | { ToolCall: { task_id: number; name: string; input_digest: string } }
    | { ToolResult: { task_id: number; name: string; output_digest: string; is_error: boolean } }
    | { PermissionRequested: { task_id: number; action: string; detail: string } }
    | { Diff: { task_id: number; path: string; added: number; removed: number } }
    | { Artifact: { task_id: number; kind: string; path: string; digest: string } }
    | { Usage: { task_id: number; input_tokens: number; output_tokens: number } }
    | { Warning: { task_id: number; code: string; detail: string } }
    | { Ended: { task_id: number; outcome: unknown } };
