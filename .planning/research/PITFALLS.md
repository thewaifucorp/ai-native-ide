# Pitfalls Research

**Domain:** AI-native IDEs, coding agents, semantic workspaces and low-code software creation
**Researched:** 2026-08-22
**Confidence:** MEDIUM (current primary documentation cross-checked; product behavior and market hypotheses still require prototypes and user studies)

## Critical Pitfalls

### Pitfall 1: Claiming control over an agent that the IDE can only observe

**What goes wrong:**
The UI shows one permissions model for ACP agents, terminal agents, model APIs and embedded agents even though each path exposes different interception points. Users believe a file, shell or network action will be stopped, but an external process executes through its own tools or credentials. ACP itself describes a trusted-agent setting; it carries permission requests but is not a sandbox. Zed likewise states that its sandbox does not cover External Agents or Terminal Threads.

**Why it happens:**
A universal agent abstraction is attractive for UX, and successful protocol connection is mistaken for enforcement. Adapters normalize labels while hiding missing guarantees.

**How to avoid:**
Define a capability/guarantee contract with `enforced`, `observable`, `agent-reported` and `unavailable` states per effect. Put guaranteed filesystem, shell, network, secret and deploy controls in an IDE-owned effect broker or OS sandbox. Show explicit degradation for native agent effects. Require adapter conformance fixtures and adversarial tests.

**Warning signs:**
- Every adapter displays identical permission controls.
- An adapter promises pre-action approval without brokered tools or process isolation.
- Tests mock agent events but never attempt out-of-band file/network access.
- “ACP-compatible” is used as a synonym for “sandboxed.”

**Phase to address:**
Agent Contract + Effect Boundary spike, before real provider integrations. Ship no “safe mode” claim until an escape test proves the boundary.

---

### Pitfall 2: Turning semantic state into a third, opaque source of truth

**What goes wrong:**
The intent graph, embeddings or generated summaries become more authoritative than both editable specs and executable behavior. Links silently retarget after refactors; inferred decisions are persisted as fact; users cannot explain why the IDE says code and intent agree. The product recreates the append-only artifact trap it is intended to fix.

**Why it happens:**
Teams want a clean “knowledge graph” demo and treat probabilistic extraction as database normalization. They optimize for automatic sync rather than reconciliation and provenance.

**How to avoid:**
Keep two authoritative domains: reviewed intent/spec artifacts and executable/observed implementation. Treat the activity ledger and evidence index as history, not truth. Every inferred node/link needs provenance, confidence, timestamp and review state. Reconciliation must propose `update intent`, `update implementation`, `accept exception` or `defer`; never silently rewrite either side. Anchor evidence by resource ID + revision + semantic locator + fingerprint, not path/line alone.

**Warning signs:**
- “Sync” means regenerating Markdown or code automatically.
- A graph edge has no source revision or reviewer.
- Moving a symbol makes evidence appear valid against the wrong code.
- Users must edit generated JSON instead of normal Markdown/code.

**Phase to address:**
Intent/Evidence Model spike, then a Reconciliation vertical slice using refactor, external-edit and conflicting-spec fixtures.

---

### Pitfall 3: Semantic lint that manufactures confidence instead of evidence

**What goes wrong:**
The harness declares a store, payments flow or internal tool “secure,” “complete” or “spec-compliant” because another model reviewed generated text. Nontechnical users are especially likely to interpret confident prose and green checks as verification. Generated tests may merely encode the same mistaken assumption as generated code.

**Why it happens:**
LLM evaluation is cheap to demo, while runtime evidence, domain oracles and independent static/dynamic checks are harder. A single model is allowed to propose, implement and grade its own work.

**How to avoid:**
Separate findings from verdicts. Each finding carries severity, confidence, evidence and evaluator identity. Reserve “verified” for reproducible observations: tests, static analysis, type checks, preview/browser assertions, runtime traces or human acceptance. Use diverse checks and mutation/adversarial fixtures; present “not checked” separately from “passed.” Gate deployment of high-impact domains on concrete checklists, not model confidence.

**Warning signs:**
- A green badge has no linked command/result/artifact revision.
- The same model writes the feature and its acceptance test in one unreviewed turn.
- “No issues found” is rendered as “safe.”
- Harness quality is measured by number of warnings, not precision/recall and user outcomes.

**Phase to address:**
Harness Evaluation spike before semantic warnings become default; build a reference corpus of intentionally flawed store, micro-SaaS, internal-tool and chatbot projects.

---

### Pitfall 4: Prompt guidance becoming a questionnaire, prompt beautifier or hidden spec author

**What goes wrong:**
Autocomplete interrupts every sentence, front-loads dozens of questions, or expands simple intent into verbose boilerplate. Full Vibes stops feeling full-vibes; nontechnical users approve suggestions they do not understand; technical users disable the feature. Alternatively, the model silently chooses authentication, data retention or payment semantics and buries the assumption in code.

**Why it happens:**
Completion quality is optimized offline for “more comprehensive prompt” rather than decision value, timing and cognitive load.

**How to avoid:**
Classify gaps by reversibility, impact and confidence. Inline-complete low-risk wording; surface a small number of high-value forks; defer reversible decisions; require explicit confirmation only for costly, security-sensitive or externally visible choices. Full Vibes, Hybrid and Spec modes change interruption thresholds, not evidence collection. Log accepted, rejected and ignored suggestions to measure usefulness without training on secrets by default.

**Warning signs:**
- Prompts become longer but projects do not require fewer corrections.
- Users repeatedly press “accept all.”
- Suggestions ask implementation questions before clarifying product behavior.
- Mode changes are cosmetic rather than policy changes.

**Phase to address:**
Guided Intent UX prototype with task-based testing across all three modes before building generalized autocomplete infrastructure.

---

### Pitfall 5: Context assembly leaks data and degrades reasoning

**What goes wrong:**
A semantic project spanning shared repositories sends unrelated source, secrets, private documents or another project's decisions to a provider or agent. Bigger context also raises latency/cost and makes instruction conflicts more likely. Persistent summaries can carry prompt injection or false assumptions into later sessions.

**Why it happens:**
“Full codebase context” is marketed as quality, and multi-repo project membership is treated as blanket read authority. Retrieval provenance and disclosure boundaries are added late.

**How to avoid:**
Separate project membership, session scope and provider disclosure. Context assembly must be IDE-owned, provenance-labelled, redacted and budgeted. Default to summaries + targeted evidence, not transcripts or repository dumps. Treat repository files, web results, MCP results and imported memory as untrusted data. Make persistent-memory writes reviewable, scoped, expirable and reversible. Include a “what was sent where” receipt.

**Warning signs:**
- Attaching a repo automatically exposes all files to every model.
- Context size rises monotonically over a session.
- Summaries cannot be traced to source revisions.
- Secrets are filtered only by filename patterns.

**Phase to address:**
Project/Resource Graph + Context Boundary spike, before multi-repo agent execution or remote providers.

---

### Pitfall 6: Conversation remains the real database despite project-first branding

**What goes wrong:**
Files are technically visible, but decisions, pending questions, costs and agent assumptions remain trapped in threads. Changing agents loses the actual state. Cross-project views become chat search. Users cannot answer “what is true now?” without replaying sessions.

**Why it happens:**
Chat storage is available before project-domain modeling, so temporary transcripts accrete product responsibilities.

**How to avoid:**
Make sessions temporal scopes that reference project resources and artifact revisions. Promote decisions into editable artifacts/reviewed intent nodes. Generate portable checkpoints containing current decisions, unresolved issues, resource scope and evidence references. Test handoff across two unlike agents without passing raw transcript.

**Warning signs:**
- Deleting a chat deletes knowledge or generated artifacts.
- A project dashboard is only a list of threads.
- Agent handoff requires copy/pasting conversation history.
- Search results cannot distinguish obsolete discussion from current decisions.

**Phase to address:**
Project/Session Domain foundation; acceptance test must resume a multi-repo task in a fresh session and different adapter.

---

### Pitfall 7: Permissions produce either universal trust or approval fatigue

**What goes wrong:**
Users choose YOLO because prompts are incessant, or grant universal trust because resource-scoped policy is too hard to edit. A shared repository added to a trusted project inherits unrelated authority. High-impact actions become indistinguishable from harmless reads.

**Why it happens:**
Permission systems start as allow/deny dialogs keyed to tool names instead of resource, effect and consequence. Policies are hidden in global JSON.

**How to avoid:**
Support project defaults plus resource, path, capability, agent and session overrides. Provide inspectable presets including explicit YOLO with visible blast radius. Group predictable low-risk actions; require fresh confirmation for irreversible, financial, credential, production and externally visible effects. Let users edit/revoke policies from the active context and show why a decision was made.

**Warning signs:**
- Most experienced users disable all prompts within a day.
- Approval rate approaches 100% with sub-second decisions.
- “Allow always” has no displayed scope or expiry.
- Adding one repo changes permissions of another.

**Phase to address:**
Permissions UX + Policy Engine spike immediately after the Effect Boundary; test fatigue and revocation, not only denial correctness.

---

### Pitfall 8: Protocol and provider churn leaks into the domain model

**What goes wrong:**
ACP, ACPX, MCP or one vendor's stream schema becomes the internal event model. A protocol revision, deprecated install path, missing capability or provider auth change forces migrations throughout sessions, UI and harness logic. Zed has already deprecated extension-provided ACP agents in favor of its registry, illustrating that ecosystem packaging changes even when the protocol remains useful.

**Why it happens:**
Early prototypes import external types directly because it is faster than defining a narrow internal contract.

**How to avoid:**
Use ports/adapters and snapshot negotiated capabilities per session. Preserve provider-native events as opaque/versioned attachments while normalizing only stable facts. Build fake-agent conformance tests and recorded protocol fixtures. Pin protocol versions; support feature detection and visible degradation. Keep ACPX a replaceable compatibility tool, not a state dependency.

**Warning signs:**
- Core domain packages import ACP/MCP SDK types.
- UI branches on provider names rather than capabilities.
- Old sessions cannot render without the exact old adapter.
- Upgrading an SDK requires rewriting stored events.

**Phase to address:**
Agent Contract spike and adapter test kit before the second real agent integration.

---

### Pitfall 9: Incremental semantic analysis becomes a token-burning, noisy background agent

**What goes wrong:**
Every keystroke triggers whole-project indexing, LLM review and reconciliation. Costs become unpredictable, laptops heat up, providers rate-limit, and users learn to ignore repeated warnings. If revenue depends on inference volume, the system has a structural incentive to over-call models or recommend expensive routes.

**Why it happens:**
The initial demo runs on small repositories and lacks a cost ledger, invalidation graph or independent quality objective.

**How to avoid:**
Use deterministic parsing/indexing first, dependency-based invalidation, debounce and explicit deep-check checkpoints. Every inference call records initiator, model, purpose, tokens/cost, cache status and result usefulness. Expose budgets and stop conditions across agent loops. Separate routing quality metrics from revenue; label sponsorship and give a neutral choice. Optimize for verified outcome per cost/time, not tokens consumed.

**Warning signs:**
- Idle editing produces billable calls.
- Cost cannot be attributed to a feature or session.
- Warning count scales with repository size rather than changed scope.
- The default router cannot explain why a model/provider was chosen.

**Phase to address:**
Cost/Telemetry foundation before background harnesses; Incremental Analysis spike before enabling always-on semantics.

---

### Pitfall 10: Generated software works in preview but cannot be owned or operated

**What goes wrong:**
The happy path produces a polished demo while authentication recovery, migrations, backups, observability, accessibility, abuse handling, dependency updates and failure recovery are absent. Deployment credentials or proprietary runtime primitives create lock-in even when code export exists.

**Why it happens:**
Builder products optimize time-to-first-preview and acquisition. Nontechnical users cannot easily notice operational omissions until real users or money arrive.

**How to avoid:**
Define “real software” readiness profiles per application class. Keep ordinary files, package manifests and deployment configuration editable/exportable. Before production, show environment-specific evidence and unresolved obligations. Build operate/evolve flows—errors, schema changes, rollback, costs and dependency advisories—into the product rather than treating deploy as completion.

**Warning signs:**
- Success metric is preview generation or deploy count alone.
- Exported projects require an undocumented proprietary backend.
- No restore/rollback exercise exists.
- Production state is invisible to the intent/evidence model.

**Phase to address:**
First End-to-End Product Slice must include deploy, observe, change and rollback—not only creation.

---

### Pitfall 11: Building an editor platform before validating the new primitive

**What goes wrong:**
Years go into text editing, LSP, terminals, Git, remote development, keymaps and extension compatibility while the distinctive loop—guided intent, semantic verification and reconciliation—remains unproven. Conversely, embedding an existing editor without an isolation boundary can inherit extension/runtime risk and constrain the new UX.

**Why it happens:**
“IDE” invites parity checklists, and infrastructure work feels concrete compared with validating semantic UX.

**How to avoid:**
Prototype the differentiating loop using replaceable editor/runtime bridges and a constrained application fixture. Reuse mature editor components/services where licensing and architecture allow, but keep Project, Session, Intent, Harness and Agent contracts independent. Establish parity boundaries explicitly: which traditional IDE capabilities are table stakes for the first ICP and which are later.

**Warning signs:**
- Roadmap begins with “implement VS Code.”
- No user can complete a full intent→evidence→reconcile loop after months of work.
- Domain logic lives inside editor widget callbacks.
- Success is measured by supported languages rather than completed products.

**Phase to address:**
Experience Prototype first; Editor Foundation only after the semantic loop passes user testing.

---

### Pitfall 12: Open-core and marketplace choices undermine neutral distribution

**What goes wrong:**
The client is called open while essential agent routing, project format or extension APIs are controlled; forks cannot access the official marketplace; contributors fear future relicensing; sponsored recommendations compromise trust. Alternatively, a permissive fork captures distribution while ShinAI funds the commons with no service advantage.

**Why it happens:**
License, trademark, marketplace terms and service boundaries are treated as a late legal cleanup. The VS Code/Code-OSS distinction demonstrates that an open repository, official binary and marketplace can have materially different terms and capabilities.

**How to avoid:**
Before ecosystem launch, publish a boundary matrix for code, protocol, project format, marketplace, telemetry, hosted services, trademarks and model routing. Ensure projects and plugins remain portable. Define transparent ranking/sponsorship rules and conflict-of-interest metrics. Choose license after a fork-threat/service-moat exercise, not by ideology; obtain legal review before accepting dependencies or third-party extensions at scale.

**Warning signs:**
- “Open source” cannot be mapped to exact repositories and licenses.
- The official marketplace API is required to run community harnesses.
- Sponsored model placement is indistinguishable from quality ranking.
- Core formats change without public compatibility policy.

**Phase to address:**
Open Ecosystem & Business Boundary spike before public plugin SDK/marketplace and before branding the core open source.

---

### Pitfall 13: Free distribution has no compounding loop or sustainable unit economics

**What goes wrong:**
The IDE attracts curiosity but not durable creation; users bring subscription-backed agents or BYOK routes that generate no revenue; a 1% rail fee is too small for support, inference-dependent native features and marketplace moderation. Ads or sponsored models reduce neutrality before there is enough demand to matter.

**Why it happens:**
“Free” is mistaken for distribution, and token volume is mistaken for value. Existing rails can charge on credit purchase or BYOK usage, but credits are provider-specific balances, not a universal transferable asset; OpenRouter's current terms restrict redemption/exchange.

**How to avoid:**
Instrument a distribution funnel: install→first useful artifact→deploy→30/90-day evolution→agent/model/marketplace transaction. Model unit economics separately for direct API, BYOK, subscription-backed external agents, local models and sponsored capacity. Preserve a useful zero-revenue path, then test optional rails whose value is uptime, routing, settlement or convenience. Do not launch a “token asset” until transferability, regulation, provider contracts, fraud and settlement are validated.

**Warning signs:**
- Forecasts multiply users by assumed token spend without adapter-path segmentation.
- Retention is not measured after first deploy.
- Monetization requires silently routing around users' existing subscriptions.
- Marketplace supply is recruited before recurring demand exists.

**Phase to address:**
Distribution/Economics experiments alongside the first usable slice; separate Feasibility spike for capacity/credit marketplace before implementation.

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Store provider protocol objects as domain events | Fast adapter prototype | Locked schemas, unreadable old sessions | Throwaway spike only |
| Use path + line as evidence identity | Easy links | Silent evidence rot after refactors | Demo fixture only, never persisted as authoritative |
| Put all project state in chat history/vector memory | Rapid conversational prototype | No current truth, poisoning and deletion problems | Never for durable state |
| Run every check through an LLM | Uniform implementation | Cost, latency, nondeterminism, false positives | Optional experimental evaluator only |
| One global trusted-workspace boolean | Simple UX | Excess authority across shared resources | Never for multi-resource projects |
| Give extensions host-process privileges | Easy ecosystem compatibility | Supply-chain compromise equals machine compromise | Never for community packages |
| Couple UI directly to filesystem/agent processes | Fast desktop demo | Security boundary and remote execution rewrite | Throwaway prototype only |
| Hide native agent features to preserve uniformity | Clean UI | Lowest-common-denominator integrations | Never; expose capability-specific escape hatches |
| Use whole transcripts for handoff | High apparent recall | Cost, stale assumptions, injection propagation | Debug-only with explicit disclosure |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| ACP | Treat permission requests as a security sandbox | Treat the agent as trusted; negotiate capabilities and enforce effects in a broker/sandbox |
| ACPX/CLI adapters | Depend on alpha/terminal output format for durable state | Keep replaceable adapter; normalize only stable observations; store raw versioned payload separately |
| MCP | Trust tool descriptions/results or forward bearer tokens | Treat results as untrusted, authorize per server/tool/resource, validate token audience, never token-pass-through |
| External subscriptions | Assume IDE provider keys and agent subscription auth are interchangeable | Let the external agent own auth/billing and show exact boundary; provide separate native-provider path |
| Git/filesystem | Assume a project maps to one root or repo | Stable resource IDs, many-to-many project membership, explicit session scopes |
| Extensions/marketplace | Trust install-time review/signature as runtime confinement | Signed provenance plus declared capabilities, isolation, revocation/blocklist and update review |
| Remote runtime | Reuse local paths/credentials as identity | Stable logical resource identity; separate locator, execution authority and secret scope |
| Hosted inference rail | Charge by raw token count uniformly | Meter actual provider units/cost; disclose markup, routing, caching and sponsorship |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Whole-project semantic review on edit | Lag, repeated findings, runaway cost | Incremental invalidation + checkpoint deep scans | Multi-repo projects or frequent edits |
| Transcript/context accumulation | Slower/worse responses and context limits | Checkpoints, scoped retrieval, provenance and budgets | Long-lived projects/sessions |
| Full repository graph in one store/query | UI stalls and expensive re-index | Split domain graph from derived code index; revisioned incremental workers | Large repos/shared resources |
| Re-index shared repo once per project | Duplicate compute and conflicting anchors | Resource-level index reused by project projections | First repo shared across projects |
| Serial multi-agent orchestration | Long waits and cascading context | Independent bounded tasks, cancellation and deterministic merge/reconcile | More than one slow provider/tool chain |
| Persist every editor event | Storage/projection overload | Event-source meaningful activity; CRUD/version normal edits | Normal typing volume |
| Unbounded retries/tool loops | Denial-of-wallet and resource exhaustion | Per-session/tool budgets, depth/time limits, circuit breakers | Can fail on a single adversarial task |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Renderer can access Node/filesystem/shell | Project/web content compromises host | Sandboxed renderer, context isolation, minimal validated IPC bridge |
| Repository content treated as instructions | Persistent prompt injection and goal hijacking | Provenance/instruction-data separation, trust mode, memory-write gate |
| Agent receives broad environment/credentials | Exfiltration across projects/providers | Secret broker with scoped short-lived handles; no ambient secrets |
| MCP/external tool result trusted at runtime | Tool poisoning triggers privileged follow-up | Label untrusted results; constrain available follow-on effects; inspect egress |
| YOLO implemented as disabling all controls | Irreversible or external harm | Keep containment, audit, budgets and high-impact external gates; define blast radius |
| Extension signing treated as sandbox | Signed malicious/compromised update has host power | Capability isolation, reproducible provenance, revocation and update policy |
| Generated tests accepted as independent proof | Shared hallucination becomes green gate | Independent deterministic oracles, mutation/adversarial tests, human acceptance |
| Logs contain prompts, code and secrets indefinitely | Cross-session/provider privacy breach | Data classification, redaction, retention controls and deletable payload references |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Chat/thread as navigation root | Cannot see current product state across sessions/repos | Project-first surfaces with sessions as filterable history |
| “Simple” mode hides files/docs | Nontechnical user cannot recover control | Progressive disclosure; same editable artifacts in every profile |
| Endless plan/spec append | Users lose authoritative current document | Editable canonical artifacts + revision/diff + reconciliation |
| Warning firehose | Users disable harness or blindly approve | Risk-ranked, evidence-linked, deduplicated findings with suppression/exception |
| Agent parity fiction | User chooses agent without understanding lost features | Capability matrix and session-specific degradation before execution |
| Invisible context/routing | User cannot assess privacy, cost or sponsorship | Per-turn context receipt, cost estimate and routing explanation |
| Premature success celebration | Preview is mistaken for operable product | Readiness view: verified, assumed, missing, production-observed |
| Technical/nontechnical product split | Users get trapped below or overwhelmed above | One progressive interface with customizable layouts/profiles |
| Project/repo ambiguity | Shared repo changes affect unexpected product | Always show active project, resource scope, branch/revision and affected projects |

## "Looks Done But Isn't" Checklist

- [ ] **Agent integration:** Demonstrates structured chat but not cancellation, resume, native auth, capability degradation, out-of-band effects or old-session rendering.
- [ ] **Safe execution:** Shows approval prompts but has not tested filesystem/network/secret escape paths against each adapter class.
- [ ] **Intent reconciliation:** Links a spec to files but has not survived rename, refactor, external edit, conflicting decisions and accepted exceptions.
- [ ] **Semantic harness:** Emits plausible findings but lacks a labeled flaw corpus, precision/recall tracking and reproducible evidence.
- [ ] **Prompt autocomplete:** Produces richer text but has not reduced time, corrections or unsafe assumptions in observed user tasks.
- [ ] **Multi-repo project:** Opens several roots but lacks shared-resource identity, cross-project impact and per-session disclosure scope.
- [ ] **Session persistence:** Restores messages but not capability snapshot, current decisions, artifact revisions, cost and unresolved divergences.
- [ ] **Model agnosticism:** Supports several OpenAI-compatible APIs but not different agent-owned auth, tools, sessions and observability levels.
- [ ] **Production support:** Deploys a preview but cannot surface errors, costs, migrations, backup/restore, rollback and dependency risk.
- [ ] **Open ecosystem:** Publishes source but lacks a portable project format, stable SDK policy, extension isolation and marketplace governance.
- [ ] **Free distribution:** Counts installs but not useful artifact, deployment, continued evolution, rail adoption and per-path margin.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Protocol types infected domain/storage | HIGH | Freeze old envelope reader; introduce internal contract; migrate projections gradually; retain raw payloads |
| Semantic graph became authoritative | HIGH | Reclassify inferred state as candidates; rebuild provenance from revisions; ask users to review uncertain decisions |
| Universal permissions shipped | HIGH | Inventory effects/credentials; default unknown scopes to restricted; introduce hierarchical policy and revoke grants |
| Harness warning fatigue | MEDIUM | Disable noisy evaluators; label corpus; measure precision; deduplicate; re-enable by confidence tier |
| Conversation-owned project state | HIGH | Extract current artifacts/decisions with review; create session checkpoints; make chats read-only historical evidence |
| Whole-project inference costs | MEDIUM | Add call ledger/caps; disable background calls; introduce invalidation graph, caching and explicit checkpoints |
| Preview-only generated projects | HIGH | Publish readiness profiles; add portable export; build observe/change/rollback loop before expanding templates |
| Marketplace trust failure | HIGH | Quarantine/revoke package; disclose scope; rotate exposed secrets; add signed provenance and capability review |
| Monetization compromises routing trust | HIGH | Separate sponsored inventory; publish ranking logic; add neutral default/receipts; audit historical routes |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase / Spike | Verification |
|---------|--------------------------|--------------|
| Observability mistaken for control | Agent Contract + Effect Boundary | Malicious fake agent cannot escape promised controls; unsupported guarantees are visible |
| Third opaque truth | Intent/Evidence Model | Every verdict traces to reviewed intent or reproducible implementation evidence |
| Semantic false confidence | Harness Evaluation | Known-flaw corpus reports precision/recall and never maps unknown to passed |
| Prompt questionnaire/hidden author | Guided Intent UX | Nontechnical and technical users complete benchmark tasks across three modes with fewer corrections |
| Context leakage/poisoning | Context Boundary | Cross-project canary secrets never reach unauthorized adapter; memory writes are reviewable/rollbackable |
| Conversation as database | Project/Session Domain | Fresh-session, cross-agent handoff succeeds without raw transcript |
| Permission fatigue/universal trust | Permissions UX + Policy Engine | Users can inspect/revoke resource grants; high-impact effects require correct policy under YOLO definition |
| Protocol churn | Adapter Test Kit | Two real agents + fake old/new protocol fixtures render and resume through capability negotiation |
| Token-burning background analysis | Cost/Telemetry + Incremental Analysis | No billable idle work; changed-scope cost is bounded and attributable |
| Preview without ownership | End-to-End Product Slice | Create, deploy, observe failure, modify and rollback a portable application |
| IDE parity sink | Experience Prototype | Differentiating loop validated before broad language/editor parity work |
| License/marketplace trap | Open Ecosystem Boundary | Published boundary/compatibility policy reviewed legally; project works without official marketplace |
| Free without economics | Distribution/Economics | Cohort funnel and unit economics segmented by API/BYOK/subscription/local/sponsored paths |

## Sources

Primary/current sources used for product and protocol claims:

- [ACP architecture](https://agentclientprotocol.com/get-started/architecture) — ACP assumes a trusted agent and supports bidirectional permission requests. **MEDIUM confidence** (official protocol documentation via verified search).
- [Zed external agents](https://zed.dev/docs/ai/external-agents) — external agents own runtime/auth/config; permission behavior can differ. **MEDIUM confidence**.
- [Zed agent sandboxing](https://zed.dev/docs/ai/sandboxing) — sandbox coverage excludes External Agents and Terminal Threads. **MEDIUM confidence**.
- [Zed agent server extensions](https://zed.dev/docs/extensions/agent-servers) — extension-provided ACP agents were deprecated in favor of the registry. **MEDIUM confidence**.
- [MCP authorization specification](https://modelcontextprotocol.io/specification/draft/basic/authorization) — audience validation and confused-deputy/token-passthrough risks. **MEDIUM confidence**.
- [VS Code Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust) — untrusted code can trigger execution through agents, tasks, terminals, settings and extensions; restricted mode limits them. **MEDIUM confidence**.
- [VS Code extension runtime security](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security) — publisher trust, signing, scanning and blocklist controls. **MEDIUM confidence**.
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security) and [process sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox/) — renderer isolation, sandbox and minimal privilege guidance. **MEDIUM confidence**.
- [GitHub Copilot cloud-agent risks and mitigations](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations) — prompt injection, constrained branches/credentials, firewalls and human merge review. **MEDIUM confidence**.
- [GitHub Copilot cloud-agent limitations](https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/about-assigning-tasks-to-copilot) — one-repository/one-branch constraints and policy compatibility limitations. **MEDIUM confidence**.
- [OWASP AI Agent Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html) and [Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) — tool misuse, memory poisoning, exfiltration, denial-of-wallet and excessive autonomy. **MEDIUM confidence**.
- [OpenRouter FAQ](https://openrouter.ai/docs/faq), [BYOK](https://openrouter.ai/docs/guides/overview/auth/byok) and [Terms](https://openrouter.ai/terms) — current credit/BYOK fee mechanics and credit restrictions. **MEDIUM confidence**.
- [Code-OSS versus Visual Studio Code](https://github.com/microsoft/vscode/wiki/Differences-between-the-repository-and-Visual-Studio-Code/5ce92cf9dfd4c58da1d43b3d389ebbdc2bd79885) — open repository, official distribution and Marketplace are distinct boundaries. **MEDIUM confidence**.
- [METR developer productivity RCT](https://metr.org/Early_2025_AI_Experienced_OS_Devs_Study-paper.pdf) — in one narrow cohort/context, experienced maintainers were slower despite believing AI sped them up; supports measuring outcomes rather than perceived speed, not a universal productivity claim. **MEDIUM confidence**.

## Research Gaps / Required Phase Research

- The default harness policy needs its own design discussion after these boundary findings and before requirements/roadmap freeze. Specifically decide evaluator composition, enforcement vocabulary, mode thresholds and evidence contract.
- ACP capability/version lifecycle and ACPX stability should be validated against pinned implementations in a code spike, not documentation alone.
- Cross-platform process/network sandbox guarantees need OS-specific testing (Linux, macOS, Windows) before selecting a desktop framework.
- Semantic reconciliation accuracy has no accepted industry benchmark; the project must create its own labeled fixture corpus and user-reviewed ground truth.
- “1% of inference” and a secondary capacity market require separate technical, contractual, regulatory and unit-economic feasibility work.
- License choice requires dependency inventory, fork-threat analysis and legal advice; this research only establishes the boundary risks.
- Distribution assumptions need interviews and instrumented usage with nontechnical builders; competitor feature lists cannot validate durable retention.

---
*Pitfalls research for: AI-Native IDE*
*Researched: 2026-08-22*
