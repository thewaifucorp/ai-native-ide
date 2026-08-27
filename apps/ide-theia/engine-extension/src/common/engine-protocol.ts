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

    /**
     * Run the deterministic Layer-0 checks (§4) over a project.
     *
     * `runTools` executes the commands declared in `.instrument/checks.json`
     * and defaults to FALSE — opening or refreshing a project must never run
     * something a repository file asked for. Asking is a per-call, explicit act.
     */
    harnessRun(root: string, owner: string, runTools?: boolean): Promise<HarnessRun>;

    /**
     * Approve ONE pending effect, named by its id.
     *
     * It used to approve "the next pending effect" for the scope, which
     * authorized the oldest queued row rather than the one decided on. With two
     * decisions open that grants the wrong write.
     */
    brokerApprove(root: string, owner: string, effectId: string): Promise<{ approved_id: number }>;

    /** Restore the snapshot taken when the effect executed. */
    brokerRollback(root: string, owner: string, effectId: string): Promise<{ rolledback: boolean }>;

    /** The broker's honest audit trail for this (owner, root). */
    brokerActivity(root: string, owner: string): Promise<{ activity: BrokerActivity[] }>;

    /** Real `ide-agent` probe: descriptor + honest health of an agent adapter. */
    agentProbe(agent: string): Promise<AgentProbe>;

    // ── Real ACP session (ide-agent AgentFacade over the direct-ACP adapter) ──
    // The facade lives in the sidecar and owns the session, so the id returned
    // here is what later calls resolve against. Because the sidecar is now the
    // ACP client itself, `PermissionRequested` is a question that blocks the
    // agent until `agentRespondPermission` answers it — not a notice about a
    // decision someone else already took.

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

    /**
     * Answer a parked `PermissionRequested`. The agent is blocked on this until
     * it arrives (or until the task's own timeout fires, which counts as a
     * denial). `denyEndsTurn` defaults to the product default: a refusal also
     * ends the turn, so the same goal cannot be retried through another ungated
     * tool.
     */
    agentRespondPermission(
        agent: string,
        sessionId: string,
        requestId: number,
        allow: boolean,
        denyEndsTurn?: boolean
    ): Promise<{ answered: boolean }>;

    // ── §4 preview (ide-reconciliation PreviewSupervisor + evidence ledger) ───
    // The engine owns the lifecycle and refuses to record a clean exit as a
    // failure; the sidecar owns spawning, probing and the log.

    /** Starts the preview declared in `.instrument/preview.json` and waits for
     *  its first honest verdict. Rejects when nothing is declared. */
    previewStart(root: string): Promise<PreviewSnapshot>;

    /** Re-reads the preview. NEVER starts one — `state: null` means not started. */
    previewStatus(root: string): Promise<PreviewSnapshot>;

    /** Stops it, keeping the recorded failures inspectable. */
    previewStop(root: string): Promise<PreviewSnapshot>;

    // ── §4 reconciliation: declared behavior vs observed behavior ─────────────
    // Not §3's axis. §3 reconciles intent against implementation through
    // `.product/` claims; this reconciles a declaration against what was
    // OBSERVED, which is what the preview ledger produces.

    /** Current intents, observations and the divergences between them. */
    reconcileScan(root: string): Promise<ReconciliationSnapshot>;

    /** Records one human decision. The engine refuses an implementation change
     *  with no effect named, and an exception with no justification or scope. */
    reconcileDecide(
        root: string,
        divergenceId: string,
        choice: ReconciliationChoice
    ): Promise<ReconciliationSnapshot>;

    // ── §4 local packs (ide-packs) ────────────────────────────────────────────

    /** Available / installed / applied packs, plus readiness for applied ones.
     *  `passed` / `failed` are check ids actually observed; empty blocks. */
    packsSnapshot(root: string, passed?: string[], failed?: string[]): Promise<PacksSnapshot>;

    /** Installs one local `*.pack.json`. Installing does not apply it. */
    packsInstall(root: string, path: string): Promise<PacksSnapshot>;

    packsApply(root: string, packId: string): Promise<PacksSnapshot>;

    packsRevert(root: string, packId: string): Promise<PacksSnapshot>;

    // ── §6 contexto do agente (ide-context) ───────────────────────────────────

    /** Compiles the minimum package an agent would receive, plus what was left
     *  out and what nobody can answer. Never scans the project. */
    contextCompile(root: string, budgetChars?: number): Promise<ContextPackage>;
}

/** A check's outcome. `unknown` and `not_run` are distinct absences of
 *  knowledge, and NEITHER is ever an approval. */
export type CheckState = 'passed' | 'failed' | 'unknown' | 'not_run';

export type CheckSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** One evaluated check. `evidence` is the observed fact behind `state` — for a
 *  tool check it carries the raw command and its exit status. */
export interface Finding {
    id: string;
    /** camelCase because `ide_harness` serializes with `rename_all = "camelCase"`. */
    checkId: string;
    layer: number;
    title: string;
    state: CheckState;
    severity: CheckSeverity;
    /** The assertion being evaluated. */
    claim: string;
    /** The observed fact supporting the state. */
    evidence: string;
    remediation?: string | null;
}

export interface HarnessReport {
    findings: Finding[];
    passed: number;
    failed: number;
    unknown: number;
    /** camelCase, like the rest of `ide_harness`'s own types. The sidecar's own
     *  wrapper (`HarnessRun`) is snake_case — the two crates differ, and that
     *  seam is exactly where a silently-undefined field hides. */
    notRun: number;
}

/** A command declared in `.instrument/checks.json`. */
export interface DeclaredCheck {
    slug: string;
    command: string;
    cwd?: string | null;
}

export interface HarnessRun {
    report: HarnessReport;
    declared: DeclaredCheck[];
    ran_tools: boolean;
    /** Why the tool checks are `not_run`. Null when they ran. Rendering this is
     *  not optional: a `not_run` with no reason reads as unfinished when it is
     *  usually unconfigured. */
    not_run_reason?: string | null;
    files_scanned: number;
    files_skipped: number;
}

/**
 * One edit a pending permission would perform, as the agent proposed it.
 *
 * `path` is relative to the workspace root when the edit stays inside it and
 * ABSOLUTE when it aims outside — rendering must preserve that difference.
 * `truncated` means the preview was shortened and has to be labelled as such.
 */
export interface AgentPermissionEdit {
    path: string;
    old_text?: string | null;
    new_text: string;
    truncated: boolean;
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
    | {
          PermissionRequested: {
              task_id: number;
              request_id: number;
              action: string;
              detail: string;
              /** Edits this request would perform; empty when none was reported. */
              edits: AgentPermissionEdit[];
          };
      }
    | { Diff: { task_id: number; path: string; added: number; removed: number } }
    | { Artifact: { task_id: number; kind: string; path: string; digest: string } }
    | { Usage: { task_id: number; input_tokens: number; output_tokens: number } }
    | { Warning: { task_id: number; code: string; detail: string } }
    | { Ended: { task_id: number; outcome: unknown } };

// ── §4 PREVIEW (ide-reconciliation) ─────────────────────────────────────────
//
// Mirrors what `engine-sidecar/src/preview.rs` serializes. The WRAPPER fields are
// camelCase; the fields that come straight out of `ide_reconciliation` keep that
// crate's own snake_case. The two casings meeting inside one object is not sloppy
// — it is where a silently-undefined field hides, so each side is named exactly
// as it arrives instead of being "tidied" on the way through.

/** Lifecycle state of a preview. `stale` is a preview that WAS healthy and
 *  stopped answering — recoverable, and deliberately not `broken`. */
export type PreviewHealth = 'starting' | 'healthy' | 'stale' | 'broken' | 'reconnecting';

export interface PreviewState {
    health: PreviewHealth;
    changed_at_ms: number;
    detail?: string | null;
}

/** Identifiers owned by other subsystems (broker effects, activity, files). A
 *  recorded failure always has at least one — the engine refuses the rest. */
export interface CausalLinks {
    effect_ids: string[];
    activity_ids: string[];
    file_paths: string[];
}

/** Why the preview failed. A clean process exit can never appear here: the
 *  engine rejects it as evidence. */
export type PreviewFailureKind =
    | { kind: 'process_exited'; process_id: string; exit_code: number }
    | { kind: 'health_check_failed'; url: string; detail: string };

export interface PreviewFailure {
    id: string;
    preview_id: string;
    /** Points at the log line range that produced this failure. */
    evidence_id: string;
    message: string;
    kind: PreviewFailureKind;
    causal_links: CausalLinks;
    observed_at_ms: number;
}

/** `.instrument/preview.json`, as declared by the project. */
export interface DeclaredPreview {
    command: string;
    cwd?: string | null;
    /** Absent means nothing can be probed — the preview never claims health. */
    url?: string | null;
    readyTimeoutMs?: number | null;
}

export interface PreviewSnapshot {
    declared?: DeclaredPreview | null;
    /** Why there is no usable declaration. Rendering it is not optional. */
    notDeclaredReason?: string | null;
    /** Null until someone started it: NOT STARTED is not broken. */
    state?: PreviewState | null;
    running: boolean;
    /** True when a person stopped it, so `broken` is not read as a crash. */
    stopped: boolean;
    failures: PreviewFailure[];
    /** The last probe attempt verbatim: URL and what came back. */
    lastProbe?: string | null;
    logTail?: string | null;
    logPath?: string | null;
}

// ── §4 RECONCILIATION (ide-reconciliation) ──────────────────────────────────

export interface IntentSpecRecord {
    id: string;
    subject: string;
    expected: unknown;
    /** The file that says so — `.instrument/intents.json` or `preview.json`. */
    source_path: string;
    revision: string;
}

export interface ObservedBehavior {
    id: string;
    subject: string;
    actual: unknown;
    /** Empty means the observation is not eligible for detection at all. */
    evidence_ids: string[];
    observed_at_ms: number;
}

export interface Divergence {
    id: string;
    intent_id: string;
    observation_id: string;
    subject: string;
    expected: unknown;
    actual: unknown;
    evidence_ids: string[];
}

/** Externally tagged, exactly as `ide_reconciliation::ExceptionScope` serializes. */
export type ExceptionScope =
    | { project: { project_id: string } }
    | { resource: { resource_id: string } }
    | { path: { path: string } }
    | { preview: { preview_id: string } };

/** The three decisions a person can take about a divergence. */
export type ReconciliationChoice =
    | { kind: 'change_implementation'; proposed_effect_id: string }
    | { kind: 'change_intent'; revised_expected: unknown }
    | { kind: 'accept_scoped_exception'; scope: ExceptionScope; justification: string };

/** `pending_verification` is NOT resolved: the code still has to change and
 *  produce fresh evidence. Only an explicitly justified, explicitly scoped
 *  exception closes on the spot. */
export type ReconciliationStatus = 'pending_verification' | 'accepted_scoped_exception';

export interface StoredReconciliation {
    divergenceId: string;
    choice: ReconciliationChoice;
    status: ReconciliationStatus;
    atMs: number;
}

export interface DivergenceView {
    divergence: Divergence;
    /** Null means OPEN. An open divergence is never rendered as decided. */
    reconciliation?: StoredReconciliation | null;
}

export interface ReconciliationSnapshot {
    intents: IntentSpecRecord[];
    observations: ObservedBehavior[];
    divergences: DivergenceView[];
    /** Which silence this is: nothing declared, or nothing observed yet. */
    nothingToCompare?: string | null;
    problem?: string | null;
}

// ── §4 LOCAL PACKS (ide-packs) ──────────────────────────────────────────────

/** Deliberately has no native-execution member: a pack observes and guides. */
export type PackCapability = 'read_workspace' | 'run_deterministic_check' | 'offer_guidance';

export interface PackCheck {
    id: string;
    title: string;
    subject: string;
    criterion: string;
    layer: number;
}

export interface PackGuide {
    id: string;
    title: string;
    text: string;
}

export interface Pack {
    id: string;
    name: string;
    domain: string;
    description: string;
    checks: PackCheck[];
    guides: PackGuide[];
    capabilities: PackCapability[];
    reversible: boolean;
}

export interface ReadinessVerdict {
    packId: string;
    ready: boolean;
    /** Checks with no observed result. These BLOCK — unknown is not a pass. */
    missingChecks: string[];
    failedChecks: string[];
    /** Failures accepted by a recorded disposition, kept visible on purpose. */
    dispositionedChecks: string[];
    note: string;
}

/** A `*.pack.json` found under the project's `packs/` directory. */
export interface AvailablePack {
    path: string;
    id?: string | null;
    name?: string | null;
    domain?: string | null;
    checks: number;
    guides: number;
    installed: boolean;
    /** Present when the file exists but cannot be read as a valid pack. */
    problem?: string | null;
}

export interface PacksSnapshot {
    installed: Pack[];
    applied: string[];
    available: AvailablePack[];
    /** One verdict per APPLIED pack. */
    readiness: ReadinessVerdict[];
    lookedIn: string;
    /** Why no pack check has a result. Never omitted while it is true. */
    noObservedResults?: string | null;
}

// ── §6 CONTEXTO DO AGENTE (ide-context) ─────────────────────────────────────
//
// Mirrors `engine-sidecar/src/context.rs`. The wrapper is camelCase; the
// compiler's own types (`ide_context`) already serialize camelCase, so this whole
// surface is camelCase — unlike the §4 preview, where two crates' conventions
// meet.

/** One piece of material in the compiled package, with why it is there. */
export interface ContextSegment {
    /** `guidance:<id>`, `intent`, `truth:<id>`, `evidence:<id>`. */
    origin: string;
    scope: string;
    reason: string;
    text: string;
    /** Policies and required/blocking guidance: never dropped for budget. */
    verbatim: boolean;
    priority: number;
}

export interface CompiledContext {
    segments: ContextSegment[];
    /** Origins the budget cut. Rendering this is the honesty of the budget. */
    droppedForBudget: string[];
    usedChars: number;
    budgetChars: number;
}

export interface ContextSourceRow {
    path: string;
    /** `guidance`, `authority` or `evidence`. */
    kind: string;
    /** Coarse observed version: mtime + byte length. Detects change, never
     *  claims to know what changed. */
    version: string;
}

export interface ContextExclusion {
    what: string;
    reason: string;
}

export interface ContextPackage {
    compiled: CompiledContext;
    sources: ContextSourceRow[];
    /** Real material deliberately left out, each with the reason. */
    excluded: ContextExclusion[];
    /** Rules held while compiling, stated as facts about THIS package. */
    policy: string[];
    /** What declared material cannot answer. Only governed retrieval could —
     *  and it does not exist yet, so this stays unknown. */
    unknown: string[];
    limits: string[];
    /** How many project files are NOT in the package. "Nothing was dumped" has
     *  to be a number, not a promise. */
    projectFilesNotIncluded: number;
}
