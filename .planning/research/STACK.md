# Stack Research

**Domain:** Desktop AI-native IDE for long-lived, multi-repository software creation
**Researched:** 2026-08-22
**Confidence:** MEDIUM (primary documentation and live registries verified; desktop shell, sandbox and plugin ABI still require spikes)

## Recommendation in One Sentence

Build a **thin Tauri 2 desktop shell with a React/Monaco interface over a separately testable Rust core/daemon**, persist local project metadata as SQLite plus editable/versionable files, and integrate established protocols at distinct boundaries: ACP for agents, MCP for tools/context, LSP for language intelligence, and PTYs for terminals.

This stack supports a new IDE primitive rather than a chat wrapper. Intent, specifications, code, sessions, evidence, resources, agents and permissions should be first-class domain objects in the Rust core; Monaco and conversation views are merely projections over that shared state.

## Recommended Stack

### Core Technologies

| Technology | Verified version | Purpose | Why Recommended | Confidence |
|------------|------------------|---------|-----------------|------------|
| Rust | 1.97.1 stable | Local runtime, filesystem/process control, protocol clients, indexers and policy enforcement | Strong fit for a long-lived desktop daemon that supervises untrusted subprocesses and must remain responsive under concurrent agent/terminal/indexing work | MEDIUM |
| Tauri | 2.11.5 | Desktop shell, native packaging, capability-scoped frontend IPC and updater integration | Keeps the UI web-native while putting privileged operations in Rust; substantially smaller architectural surface than forking Code-OSS | MEDIUM; spike required |
| React | 19.2.8 | Progressive-disclosure desktop UI | Mature ecosystem for complex stateful workbenches, accessibility and virtualization; recruitable and compatible with Monaco | MEDIUM |
| TypeScript | 7.0.2 | UI and extension-facing type system | Protocol-heavy UI benefits from generated discriminated unions and exhaustive event handling | MEDIUM; ecosystem compatibility must be pinned in lockfile |
| Vite | 8.2.2 | Frontend build/dev server | Fast ESM development and straightforward Tauri integration | MEDIUM |
| Monaco Editor | 0.56.0 | Code, Markdown and diff editor surfaces | MIT-licensed editor extracted from VS Code, with models, decorations, completion APIs and diffs; supports progressive descent into real artifacts | MEDIUM; WebView spike required |
| SQLite | 3.53.4 current upstream; use `rusqlite` 0.40.2 with bundled SQLite | Local application/project graph, event journal, indexes, FTS and migrations | Durable, transactional, inspectable and deployless. Normalized node/edge tables model shared resources without introducing an operational graph database | MEDIUM |
| Tokio | 1.53.1 | Async runtime for daemon/process/protocol workloads | Standard Rust runtime underneath Tauri ecosystem, ACP/MCP transports and concurrent subprocess supervision | MEDIUM |

### Local Runtime Boundary

Do not place the entire product in Tauri command handlers. Organize a Cargo workspace with these boundaries:

| Crate/process | Responsibility | Initial deployment |
|---------------|----------------|--------------------|
| `ide-domain` | Typed IDs, project/resource/session/intent/evidence graph, reconciliation contracts | Pure Rust library |
| `ide-store` | SQLite transactions, migrations, file-backed documents, search indexes | Pure Rust library |
| `ide-runtime` | Process supervision, PTYs, filesystem watching, Git, policy/capability broker | Pure Rust library |
| `ide-protocols` | ACP, MCP, LSP, CLI and raw-model adapters behind internal traits | Pure Rust library |
| `ide-daemon` | Owns mutable state and background jobs; exposes a versioned local API | Supervised child process or sidecar |
| `ide-desktop` | Tauri lifecycle, windows, menus, updater and narrow IPC bridge | Desktop executable |
| `ide-ui` | React workbench and projections | Tauri WebView |

Start with the daemon API on an inherited pipe or OS-local socket, authenticated by a per-launch secret. Use framed JSON/JSON-RPC with generated schemas for the first milestone; its observability is more valuable than premature binary RPC. Keep the domain service callable in-process in tests. A separate daemon becomes mandatory before long-running/background sessions or crash recovery ship, but the first vertical prototype may host the same service in the Tauri process.

### Editor, Language and Terminal

| Library/protocol | Verified version | Purpose | When to Use |
|------------------|------------------|---------|-------------|
| `monaco-editor` | 0.56.0 | Text models, diffs, decorations, inline prompt/intention suggestions | All code and editable Markdown surfaces; consume the ESM build because AMD is deprecated |
| LSP | Specification 3.18 | Diagnostics, completion, navigation, symbols and edits | Launch each language server out of process and translate its workspace edits into the IDE change/evidence pipeline |
| Tree-sitter | 0.26.12 Rust binding | Fast incremental syntax trees, structural chunks and changed-region analysis | Indexing and harness evidence where LSP is absent or too expensive; not a semantic type checker |
| `@xterm/xterm` | 6.0.0 | Terminal renderer | Render supervised PTY sessions; never treat terminal text scraping as the agent protocol |
| `portable-pty` | 0.9.0 | Cross-platform PTY creation/control | Interactive shells and CLIs that truly require terminal behavior |
| `notify` | Pin during implementation | Cross-platform filesystem watching | Detect external edits and schedule debounced reconciliation/index work; watchers are hints, periodic rescan remains authoritative |

Monaco is an editor component, **not a VS Code extension host**. Plan LSP support explicitly. Do not promise VS Code extension compatibility without implementing or adopting a compatible extension host—an independent, multi-phase product in itself.

### Project Graph and Storage

Use two synchronized persistence planes, because neither alone meets the product promise:

1. **Portable, human-editable project artifacts:** a small project manifest plus Markdown/spec/decision artifacts stored as normal files. These can be versioned, edited outside the IDE and read by any agent.
2. **Local transactional index:** SQLite stores project membership, resource aliases, nodes/edges, session events, evidence links, file fingerprints, diagnostics, job state and FTS5 indexes.

Recommended SQLite primitives:

| Primitive | Use |
|-----------|-----|
| Normalized `nodes`, `edges`, `project_resources` tables | Semantic projects and resources shared by multiple projects |
| WAL mode | Concurrent UI reads and daemon writes; still serialize schema/index writers |
| FTS5 | Exact/lexical search over docs, symbols, decisions and session summaries |
| JSON columns | Provider-specific metadata only; do not hide all domain state in opaque JSON blobs |
| Append-only event journal plus materialized tables | Crash recovery, audit and reproducible session timelines—not append-only user documents |
| Content hashes and filesystem identity | Reconcile moves/external edits without assuming paths are stable identities |

Do **not** make a graph database or vector database an MVP dependency. SQLite edges answer initial graph traversals; FTS5 plus structural indexing establishes a measurable baseline. Add embeddings only when an evaluation corpus demonstrates retrieval failures, initially as a replaceable index derived from canonical files/database rows.

### Agent and Model Integration

| Protocol/library | Verified status/version | Boundary | Recommendation |
|------------------|-------------------------|----------|----------------|
| ACP | Official protocol; `agent-client-protocol` crate 2.0.0, Tokio companion 0.11.1 at research time | IDE client ↔ complete coding agent | Preferred structured integration. Wrap behind an internal `AgentAdapter` and capability snapshot because SDK/protocol work is active |
| MCP | Specification 2026-07-28; official Rust `rmcp` 3.1.4 | Agent/model ↔ tools, resources and context | Host IDE project/harness capabilities as MCP servers where useful; do not use MCP as a substitute for ACP sessions |
| LSP | 3.18 | IDE ↔ language server | Reuse language ecosystems rather than asking an LLM to rediscover compiler facts |
| CLI adapter | Internal versioned adapter | IDE ↔ agent without ACP | Use structured output/event hooks where vendors expose them; PTY scraping is last-resort compatibility with explicit degradation |
| Raw model provider adapter | Internal interface | Harness/autocomplete ↔ model API/local model/gateway | Separate model inference from agent sessions. Record provider/model/cost/latency provenance without forcing all agents through it |

The internal adapter must express capabilities rather than a lowest-common-denominator chat API: session load/resume/fork, filesystem edits, tool calls, terminal, images, plans, permission requests, model switching, usage accounting and cancellation. Unknown capabilities degrade visibly.

### Sandbox and Permission Enforcement

`portable-pty`, Tauri capabilities and ACP permission messages are **not process sandboxes**. Build a capability broker in `ide-runtime` that authorizes filesystem roots, commands, environment variables, network, credentials and deployment separately, then delegates execution to an OS isolation backend.

The cross-platform backend is a mandatory spike:

| Platform | Candidate backend to validate | Notes |
|----------|-------------------------------|-------|
| Linux | bubblewrap/user namespaces plus Landlock/seccomp where available | Strongest practical local prototype; distro/kernel differences matter |
| macOS | sandbox-exec/Seatbelt profile or a helper using platform sandbox facilities | Public/stable API constraints and notarization require validation |
| Windows | restricted token + Job Object/AppContainer or isolated worker VM/container | Process tree termination and filesystem/network policy need native work |

Provide explicit `observe`, `ask`, `allow-scoped` and `unrestricted/YOLO` policies per project/resource. Containers/devcontainers are optional execution backends, not the default abstraction and not a substitute for host protection.

### Extensibility

Use separate extension planes rather than one omnipotent plugin API:

| Plane | Technology | Initial scope |
|-------|------------|---------------|
| Agents | ACP registry/adapters | Complete external agents with their own auth/runtime |
| Tools and context | MCP | User/community tools, resources and prompts |
| Language intelligence | LSP + Tree-sitter grammars | Existing language servers and parsers |
| Harness packs | Declarative, signed manifest + schemas/rules/prompts/evaluators | Domain guidance and checks with no arbitrary native code by default |
| UI extensions | Sandboxed WebView/iframe message API | Defer until core workbench stabilizes |
| Portable executable plugins | WASI Component Model via Wasmtime 48.0.0 | Spike after MVP; capability-based WIT interface and strict fuel/memory/time limits |

Wasmtime is the preferred future executable-plugin experiment because it supplies WASI, Component Model embedding and resource controls. Its Component Model is not fully standardized, so do not make it the first harness format or promise a stable public ABI yet. Tauri plugins are trusted native application plugins; they are not an untrusted marketplace sandbox.

### Updates and Distribution

| Technology | Purpose | Recommendation |
|------------|---------|----------------|
| Tauri bundler | `.dmg`/app, MSI/NSIS, AppImage/deb/rpm production artifacts | Produce per-OS artifacts in native runners |
| Tauri updater plugin | Signed update metadata/artifacts | Use pinned updater plugin line (2.10.1 verified), HTTPS endpoint, signature verification and staged channels |
| Platform signing | User trust and OS acceptance | Apple Developer ID + notarization; Windows Authenticode; sign Linux repository metadata/artifacts as applicable |
| GitHub Actions or equivalent | Matrix build, SBOM, provenance and release | Never cross-compile and declare success without smoke tests on each target OS |

The updater signature does not replace platform signing. Design rollback, channels (`stable`, `preview`) and database migration compatibility before automatic updates are enabled.

### Testing

| Tool | Verified version | Coverage |
|------|------------------|----------|
| Rust built-in tests + property tests (`proptest`) | Pin at implementation | Domain invariants, graph reconciliation, parsers, permission policies |
| `cargo-nextest` | Pin in CI | Parallel Rust suite and retries/reporting |
| Vitest | 4.1.11 | React components, state projections and IPC client contracts |
| Playwright | 1.62.1 | Renderer-only flows, generated application previews and browser automation used by the harness |
| WebdriverIO + Tauri service | Pin together when scaffolded | Packaged desktop E2E on Windows, Linux and macOS; official Tauri recommendation |
| Protocol golden fixtures | Repository-owned | ACP/MCP/LSP transcripts, capability negotiation, cancellation, malformed events and forward compatibility |
| Fake agent/model/language servers | Repository-owned | Deterministic end-to-end tests without spending tokens or depending on vendor availability |

Add crash/restart and adversarial tests early: daemon killed mid-edit, duplicate/out-of-order events, repo moved, symlink escape, huge output, prompt cancellation, agent ignores cancellation, malicious ANSI/Markdown, and database migration rollback.

## Installation Sketch

Exact manifests should be produced only after the shell and protocol spikes. A representative starting point is:

```bash
# Frontend
pnpm add react@19.2.8 react-dom@19.2.8 monaco-editor@0.56.0 @xterm/xterm@6.0.0 zustand@5.0.15
pnpm add -D typescript@7.0.2 vite@8.2.2 vitest@4.1.11 @playwright/test@1.62.1

# Rust workspace
cargo add tauri@2.11.5 tokio@1.53.1 --features full
cargo add rusqlite@0.40.2 --features bundled,functions,modern_sqlite
cargo add tree-sitter@0.26.12 portable-pty@0.9.0
cargo add agent-client-protocol@2.0.0 agent-client-protocol-tokio@0.11.1 rmcp@3.1.4
```

Treat these as verified snapshots, not ranges to copy blindly. Commit `Cargo.lock` and the frontend lockfile for the desktop application; use automated, reviewed dependency updates.

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Tauri 2 | Electron | Choose Electron if a spike proves OS WebView differences break Monaco/terminal/accessibility or if near-term VS Code extension-host reuse becomes a hard requirement; accept larger distribution/security surface |
| Tauri + Monaco | Fork Code-OSS | Only if VS Code extension compatibility and exact workbench parity become more important than defining new project/intention primitives and controlling UX |
| React | SolidJS/Svelte | Choose if the team has deep expertise and prototype benchmarks show a meaningful workbench benefit; integration ecosystem is the deciding factor, not microbenchmarks |
| SQLite relational graph | Embedded graph DB | Adopt only after real traversal workloads exceed recursive CTE/materialized-index performance and portability requirements are understood |
| Rust daemon | Node.js daemon | Reasonable for a throwaway protocol/UI prototype, but weaker as the permanent process/sandbox/indexing authority |
| Direct ACP SDK | ACPX subprocess | ACPX is useful for experiments and compatibility; keep it as a development bridge, not the sole runtime contract |
| WASI executable plugins later | Node extension host now | Node host is appropriate only if VS Code-style extension compatibility is explicitly chosen and its security/compatibility burden is funded |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Chat/session as persistence root | Recreates Antigravity's fragmentation and traps decisions in append-only histories | Semantic project/resource graph plus editable canonical artifacts |
| Monaco alone as “the IDE” | It does not provide filesystem, LSP orchestration, extension host, Git, terminal or project semantics | Monaco as one projection over the Rust domain/runtime |
| A universal `sendMessage(prompt)` adapter | Erases agent capabilities, auth, sessions, permissions and structured changes | Capability-negotiated ACP/CLI/API adapters |
| PTY scraping for compatible agents | Loses structured tool/permission/change events and is brittle across versions/locales | ACP first; vendor structured protocol second; PTY fallback labeled degraded |
| A graph database for v1 | Adds packaging, migrations and query complexity before workloads justify it | SQLite node/edge schema and derived indexes |
| Vector search as canonical memory | Embeddings are lossy, provider-dependent and difficult to reconcile | Files + relational graph as truth; embeddings as rebuildable index |
| Arbitrary native marketplace plugins | One compromised plugin owns the machine and supply chain | Declarative packs, MCP isolation and later WASI components |
| Docker as mandatory local runtime | Excludes users, adds resource cost and does not protect all host-side IDE actions | Native capability broker with optional containers |
| Cloud-only project state | Breaks free/local/model-agnostic positioning and makes repos inaccessible offline | Local-first state with optional synchronization later |

## Required Technical Spikes Before Committing the Roadmap

1. **Tauri/WebView workbench spike:** Monaco multi-model editing, large files, diff decorations, xterm throughput, drag/drop, IME, screen readers and Linux/macOS/Windows rendering. Compare the same workload in Electron. This decides the shell.
2. **ACP harness/proxy spike:** Connect at least Codex, Claude and Gemini-compatible agents; capture capability negotiation, auth, permission requests, edits, cancellation and resume. Verify what a proxy can observe/enforce versus what requires IDE-provided MCP tools or OS execution control.
3. **Project graph/reconciliation spike:** One semantic project, three repositories, one repo shared with another project, externally edited Markdown/code, and traceable intent → decision → change → test evidence in SQLite/files.
4. **Execution isolation spike:** Demonstrate scoped read/write, blocked symlink escape, environment filtering, process-tree cancellation and explicit unrestricted mode on all three desktop OSes.
5. **Plugin/harness boundary spike:** Prove a declarative harness pack first; separately prototype a tiny WIT/Wasmtime component. Do not let plugin architecture block the first end-to-end product slice.

## Version Compatibility and Upgrade Policy

| Package/protocol | Compatible with | Notes |
|------------------|-----------------|-------|
| Tauri 2.11.5 | Rust 1.97.1 and OS webviews | Verify documented MSRV during scaffold; pin CLI, JS API and Rust crate to compatible minor lines |
| Monaco 0.56.0 | Vite 8 ESM workers | Use ESM worker configuration; AMD build is deprecated |
| ACP Rust crates | ACP agents over stdio JSON-RPC | Active SDK evolution means internal adapter, golden protocol tests and exact pinning are required |
| MCP 2026-07-28 | `rmcp` 3.1.4 | Negotiate protocol version and test older servers; Rust SDK was not listed as Tier 1 for the new spec despite current support |
| Wasmtime 48.0.0 | WASI/Component Model | Public plugin ABI must be versioned independently; Component Model standardization remains incomplete |
| SQLite/rusqlite | Bundled SQLite selected by crate features | Record actual runtime `sqlite_version()` in diagnostics; upstream SQLite version and bundled crate version are not automatically identical |

## Harness Timing

The **default harness logic should be discussed immediately after ecosystem research and before requirements/roadmap are finalized**, because it determines the domain model, event/evidence schema, agent interception boundary and permission system. The stack decision here deliberately stops at enabling primitives. The next design activity should define:

- which guarantees apply in Full Vibes, Hybrid and Spec Mode;
- which observations are deterministic (compiler/LSP/tests/policy) versus model judgments;
- how findings attach to intent, code, runtime evidence and user decisions;
- what an ACP proxy can enforce, what must run through IDE-owned tools, and what remains unverifiable;
- how the harness stays model-agnostic and avoids manufacturing token-consuming problems.

## Sources

- [Tauri 2 documentation](https://v2.tauri.app/) and [Tauri updater](https://v2.tauri.app/plugin/updater/) — shell, capabilities, packaging and signed updates (MEDIUM)
- [Tauri testing](https://v2.tauri.app/develop/tests/) and [WebDriver guidance](https://v2.tauri.app/develop/tests/webdriver/) — packaged-app testing support (MEDIUM)
- [Rust release notes](https://doc.rust-lang.org/stable/releases.html) — Rust 1.97.1 (MEDIUM)
- [Monaco Editor npm package](https://www.npmjs.com/package/monaco-editor) and [official site](https://microsoft.github.io/monaco-editor/) — version, ESM/AMD status, licensing and extension limitation (MEDIUM)
- [SQLite release history](https://sqlite.org/changes.html), [WAL](https://sqlite.org/wal.html), [FTS5](https://sqlite.org/fts5.html) and [JSON](https://sqlite.org/json1.html) — local storage capabilities (MEDIUM)
- [ACP architecture](https://agentclientprotocol.com/get-started/architecture), [Rust SDK](https://agentclientprotocol.com/libraries/rust) and [registry](https://agentclientprotocol.com/get-started/registry) — agent boundary and ecosystem (MEDIUM)
- [ACP Rust SDK v1 RFD](https://agentclientprotocol.com/rfds/rust-sdk-v1) — evidence that SDK design remains in motion (MEDIUM)
- [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/) and [official Rust SDK](https://rust.sdk.modelcontextprotocol.io/) — tool/context protocol and SDK status (MEDIUM)
- [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) — specification 3.18 and language-service boundary (MEDIUM)
- [Tree-sitter documentation](https://tree-sitter.github.io/) — incremental parsing guarantees and official bindings (MEDIUM)
- [Wasmtime documentation](https://docs.wasmtime.dev/) and [proposal stability](https://docs.wasmtime.dev/stability-wasm-proposals.html) — WASI/plugin sandbox candidate and maturity caveat (MEDIUM)
- [portable-pty 0.9.0 docs](https://docs.rs/portable-pty/latest/portable_pty/) — PTY portability surface (MEDIUM)
- Live npm and crates.io registries checked 2026-08-22 for package versions listed above (MEDIUM)

---
*Stack research for: AI-Native IDE*
*Researched: 2026-08-22*
