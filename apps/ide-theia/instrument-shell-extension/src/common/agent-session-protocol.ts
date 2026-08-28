// AGENT SESSION — the pre-disk path (the third write path, closed).
//
// The observer covers writes that already happened. This covers the agent the IDE
// hosts itself: it runs the real ACP session (ide-agent → the direct-ACP adapter
// → the agent bridge), and the agent's changes are proposed through the broker
// BEFORE they touch the project. That is what Cursor/Copilot get from writing through the editor's edit
// API instead of the filesystem, and what an external CLI agent cannot give us.
//
// ── HOW THE PRE-DISK GUARANTEE IS OBTAINED ────────────────────────────────
// `ide_agent`'s `Diff` event carries the path and line counts but not the bytes,
// so the IDE cannot reconstruct a proposal from events alone. Instead the session
// runs with its workspace root pointed at a real git WORKTREE of the project:
// the agent writes freely there — it is not the project — and `harvest` compares
// worktree against project and proposes each changed file through the governed
// broker. Nothing reaches the project without a decision.
//
// ── O QUE O ISOLAMENTO NÃO É ──────────────────────────────────────────────
// A worktree NÃO é jaula, e o adapter direto de ACP não mudou isso: ele também
// declara `policy_coverage.sandbox = None`. O `cwd` do `session/new` é dica, e
// foi MEDIDO que os bridges escrevem com ferramenta nativa, não pelo
// `fs/write_text_file` do cliente — então nada impede escrita fora da raiz por
// caminho absoluto. A worktree evita escrita ACIDENTAL no projeto; não evita
// deliberada. Quem cobre esse caso é o OBSERVADOR mais o broker.
//
// ── O QUE O ADAPTER DIRETO MUDOU ──────────────────────────────────────────
// A permissão. Antes, o `acpx` respondia `session/request_permission` sozinho e
// o IDE só recebia o aviso do que já tinha sido decidido (`approvals =
// HarnessOwned`). Agora o sidecar É o cliente ACP: o pedido PARA aqui e o agente
// fica bloqueado até `respondPermission` responder. Sem resposta, o pedido morre
// no timeout da própria tarefa — e timeout conta como negação, nunca aprovação.
//
// Isso vale para os agentes que PERGUNTAM. Foi medido: o `claude-agent-acp`
// pergunta antes de editar; `codex-acp` e `opencode` resolvem internamente e não
// perguntam. O `descriptor()` do adapter declara isso por bridge, e a UI mostra
// a declaração em vez de prometer um portão que aquele agente não usa.
//
// Consequences, stated rather than hidden:
//  • the project must be a git repository (otherwise the session is refused);
//  • the broker's approval is positional, so proposals are made ONE AT A TIME;
//    `harvest` reports how many changes are still queued behind the current one;
//  • the agent sees the project as of the worktree's commit, not uncommitted
//    working-tree edits.
//
// ── O QUE `harvest` COBRE, E O QUE NÃO ────────────────────────────────────
// A comparação é de TRÊS lados: a baseline de que a worktree nasceu, a worktree
// agora e o projeto agora. Sem a baseline, `harvest` só sabia comparar worktree
// com projeto — então o que a PESSOA editou depois aparecia como mudança do
// agente, e aprovar revertia o trabalho dela. Com ela:
//  • worktree ≠ baseline  → ato do agente, proposto pelo broker;
//  • projeto ≠ baseline e worktree = baseline → ato da pessoa, ignorado;
//  • os dois mudaram → CONFLITO: reportado, nunca proposto;
//  • a baseline tinha e a worktree não → EXCLUSÃO: reportada, nunca proposta,
//    porque o broker não tem efeito de exclusão (logo não há snapshot nem
//    rollback para ela). Propor um arquivo vazio no lugar seria escrever mentira.
//
// COMANDO NÃO É COBERTO PELO BROKER. O que o agente roda passa só pelo portão de
// permissão (e só nos bridges que perguntam): não deixa recibo no broker, não tem
// snapshot e não tem rollback. Efeito de comando fora de arquivo colhido está
// fora do caminho governado, e a tela diz isso em vez de sugerir o contrário.
//
// Binário, arquivo acima de 512 KiB e link simbólico não são comparados. Eles
// entram em `skipped` com o motivo: "não comparado" é um fato que o usuário
// precisa ver, não um silêncio.

import { AgentEvent } from 'engine-extension';

/** JSON-RPC path the agent session service is exposed on. */
export const AGENT_SESSION_SERVICE_PATH = '/services/agent-session';

/** DI symbol; merges with the interface below so the name serves as both. */
export const AgentSessionService = Symbol('AgentSessionService');

export type SessionPhase = 'none' | 'starting' | 'idle' | 'working' | 'failed';

/** One event, flattened for rendering. */
export interface SessionEventView {
    at: string;
    kind: string;
    text: string;
}

/**
 * A permission the agent asked for and that nothing has answered yet.
 *
 * The agent's turn is BLOCKED while this is pending. It is the one snapshot
 * field that represents an open question rather than a record of the past.
 */
export interface PendingPermission {
    /** Handle that answers it; unique within the session. */
    requestId: number;
    /**
     * The edits this request would perform, so the decision is taken over the
     * bytes and not over a description of them. Empty when the agent reported
     * none — a command or a network call has nothing to preview.
     */
    edits: PermissionEditView[];
    /** Action class, e.g. `write-file`, `run-command`, `network`, `use-tool`. */
    action: string;
    /** Human-readable target — tool title plus the paths it would touch. */
    detail: string;
    /** When the IDE saw the request. */
    at: string;
}

/** One proposed edit, ready to render as a diff. */
export interface PermissionEditView {
    /** Relative to the root when inside it; ABSOLUTE when the edit aims out. */
    path: string;
    /** Previous content when reported. `undefined` is "not reported", which is
     *  NOT the same as "new file", and must not be rendered as if it were. */
    oldText?: string;
    newText: string;
    /** The preview was shortened; say so wherever it is shown. */
    truncated: boolean;
}

/** What the agent did to the file, relative to the worktree's BASELINE. */
export type HarvestKind = 'create' | 'modify' | 'delete';

/** A change the agent made inside the worktree, not yet in the project. */
export interface HarvestedChange {
    relPath: string;
    /**
     * Which act this is. `delete` exists because comparing only the files the
     * worktree still has makes a deletion invisible, and an invisible write is
     * exactly what this panel must never produce.
     */
    kind: HarvestKind;
    addedLines: number;
    removedLines: number;
    /** True when this one was proposed to the broker in this harvest. */
    proposed: boolean;
    /** Proposal id, when it was the one proposed. */
    proposalId?: string;
    /** Why it was not proposed (another decision is pending, unreadable, …). */
    detail?: string;
    /**
     * The PERSON also changed this file in the project since the baseline. The
     * broker's write replaces bytes, so proposing this one would silently discard
     * their work — it is reported and NOT proposed.
     */
    conflict?: boolean;
}

/** A file the comparison did not read, and why. Never dropped in silence. */
export interface SkippedFile {
    relPath: string;
    /** `binário`, `grande demais (…)`, `ilegível: …`, `link simbólico`. */
    reason: string;
}

/**
 * What the worktree was made from — the third side of the comparison.
 *
 * Without it `harvest` can only compare worktree bytes against project bytes,
 * which reports the PERSON's later edits as the agent's, and offers to revert
 * them. With it, "the agent changed this" and "you changed this" are different
 * facts.
 */
export interface WorktreeBaseline {
    /** When the baseline was taken (ISO). */
    at: string;
    /** `git rev-parse HEAD` at that moment, when the project is a repository. */
    commit?: string;
    /** How many files it recorded. */
    files: number;
    /** True when this session adopted a worktree an earlier session left behind. */
    reused: boolean;
    /**
     * True when the baseline had to be reconstructed from the project because the
     * worktree existed without one. Everything the agent did BEFORE that moment
     * is indistinguishable from what the person did, and the UI must say so.
     */
    recovered?: boolean;
}

/** §10 — spend, as the ADAPTER reported it. */
export interface SessionUsage {
    inputTokens: number;
    outputTokens: number;
    /**
     * False when the adapter does not report usage at all. Without this, a zero
     * would read as "cheap" when it means "not measured" — the same lie in a
     * different currency.
     */
    reported: boolean;
}

/** §10 — what a swap moved and what it could not. */
export interface SwapOutcome {
    from: string;
    to: string;
    /** True only when the target reattached the original session. */
    resumed: boolean;
    preserved: string[];
    dropped: string[];
    at: string;
}

export interface AgentSessionSnapshot {
    agent: string;
    phase: SessionPhase;
    sessionId?: string;
    /** Where the agent is actually working — a worktree, never the project. */
    worktree?: string;
    events: SessionEventView[];
    /** Last honest failure reason (missing bridge, no git, adapter down). */
    lastError?: string;
    /** Changes seen in the worktree at the last harvest. */
    changes: HarvestedChange[];
    /** Files the last harvest could not compare, with the reason for each. */
    skipped: SkippedFile[];
    /** What the worktree was made from, when there is a worktree. */
    baseline?: WorktreeBaseline;
    /** Permissions awaiting a decision. Non-empty means the agent is blocked. */
    pending: PendingPermission[];
    /** Spend so far, when the adapter reports it (§10). */
    usage?: SessionUsage;
    /** The last adapter swap, kept so the loss it declared stays on screen (§10). */
    lastSwap?: SwapOutcome;
}

export interface AgentSessionService {
    snapshot(rootUri: string): Promise<AgentSessionSnapshot>;

    /** Prepare the worktree and open a real ACP session against it. */
    start(rootUri: string, agent: string): Promise<AgentSessionSnapshot>;

    /** Send a prompt. `codeChange` tells the adapter to expect file edits. */
    submit(rootUri: string, prompt: string, codeChange: boolean): Promise<AgentSessionSnapshot>;

    /** Drain pending events into the snapshot. */
    poll(rootUri: string): Promise<AgentSessionSnapshot>;

    /**
     * Compare the worktree with the project and propose the first pending change
     * through the broker. Returns the full change list so the UI can show what is
     * still queued.
     */
    harvest(rootUri: string): Promise<AgentSessionSnapshot>;

    /**
     * Answer a pending permission. `allow: false` denies; `denyEndsTurn` (the
     * default) also ends the agent's turn, so a refused write cannot be retried
     * through another ungated tool in the same turn.
     */
    respondPermission(
        rootUri: string,
        requestId: number,
        allow: boolean,
        denyEndsTurn?: boolean
    ): Promise<AgentSessionSnapshot>;

    /** End the session. The worktree is left in place for inspection. */
    cancel(rootUri: string): Promise<AgentSessionSnapshot>;

    /**
     * Throw the worktree and its baseline away.
     *
     * `cancel` deliberately keeps the worktree so unharvested work can still be
     * inspected — but keeping it forever is its own defect: the next session
     * inherits the leftovers and keeps looking at the project as of an old commit.
     * Discarding is therefore an explicit act, with a real loss to state: anything
     * the agent wrote and nobody harvested is gone.
     */
    discard(rootUri: string): Promise<AgentSessionSnapshot>;

    /**
     * §10 — hand the live session to another adapter.
     *
     * The engine decides what survives: reattaching on the same adapter keeps the
     * conversation; anything else starts fresh, because harness-owned context is
     * not portable across backends. Either way the outcome is REPORTED, and the
     * project is untouched — a swap never writes, so it cannot bypass the broker.
     */
    swap(rootUri: string, toAgent: string): Promise<AgentSessionSnapshot>;
}
