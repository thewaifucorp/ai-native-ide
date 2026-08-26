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
    /** Action class, e.g. `write-file`, `run-command`, `network`, `use-tool`. */
    action: string;
    /** Human-readable target — tool title plus the paths it would touch. */
    detail: string;
    /** When the IDE saw the request. */
    at: string;
}

/** A change the agent made inside the worktree, not yet in the project. */
export interface HarvestedChange {
    relPath: string;
    addedLines: number;
    removedLines: number;
    /** True when this one was proposed to the broker in this harvest. */
    proposed: boolean;
    /** Proposal id, when it was the one proposed. */
    proposalId?: string;
    /** Why it was not proposed (another decision is pending, unreadable, …). */
    detail?: string;
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
    /** Permissions awaiting a decision. Non-empty means the agent is blocked. */
    pending: PendingPermission[];
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
}
