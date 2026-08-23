# Phase 1: Category Proof - Research

**Researched:** 2026-08-22
**Domain:** Desktop IDE walking skeleton, privileged process boundary, agent execution, preview/evidence correlation, and concurrent benchmark behavior
**Confidence:** HIGH for platform primitives and security boundaries; MEDIUM for the shell choice until the same-slice spike is measured

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- Vertical walking skeleton; never frontend-first or backend-first horizontal delivery.
- Compare Tauri and Electron using the same representative slice, then keep one.
- React/TypeScript UI, Rust-oriented privileged core boundary, Monaco candidate, real PTY.
- AAG is an external degradable graph/evidence provider, not the source of truth.
- Project is semantic and above repos/sessions; Phase 1 may use one benchmark repo while preserving the boundary.
- Hybrid, balanced permissions, reversible checkpoints, no paid idle inference.
- Instrument visual language and progressive depth from global `UI-SPEC.md`.
- Essential and Raw must both be reachable in the slice.
- Context Dock is canonical for permissions; Activity Strip links actions to observed effects.
- Authorization itself never grants Game Mode progression.
- No required Katsui, ShinAI infrastructure, marketplace, cloud account, or subscription.

### the agent's Discretion

Remaining implementation-level choices may be decided by the team as long as they preserve the product thesis, Katsui boundary, free/local core, model neutrality, and simplified default UX.

### Deferred Ideas (OUT OF SCOPE)

- No generalized marketplace or inference rail.
- No complete plugin system.
- No production-grade multi-repo semantic graph yet.
- No full Katsui Company Brain capabilities.
- No comprehensive harness packs.
- No polished publishing platform.
- No multiple companions, seasons, leaderboards, or cloud progression.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|---|---|---|
| PROJ-01 | Criar projeto semântico por intenção ou abrir produto existente sem escolher estrutura técnica. | Define a minimal project manifest whose identity is independent of repository and session, plus a no-wizard intent entry flow. |
| WORK-04 | Abrir preview executável e relacionar erros à sessão e aos artefatos relevantes. | Defines supervised preview lifecycle and causal activity/effect/artifact correlation. |
| INTN-01 | Autocomplete reveals ambiguities, missing decisions, risks, and relevant concepts. | Defines a deterministic benchmark-specific intent preflight rather than a generic text completion. |
| CONF-01 | Start a new project by describing intent without a technical wizard. | Keeps stack/repository choices behind defaults; only an effect-time decision interrupts the path. |
| LIFE-01 | Traverse intent, construction, preview, evidence, and reconciliation in an executable microsaaS. | Defines the single acceptance journey and evidence ledger that binds every stage. |
</phase_requirements>

## Summary

Phase 1 should be one executable walking skeleton backed by one shared React/TypeScript renderer and one typed privileged contract. The Tauri and Electron candidates must host exactly that same renderer and invoke the same Rust-oriented core contract; only shell-specific bridge and lifecycle code may differ. The spike is a decision experiment, not two product branches. [CITED: https://v2.tauri.app/concept/inter-process-communication/] [CITED: https://www.electronjs.org/docs/latest/tutorial/process-model]

The differentiating proof is not editor chrome. It is one causal chain: informal intent → guided clarification → scoped agent activity → approved effect → real file mutation → preview observation → deterministic/semantic evidence → divergence choice → verified outcome receipt. Durable events and editable files coexist; neither chat nor an append-only event log owns the project. This is a project-specific architectural recommendation derived from the locked product constraints.

The benchmark must implement bids server-side in an atomic database transaction and never disclose the current winning bid. SQLite serializes writes and `BEGIN IMMEDIATE` acquires a write transaction before the read-modify-write sequence; concurrent tests must use separate connections and assert one committed winner, stable ordering rules, no leaked bid values, and retry/timeout behavior. [CITED: https://www.sqlite.org/isolation.html] [CITED: https://www.sqlite.org/lang_transaction.html]

**Primary recommendation:** Build the shell-neutral walking skeleton first, attach two minimal host bridges to it for a time-boxed same-slice measurement, record an ADR from weighted evidence, delete the losing host and all throwaway probes, then continue Phase 1 only on the selected shell.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|---|---|---|---|
| Instrument shell and progressive depth | Browser / Client | Desktop host | React owns projections and interaction; the host only supplies typed capabilities. |
| Project/resource identity | Privileged core / local backend | Local storage | Renderer must not derive authority from paths or conversations. |
| File read/write/watch | Privileged core / local backend | OS filesystem | File effects require path/scope validation outside the renderer. |
| PTY and process lifecycle | Privileged core / worker process | OS process boundary | Terminal authority and cleanup cannot live in browser UI. |
| Preview supervision | Privileged core / local backend | Isolated web content surface | Host starts/stops process; preview renderer displays only isolated output. |
| Agent adapter | Privileged core / adapter process | React projection | Adapter owns transport and capabilities; UI renders normalized events and degradation. |
| AAG evidence lookup | External local provider | Privileged provider port | AAG can disappear; local project/files remain usable and structural evidence becomes `unknown`. |
| Intent preflight | Domain application layer | React intent canvas | Pure deterministic rules should run locally; optional semantic inference is explicit and not idle. |
| Permission checkpoint | Policy/effect broker | Context Dock | Deterministic broker decides admission; Dock is the canonical human decision surface. |
| Preview/error correlation | Activity/evidence application layer | UI projections | Correlation uses IDs emitted before effects, not temporal guesswork in the UI. |
| Auction state/concurrency | Benchmark server/backend | SQLite storage | Winner selection and bid secrecy are server invariants, not client behavior. |
| Game Mode reward | Outcome projector | UI profile | Projector consumes verified evidence; it never listens directly to clicks, prompts, or approvals. |

## Standard Stack

### Core

| Library / runtime | Verified version | Purpose | Why this phase uses it |
|---|---:|---|---|
| React | 19.2.8 (registry modified 2026-08-20) | Shared renderer | One shell-neutral component tree and projection model. [VERIFIED: npm registry; official repo https://github.com/facebook/react] |
| TypeScript | 7.0.2 (2026-08-22) | Renderer and cross-boundary DTOs | Compile-time contract plus generated/validated runtime schemas. [VERIFIED: npm registry; official repo https://github.com/microsoft/TypeScript] |
| Vite | 8.2.2 (2026-08-20) | Renderer dev/build | Official `react-ts` template, HMR, and a shell-neutral browser build. Vite transpiles TypeScript but does not type-check, so `tsc --noEmit` remains a separate gate. [CITED: https://vite.dev/guide/] [CITED: https://vite.dev/guide/features.html] |
| Rust | 1.97.0 installed | Privileged core/daemon | The same typed core can be called in-process by Tauri or as a supervised sidecar by Electron. [VERIFIED: local toolchain] |
| Tauri | crate 2.11.5 / API 2.11.1 | Candidate host A | Commands, channels, runtime authority, scoped permissions, and sidecars are official v2 primitives. [CITED: https://v2.tauri.app/develop/calling-rust/] [CITED: https://v2.tauri.app/security/runtime-authority/] |
| Electron | 43.4.1 (2026-08-20) | Candidate host B | Sandboxed renderer, isolated preload bridge, and utility/child process primitives provide the comparison host. [CITED: https://www.electronjs.org/docs/latest/tutorial/process-model] [CITED: https://www.electronjs.org/docs/latest/tutorial/security] |
| Monaco Editor | 0.56.0 (2026-07-20) | Real code/Markdown editing proof | Browser editor model with worker support; create/dispose models by resource identity rather than tab lifetime. [VERIFIED: npm registry; official API https://microsoft.github.io/monaco-editor/typedoc/] |
| xterm.js | 6.0.0 (2026-08-10) | Terminal renderer | UI-only terminal emulator paired with host-owned PTY. Terminal output remains untrusted data. [CITED: https://xtermjs.org/docs/] [CITED: https://xtermjs.org/docs/guides/security/] |
| portable-pty | 0.9.0 | Rust PTY port | Preferred shared PTY implementation so the product path does not depend on Electron/Node. [VERIFIED: crates.io registry; source requires confirmation before lock] |
| SQLite via rusqlite | rusqlite 0.40.2 | Local project/activity and benchmark state | Embedded, transactional, zero-service storage suitable for a local phase slice. [VERIFIED: crates.io registry] [CITED: https://www.sqlite.org/whentouse.html] |

### Supporting

| Library | Verified version | Purpose | When to use |
|---|---:|---|---|
| Zod | 4.4.3 | Runtime validation at TypeScript-facing boundaries | Validate every host response/event and imported manifest before it becomes domain state. [VERIFIED: npm registry; official repo https://github.com/colinhacks/zod] |
| Vitest | 4.1.11 | Renderer/domain unit and contract tests | Pure projections, intent preflight, event reducer, and host contract fixtures. [CITED: https://vitest.dev/guide/] |
| Playwright | 1.62.1 | Browser-level journey checks | Exercise the shell-neutral web renderer and preview; Electron automation is explicitly experimental, so do not make it the sole desktop gate. [CITED: https://playwright.dev/docs/api/class-electron] |
| `notify` | 9.0.0-rc.4 | Rust filesystem observation candidate | Spike only; because the latest is a release candidate, pin a stable release after `cargo info` verification. [ASSUMED] |
| node-pty | 1.1.0 | Electron-only comparison PTY | Use only in candidate-specific spike if needed; product walking skeleton should prefer the Rust PTY port. It is not thread-safe and recommends host isolation. [CITED: https://github.com/microsoft/node-pty] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|---|---|---|
| Rust `portable-pty` shared core | Electron `node-pty` | Faster Electron proof and VS Code lineage, but creates two PTY implementations and native Node packaging work. Keep it only as a spike comparator. |
| SQLite | PostgreSQL | Better many-writer production behavior, but adds a service and violates the zero-configuration local Phase 1 proof. The benchmark tests correctness under two concurrent bids, not production-scale throughput. [CITED: https://www.sqlite.org/whentouse.html] |
| Monaco | CodeMirror | Smaller and composition-friendly, but the phase explicitly needs a credible IDE-grade code surface; Monaco is the locked candidate to prove first. [ASSUMED] |
| ACP edge adapter | ACP as internal domain schema | ACP standardizes agent/editor transport, not project truth, evidence, policy, or harness semantics. Keep it at the adapter boundary. [CITED: https://agentclientprotocol.com/get-started/architecture] |

**Installation (after the legitimacy checkpoint):**

```bash
npm install react monaco-editor @xterm/xterm zod
npm install -D typescript vite vitest @playwright/test
# Candidate hosts are isolated workspaces; never install both into the final app.
```

## Package Legitimacy Audit

The seam checked registry existence, download volume, repository URL, deprecation, and postinstall metadata on 2026-08-22. Exact age/download numbers below are from that check. [VERIFIED: local `package-legitimacy` seam]

| Package | Registry | Weekly downloads | Source repo | Verdict | Disposition |
|---|---|---:|---|---|---|
| react | npm | 169,729,845 | github.com/react/react | OK | Approved |
| typescript | npm | 269,176,101 | github.com/microsoft/TypeScript | OK | Approved |
| vite | npm | 169,269,117 | github.com/vitejs/vite | SUS (`too-new`) | Human verify exact release before install |
| monaco-editor | npm | 8,608,423 | github.com/microsoft/monaco-editor | OK | Approved |
| @xterm/xterm | npm | 3,820,017 | github.com/xtermjs/xterm.js | OK | Approved |
| node-pty | npm | 6,327,164 | github.com/microsoft/node-pty | OK; has native postinstall | Candidate-only; inspect/build in isolated spike |
| zod | npm | 264,797,429 | github.com/colinhacks/zod | OK | Approved |
| vitest | npm | 92,661,384 | github.com/vitest-dev/vitest | SUS (`too-new`) | Human verify exact release before install |
| @playwright/test | npm | 54,969,418 | github.com/microsoft/playwright | SUS (`too-new`) | Human verify exact release before install |
| electron | npm | 5,871,842 | github.com/electron/electron | SUS (`too-new`) | Candidate-only; human verify exact release |
| @tauri-apps/api | npm | 2,342,174 | github.com/tauri-apps/tauri | OK | Approved |

**Packages removed due to SLOP verdict:** none.

**Packages flagged as suspicious [SUS]:** `vite`, `vitest`, `@playwright/test`, `electron`; the flag is freshness-based, not an identity mismatch. The planner must insert one human verification checkpoint before the first dependency installation.

## Architecture Patterns

### System Architecture Diagram

```text
informal intent
  → deterministic intent preflight → user accepts/edits clarified intent
  → session command {projectId, resourceScope, intentRevision}
  → agent adapter port
       ├─ ACP subprocess (structured events/permissions when available)
       └─ CLI/PTTY subprocess (partial observability, explicit degradation)
  → proposed effect {effectId, paths, command, consequence}
  → policy/effect broker → Context Dock decision
       ├─ deny → denied event; no mutation; no reward
       └─ allow → checkpoint → privileged file/process operation
  → filesystem/process observation {effectId, artifactRevision}
  → preview supervisor → isolated preview health/error event
  → deterministic check + minimal semantic divergence
  → reconciliation choice {change code | change intent | scoped exception}
  → verified outcome event → optional Game Mode receipt

AAG process/MCP → optional structural evidence port → evidence or `unknown`
                         (never project authority; absence never blocks journey)
```

### Recommended Project Structure

```text
apps/
├── renderer/                 # shared React Instrument UI; no Node/Rust privileges
├── host-tauri-spike/        # throwaway candidate bridge/package probe
├── host-electron-spike/     # throwaway candidate bridge/package probe
└── benchmark/                # executable sealed-bid leaderboard fixture
crates/
├── ide-core/                 # project, activity, policy, evidence domain services
├── ide-daemon/               # typed IPC server for out-of-process host path
├── pty-runtime/              # spawn/stream/resize/cancel/cleanup
├── preview-supervisor/       # process and health lifecycle
└── benchmark-domain/         # atomic bid command + invariants
packages/
├── contracts/                # versioned DTO schemas and fixtures
├── projections/              # activity, evidence, permission, Game Mode reducers
└── adapter-contract/         # capabilities + normalized agent events
fixtures/
├── fake-agent/               # deterministic conformance agent
└── aag-provider/             # available/unavailable fixture responses
spikes/
└── shell-comparison/         # scripts, measurements, raw results; deleted after ADR
docs/decisions/
└── 0001-desktop-shell.md      # rubric, measurements, decision, caveats
```

### Pattern 1: Hexagonal host boundary

**What:** Renderer imports an `IdeHost` TypeScript port, never `@tauri-apps/*`, Electron, Node, or Rust-generated APIs directly. Each host adapter implements the same request/event contract; the Rust core owns path validation and effects.

**When to use:** Every filesystem, PTY, preview, adapter, checkpoint, and AAG operation.

```typescript
type HostRequest =
  | { kind: 'readFile'; projectId: string; resourceId: string; path: string }
  | { kind: 'approveEffect'; effectId: string; decision: 'allowOnce' | 'deny' }
  | { kind: 'cancelProcess'; processId: string };

type HostEvent =
  | { kind: 'activity'; activityId: string; causeId?: string; state: string }
  | { kind: 'fileObserved'; effectId?: string; resourceId: string; revision: string }
  | { kind: 'previewState'; previewId: string; state: 'starting' | 'healthy' | 'broken' | 'reconnecting'; causeId?: string };
```

Tauri officially supports serialized command request/response and Channels for streaming; Electron recommends narrow preload APIs rather than exposing raw IPC. [CITED: https://v2.tauri.app/develop/calling-rust/] [CITED: https://www.electronjs.org/docs/latest/tutorial/context-isolation]

### Pattern 2: Same-slice shell spike and weighted ADR

**What:** Build a shared conformance script that runs these identical operations in both candidates: launch; open one project; load Monaco and create/dispose two models; read/write/watch a file; spawn PTY, stream 10 MB bounded output, resize and cancel; start/stop/restart preview; render isolated preview; crash the child and prove cleanup; create distributable artifact.

**Decision rubric:**

| Dimension | Weight | Pass/measurement |
|---|---:|---|
| Privileged-boundary safety and auditability | 25 | Least-privilege API, sender/origin validation, preview isolation, no renderer filesystem/shell access. |
| PTY/agent/preview lifecycle correctness | 20 | Streaming, backpressure, cancellation, descendant cleanup, crash recovery. |
| Cross-platform packaging feasibility | 15 | Clean dev build and packaged artifact on Linux; documented Windows/macOS native prerequisites. |
| Shared Rust core fit | 15 | Minimal duplicate bridge logic; protocol contract remains identical. |
| Editor/worker/preview compatibility | 10 | Monaco workers, xterm, HMR, isolated preview all function. |
| Measured resource profile | 10 | Cold start, idle RSS, packaged size, IPC p50/p95 recorded on same machine/build mode. |
| Developer iteration complexity | 5 | Reproducible commands, build time, failure diagnosis, native module burden. |

Use release builds for resource comparisons, run at least 10 launches after one warm-up, record median and p95, keep hardware/OS/commit constant, and disclose that Tauri uses the OS webview while Electron bundles Chromium. [CITED: https://v2.tauri.app/concept/inter-process-communication/] [CITED: https://www.electronjs.org/docs/latest/tutorial/process-model]

**Decision rule:** Both candidates must pass all safety/lifecycle gates. Among passers, select the higher weighted score; a difference under 5/100 is inconclusive and should be decided by shared-core fit, not tiny performance noise. This threshold is a project recommendation, not an industry standard.

**Separation rule:** `spikes/shell-comparison` may contain direct framework calls and disposable probes. The walking skeleton may import only `packages/contracts` and the selected host adapter. After the ADR, delete both raw candidate apps, recreate the winner as `apps/desktop`, and retain only measurements/ADR and any framework-neutral conformance tests. This prevents benchmark shortcuts becoming architecture.

### Pattern 3: Causal activity ledger, editable artifacts

Every command/effect/observation carries stable IDs and `causeId`/`parentId`. Record intent revision, adapter session, permission, checkpoint, changed resource revision, preview run, check result, and reconciliation. Store specs/files normally and versionably; the ledger explains causation but is not the only writable state.

Correlation priority is explicit ID → process/run ID → resource revision/time window as low-confidence fallback. Never claim an error was caused by an edit solely because it occurred later.

### Pattern 4: One honest adapter contract

Evaluate one ACP agent path and one CLI/PTTY path against the same matrix: authentication owner; create/resume/cancel; input/output streaming; tool/effect events; permission requests; filesystem scope; native configuration; failure mode. ACP uses JSON-RPC, stdio subprocesses, concurrent sessions, streaming notifications, and bidirectional permission requests; it explicitly assumes a trusted agent, so it is not a sandbox. [CITED: https://agentclientprotocol.com/get-started/architecture]

For Phase 1, only one path needs to drive the golden journey. The second is a compatibility spike and must visibly declare missing resume/pre-effect control rather than simulate it. `cancel` means requested, then observed process exit; `resume` is supported only if the agent returns a durable session identifier and proves continuation.

### Pattern 5: Atomic sealed-bid command

```sql
BEGIN IMMEDIATE;
INSERT INTO bids (auction_id, bidder_id, amount_cents, submitted_at, nonce)
VALUES (?, ?, ?, ?, ?);
-- Compute winner inside the same transaction using amount DESC and an explicit
-- deterministic tie-breaker; return only bidder-visible receipt/status.
COMMIT;
```

`BEGIN IMMEDIATE` may itself return `SQLITE_BUSY`; configure a bounded busy timeout/retry and surface exhaustion honestly. SQLite permits only one writer at a time, which is sufficient for this two-bid correctness fixture but not evidence of marketplace-scale throughput. [CITED: https://www.sqlite.org/lang_transaction.html] [CITED: https://www.sqlite.org/whentouse.html]

The public API returns `accepted`, the caller's own bid/receipt, auction state, and winner only after closure; it never returns best amount, rank-by-amount during bidding, or a rejection threshold that acts as an oracle. The exact auction disclosure policy is a benchmark product decision and must be encoded in tests.

### Pattern 6: Verified-outcome projector

Game Mode subscribes only to `OutcomeVerified` events containing `criterionId`, evidence IDs, verifier kind/version, and artifact revisions. Permission, file-write, token, prompt, terminal, and elapsed-time events cannot increment progress. Revoking verification or detecting regression invalidates the receipt projection without removing the historical event.

### Anti-Patterns to Avoid

- **Two evolving desktop apps:** invalid comparison and guaranteed divergence; share renderer/contracts/core and time-box host-only differences.
- **Renderer imports privileged SDKs everywhere:** makes shell replacement and security review impossible; one adapter module is the only host import seam.
- **Preview inside privileged renderer:** benchmark code is untrusted; use a separately isolated web contents/webview with no host bridge and strict navigation/permission policy. Electron explicitly warns against remote/untrusted content with Node integration. [CITED: https://www.electronjs.org/docs/latest/tutorial/security]
- **Terminal as a text area over `spawn`:** interactive programs require a real PTY, resize, flow control, exit, and cleanup semantics. [CITED: https://github.com/microsoft/node-pty]
- **ACP as sandbox:** ACP's trusted-agent assumption means effect guarantees still require brokered tools or OS isolation. [CITED: https://agentclientprotocol.com/get-started/architecture]
- **AAG success assumed:** provider absence maps to `unknown`, never `passed`; no project load or mutation depends on AAG.
- **Filesystem timestamp correlation:** use causation IDs and content revisions; time-only links are suggestions with low confidence.
- **Award on approval:** authorization is not execution, observation, or verified value.
- **Auction read-then-write outside one transaction:** permits stale winner decisions and unreliable concurrency tests.
- **Winner amount in UI/log/evidence payload:** violates sealed-bid behavior even if hidden visually.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| Code editor engine | Custom textarea/tokenizer | Monaco | Models, workers, language services, selection and editing edge cases are phase distractions. |
| Terminal emulation | ANSI parser/UI | xterm.js | Escape sequences, Unicode, selection, accessibility, and rendering are specialized. [CITED: https://xtermjs.org/docs/] |
| PTY | Pipes pretending to be a terminal | portable-pty; node-pty only for Electron spike | Interactive shells require OS-specific pseudo-terminal semantics. |
| Renderer privilege bridge | Generic `send(channel, payload)` | Narrow typed commands + runtime validation | Electron official guidance warns against exposing raw IPC; Tauri scopes commands/capabilities. [CITED: https://www.electronjs.org/docs/latest/tutorial/context-isolation] [CITED: https://v2.tauri.app/security/runtime-authority/] |
| Concurrency control | JS mutex or "check then insert" | SQLite transaction/constraints | App locks do not cover separate connections/processes or crashes. |
| Agent security | Prompt instructions | Effect broker, path validation, process boundary | The model/agent cannot authorize its own effects. |
| Structural code graph | Phase-local graph crawler | Optional AAG provider port | Reuse existing external structural evidence while preserving degraded operation. |
| Desktop benchmark harness | Screenshots/manual impressions | Shared conformance scenario + recorded measurements | Shell choice must be reproducible and falsifiable. |

**Key insight:** This phase should hand-roll only the product-specific contracts: semantic project identity, activity/evidence causation, adapter capability truth, permission consequence, divergence choice, and verified-outcome projection.

## Common Pitfalls

### Pitfall 1: A benchmark that favors one shell
**What goes wrong:** Electron runs Node-native code in-process while Tauri pays sidecar/IPC cost, or Tauri gets a Rust implementation while Electron gets a JS substitute.
**How to avoid:** Same renderer assets, same Rust core behavior, same fixtures, same release mode, same machine, and candidate-specific code limited to bridge/lifecycle.
**Warning signs:** Different feature lists, different benchmark data, or direct framework imports outside host adapters.

### Pitfall 2: Native cleanup is treated as `kill(parent)`
**What goes wrong:** Preview servers, agents, or shell descendants survive window close/cancel.
**How to avoid:** Track process group/job ownership, close stdin, request graceful termination, escalate after timeout, reap exit, and test app crash/close. Electron's utility process `kill()` is graceful and reaps the process, but spawned descendants still require explicit ownership design. [CITED: https://www.electronjs.org/docs/latest/api/utility-process]
**Warning signs:** occupied preview ports or orphan processes after repeated tests.

### Pitfall 3: Webview/editor memory leaks
**What goes wrong:** Monaco models, workers, event listeners, terminals, and preview views accumulate across tabs/projects.
**How to avoid:** Resource-keyed registries with explicit disposal and lifecycle tests. Monaco workers expose `dispose`; PTY subscriptions also return disposables. [CITED: https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor_editor_api.editor.MonacoWebWorker.html] [CITED: https://github.com/microsoft/node-pty/blob/main/typings/node-pty.d.ts]
**Warning signs:** idle RSS grows after ten open/close cycles.

### Pitfall 4: UI claims more control than adapter provides
**What goes wrong:** CLI agent is labeled cancellable/resumable/permissioned because the IDE has buttons.
**How to avoid:** Snapshot negotiated/observed capabilities per session and show degradation before use.
**Warning signs:** cancel button changes UI state without observed child exit; resume starts a fresh context.

### Pitfall 5: Preview content crosses the privileged boundary
**What goes wrong:** Generated app reaches host APIs, terminal keystrokes, or unrestricted navigation.
**How to avoid:** isolated preview partition/origin, no preload/bridge, CSP, navigation/window-open denial, explicit external-open validation, and host-side permission handlers. Electron's security checklist requires sender validation, sandboxing, context isolation, restricted navigation, and no exposed APIs. [CITED: https://www.electronjs.org/docs/latest/tutorial/security]
**Warning signs:** preview can call `window.ideHost` or navigate the IDE frame.

### Pitfall 6: Flaky concurrency proof
**What goes wrong:** `Promise.all` hits one connection sequentially and is called a concurrency test.
**How to avoid:** two independent clients/connections synchronized by a barrier, repeated randomized order, invariant assertions on committed rows/winner, and bounded busy retry.
**Warning signs:** the test never produces lock contention or fails when connection order changes.

### Pitfall 7: Evidence launders uncertainty
**What goes wrong:** missing AAG, non-run check, semantic hypothesis, or temporal correlation appears green.
**How to avoid:** closed state enum `passed | failed | unknown | notRun | inconclusive`; only `passed` plus evidence can emit `OutcomeVerified`.
**Warning signs:** boolean `success` field shared across provider, check, and outcome events.

## Code Examples

### Narrow Electron bridge

```typescript
// Source pattern: https://www.electronjs.org/docs/latest/tutorial/context-isolation
contextBridge.exposeInMainWorld('ideHost', {
  request: (request: HostRequest) => ipcRenderer.invoke('ide:request', request),
  subscribe: (listener: (event: HostEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) =>
      listener(HostEventSchema.parse(value));
    ipcRenderer.on('ide:event', handler);
    return () => ipcRenderer.removeListener('ide:event', handler);
  },
});
```

The main process must validate both sender/frame origin and payload; never expose `ipcRenderer` itself. [CITED: https://www.electronjs.org/docs/latest/tutorial/security]

### Tauri streaming command

```rust
// Source pattern: https://v2.tauri.app/develop/calling-rust/
#[tauri::command]
async fn run_process(request: RunRequest, events: tauri::ipc::Channel<HostEvent>)
  -> Result<ProcessId, HostError>
{
    validate_scope(&request)?;
    process_supervisor::spawn(request, events).await
}
```

Async commands avoid blocking the main thread; Tauri documents Channels as the preferred streaming mechanism. [CITED: https://v2.tauri.app/develop/calling-rust/]

### Outcome gate

```typescript
function projectGameProgress(event: EvidenceEvent, state: GameState): GameState {
  if (event.kind !== 'OutcomeVerified' || event.status !== 'passed') return state;
  if (event.evidenceIds.length === 0) return state;
  return addReceiptOnce(state, event.criterionId, event.evidenceIds);
}
```

This is a project-specific pattern derived from the locked Game Mode contract.

## Validation Approach

Nyquist validation is explicitly disabled in `.planning/config.json`, so no formal `Validation Architecture` section is emitted. Phase 1 still needs proportional proof:

1. **Contract tests:** same request/event fixture suite against Tauri bridge, Electron bridge, and fake host.
2. **Rust unit/integration:** path/scope validation, checkpoint rollback, activity causation, auction invariants, bounded busy retry, process lifecycle.
3. **Renderer tests:** intent preflight, Essential↔Raw reachability, canonical permission projection, `unknown/notRun` rendering, Game Mode reducer.
4. **PTY integration:** spawn interactive shell, echo round-trip, resize, large-output backpressure, cancel, exit code, app-close cleanup.
5. **Preview integration:** healthy/start/broken/reconnect states; compile/runtime error correlated to run/effect/artifact; generated content cannot call host bridge.
6. **Agent conformance:** auth ownership, stream, cancel observation, resume proof or explicit unsupported, permission fidelity, degradation; fake agent supplies deterministic CI coverage.
7. **AAG degradation:** identical journey with provider fixture available, absent, slow, and malformed; only structural evidence changes to `unknown`.
8. **Auction race:** two barrier-synchronized connections bid concurrently for the same auction across at least 100 repetitions; assert one deterministic winner, both receipts, no amount leakage, and database invariants.
9. **Golden journey:** start only with natural-language intent, accept guided clarification, approve one scoped effect, observe files/preview/evidence, reconcile one divergence, receive one outcome receipt; repeat with Game Mode off and prove identical capability.
10. **Shell ADR gate:** both candidates run the identical conformance script; raw results and failure logs are attached to `0001-desktop-shell.md` before selecting the product host.

Phase acceptance must distinguish three artifacts:

- `spikes/shell-comparison`: disposable experimental code, not shipped.
- `apps/benchmark`: maintained product fixture used by tests/demos.
- selected `apps/desktop` + shared core/contracts: the walking skeleton that Phase 2 extends.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---|---|---|
| V2 Authentication | Limited | Agent/provider auth remains adapter-owned; never expose tokens to renderer or logs. |
| V3 Session Management | Yes | Stable local session IDs, adapter-native session reference, cancel/exit observation, no transcript as authority. |
| V4 Access Control | Yes | Resource-scoped effect broker; balanced decision at effect time; deny by default outside roots. |
| V5 Input Validation | Yes | Zod at JS bridge, Serde/domain validation in Rust, canonicalized path containment, allowlisted command/effect DTOs. |
| V6 Cryptography | Limited | No custom cryptography; use OS credential storage later if credentials are persisted. Phase 1 should prefer agent-owned auth. |
| V8 Data Protection | Yes | Bid secrecy; redact secrets/bid amounts from activity, logs, screenshots, and evidence payloads. |
| V10 Malicious Code | Yes | Generated project/preview/agent output is untrusted; isolate preview, sandbox renderer, broker effects. |
| V14 Configuration | Yes | Secure host defaults, CSP, no Node integration in UI/preview, explicit Tauri capabilities or narrow Electron preload. |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---|---|---|
| Renderer or preview invokes arbitrary filesystem/shell API | Elevation/Tampering | Narrow typed bridge, sender/origin validation, capability scopes, broker-side path checks. |
| Path traversal/symlink escape from project root | Tampering | Canonicalize target and ancestor, compare resource identity/root, reject out-of-scope and race-sensitive writes. |
| Terminal escape/link output attacks UI | Spoofing/Elevation | Treat terminal data as untrusted, use xterm renderer, validate external links, no `innerHTML`. [CITED: https://xtermjs.org/docs/guides/security/] |
| Agent subprocess leaks inherited secrets | Information disclosure | Minimal explicit environment allowlist and adapter-owned auth; do not inherit entire IDE environment. |
| Preview navigates to privileged content | Elevation | Separate origin/partition, no bridge, CSP, deny navigation/window creation, validate external open. |
| Permission confused deputy | Elevation | Decision binds exact effect ID, resource IDs, command/path summary, expiry, and adapter session; re-prompt on changed effect. |
| Bid oracle/log leakage | Information disclosure | Public DTO allowlist and redaction tests; no winning amount until policy permits. |
| Stale read chooses wrong winner | Tampering | Atomic transaction, deterministic tie-break, constraints, concurrent test with separate connections. |
| Forged verification gives progress | Spoofing | Only verifier-owned `OutcomeVerified` with criterion and evidence references reaches Game projector. |

Electron officially recommends sandboxed renderers, context isolation, CSP, sender validation, restricted navigation/window creation, and not exposing Electron APIs to untrusted content. Tauri runtime authority checks origin/capability/scope before commands, but application commands still must validate semantic resource scope. [CITED: https://www.electronjs.org/docs/latest/tutorial/security] [CITED: https://v2.tauri.app/security/runtime-authority/]

## State of the Art

| Old approach | Current approach | Impact for this phase |
|---|---|---|
| Renderer with direct Node integration | Sandboxed/context-isolated renderer with narrow privileged bridge | Electron has defaulted context isolation since 12 and renderer sandboxing since 20; do not copy old tutorials. [CITED: https://www.electronjs.org/docs/latest/tutorial/security] |
| Tauri v1 global allowlist | Tauri v2 capabilities, permissions, and scopes | Define per-window command authority and keep preview outside capabilities. [CITED: https://v2.tauri.app/security/runtime-authority/] |
| Agent-specific chat integration | ACP JSON-RPC edge adapter plus explicit capabilities | Useful structured path, but remote support remains work in progress and ACP remains a trusted-agent protocol. [CITED: https://agentclientprotocol.com/get-started/introduction] [CITED: https://agentclientprotocol.com/get-started/architecture] |
| Boolean check result | `passed/failed/unknown/notRun/inconclusive` evidence state | Prevents degraded providers and unexecuted checks from laundering uncertainty. This is a project contract. |

**Deprecated/outdated:** Electron examples with `nodeIntegration: true`, disabled `contextIsolation`, generic raw IPC bridges, or un-sandboxed remote preview content contradict current official security guidance. [CITED: https://www.electronjs.org/docs/latest/tutorial/security]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|---|---|---|
| A1 | `portable-pty` 0.9.0 is suitable as the cross-platform shared PTY implementation. | Standard Stack | May require switching the Rust PTY port after a focused API/platform spike; contract remains stable. |
| A2 | `notify` is the best Rust watcher after choosing a stable release. | Standard Stack | May replace implementation with polling/another crate without changing observation contract. |
| A3 | Monaco is preferable to CodeMirror for the product's technical depth. | Alternatives | Phase spike may show webview/worker/bundle issues; editor bridge isolates replacement. |

## Spike-Gated Resolution Records

These empirical decisions remain deliberately unresolved in research. Each has a blocking execution gate, an evidence artifact, and an exact consuming plan; no downstream plan may present a winner or guarantee before that artifact exists.

| Record | Unresolved decision | Spike and pass gate | Resolution artifact | Consumed by |
|---|---|---|---|---|
| R-01 | Which desktop shell wins | Plans 01-04 through 01-06 freeze the identical shared-Rust fixture/rubric, execute both candidates, then select only an eligible winner after privilege, preview isolation, PTY lifecycle, cleanup, packaging, and reproducibility gates pass | `docs/decisions/0001-desktop-shell.md` plus `spikes/shell-comparison/results.json` | Plans 01-07 through 01-15 use only the recorded winner |
| R-02 | Which real external agent drives the journey | Plan 01-10 probes one ACP and one CLI/PTTY adapter; eligibility requires observed create, stream, cancel-to-exit, and one scoped edit, while resume/control remain explicitly supported, unsupported, or degraded | `tests/contracts/agent-conformance.test.ts` fixture and `01-10-SUMMARY.md` capability matrix | Plans 01-11 through 01-15 journey continuation |
| R-03 | What descendant cleanup can the PTY runtime claim | Plan 01-09 runs the Linux process-group lifecycle test and records unexecuted Windows/macOS claims as unknown; cross-platform claims require later platform-specific evidence | `crates/pty-runtime/tests/pty_lifecycle.rs` results and `01-09-SUMMARY.md` platform table | Plan 01-13 preview/process supervision and phase acceptance language |
| R-04 | How semantic the first divergence should be | Plan 01-14 is gated to one editable sealed-bid privacy rule, one deterministic behavior probe, and one human-readable finding; the spike passes only if evidence can distinguish implementation change, intent change, and scoped exception without generic inference | `crates/ide-core/tests/evidence_reconciliation.rs` and the reconciliation journey receipt | Plan 01-14 and final journey Plan 01-15 |

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---:|---|---|
| Node.js | Renderer toolchain | ✓ | 22.22.2 | — |
| npm | JS dependencies | ✓ | 10.9.7 | — |
| Rust/Cargo | privileged core | ✓ | rustc 1.97.0 / cargo 1.97.0 | — |
| Git | checkpoints/diff fixture | ✓ | 2.43.0 | File snapshot checkpoint for spike only |
| CMake / Make / GCC / pkg-config | native builds | ✓ | 3.28.3 / 4.3 / 13.3.0 / 1.8.1 | — |
| SQLite CLI | manual inspection | ✗ | — | Use bundled rusqlite and test queries; CLI is not runtime-required |
| Tauri CLI | candidate host | ✗ | — | Install verified project-local CLI after legitimacy checkpoint |
| Electron CLI | candidate host | ✗ | — | Install verified project-local dependency after legitimacy checkpoint |

**Missing dependencies with no fallback:** none before dependency installation.

**Missing dependencies with fallback:** SQLite CLI is optional; the Rust library owns database access. Tauri and Electron CLIs are expected project dependencies, not global prerequisites.

## Project Constraints (from AGENTS.md)

No repository-local `AGENTS.md`, `.codex/skills`, or `.agents/skills` was found. The workspace instruction `/home/mario/.codex/RTK.md` requires every shell command to be prefixed with `rtk`; plans and execution commands must preserve this.

## Sources

### Primary (HIGH confidence)

- https://v2.tauri.app/develop/calling-rust/ — commands, async work, error serialization, Channels.
- https://v2.tauri.app/concept/inter-process-communication/ — Tauri message-passing boundary.
- https://v2.tauri.app/security/runtime-authority/ — origin, capability, permission, and scope checks.
- https://v2.tauri.app/develop/sidecar/ — sidecar lifecycle and explicit spawn permissions.
- https://www.electronjs.org/docs/latest/tutorial/process-model — main/renderer/preload/utility process responsibilities.
- https://www.electronjs.org/docs/latest/tutorial/context-isolation — narrow preload API pattern.
- https://www.electronjs.org/docs/latest/tutorial/security — current security checklist.
- https://www.electronjs.org/docs/latest/api/utility-process — supervised Node utility process lifecycle.
- https://microsoft.github.io/monaco-editor/typedoc/ — Monaco API and disposables.
- https://xtermjs.org/docs/guides/security/ — terminal integration threat model.
- https://github.com/microsoft/node-pty — PTY API, flow control, security, and thread-safety notes.
- https://agentclientprotocol.com/get-started/architecture — ACP transport, sessions, permissions, trust assumption.
- https://agentclientprotocol.com/get-started/introduction — ACP local/remote scope and remote maturity statement.
- https://www.sqlite.org/isolation.html — serializable writes and WAL isolation.
- https://www.sqlite.org/lang_transaction.html — `BEGIN IMMEDIATE`, busy behavior, transaction semantics.
- https://www.sqlite.org/whentouse.html — embedded fit and many-writer boundary.
- https://vite.dev/guide/ and https://vite.dev/guide/features.html — React/TS templates, HMR, transpile-only behavior.
- https://vitest.dev/guide/ — test runner setup and requirements.
- https://playwright.dev/docs/api/class-electron — Electron support is experimental and native-dialog limitation.

### Secondary (MEDIUM confidence)

- npm and crates registry metadata captured locally on 2026-08-22 for exact package versions and legitimacy signals.

### Tertiary (LOW confidence)

- `portable-pty` and `notify` suitability beyond registry existence; both require focused API/platform verification during the PTY/watcher spike.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH for React/Vite/TypeScript/Monaco/xterm/Tauri/Electron identities and current versions; MEDIUM for the final host and PTY/watcher implementation.
- Architecture: HIGH for isolation, typed boundary, transactional bid, and causal evidence patterns; they follow locked constraints and official platform boundaries.
- Pitfalls: HIGH where supported by official security/runtime docs; MEDIUM for cross-platform descendant cleanup until executed on each OS.

**Research date:** 2026-08-22
**Valid until:** 2026-09-05 for fast-moving desktop/agent packages; SQLite/security architecture remains valid longer but should be rechecked at implementation.

## RESEARCH COMPLETE
