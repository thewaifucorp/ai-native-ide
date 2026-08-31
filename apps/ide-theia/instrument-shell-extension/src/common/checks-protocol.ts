// DETERMINISTIC CHECKS (§4) — shared contract.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
// The Overview said "checks não executados" and meant it: nothing in the Theia
// shell fed the engine. The engine itself was never missing — `crates/ide-harness`
// evaluates observed facts into findings with an explicit state, evidence and
// remediation, and keeps `unknown` and `not_run` distinct from a pass. It is
// shell-neutral on purpose (it starts no process and reads no repository), so
// somebody has to gather the facts. In the Theia path that is the sidecar; this
// service is the thin, host-side route to it.
//
// ── THE RULE THIS SURFACE EXISTS TO HOLD ──────────────────────────────────
// `unknown` and `not_run` NEVER read as approval. They are not "almost passed"
// and they are not failures either — they are absences of knowledge, and each
// one carries the reason it is absent. A panel that renders them as a neutral
// grey tick would undo the whole point of the engine.
//
// ── WHY THE COMMANDS ARE DECLARED, NOT DETECTED ───────────────────────────
// Build/test/typecheck come from `.instrument/checks.json`. Detecting a
// project's stack and commands WITH PROVENANCE is §5's job; guessing them here
// would duplicate it worse, and would have the IDE run something nobody wrote
// down. When §5 lands it proposes candidates into that same file, reviewable.
//
// ── AND WHY RUNNING IS EXPLICIT ───────────────────────────────────────────
// `runTools` defaults to false. Refreshing a panel must never execute a command
// that arrived with the repository. It is not new authority — the IDE already
// hosts terminals and an agent — but it stays a deliberate, per-call act.

import { HarnessRun } from 'engine-extension';

/** JSON-RPC path the checks service is exposed on. */
export const CHECKS_SERVICE_PATH = '/services/checks';

/** DI symbol; merges with the interface below so the name serves as both. */
export const ChecksService = Symbol('ChecksService');

export interface ChecksService {
    /**
     * Runs the deterministic Layer-0 checks over the project.
     *
     * @param runTools when true, also executes the commands declared in
     * `.instrument/checks.json`. Defaults to false — see the note above.
     */
    run(rootUri: string, runTools?: boolean): Promise<HarnessRun>;
}
