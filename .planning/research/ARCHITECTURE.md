# Architecture Research

**Domain:** AI-native IDE for intention-driven software creation and ongoing operation
**Researched:** 2026-08-22
**Confidence:** MEDIUM

## Recommended Architecture

### System Overview

The product should begin as a **local-first modular monolith with isolated worker processes**, not as microservices and not as a chat client. The desktop host owns canonical project state, resource access, policy, observations, and reconciliation. Editors and conversational surfaces are projections over that state. Agents are replaceable execution providers behind capability adapters.

```text
┌────────────────────── Progressive Experience Layer ──────────────────────┐
│ Intent composer │ Spec/graph │ Files/editor │ Preview │ Terminal │ Ops │
└───────────────────────────────────────────────┬────────────────────────────────────────────────────┘
                                               │ commands / projections / events
┌──────────────────────────── Desktop Application Host ────────────────────────────┐
│ Project service │ Session service │ Policy broker │ Effect broker │ Event log │
│ Artifact service │ Context assembler │ Capability registry │ Secret broker      │
└───────────────────────────────────────┬─────────────────────────────────────────────────────────┘
                                       │ normalized observations and proposed effects
┌───────────────────────── Semantic Control Plane ──────────────────────────┐
│ Intent graph │ Evidence index │ Reconciler │ Harness pipeline │ Guide engine │
│                    Incremental analysis / evaluator workers                     │
└─────────────────────────────────────┬───────────────────────────────────────────────────────────┘
                                     │
┌────────────────────── Agent Integration Plane ──────────────────────┐
│ ACP adapter │ Structured CLI adapter │ PTY adapter │ Model/API runner │ Local │
│                 capability discovery + lifecycle + event normalization         │
└───────────────────────────────────────────────┬────────────────────────────────────────────────────┘
                                              │ capability-mediated effects
┌───────────────────────── Resource & Runtime Plane ─────────────────────────┐
│ Git/files │ terminals/tasks │ preview/browser │ DB/cloud │ LSP/indexers │
│ local process isolation now; remote execution environment may be added later     │
└───────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Owns | Must not own |
|---|---|---|
| Project service | Semantic projects, resource links, roles of resources in projects, project-local configuration | Filesystem contents or chat transcripts |
| Resource registry | Stable identity, locator, type, trust, revision observation and sharing of repos/directories/services across projects | Project meaning; a resource can have many project memberships |
| Artifact service | Editable specs, decisions, requirements, documents and their revisions | Immutable session history or generated code ownership |
| Session service | Temporal work episodes, participants, scope, mode, status, checkpoints and handoffs | Project files; a session references resources but never contains them |
| Capability registry | What each agent/runtime can actually do and how reliably it can be observed or controlled | Pretending all providers share one tool/model abstraction |
| Agent adapters | Lifecycle and protocol translation for ACP, CLI, PTY, API and local agents | Product policy or canonical project state |
| Context assembler | A scoped, provenance-bearing context package for a turn/task | Permanent truth; it emits a snapshot derived from current sources |
| Effect broker | Normalized proposals and execution of filesystem, shell, network, secret, deployment and external-service effects | Model reasoning or UI-specific approval dialogs |
| Policy broker | Evaluates effects against project/resource/session policy and records decisions | Executing effects itself |
| Activity ledger | Append-only normalized facts about prompts, agent messages, tool/effect lifecycle, artifact changes and decisions | Serving as the only editable product store |
| Intent graph | Typed nodes and edges for goals, requirements, decisions, constraints, implementation anchors, tests and evidence | Raw full-code graph or entire chat history |
| Evidence index | Derived links/fingerprints into code, tests, runtime observations and documents with confidence/provenance | Declaring semantic truth without review |
| Reconciler | Detects missing, stale, contradictory or unsupported links and proposes reconciliation | Silently rewriting specs or code |
| Harness pipeline | Pre/post checks and evaluators around context, plans, effects and outcomes | Becoming a second opaque autonomous agent |
| Editor/runtime bridge | File buffers, LSP, Git, task/terminal and preview coordination | Semantic project identity |

## Core Domain Model

Use stable IDs and explicit many-to-many relations. Do not encode identity in directory paths.

```text
Portfolio --contains--> Project
Project --uses(role, scope, policy)--> Resource
Resource --can be used by--> many Projects

Project --has--> IntentNode
IntentNode --refines|depends_on|conflicts_with--> IntentNode
IntentNode --specified_by--> ArtifactRevision
IntentNode --implemented_by--> EvidenceAnchor
IntentNode --verified_by--> EvidenceAnchor

Session --works_in--> Project or PortfolioView
Session --scopes--> Resource[] / IntentNode[]
Session --uses--> AgentBinding[]
Session --records--> ActivityEvent[]
```

Minimum node types should be small: `goal`, `requirement`, `decision`, `constraint`, `risk`, `task`, and `evidence`. Add domain-specific node types only after observed need. Every inferred node or edge carries `provenance`, `confidence`, `observed_at`, and review status. Human-authored Markdown remains editable and trustworthy; the graph indexes it rather than replacing it.

### Dual State, Not Three Competing Sources of Truth

The source-of-truth rule should be explicit:

- **Product intent/spec truth:** editable artifacts plus reviewed structured nodes.
- **Executable truth:** actual files, configuration, deployments and observed runtime behavior.
- **History/evidence:** immutable activity events and derived anchors explain how each side changed; they are not a third definition of desired behavior.

Reconciliation is therefore a comparison between two authoritative domains, using evidence, never a regeneration of code from a master spec. A divergence may be legitimate. The system classifies and asks: update intent, update implementation, accept an exception, or defer.

## Session and Event Model

A session is an addressable temporal scope, not a conversation container. It has:

- `session_id`, project/portfolio context and explicit resource scope;
- selected interaction mode (`full-vibes`, `spec`, `hybrid`) and mode transitions;
- one or more agent bindings with capability snapshots;
- parent/fork/handoff relationships;
- ordered normalized activities and checkpoints;
- outputs linked to real artifact revisions and repository commits/diffs.

Store current project configuration and editable artifacts with ordinary versioned CRUD. Apply event sourcing selectively to the **activity ledger** because replay, audit and handoff justify it. Project read models, session timelines, cost views and harness traces are projections. Do not event-source preferences, every editor keystroke or the entire product database: official guidance warns that full event sourcing adds schema, projection and consistency costs that rarely pay back in simple CRUD domains.

Every event envelope should include schema version, actor, session, project, resource, causation/correlation IDs, timestamp/sequence, provenance, visibility/redaction class, and payload reference. Large/sensitive payloads belong in content-addressed storage or secret-safe stores; events reference them so deletion and redaction remain possible.

## Agent Capability and Adapter Boundary

Define an internal **capability contract**, not a universal agent protocol. An adapter reports facts such as:

```text
transport: ACP | structured-cli | PTY | API | embedded
session: create | resume | fork | import | cancel
input: text | image | audio | structured-context
output: streaming | structured-plan | tool-events | usage
effects: file-read | file-write | shell | network | MCP | browser | deploy
control: pre-effect approval | cancellation | checkpoint | native-mode
observability: full | partial | terminal-only | opaque
auth/billing: agent-owned | IDE-owned | gateway-owned
```

ACP is the preferred structured path: its official architecture provides JSON-RPC streaming, concurrent sessions, bidirectional permission requests, terminal/filesystem capabilities and MCP forwarding. It explicitly assumes a trusted agent, so ACP is not the security boundary. Zed's implementation confirms that external agents can and should retain their runtime, authentication, model and native configuration.

Adapters normalize only what is observable. A PTY agent that edits files through its own shell cannot honestly promise pre-effect interception. Mark it `partial` and recover observation through filesystem/Git watchers and process isolation. To guarantee enforcement, the agent must operate through brokered tools or inside an execution sandbox whose filesystem/network boundary the IDE controls.

## Harness as a First-Class Pipeline

The default harness architecture should be provider-neutral and layered:

```text
User intent
  → (H0) scope + provenance: project, resources, mode, budget
  → (H1) semantic preflight: ambiguity, missing decisions, relevant guides
  → context assembler → agent adapter
  → (H2) plan/proposal inspection: contradiction, scope, risk
  → (H3) effect admission: policy + approval + secret/resource boundary
  → effect broker/runtime
  → (H4) observation: diff, command result, preview, tests, runtime evidence
  → (H5) outcome evaluation: requested behavior, regressions, unresolved risk
  → (H6) reconciliation: intent↔implementation links and divergence queue
  → user-visible result + durable session events
```

The harness produces findings and control decisions, each with severity, confidence, evidence and remediation. It must support `inform`, `suggest`, `warn`, `require-confirmation`, and `block-by-policy`; the model does not choose enforcement. Full Vibes, Spec and Hybrid change interruption thresholds and ordering, not whether evidence is collected.

### Interception Guarantees

| Point | Always possible? | Enforcement |
|---|---:|---|
| Before context is sent | Yes | IDE owns context assembly and redaction |
| Before IDE-brokered tool/effect | Yes | Policy/effect broker |
| Before agent-native effect | No | Only when protocol exposes approval or runtime is sandboxed |
| During filesystem change | Usually observable | Watcher/journal; prevention needs controlled mount/sandbox |
| After diff/command/test | Yes when resource is visible | Normalize observations and evaluate |
| Before accepting project state | Yes | Gate checkpoint/merge/deploy, not every keystroke |

This distinction prevents a dangerous false promise: “connected” is not equivalent to “controlled.”

## Trust Boundaries

```text
untrusted project content / fetched docs
             │
             ▼
context assembler (provenance + instruction/data separation)
             │
             ▼
agent process / model provider  ← secrets only via scoped broker
             │ proposed effects
             ▼
policy + effect broker → local/remote execution sandbox
             │ observations
             ▼
artifact + intent reconciliation (inference is untrusted until reviewed/evidenced)
```

Required boundaries:

1. **UI ↔ privileged host:** renderer cannot directly access filesystem, shell, secrets or provider credentials.
2. **Host ↔ agent process/provider:** per-session lifecycle, scoped environment and explicit data disclosure.
3. **Agent ↔ effects:** all guaranteed controls occur at the effect broker or sandbox boundary.
4. **Project ↔ resource:** trust and permissions attach to resource membership, with project defaults and resource overrides; avoid a universal workspace boolean.
5. **Local ↔ remote runtime:** resource identities remain stable while locators and execution authority differ.
6. **Extension/harness package ↔ core:** signed manifest, declared capabilities, isolated execution and versioned APIs.
7. **Inference ↔ truth:** model-generated specs, links, warnings and “passed” claims require provenance/evidence and remain revisable.

## Key Data Flows

### 1. Attach a Shared Repository

```text
User selects repository → Resource registry resolves stable identity
  → trust/policy assigned → ProjectResource edge created
  → indexers observe revision → evidence index updated
  → project projection refreshes without duplicating the repository
```

### 2. Intent-Driven Build Turn

```text
Draft intention → autocomplete/preflight suggests missing decisions
  → user accepts/edits → artifact + intent graph revision
  → scoped context package → chosen agent adapter
  → streamed proposals/effects → admission policy → runtime
  → file/Git/test/preview observations → evidence + reconciliation
  → checkpoint summarizes delivered, diverged, assumed and still unknown
```

### 3. Direct Human or External Edit

```text
Filesystem/document watcher → changed anchors invalidated
  → incremental analyzer recomputes affected evidence
  → reconciler emits candidate divergence
  → user/agent chooses: update spec | update code | exception | defer
```

### 4. Agent Handoff

```text
Session checkpoint → portable context snapshot + artifact references
  → target adapter capability check → explicit degradation shown
  → new binding/session continuation → causation links preserved
```

Do not pass raw transcripts by default. Pass current decisions, unresolved questions, scoped resources, relevant activity summary and evidence references; retain the transcript for inspection.

## Recommended Project Structure

Keep domain boundaries visible even if the initial language/framework changes:

```text
apps/
├── desktop/                 # trusted host + renderer composition
└── worker/                  # isolated analysis/index/evaluator process
packages/
├── domain/                  # Project, Resource, Session, Artifact, Intent
├── project-store/           # CRUD state, revisions, resource memberships
├── activity-ledger/         # immutable event envelopes and projections
├── intent-graph/             # schema, links, evidence and reconciliation
├── harness-core/             # stages, findings, policies, evaluators
├── effect-broker/            # filesystem/shell/network/deploy operations
├── agent-contract/           # capability descriptors + normalized events
├── adapters/
│   ├── acp/
│   ├── cli/
│   ├── pty/
│   └── model-api/
├── editor-bridge/            # buffers, LSP, Git, tasks, preview
├── extension-sdk/            # later: harness/guide/integration packages
└── ui/                       # progressive surfaces and projections
fixtures/
├── sample-products/          # store, internal tool, micro-SaaS, chatbot
└── fake-agents/              # deterministic adapter/harness conformance
```

Avoid creating deployable services for these packages initially. Process isolation is justified for agents and analyzers; network isolation is not yet justified for internal modules.

## Architectural Patterns

### Ports and Adapters Around Agents and Effects

Agents, model APIs, terminals and filesystems are volatile integrations. Stable domain commands and normalized observations protect the core from ACP/CLI/provider churn. The cost is resisting the temptation to expose every provider-native feature through one leaky interface; preserve an escape hatch for native commands and renderable events.

### Capability Negotiation, Inspired by LSP/ACP

LSP validates standardizing the IDE-to-specialist process boundary, while ACP applies the pattern to agents. Negotiate capabilities at connection/session start and snapshot them into session history. Never infer a guarantee from adapter name alone.

### Selective Event Sourcing + Materialized Projections

Use intent-rich immutable events for activities that need audit, replay, handoff and cost tracing. Use projections for timelines and UI. Use editable/versioned records for specs and project configuration. This obtains historical explainability without making the whole application append-only—a direct product failure the user wants to avoid.

### Content-Addressed Evidence Anchors

Evidence links should combine resource ID, revision ID, semantic locator (symbol/test/route), optional range and content fingerprint. Paths and line numbers alone rot under refactors. Re-indexing resolves an anchor or marks it stale; it never silently retargets with high confidence.

### Incremental Reconciliation

Changes invalidate only related nodes/anchors and enqueue bounded analyzers. A full-project LLM review on every edit is too slow, costly and noisy. Run deeper semantic evaluations at explicit checkpoints, before deploy and on user request.

## Anti-Patterns

### Conversation as Database

**Failure:** Files, decisions and generated artifacts belong to a chat/thread.
**Consequence:** Cross-session work fragments and users cannot directly edit durable state.
**Instead:** Sessions reference projects/resources; all outputs link to normal artifacts and repository revisions.

### Spec as Generator-Owned Append-Only Log

**Failure:** Agents append documents the human cannot safely edit.
**Consequence:** Documentation becomes ceremonially “authoritative” while diverging from reality.
**Instead:** Human-editable artifacts plus revision history and explicit reconciliation.

### One Universal Agent Interface

**Failure:** ACP, terminal agents and raw models are presented as equally controllable.
**Consequence:** Native capability is lost and security guarantees become fictional.
**Instead:** Small capability vocabulary, adapter-specific extensions and visible degradation.

### Model as Security Boundary

**Failure:** Prompt instructions are expected to stop unsafe effects.
**Consequence:** Prompt injection or agent error bypasses policy.
**Instead:** Deterministic admission at effect broker/sandbox; semantic evaluators advise policy but do not replace it.

### Full Code Graph as the Intent Graph

**Failure:** Every AST symbol becomes a domain node.
**Consequence:** Graph scale/noise obscures human decisions and creates constant churn.
**Instead:** Separate code intelligence index; link selected evidence anchors into a sparse product-intent graph.

### Harness as a Monolithic Judge

**Failure:** One LLM pass declares the project safe/correct.
**Consequence:** False certainty, high cost and irreproducible results.
**Instead:** Composable evaluators with evidence, confidence, caching and deterministic checks where possible.

## Build Order Implications

1. **Architecture spikes before product commitment**
   - Prove an embedded editor/terminal/preview shell can safely communicate with a privileged host.
   - Connect one ACP agent and one less-structured CLI agent; measure event fidelity, cancellation, auth retention and effect visibility.
   - Prototype the smallest project/resource/session schema with one repository shared by two projects.

2. **Durable project substrate**
   - Project/resource graph, editable artifact store, session identity, activity ledger and filesystem/Git observations.
   - This must precede the chat/composer polish because every surface relies on stable identity and state.

3. **One end-to-end controlled build loop**
   - Context assembly, capability registry, effect broker, adapter, diff/review and checkpoint.
   - Use deterministic fake agents for conformance tests before adding providers.

4. **Intent graph and reconciliation thin slice**
   - A few node types; manually accepted links; detect direct-code and direct-Markdown divergence.
   - Validate usefulness before automating graph extraction.

5. **Default harness v0**
   - Scope/provenance, effect admission, change observation, deterministic checks and one evidence-backed semantic evaluator.
   - Product-domain harness packs and guides come after the pipeline is measurable.

6. **Progressive UX and three modes**
   - Compose the same commands/projections differently; do not implement three backends.

7. **Additional adapters, runtime/production integration, SDK and marketplace**
   - Expand only after adapter and harness contracts survive two meaningfully different agents.

## Decisions to Delay Behind Spikes

| Decision | Spike / evidence required | Why delay |
|---|---|---|
| Desktop shell and editor core | Compare native/webview/editor embedding, terminal/PTY and extension compatibility with a working vertical slice | Dominates packaging, security and long-term extension strategy |
| Exact intent graph storage | Implement sparse graph + revision/evidence queries in a simple local store first | Graph database may be unnecessary; query shapes are unknown |
| ACP as internal canonical schema | Test ACP plus a CLI agent and provider-native features | ACP is valuable at the edge but may not express project/harness semantics |
| ACPX dependency | Prototype only | Useful bridge but not a stable foundation until lifecycle/API stability is demonstrated |
| Full event sourcing | Do not adopt globally; benchmark selective ledger | Rewrite risk and unnecessary complexity are high |
| Sandbox technology | Threat-model local, container, OS sandbox and remote executor against target platforms | Enforcement guarantees vary dramatically by OS and adapter path |
| Automated intent↔code link generation | Evaluate precision/recall on sample projects with human review | No established representation guarantees acceptable signal/noise |
| Code intelligence representation | Compare LSP/index output, tree-sitter and code property graph only for required queries | Full CPG can be expensive and premature |
| Multi-agent concurrency/branching | First prove single-agent checkpoints and resource conflict detection | Concurrency magnifies state and merge semantics |
| Cloud sync/collaboration | Validate local durable model and privacy boundary | Not necessary for initial individual distribution thesis |
| Plugin/marketplace isolation API | Build one internal harness pack and one external prototype | Capability/security boundary must follow real extension needs |
| Monetization rail | Separate feasibility/business research | Must not contaminate neutral core architecture prematurely |

## Scaling Considerations

| Scale | Architecture adjustment |
|---|---|
| Initial local users | SQLite/embedded store, local content blobs, worker processes, incremental watchers; no backend required for core use |
| Large projects/many repos | Persistent index, bounded queues, content hashing, per-resource revisions, analyzer budgets and checkpoint scheduling |
| Cross-device/hosted services | Sync immutable activities and artifact revisions; keep local credentials and resource locators separate from portable identities |
| Marketplace/large distribution | Signed packages, sandboxed extension workers, registry service, transparent ranking and telemetry consent |

The first bottleneck is likely semantic analysis cost/noise, not database throughput. The second is resource indexing and invalidation across large multi-repository projects. Optimize with incremental work, evidence caching and explicit deep-analysis checkpoints before considering distributed internal services.

## Sources

- [Agent Client Protocol: Architecture](https://agentclientprotocol.com/get-started/architecture) — official; JSON-RPC process model, concurrent sessions, permissions and MCP forwarding. **MEDIUM confidence** via verified web provider.
- [ACP protocol schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json) — official schema; client filesystem/terminal capabilities and permission requests. **MEDIUM confidence**.
- [Zed External Agents](https://zed.dev/docs/ai/external-agents) — official implementation evidence for ownership/configuration boundaries and ACP sessions. **MEDIUM confidence**.
- [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) — official protocol architecture and JSON-RPC boundary. **MEDIUM confidence**.
- [VS Code Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust) — official trust and multi-root behavior. **MEDIUM confidence**.
- [VS Code Agent Harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses) — official distinctions among session targets, execution locations, tools and code isolation. **MEDIUM confidence**.
- [Microsoft Agent Framework: Agent Harness](https://learn.microsoft.com/en-us/agent-framework/concepts/harness) — official harness decomposition into model/tool loop, context, persistence, approvals, observability and UX. **MEDIUM confidence**.
- [Azure Architecture Center: Event Sourcing](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing) — official benefits and costs supporting selective, intent-rich activity events rather than global event sourcing. **MEDIUM confidence**.
- [ReqToCode](https://arxiv.org/abs/2603.13999) — current research demonstrating bidirectional structural requirements-to-code/test links; useful direction, not yet sufficient to choose this project's graph algorithm. **LOW confidence as sole evidence; treat as spike input**.

---
*Architecture research for: AI-Native IDE*
*Researched: 2026-08-22*
