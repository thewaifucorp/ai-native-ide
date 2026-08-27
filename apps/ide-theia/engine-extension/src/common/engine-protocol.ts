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

    // ── §13 Guidance Library + Truth Registry (ide-guidance) ──────────────────

    /** Both registries plus `appliedNow` for the open project. */
    librarySnapshot(root: string): Promise<LibrarySnapshot>;

    /** Captures guidance the person wrote. The destination decides its lifecycle. */
    libraryCapture(root: string, request: CaptureRequest): Promise<LibrarySnapshot>;

    /** Imports a steering text as a CANDIDATE — never active, never steering. */
    libraryImport(
        root: string,
        name: string,
        text: string,
        provenance?: string,
        owner?: string
    ): Promise<Guidance>;

    /** `active` | `suspended` | `archived` | `superseded` (needs `by`). */
    libraryLifecycle(
        root: string,
        id: string,
        to: GuidanceState,
        by?: string
    ): Promise<LibrarySnapshot>;

    /** Declares which file owns a subject. */
    truthDeclare(
        root: string,
        subject: string,
        authorityPath: string,
        precedence?: number,
        provenance?: string
    ): Promise<LibrarySnapshot>;

    truthConsumer(root: string, id: string, consumer: string): Promise<LibrarySnapshot>;

    /** Describes the sync work; performs none of it. */
    truthSync(root: string, id: string, upToDate?: string[]): Promise<SyncProposal>;

    // ── §13 config: one schema for the panel and the file ─────────────────────

    // ── §13 referências: serviço e ambiente ───────────────────────────────────

    referencesSnapshot(root: string): Promise<ReferencesSnapshot>;
    /** Links a service/environment to this project, reusing an existing id. */
    referencesLink(
        root: string,
        id: string,
        kind: 'service' | 'environment',
        name: string,
        endpoint: string
    ): Promise<ReferencesSnapshot>;
    /** Unlinks it from THIS project; other projects keep theirs. */
    referencesUnlink(root: string, id: string): Promise<ReferencesSnapshot>;

    // ── §9 trabalho e status calculado ────────────────────────────────────────

    /** Reads the items and COMPUTES every status over material measured now. */
    workSnapshot(root: string): Promise<WorkSnapshot>;
    /**
     * Writes one item artifact. It takes facts — criteria, implementation,
     * evidence — and there is deliberately no status parameter: writing a status
     * has to be impossible, not discouraged.
     */
    workWriteItem(root: string, item: WorkItem): Promise<WorkSnapshot>;

    // ── §16 publicar e evoluir ────────────────────────────────────────────────

    lifecycleSnapshot(root: string): Promise<LifecycleSnapshot>;
    /** Writes the portable manifest locally. Reversible: deleting it undoes it. */
    lifecycleExport(root: string): Promise<PublishAttempt>;
    /** Performs the compensation for a local export: deletes the file. */
    lifecycleDeleteExport(root: string, path: string): Promise<LifecycleSnapshot>;
    /**
     * Publishes (or republishes) the next version.
     *
     * `confirmed` is the person's explicit act; without it an external effect
     * comes back as `needsConfirmation` and NOTHING is recorded. A republish
     * requires the observed problem it fixes.
     */
    lifecyclePublish(
        root: string,
        options: {
            target?: 'compensable' | 'immutable';
            confirmed?: boolean;
            problem?: string;
            relatedResources?: string[];
        }
    ): Promise<PublishAttempt>;

    /**
     * §14 — what the project's mode and permissions require for ONE effect.
     *
     * Answering is all it does: the caller still proposes through the broker, and
     * `auto_approve_recorded` only means the IDE does not stop to ask — the
     * snapshot, the receipt and the rollback are unchanged.
     */
    policyDecide(
        root: string,
        effectClass: 'durable' | 'prototype',
        scope?: { project?: string; resource?: string; tool?: string }
    ): Promise<PolicyDecision>;

    settingsSnapshot(root: string): Promise<SettingsSnapshot>;
    settingsPatch(root: string, patch: SettingsPatch): Promise<SettingsSnapshot>;
    settingsProfile(root: string, profile: string): Promise<SettingsSnapshot>;
    settingsReset(root: string, field: string): Promise<SettingsSnapshot>;
    /** Reversible defaults from what §1 detected. A user value is never touched. */
    settingsDetected(
        root: string,
        git: boolean,
        agent: boolean,
        aag: boolean
    ): Promise<SettingsSnapshot>;

    // ── §13 durable project ───────────────────────────────────────────────────

    projectSnapshot(root: string): Promise<ProjectSnapshot>;
    /** Needs a title AND a written intent: those survive without a transcript. */
    projectRegister(root: string, title: string, intent: string): Promise<ProjectSnapshot>;
    projectAttach(root: string, path: string, kind?: 'directory' | 'repository'): Promise<ProjectSnapshot>;
    projectIntent(root: string, intent: string): Promise<ProjectSnapshot>;

    // ── §8 intenção guiada (ide-semantic) ─────────────────────────────────────

    /** Evaluates the intent and merges the recorded review decisions. Reads
     *  only; the intent text is never rewritten by this call. */
    intentReview(root: string, intent: string, maxFindings?: number): Promise<IntentReview>;

    /** Records one decision. A dismissal requires a reason; accepting may name
     *  the artifact it produced. */
    intentDecide(
        root: string,
        intent: string,
        findingId: string,
        state: 'accepted' | 'dismissed',
        note: string,
        artifact?: string
    ): Promise<IntentReview>;

    // ── §7 notas e reconciliação (ide-notes) ──────────────────────────────────

    notesSnapshot(root: string): Promise<NotesSnapshot>;
    notesCreate(root: string, note: NoteRequest): Promise<NotesSnapshot>;
    /** Closing a note requires saying how. */
    notesResolve(root: string, id: string, reason: string): Promise<NotesSnapshot>;
    /** Superseding requires naming the replacement AND a reason. */
    notesSupersede(root: string, id: string, by: string, reason: string): Promise<NotesSnapshot>;
    notesLink(root: string, id: string, link: NoteLink): Promise<NotesSnapshot>;
    /** Writes a NEW note that supersedes the originals — nothing edited in place. */
    notesMerge(
        root: string,
        ids: string[],
        theme: string,
        subject: string,
        text: string,
        reason: string
    ): Promise<NotesSnapshot>;
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

// ── §13 GUIDANCE LIBRARY + TRUTH REGISTRY (ide-guidance) ────────────────────
//
// Mirrors `engine-sidecar/src/library.rs`. The engine's own types serialize
// camelCase, so this whole surface is camelCase.
//
// The line that matters here: a CANDIDATE never steers an agent. `import` (a
// steering file, a §5 detection) lands `candidate`; only an explicit `activate`
// makes guidance eligible for `appliedNow`, which is the engine's deterministic
// compilation — active + matching scope + matching application, strongest and
// most specific first, each with the reason it applies.

export type GuidanceState = 'candidate' | 'active' | 'suspended' | 'superseded' | 'archived';

export type GuidanceStrengthName = 'suggestion' | 'default' | 'required' | 'blocking';

export type GuidanceTypeName =
    | 'preference'
    | 'convention'
    | 'applicable_decision'
    | 'rule'
    | 'policy';

export type GuidanceApplicationName =
    | 'writing'
    | 'code'
    | 'design'
    | 'tool'
    | 'agent'
    | 'effect'
    | 'general';

/**
 * Internally tagged with `kind`, as the crate declares it.
 *
 * The FIELDS stay snake_case: `rename_all` on a Rust enum renames the VARIANTS,
 * not the fields inside them. Typing `projectId` here produced `undefined` at
 * runtime — the same seam that turned `idle_ms` into "NaN dias" on screen.
 */
export type GuidanceScope =
    | { kind: 'person' }
    | { kind: 'project'; project_id: string }
    | { kind: 'resource'; resource_id: string }
    | { kind: 'path'; path: string }
    | { kind: 'task'; session_id: string };

export type GuidanceDuration =
    | { kind: 'session' }
    | { kind: 'task' }
    | { kind: 'until'; date: string }
    | { kind: 'permanent' };

export interface Guidance {
    id: string;
    name: string;
    guidanceType: GuidanceTypeName;
    scope: GuidanceScope;
    application: GuidanceApplicationName;
    strength: GuidanceStrengthName;
    origin: 'created' | 'imported' | 'suggested';
    duration: GuidanceDuration;
    priority: number;
    owner: string;
    /** Where the sentence came from — a file and line when §5 imported it. */
    provenance: string;
    /** The set (`.guidance/<set>.md`) this guidance belongs to. */
    set: string;
    text: string;
    state: GuidanceState;
    /** 0 until a context compilation actually carried it. */
    lastUsedMs: number;
}

export interface AppliedGuidance {
    guidance: Guidance;
    /** Strength label plus why the scope matched this activity. */
    reason: string;
}

/** Hygiene the engine can prove. `obsolete` is surfaced for review only —
 *  nothing is ever removed automatically. */
export type HygieneFinding =
    | { kind: 'duplicate'; ids: string[]; name: string }
    | { kind: 'point_rule_as_permanent'; id: string; name: string }
    /** `idle_ms`, not `idleMs`: enum variant fields keep the crate's casing. */
    | { kind: 'obsolete'; id: string; name: string; idle_ms: number };

export interface TruthDeclaration {
    id: string;
    subject: string;
    scope: GuidanceScope;
    /** The file that owns the subject. */
    authorityPath: string;
    precedence: number;
    consumers: string[];
    provenance: string;
}

export type TruthFinding = { kind: 'authority_conflict'; ids: string[]; subject: string };

/** Describes a sync and performs none of it. */
export interface SyncProposal {
    subject: string;
    authorityPath: string;
    consumersToUpdate: string[];
    reason: string;
}

export interface LibrarySnapshot {
    guidance: Guidance[];
    /** What WOULD be compiled for the current activity, in order. */
    appliedNow: AppliedGuidance[];
    hygiene: HygieneFinding[];
    truth: TruthDeclaration[];
    conflicts: TruthFinding[];
    libraryPath: string;
    /** The window behind the `obsolete` findings, so the badge is explainable. */
    stalenessWindowMs: number;
}

/** A capture, as the panel sends it. `destination` decides state, duration and
 *  set — never an inference, and a malformed one is refused. */
export interface CaptureRequest {
    name: string;
    text: string;
    guidanceType?: GuidanceTypeName;
    application?: GuidanceApplicationName;
    strength?: GuidanceStrengthName;
    owner?: string;
    provenance?: string;
    /** `use_now`, `create_stable`, `record_decision` or `incorporate:<set>`. */
    destination: string;
}

// ── §13 CONFIG (ide-config) ─────────────────────────────────────────────────

export interface SettingRow {
    field: string;
    label: string;
    value: string;
    /** `default`, `detected` or `user`. A user value survives detection. */
    source: 'default' | 'detected' | 'user';
    /** Plain-language consequence, from the engine. */
    explain: string;
    /** True when nothing consumes this value yet — marked, never hidden. */
    declaredNotWired: boolean;
}

// ── §13 references: a service has an address, not a path ─────────────────────

/**
 * A service or environment this project depends on.
 *
 * NOT the §5 "references" (`.product/references/*.json`), which are project
 * MATERIAL with provenance and go through the broker. These are addresses: no
 * path, no bytes to version, and no status — nothing here calls the endpoint, so
 * any health claim would be invented.
 */
export interface ProjectReference {
    id: string;
    /** `service` | `environment`. */
    kind: string;
    name: string;
    endpoint: string;
    /** Projects linking this reference — it is shared, never duplicated. */
    projects: string[];
}

export interface ReferencesSnapshot {
    references: ProjectReference[];
    projectId?: string;
    /** Why linking is unavailable (no durable project yet), when it is. */
    blockedReason?: string;
    registryPath: string;
    /** Said in the payload: registering declares a dependency, it verifies nothing. */
    note: string;
}

// ── §9 work: Features, Tasks and a status nobody can type ────────────────────

/** What a verification produced, and over WHAT material. */
export interface WorkEvidence {
    passed: boolean;
    atMs: number;
    /** The subject the proof was taken over (a path, a check id). */
    subject: string;
    /** Hash of that subject AT PROOF TIME — what makes proof go stale. */
    subjectHash: string;
    note: string;
}

export interface WorkCriterion {
    id: string;
    text: string;
    evidence?: WorkEvidence;
    /** Proposed by an agent and not adopted: shown, counted nowhere. */
    proposed?: boolean;
}

export interface WorkItem {
    id: string;
    title: string;
    /** `feature` | `task` | `subtask`. */
    kind: string;
    /** Items this one serves. Empty = direct task; many = multi-feature task. */
    parents?: string[];
    criteria?: WorkCriterion[];
    /** Subjects that implement this item. */
    implementation?: string[];
    /** Reason, when someone declared it blocked. */
    blocked?: string;
}

/** A computed status. There is no field anywhere that sets one. */
export interface WorkStatusReport {
    id: string;
    /** One of the seven §9 states, computed. */
    status: string;
    /** Why it came out that way — a status nobody can explain is one somebody typed. */
    reason: string;
    criteriaTotal: number;
    criteriaVerified: number;
    staleCriteria: string[];
    unobservedSubjects: string[];
    proposedCriteria: number;
    children: string[];
}

export interface WorkHierarchyProblem {
    id: string;
    problem: string;
}

export interface WorkSnapshot {
    items: WorkItem[];
    statuses: WorkStatusReport[];
    problems: WorkHierarchyProblem[];
    /** Item files that could not be read, with the reason for each. */
    unreadable: { path: string; problem: string }[];
    /** Subject → hash measured NOW: the evidence that freshness was measured. */
    observed: Record<string, string>;
    itemsDir: string;
}

// ── §16 lifecycle: export, publish, republish ────────────────────────────────

/** A manifest already written to `.instrument/exports/`. */
export interface ExportedFile {
    path: string;
    bytes: number;
    version?: string;
}

/** The compensating action for an effect, or the honest absence of one. */
export interface CompensationPlan {
    /** `reversible` | `compensation_only` | `irreversible`. */
    reversibility: string;
    /** `delete_exported_file` | `publish_compensating_version`. */
    kind: string;
    target: string;
    note: string;
}

export interface PublishRecord {
    projectId: string;
    version: string;
    problem?: string;
    relatedResources: string[];
    note: string;
    reversibility: string;
    compensation?: CompensationPlan;
}

export interface LifecycleSnapshot {
    projectId?: string;
    title?: string;
    latestVersion?: string;
    nextVersion: string;
    history: PublishRecord[];
    exports: ExportedFile[];
    /** Why publishing is unavailable right now, when it is. */
    blockedReason?: string;
    logPath: string;
    exportsPath: string;
}

/**
 * The result of trying to export or publish.
 *
 * `needsConfirmation` means NOTHING happened yet: the engine decided this effect
 * requires an explicit act first. The reversibility class and the compensation
 * plan travel with it, so the confirmation names what cannot be undone.
 */
export interface PublishAttempt {
    needsConfirmation: boolean;
    reversibility: string;
    compensation?: CompensationPlan;
    explain: string;
    record?: PublishRecord;
    snapshot: LifecycleSnapshot;
}

/** §14 — the policy answer for one effect, from `ide-modes` + `ide-config`. */
export interface PolicyDecision {
    /** `full_vibes` | `hybrid` | `spec`. */
    mode: string;
    /** The EFFECTIVE permission for this context, scoped override included. */
    permissions: string;
    /** True when a scoped override, not the project-wide value, decided. */
    scoped: boolean;
    /** `prototype` | `durable`. */
    class: string;
    /** `require_approval` | `auto_approve_recorded`. */
    effect: string;
    /** `proceed` | `proceed_recording_hypothesis` | `require_checkpoint` | `resolve_contract_first`. */
    interruption: string;
    /** Plain sentence naming what decided, for the decision card. */
    explain: string;
}

export interface SettingsSnapshot {
    /** The typed config, exactly as the file holds it. */
    config: unknown;
    rows: SettingRow[];
    profiles: { name: string; layout: string; depth: string }[];
    /** The file the panel is editing, so both surfaces are visibly one thing. */
    path: string;
}

export interface SettingsPatch {
    mode?: 'full_vibes' | 'hybrid' | 'spec';
    depth?: 'essential' | 'detailed' | 'raw';
    layout?: 'focused' | 'balanced' | 'expanded';
    permissions?: 'cautious' | 'balanced' | 'yolo';
    harnessLayers?: number[];
    automaticCheckpoints?: boolean;
    idlePaidInference?: boolean;
}

// ── §13 DURABLE PROJECT (ide-domain semantic store) ─────────────────────────

export interface ProjectRecord {
    /** Newtype in Rust (`ProjectId(String)`), so it arrives as a plain string. */
    id: string;
    title: string;
    intent: string;
    created_at_ms: number;
    updated_at_ms: number;
}

export interface DurableResource {
    id: string;
    kind: 'directory' | 'repository';
    canonical_path: string;
    created_at_ms: number;
}

export interface ProjectSnapshot {
    /** Null until somebody registers one: a folder is not a project. */
    project?: ProjectRecord | null;
    resources: DurableResource[];
    allProjects: ProjectRecord[];
    storePath: string;
    notRegisteredReason?: string | null;
    /** Capabilities this surface deliberately does not have yet. */
    gaps: string[];
}

// ── §8 INTENÇÃO GUIADA (ide-semantic) ───────────────────────────────────────
//
// Mirrors `engine-sidecar/src/intent.rs`. Layer-1 findings are HYPOTHESES: each
// carries the text that triggered it, a calibrated confidence and a review
// state. They never block an effect (only a failing Layer-0 check does) and they
// never enter the agent context (§6 compiles active guidance and declared
// authority, never a finding).

export type SemanticCategory = 'ambiguity' | 'missing_decision' | 'risk' | 'contradiction';

export type SemanticReviewState = 'open' | 'accepted' | 'dismissed';

export interface SemanticFinding {
    id: string;
    evaluator: string;
    evaluatorVersion: string;
    layer: number;
    category: SemanticCategory;
    /** What the finding asserts. A contradiction quotes the declaration too. */
    claim: string;
    /** The exact text that triggered it — never a bare guess. */
    evidence: string;
    /** Calibrated 0–1. Keyword rules stay modest; a literal contradiction is high. */
    confidence: number;
    severity: CheckSeverity;
    remediation: string;
    reviewState: SemanticReviewState;
}

export interface SemanticReport {
    findings: SemanticFinding[];
    /** Findings the budget held back — least severe first. */
    withheldForBudget: number;
    evaluatorsRun: string[];
    /** Stable hash of the evaluated intent. */
    contentHash: string;
}

/** A statement the project declared, plus the literal text it forbids. */
export interface DeclaredStatement {
    id: string;
    source: string;
    statement: string;
    forbidden: string;
}

export interface ReviewDecision {
    findingId: string;
    state: 'accepted' | 'dismissed';
    /** Why. Required for a dismissal. */
    note: string;
    /** The intent hash this decision was taken on. */
    intentHash: string;
    atMs: number;
    /** The artifact accepting produced, when it produced one. */
    artifact?: string | null;
}

export interface ReviewedFinding {
    finding: SemanticFinding;
    /** Null means nobody decided yet. */
    decision?: ReviewDecision | null;
    /** True when the decision was taken on a DIFFERENT intent text. */
    decidedOnOtherIntent: boolean;
}

export interface IntentReview {
    report: SemanticReport;
    reviewed: ReviewedFinding[];
    /** The declarations the contradiction check ran against. */
    declared: DeclaredStatement[];
    /** Facts about what these findings do — not advice, not a threat. */
    consequences: string[];
    nothingFound?: string | null;
}

// ── §7 NOTAS E RECONCILIAÇÃO (ide-notes) ────────────────────────────────────
//
// Mirrors `engine-sidecar/src/notes.rs`. Every conflict is a comparison anybody
// can redo by reading two notes; promotion, merge and discard are separate,
// explicit acts, and each records its reason.

export type NoteKind = 'proposal' | 'decision' | 'question' | 'alternative';

/** `superseded` is a STATE, not a kind: a replaced decision is still a decision. */
export type NoteState = 'open' | 'resolved' | 'superseded';

/** Externally tagged with `kind`/`id`, as the crate declares. */
export type NoteLink =
    | { kind: 'message'; id: string }
    | { kind: 'reference'; id: string }
    | { kind: 'file'; id: string }
    | { kind: 'sot'; id: string }
    | { kind: 'guidance'; id: string }
    | { kind: 'feature'; id: string }
    | { kind: 'task'; id: string };

export interface Note {
    id: string;
    theme: string;
    kind: NoteKind;
    /** What the note is about. Two decisions sharing it are comparable. */
    subject: string;
    text: string;
    links: NoteLink[];
    state: NoteState;
    /** Set only when superseded, and never empty then. */
    supersededBy?: string | null;
    /** Why it was resolved or superseded. Required for both. */
    stateReason?: string | null;
    createdAtMs: number;
    updatedAtMs: number;
}

export type NoteConflict =
    | { kind: 'decisions_disagree'; subject: string; note_ids: string[] }
    | {
          kind: 'contradicts_declaration';
          note_id: string;
          source: string;
          forbidden: string;
          statement: string;
      }
    | {
          kind: 'question_on_decided_subject';
          subject: string;
          question_id: string;
          decision_id: string;
      }
    | { kind: 'dangling_link'; note_id: string; link: string }
    | { kind: 'stale_guidance_link'; note_id: string; guidance_id: string };

/** What the conflict check ran against — an empty conflict list only means
 *  something if you can see what was compared. */
export interface KnownWorld {
    files: string[];
    sots: string[];
    references: string[];
    activeGuidance: string[];
    knownGuidance: string[];
    features: string[];
    tasks: string[];
    forbidden: { source: string; statement: string; forbidden: string }[];
}

export interface NotesSnapshot {
    notes: Note[];
    conflicts: NoteConflict[];
    themes: string[];
    known: KnownWorld;
    notesPath: string;
}

export interface NoteRequest {
    theme: string;
    kind: NoteKind;
    subject: string;
    text: string;
    links?: NoteLink[];
}
