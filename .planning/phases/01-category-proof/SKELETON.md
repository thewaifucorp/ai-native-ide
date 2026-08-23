# Walking Skeleton — AI-Native IDE

**Phase:** 1
**Generated:** 2026-08-22

## Capability Proven End-to-End

A nontechnical builder can describe a sealed-bid leaderboard, accept guided clarification, let one honest agent change real files through a scoped effect, inspect the running result and causal evidence, reconcile one intent divergence, and receive Game Mode progress only for a verified outcome.

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Desktop host | Evidence-selected winner of an identical Tauri 2 / Electron comparison; recorded in `docs/decisions/0001-desktop-shell.md` before `apps/desktop` is created | The host is an empirical Phase 1 gate. Candidate-specific code stays disposable and cannot enter shared contracts. |
| Desktop extension ownership | Winner-neutral contracts live in `packages/contracts/src/desktop-extension.ts`; `apps/desktop/host.config.json` records the exact selected native owners. Tauri materializes `src-tauri/{Cargo.toml,tauri.conf.json,src/main.rs,src/lib.rs,src/commands.rs}`; Electron materializes `electron/{package.json,main.ts,preload.ts,supervisor.ts}`; only the winner exists. | Later project, PTY, agent, effect, and preview work extends concrete selected-host owners while one conformance suite proves either route. |
| Renderer | React 19 + TypeScript + Vite, behind an `IdeHost` port | One shell-neutral Instrument UI can run in both candidates and in browser tests. |
| Privileged core | Rust workspace with narrow Serde DTOs; in-process for Tauri or the explicit `ide-daemon` binary for Electron | Files, PTY, preview, policy, and process ownership remain outside the untrusted renderer while preserving a Rust-oriented core. |
| Editor and terminal | Monaco models keyed by resource identity; xterm rendering a Rust-owned real PTY | Technical depth remains directly reachable without giving browser UI filesystem or process authority. |
| Data layer | SQLite via `rusqlite`, WAL where appropriate, explicit transactions | Local zero-service persistence supports the project/activity ledger and a real concurrent sealed-bid proof. |
| Project truth | Editable project manifest and files are authoritative; activity/evidence ledger explains causation | Neither chat nor AAG owns the project. |
| Agent boundary | Capability-declared adapter contract with ACP and CLI/PTTY conformance probes; one observed path drives the journey | Native authentication and unsupported controls remain honest instead of being normalized away. |
| AAG | Optional external `GraphEvidenceProvider` returning evidence or typed `unknown` | Structural evidence can degrade without blocking project use or becoming a source of truth. |
| Auth | Adapter-owned local authentication; no IDE credential persistence in this phase | The proof preserves native agent auth and avoids inventing an account system. |
| Deployment target | Reproducible Linux desktop dev/package command plus supervised local benchmark preview | Phase 1 validates a desktop product and executable output without requiring a cloud account. |
| Benchmark transaction route | TypeScript `/api/bids` server supervises the explicit `benchmark-domain` Rust binary; the server contains no winner logic | The concurrency and secrecy invariant has one executable implementation and a verifiable process boundary. |
| Typography assets | Official local Geologica and DM Mono files plus `apps/renderer/src/assets/fonts/LICENSES.md` | The Instrument UI works offline while retaining redistribution licenses and exact attribution. |
| Directory layout | `apps/{renderer,desktop,benchmark}`, `crates/{ide-core,ide-daemon,pty-runtime,preview-supervisor,benchmark-domain}`, `packages/{contracts,projections,adapter-contract}`, `fixtures`, `tests`, `spikes`, `docs/decisions` | Product-neutral contracts, privileged authority, fixtures, and disposable host experiments remain visibly separated. |

## Stack Touched in Phase 1

- [ ] Project scaffold with `rtk npm run build`, `rtk npm run lint`, `rtk npm test`, contract, Cargo integration, and Playwright journey commands backed by checked-in configuration
- [ ] One real semantic-project route from intent to persisted project state
- [ ] SQLite read/write for project/activity state and atomic benchmark bids
- [ ] Interactive Instrument UI wired through the selected typed desktop bridge
- [ ] Documented local full-stack run and Linux package command

## Out of Scope (Deferred to Later Slices)

- Production multi-repository graph and durable cross-session resource reuse
- Complete workspace, adapter matrix, mode semantics, harness packs, and readiness system
- Marketplace, cloud progression, organization connectors, inference economics, and Katsui Company Brain
- Publishing, production observability, multiplayer, and portfolio management

## Subsequent Slice Plan

- Phase 2: make semantic projects, resources, editable truths, and decisions durable across sessions and external changes.
- Phase 3: provide the complete controlled workspace and neutral agent/model adapter surface.
- Phase 4: reconcile intent and implementation across Full Vibes, Spec, and Hybrid.
- Phase 5: expand evidence, graph navigation, semantic evaluators, packs, and readiness.
- Phase 6: publish, reopen, repair, and republish a portable product.
