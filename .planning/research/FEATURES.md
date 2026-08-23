# Feature Research

**Domain:** AI-native IDE for intent-led, long-lived software creation
**Researched:** 2026-08-22
**Confidence:** MEDIUM-HIGH — competitor capabilities and protocols are grounded in current primary documentation; prioritization is an opinionated product inference that still requires user testing.

## Product Frame

The competitive baseline is no longer “chat that writes code.” Current tools already plan, edit files, run terminals, browse/test applications, retain instructions, invoke MCP tools, revert agent changes, deploy, and run agents asynchronously. Shipping only those capabilities would produce a late generic agent IDE.

The product should instead treat **intent, specifications, implementation, runtime evidence, and human understanding as coequal editable surfaces**. Its primary interaction is guided intent, not chat; its project model is semantic and may span reusable repositories/resources; its abstraction is progressively reversible down to code and infrastructure. The free IDE is a distribution surface, so bring-your-own models, agents, subscriptions, repositories, and infrastructure must remain useful without a paid ShinAI dependency.

## Feature Landscape

### Table Stakes (Users Expect These)

Missing these makes the environment feel weaker than an existing IDE, coding agent, or app builder.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Real editable filesystem and Markdown/code editors | VS Code-class tools expose files directly; Bolt and Lovable now advertise direct code access | HIGH | Must support manual and external edits, search, tabs, diagnostics, navigation, formatting, and file watching. Abstraction may hide panels by default but never withhold artifacts. |
| Integrated terminal, tasks, logs, and process lifecycle | Cursor, Zed, Kiro, Antigravity and traditional IDEs let agents and humans run code | HIGH | Display commands and outputs structurally while retaining a real terminal escape hatch. Processes must be associated with project/resource/environment, not only a chat. |
| Git/source control with human-readable review | Checkpoints alone are explicitly not version control; users need diffs, branches, commits, conflicts, rollback, and external Git interoperability | HIGH | Explain diffs in product language for nontechnical users, while exposing exact hunks for technical users. Never make proprietary history the sole recovery path. |
| Build-run-preview loop | Replit, Bolt, Lovable and Antigravity normalize immediate runnable previews and visual verification | HIGH | Include preview URLs, browser console/network/runtime evidence, screenshots and responsive inspection. Generic local command support precedes one-click cloud hosting. |
| Agent task loop with visible plan, progress, tool calls, edits, tests, and result | Current agent IDEs show work rather than return only prose | HIGH | ACP can carry sessions, streamed updates, tool calls, diffs, terminal content and permission requests. UI must summarize without hiding raw evidence. |
| Multiple work modes | Kiro exposes chat/quick/full specs; Copilot and Replit expose plan/autonomous choices | MEDIUM | Product-specific modes: Full Vibes, Spec Mode, Hybrid. Modes change deliberation and checkpoints, not access to underlying artifacts. Switching must preserve one project state. |
| Recovery and safe experimentation | Cursor, Kiro and Replit provide checkpoints/rewind | HIGH | Snapshot files, agent/session state and relevant runtime/schema state. Database rollback is separately difficult; file rollback must never imply data rollback. Git remains durable history. |
| Persistent project instructions and knowledge | Cursor Rules, Kiro Steering, Lovable Knowledge, AGENTS.md/CLAUDE.md conventions are standard | MEDIUM | Editable, scoped, versionable, inspectable, with provenance and conflict visibility. Do not silently convert conversations into hidden rules. |
| Context attachment and multimodal input | Users expect files, folders, screenshots, URLs and selected code to ground tasks | MEDIUM | Explicitly show what resources an agent can see. Voice should enter through the same intent pipeline, not become a separate product architecture. |
| Model/provider choice plus BYOK/local path | Zed supports hosted, API, gateway, subscription and local paths; model optionality is increasingly expected | HIGH | Separate raw-model integrations from complete agent integrations. Surface provider, cost/usage, data path, context limits, and capability degradation. |
| External agents and CLIs | Technical users already have Claude, Codex, Gemini, Cursor, Pi or other subscriptions/configurations | HIGH | Prefer ACP where available; retain terminal-thread and adapter fallbacks. Preserve agent-owned auth/config/capabilities rather than flattening all into chat completions. |
| MCP tools/connectors | MCP is supported across current IDEs/builders | MEDIUM | Host controls consent, authorization and server boundaries. Tools are project resources with declared capabilities and provenance. MCP connects tools/context; ACP connects agent runtimes. |
| Configurable permissions and explicit autonomy | Users expect allow/confirm/deny and an autonomous mode | HIGH | Scope by project, resource, tool/action and pattern; retain hard safety invariants. Make the active boundary legible. “YOLO” must be deliberate, visible, reversible and scoped. |
| Secrets handling and trust boundaries | Generated apps commonly require APIs, auth and deployment credentials | HIGH | Secure secret store, redaction, client/server exposure warnings, repository trust, agent/provider data-path disclosure. Never solve secrets through prompt instructions alone. |
| Extensible workflows/instructions | Kiro hooks/skills, Zed skills/profiles, Cursor rules/modes and MCP establish extensibility expectations | HIGH | Start with open file formats and deterministic lifecycle hooks; defer a commercial marketplace until extension boundaries and signing are credible. |
| Basic app lifecycle support | Nontechnical builders expect database/auth/storage/publish/analytics rather than a source tree only | HIGH | Provide guided adapters and explain ownership/export. Avoid forcing a proprietary backend; support an initial blessed path plus generic commands/providers. |
| Accessible onboarding and progressive interface depth | Primary users cannot be expected to understand repositories, shells, schemas, or deployment on day one | HIGH | Same underlying project, configurable surfaces/profiles. Guide through concrete goals (“store site”, “internal tool”, “microsaaS”) without creating a crippled nontechnical mode. |

### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Intent autocomplete as semantic completion | Helps a user express a buildable product by surfacing ambiguity, missing decisions, constraints, risks, acceptance evidence, and domain concepts while they type/speak | HIGH | Not prose completion or “improve prompt.” Suggestions must be optional, attributable, context-aware, cheap/fast, and capable of updating structured intent. First wedge candidate. |
| Editable intent/spec ↔ implementation reconciliation | Detects when code, docs, decisions, tests or runtime behavior diverge and helps resolve which side should change | VERY HIGH | Core moat. Requires stable identities/provenance, structured claims and evidence—not merely regenerating Markdown. Support “accepted divergence” and uncertainty to avoid alert fatigue. |
| Semantic project graph above repositories and chats | Lets “Katsui” be one durable project across multiple repos/services/docs/environments, while shared resources can participate in other projects without duplication | VERY HIGH | A project is a human/product context; resources are technical attachments; sessions are temporal work. Must show scope and prevent context leakage across shared resources. |
| Product-aware semantic harness | Finds failures such as missing authorization boundaries, double-booking, incomplete refund logic, inappropriate data collection, or untested business invariants—not just syntax issues | VERY HIGH | Combine deterministic scanners/tests with AI hypotheses, domain packs, runtime evidence and user intent. Findings need severity, evidence, confidence, remediation and suppress/accept controls. Default harness policy should be discussed and specified after ecosystem research, before implementation. |
| Contextual learning at decision time | Explains unfamiliar product/technical concepts precisely when a decision depends on them | HIGH | Separate “need to decide” from “need to learn.” Exia can deepen learning, but the free IDE must provide enough local explanation to act safely. Avoid tutorials that interrupt flow. |
| Three modes over one shared state | Full Vibes, Spec Mode and Hybrid serve different risk/clarity moments without fragmenting projects | HIGH | Hybrid should materialize a disposable preview to elicit decisions, then promote confirmed intent/spec/evidence into durable state. Modes should be selectable per task, not permanent user classes. |
| Capability-aware agent interchange | Users can move between models, full agents, local runtimes and subscriptions while the IDE preserves project context and honestly exposes capability differences | VERY HIGH | Negotiate ACP capabilities where possible; adapters declare filesystem, terminal, planning, background, subagent, permission and resume support. Never pretend feature parity. |
| Agent-neutral project contract | Important instructions, decisions and evidence remain in open, editable project artifacts readable by humans and every connected agent | HIGH | Inject/update adapters are needed for AGENTS.md, CLAUDE.md, agent skills/rules and project manifests. Detect important decisions stranded in comments or session logs and propose promotion. |
| Cross-session/cross-agent continuity without chat ownership | A session can be resumed or imported, but no conversation owns files or defines the project hierarchy | HIGH | Project timeline links prompts, decisions, edits, executions and outcomes. Users can view by project, resource, agent, objective or time. |
| Progressive depth as a first-class interaction model | A nontechnical builder sees intent, preview, choices and outcomes; a technical user opens exact files, terminal, traces and infrastructure without changing products | VERY HIGH | Needs a shared command/state model and configurable layouts. Depth is about presentation, not authorization or capability removal. |
| Evidence-backed completion and maintenance | The IDE shows why a feature is believed complete and continues translating production errors, costs, dependency changes and behavior back to intent | VERY HIGH | Begin with local test/browser evidence. Production observability and operational reconciliation come later, but architecture must not assume creation ends at deploy. |
| Open harness/guide ecosystem | Domain experts can publish checks and guidance for commerce, payments, privacy, games, internal tools or agents | VERY HIGH | Potential marketplace/distribution moat. Packages should combine deterministic checks, schemas, prompts/knowledge, evaluation cases and UI guidance with permissions/signing. Defer marketplace economics until package contract proves useful. |
| Transparent inference/capacity rail as optional distribution layer | Free use remains possible while users can opt into convenient routing, sponsored models or hosted capabilities | HIGH | Product feature is transparent routing/cost/data-path choice, not mandatory billing. Sponsored placement must be labeled and never silently reduce task quality. Economic feasibility is a separate research track. |

### Deceptively Complex Features

| Feature | Why It Looks Easy | Hidden Complexity | Required Guardrail |
|---------|-------------------|-------------------|--------------------|
| “Keep spec and code synchronized” | Sounds like updating Markdown after edits | Many-to-many traceability, partial implementations, refactors, stale tests, external edits, conflicting truths, confidence, intentional divergence | Treat reconciliation as evidence-based proposals; never auto-rewrite the declared intent silently |
| Multi-repo semantic projects | Looks like VS Code multi-root with labels | Shared resources, nested repos, branches, credentials, duplicate membership, cross-repo search/build, per-session scope, path identity and remote resources | Stable resource IDs plus explicit active scope and provenance on every action |
| Universal agent support | ACP makes integration appear uniform | Agent-defined modes, auth, subscriptions, permissions, tools, resume semantics, streaming quirks and proprietary extensions differ | Capability negotiation, adapter conformance tests, clear degradation |
| Reliable semantic harness | “Ask an LLM to review the app” is easy | False positives, incomplete context, adversarial repository content, domain ambiguity, nondeterminism, cost and proof of absence | Separate deterministic facts from AI hypotheses; require evidence/confidence and evaluate against curated faulty apps |
| One-click rollback | Files are straightforward to snapshot | Databases, external services, migrations, side effects, secrets and deployments do not rewind with source | State precisely what checkpoint covers; preview destructive rollback; use provider-specific recovery |
| Preview that proves correctness | Running localhost seems enough | Browser state, authentication, seed data, responsiveness, accessibility, external APIs and flaky agents | Record executable scenarios and artifacts; distinguish “renders” from “meets intent” |
| Prompt autocomplete | Text completion is commodity | Latency, interruption, user voice, domain knowledge, ambiguity ranking, privacy and suggestion acceptance learning | Inline lightweight suggestions with expandable rationale; never replace the user's text without consent |
| Progressive-depth UI | Hiding panels is easy | Users lose mental models; technical users lose speed; state duplicated across views; navigation becomes mode-dependent | One command/state substrate; reversible reveal; user-configurable saved layouts |
| Production operation for nontechnical users | Dashboards look simple | Logs, traces, incidents, migrations, costs, secrets, provider ownership and irreversible effects | Translate first, retain raw evidence, stage actions, require stronger confirmation for production |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Chat/conversation as project container | Familiar and easy to implement | Fragments code/specs, hides durable state, makes multi-repo work confusing, and locks knowledge in append-only history | Semantic project with reusable resources; sessions are filterable timeline entries |
| Append-only generated artifacts | Preserves an apparent audit trail | Specs become duplicated/stale and users cannot correct the system’s understanding | Directly editable versioned artifacts plus change history and reconciliation |
| Hidden or export-only code | Makes the experience feel simpler | Removes ownership, blocks maintenance, destroys technical-user trust and repeats the Antigravity/no-code ceiling | Progressive disclosure with always-available files, Git and terminal |
| One universal “AI agent” abstraction | Simplifies menus and backend code | Erases native capabilities, subscriptions, auth and permission semantics; failures become mysterious | Common capability contract plus agent-specific extensions and honest badges |
| Mandatory ShinAI/Katsui inference | Simplifies monetization | Contradicts model neutrality and free distribution; creates lock-in suspicion | BYOK/local/external agents first-class; optional optimized ShinAI rail |
| Subscription-gated core IDE | Easy SaaS revenue | Narrows distribution and conflicts with the strategy of becoming the place where people build instead of buying tools | Free core; optional inference, hosting, marketplace, services and sponsored distribution |
| Automatic silent documentation/memory | Feels magical | Encodes model guesses as truth, accumulates contradictions, and becomes hard to inspect or delete | Proposed memory/decision promotion with source, scope, confidence and approval policy |
| Fully autonomous mode as default | Impressive demos and fewer prompts | Nontechnical users cannot judge hidden architectural, cost or safety decisions | Full Vibes remains explicit; interrupt only for material irreversible decisions; show outcome/evidence and easy recovery |
| Ask the user every technical question | Avoids agent responsibility | Burdens the least-equipped user and turns guidance into an interview | Infer safe defaults, explain consequential choices, and autocomplete missing product intent |
| AI-only security review | General and easy to market | Nondeterministic, vulnerable to missing context and cannot guarantee absence of issues | Layered deterministic scanners/tests plus semantic hypotheses and explicit limitations |
| One blessed web stack as the permanent product boundary | Accelerates the first demo | Makes the “generalist IDE” obsolete or merely another hosted app builder | A blessed starter path for validation over a generic project/resource/execution model |
| Proprietary project state or extension format | Appears to protect moat | Prevents ecosystem growth and makes neutral/free claims less credible | Open, versionable formats; monetize official distribution, hosted rails and network services |
| Ads that alter model/harness recommendations invisibly | Monetizes distribution | Corrupts trust and can increase user cost or reduce quality/safety | Clearly labeled sponsorship, measurable selection criteria and a neutral mode |
| Social/collaboration suite in MVP | Broadens addressable market | Distracts from single-builder product truth and adds identity/sync/permissions complexity | Local-first single-user project; sharing/export first, collaboration after core validation |
| Universal deploy platform in MVP | Creates an end-to-end demo | Cloud, DNS, database and billing scope can swallow the IDE thesis | Provider adapters and one reference deploy path; preserve export/self-hosting |

## Feature Dependencies

```text
[Open semantic project manifest + stable resource IDs]
    ├──requires──> [Resource adapters: repos, folders, docs, services, environments]
    ├──enables──> [Explicit per-session context scope]
    ├──enables──> [Cross-session/cross-agent continuity]
    └──enables──> [Intent/spec ↔ implementation reconciliation]

[Real editor + file watching + Git/diff]
    ├──enables──> [Manual/external edits as first-class events]
    ├──enables──> [Review and recovery]
    └──feeds──> [Reconciliation evidence]

[Agent capability contract]
    ├──requires──> [ACP client path]
    ├──requires──> [CLI/raw-model fallback adapters]
    ├──enables──> [Model/agent interchange]
    └──feeds──> [Permission policy engine]

[Structured intent model]
    ├──enables──> [Intent autocomplete]
    ├──enables──> [Spec/Hybrid modes]
    ├──feeds──> [Semantic harness]
    └──anchors──> [Reconciliation]

[Execution + preview + evidence capture]
    ├──feeds──> [Semantic harness]
    ├──feeds──> [Completion evidence]
    └──precedes──> [Production operation]

[Harness finding contract]
    ├──requires──> [Intent + code + deterministic evidence]
    ├──enables──> [Default safety/product harness]
    └──precedes──> [Harness marketplace]

[Free neutral core] ──conflicts──> [Mandatory inference rail]
[Editable canonical state] ──conflicts──> [Append-only chat-owned artifacts]
```

### Dependency Notes

- **The semantic project/resource model must precede rich chat or orchestration:** otherwise conversation IDs and working directories become accidental architecture that is expensive to unwind.
- **The intent schema must precede autocomplete and reconciliation:** free-form Markdown alone cannot reliably identify which decision, requirement, constraint or evidence changed.
- **Reconciliation requires ordinary editing to be trustworthy first:** manual edits, Git operations and external-agent changes must enter one event/provenance stream.
- **The harness requires an explicit finding/evidence contract before default rules are chosen:** deciding the default harness is a product-design phase after research, not a late collection of prompts.
- **ACP reduces adapter work but does not supply semantic project state:** it standardizes client-agent interaction, not intent/code reconciliation or long-lived product organization.
- **Marketplace features depend on stable extension, permission, signing and evaluation contracts:** launching a store before those exist creates an unsafe collection of prompts and scripts.

## MVP Definition

The MVP should validate the new interaction primitive, not attempt to replace every mature IDE feature or host every workload. Use one blessed full-stack web path to prove a general architecture without declaring JavaScript the permanent boundary.

### Launch With (v1)

- [ ] **Semantic project manifest** — create/open a named product and attach one or more local repositories/folders with explicit session scope.
- [ ] **Real workspace substrate** — editable files/Markdown, search, diagnostics, terminal, Git diff/review and preview; technical truth is never hidden.
- [ ] **Structured intent canvas plus intent autocomplete** — capture goals, actors, flows, constraints, open decisions and acceptance evidence; suggest missing product decisions inline.
- [ ] **Full Vibes, Spec and Hybrid task modes over one state** — validate that different deliberation levels coexist without fragmenting the project.
- [ ] **One native/reference agent plus one ACP external agent** — prove the capability contract and agent-neutral state without promising universal compatibility.
- [ ] **Transparent agent execution and recovery** — visible plan/actions/diffs/tests, scoped permissions, checkpoints and Git-backed durable history.
- [ ] **Thin reconciliation loop** — connect selected intent items to files/tests, detect a small set of explicit divergences, and let the user reconcile either direction.
- [ ] **Evidence-based starter harness for one benchmark domain** — for example a small marketplace/internal tool: deterministic build/test/security checks plus a few semantic product invariants with confidence and evidence.
- [ ] **Guided build→preview→verify→deploy adapter** — one reference deployment path with ownership/export clear; generic commands remain available.

### Add After Validation (v1.x)

- [ ] **Multiple raw-model providers, gateways and local inference** — after the native harness proves provider-neutral prompts/tools.
- [ ] **More ACP/CLI adapters and session import/resume** — when adapter conformance tests and capability UI are stable.
- [ ] **Reusable resources across multiple semantic projects** — the schema should allow it from day one; expose full UX after single-project multi-repo behavior is sound.
- [ ] **Voice intent input** — after the intent editor is useful in text and can distinguish dictation from confirmed structured decisions.
- [ ] **Contextual guide packs** — expand from embedded starter guidance once intervention timing can be measured.
- [ ] **Visual editing and richer browser evidence** — after round-trip mapping between rendered elements, source and intent is reliable.
- [ ] **Background/parallel agents** — after scope, merge/conflict handling, permissions and resource isolation work with one agent.
- [ ] **Additional harness packs** — payments, commerce, auth, privacy, chatbots/agents, based on observed project demand.

### Future Consideration (v2+)

- [ ] **Production operations plane** — logs, incidents, costs, migrations and runtime-to-intent reconciliation; valuable but distinct from proving creation.
- [ ] **Signed harness/guide/agent marketplace** — only after package contract, sandboxing, evaluation and governance are mature.
- [ ] **Optional ShinAI/Katsui inference/capacity rail** — preserve neutrality; validate economics and provider agreements separately.
- [ ] **Sponsored model/provider discovery** — only with explicit labeling, neutrality controls and quality/cost reporting.
- [ ] **Cloud sandboxes and remote/background sessions** — after local project identity and state synchronization are stable.
- [ ] **Multiplayer collaboration and portfolio-wide orchestration** — high value later, but sync/conflict/governance complexity should not obscure single-builder validation.

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Semantic project + multi-resource model | HIGH | HIGH | P1 |
| Editable code/docs + terminal + Git + preview | HIGH | HIGH | P1 |
| Structured intent canvas | HIGH | HIGH | P1 |
| Intent autocomplete | HIGH | HIGH | P1 |
| Full Vibes / Spec / Hybrid | HIGH | MEDIUM | P1 |
| Transparent task execution and recovery | HIGH | HIGH | P1 |
| ACP reference integration + capability contract | HIGH | HIGH | P1 |
| Thin intent/code reconciliation | HIGH | VERY HIGH | P1 |
| Starter semantic harness | HIGH | VERY HIGH | P1 |
| Contextual guidance | HIGH | HIGH | P2 |
| More model/agent adapters | HIGH | HIGH | P2 |
| Voice input | MEDIUM | MEDIUM | P2 |
| Parallel/background agents | MEDIUM | VERY HIGH | P2 |
| Visual editing | MEDIUM | HIGH | P2 |
| Production operations plane | HIGH | VERY HIGH | P3 |
| Harness/guide marketplace | HIGH | VERY HIGH | P3 |
| Inference/capacity marketplace | STRATEGIC | VERY HIGH | P3 / separate validation |
| Realtime multiplayer | LOW for initial ICP | VERY HIGH | P3 |

**Priority key:**

- P1: Must prove the category thesis
- P2: Adds breadth after the substrate works
- P3: Network/business expansion or later lifecycle

## Competitor Feature Analysis

| Capability | Current Evidence | Gap / Lesson | Our Approach |
|------------|------------------|--------------|--------------|
| Traditional IDE substrate | VS Code supports multi-root folders, per-folder/workspace settings, multiple SCM providers, profiles, terminal and extensions | Folder/workspace remains mainly a technical container, not a reusable semantic product graph | Preserve IDE power but make named product/project and attached resources the primary organization |
| Agent/runtime interchange | Zed offers native agent, ACP external agents and terminal threads; external agents may retain auth, models, subscriptions and configuration | Useful interoperability, but threads/worktrees still dominate organization and project intent is not a shared semantic contract | Capability-aware ACP/CLI/model adapters inside a project-owned state model |
| Structured development modes | Kiro supports iterative chat, quick specs and full requirements→design→tasks; configuration persists in `.kiro/` across surfaces | Strong spec workflow, but repo-root configuration and document generation do not by themselves reconcile intent with implementation | Three modes over structured intent plus bidirectional, evidence-backed reconciliation |
| Autonomous orchestration | Antigravity has editor and manager surfaces; agents work across editor/terminal/browser and return artifacts | Artifact-centered review can detach users from exact project/code state and organize work around agents/sessions | Use artifacts as evidence linked to editable canonical resources, never as the container |
| Accessible full-stack creation | Replit, Bolt and Lovable generate runnable apps, provide preview, databases/integrations and publishing | Integrated convenience often narrows stack/hosting choice; recovery may not include live database state | One easy blessed path plus portable code, generic execution and provider adapters |
| Code ownership | Lovable provides direct code mode and two-way GitHub sync; Bolt exposes a code editor and source control | Code access is becoming table stakes, not differentiation | Code/docs/terminal always available; progressive depth changes presentation only |
| Persistent knowledge | Cursor Rules, Kiro Steering and Lovable project/workspace Knowledge keep instructions across sessions | Knowledge is usually prompt context; staleness/conflict and evidence linking remain weak | Typed, scoped, versioned intent/decision state with provenance and reconciliation |
| Safety | Lovable layers RLS/database/code/dependency scans; Zed/Kiro offer tool permission policies and hooks | Security scans and execution permissions are separate, while AI review can be vague | Unify deterministic checks, semantic product risks, runtime evidence and action permissions in an explainable harness |
| Recovery | Cursor checkpoints agent file changes; Replit rollback can include files, memory, tasks and optionally database; Kiro supports checkpoints/rewind | Coverage differs and users can falsely assume all external state reverted | Explicit recovery manifest showing exactly which resources/state are covered |
| Extension protocols | MCP standardizes tools/resources/prompts; ACP standardizes editor↔agent sessions/tools/permissions/terminal/fs | Neither standard supplies the product-level source of truth | Adopt both at their correct boundaries and keep semantic state in an open project contract |

## Requirements Signals

The roadmap/requirements phase should convert these findings into testable product requirements around the following outcomes:

1. A user can define a named product independently of folder/chat boundaries and attach at least two repositories without losing action provenance.
2. A nontechnical user can express an incomplete product intent and receive useful, nonintrusive semantic completions that improve buildability.
3. The same task can pass through Full Vibes, Spec, or Hybrid while files, intent and history remain one shared state.
4. Manual edits and an external ACP agent both update the project without bypassing divergence detection.
5. A harness finding cites intent, implementation/runtime evidence, confidence and a remediation path; the user can accept, suppress or revise the underlying intent.
6. A user can always inspect/edit/export code and project documents and use the free IDE with at least one non-ShinAI model/agent path.
7. Sessions can be filtered/resumed but deleting or archiving a session does not delete or orphan project artifacts.

## Sources

Primary sources, accessed 2026-08-22:

- [Google Developers Blog — Google Antigravity](https://developers.googleblog.com/en/build-with-google-antigravity-our-new-agentic-development-platform/) — editor/manager surfaces, agents across editor/terminal/browser, asynchronous tasks and review artifacts.
- [Kiro documentation overview](https://kiro.dev/docs/) and [How Kiro works](https://kiro.dev/docs/how-kiro-works) — unified harness, specs, steering, hooks, permissions, skills, MCP, checkpoints, modes and ACP boundary.
- [Kiro first project](https://kiro.dev/docs/getting-started/first-project/) — requirements/design/tasks spec flow and event-driven hooks.
- [Zed AI quick start](https://zed.dev/docs/ai/quick-start), [Agents](https://zed.dev/docs/ai/agents), [External Agents](https://zed.dev/docs/ai/external-agents), and [Tool Permissions](https://zed.dev/docs/ai/tool-permissions) — native/ACP/terminal paths, provider choices and granular permissions.
- [Agent Client Protocol architecture](https://agentclientprotocol.com/get-started/architecture) and [official schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json) — sessions, streaming, filesystem, terminal, tool calls, permissions, modes and extensions.
- [Model Context Protocol architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture) — host/client/server boundary, capability negotiation, tools/resources/prompts and consent responsibilities.
- [VS Code multi-root workspaces](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces), [Profiles](https://code.visualstudio.com/docs/configure/profiles), and [Source Control](https://code.visualstudio.com/docs/sourcecontrol/overview/) — baseline editor/workspace behavior.
- [Cursor Tools](https://docs.cursor.com/en/agent/tools), [Rules](https://docs.cursor.com/context/rules), and [Checkpoints](https://docs.cursor.com/en/agent/chat/checkpoints) — agent tooling, persistent context, custom modes/guardrails and recovery limits.
- [GitHub Copilot agent sessions](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions) — plan, autonomous modes and model/provider selection.
- [Replit — Build with Agent](https://docs.replit.com/learn/build-with-agent) — planning, context, testing and checkpoint/rollback collaboration.
- [Lovable Code Mode](https://docs.lovable.dev/features/code-mode), [GitHub sync](https://docs.lovable.dev/integrations/github), [Knowledge](https://docs.lovable.dev/features/knowledge), [Security](https://docs.lovable.dev/features/security), and [Publishing](https://docs.lovable.dev/features/publish) — editable code, two-way ownership, persistent context, layered checks and deploy.
- [Bolt introduction](https://support.bolt.new/building/intro-bolt), [Database](https://support.bolt.new/cloud/database), [MCP](https://support.bolt.new/building/using-bolt/connect-mcp), and [supported technologies](https://support.bolt.new/building/using-bolt/browser-support) — full-stack builder baseline and stack constraints.
- [Google Developers Blog — Conductor and persistent specs](https://developers.googleblog.com/evolving-spec-driven-development-conductor-now-supports-antigravity/) — version-controlled specs/plans outside ephemeral chats.

### Confidence Notes

- **HIGH:** ACP, MCP, Kiro, Zed, VS Code, Lovable, Bolt and Antigravity capability claims taken from official current documentation.
- **MEDIUM:** Cursor/Windsurf category breadth because documentation indexing and product surfaces change quickly; verify exact current behavior during their implementation phases.
- **MEDIUM:** Complexity, MVP and competitive-gap judgments; they follow the project thesis and ecosystem evidence but remain hypotheses until prototype/user validation.

---
*Feature research for: AI-native IDE*
*Researched: 2026-08-22*
