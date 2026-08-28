// Shared contract for the GOVERNED WRITE loop (the product thesis, made real on
// real files). The frontend proposes a write over a real workspace file; the
// backend computes the diff via the Rust `ide-diff` sidecar and queues the effect
// in the real broker, but nothing is written until `approve`. `rollback` restores
// the broker's snapshot.
//
// GOVERNANCE IS REAL (M4, see governed-write-service.ts): the awaiting-approval
// gate, the write, and the snapshot/restore all live in Rust — `ide-domain`'s
// `WorkspaceEffectBroker` (capability registry + SqliteApprovalGate + snapshot
// store), reached through the engine sidecar. The Node service is a thin adapter:
// it reads the pre-image for the diff preview and maps this protocol onto the
// broker's propose → approve → propose-executes → rollback lifecycle.

import { BrokerActivity } from 'engine-extension';

/** JSON-RPC path the governed-write backend service is exposed on. */
export const GOVERNED_SERVICE_PATH = '/services/governed-write';

/** DI symbol; merges with the interface below so the name serves as both. */
export const GovernedWriteService = Symbol('GovernedWriteService');

/** One diff line for the dock preview. Mirrors `ide_diff` line tags. */
export interface DiffLinePreview {
    tag: 'context' | 'added' | 'removed';
    text: string;
}

/** Lifecycle of a single governed write. */
export type WriteState = 'awaiting' | 'approved' | 'rolledback';

/** An awaiting-approval (or resolved) governed write over a real workspace file. */
export interface WriteProposal {
    /** Server-assigned id used to approve / rollback this exact proposal. */
    id: string;
    /** Path relative to the workspace root (what the user sees). */
    relPath: string;
    /** Lines the write would add / remove, per the real `ide-diff` engine. */
    addedLines: number;
    removedLines: number;
    /** Number of hunks the real engine computed. */
    hunkCount: number;
    /** Where in the lifecycle this proposal currently is. */
    state: WriteState;
    /** A capped slice of the real diff, for the dock decision card. */
    preview: DiffLinePreview[];
    /**
     * True when the file does not exist yet and this write would create it.
     *
     * The card has to be able to say "criar" instead of "gravar": a diff that is
     * all-added over an empty pre-image looks identical to a rewrite that deleted
     * everything, and those are different decisions. Rollback of a creation
     * REMOVES the file (the broker snapshots "did not exist").
     */
    creating?: boolean;
    /**
     * Set when the adapter had to recover from a governance anomaly while
     * producing this proposal. Shown to the user verbatim — a recovered anomaly
     * is still an anomaly, and hiding it would be the whole problem again.
     */
    warning?: string;
    /**
     * §14 — WHO decided this proposal's fate: the project's mode and effective
     * permission, from `ide-modes` over `.instrument/config.json`.
     *
     * It is on every proposal, including the ones that stop for approval, so the
     * card can name the rule in force instead of leaving "Permitir" looking like
     * a constant of the universe. Absent only when the policy engine could not be
     * reached — and then the proposal awaits approval, which is the safe side.
     */
    policy?: EffectPolicy;
}

/** The mode/permission rule that decided one effect, as the card shows it. */
export interface EffectPolicy {
    /** `full_vibes` | `hybrid` | `spec`. */
    mode: string;
    /** Effective permission for this file, scoped override included. */
    permissions: string;
    /** True when a scoped override, not the project-wide value, decided. */
    scoped: boolean;
    /** `require_approval` | `auto_approve_recorded`. */
    decision: string;
    /** What the mode asks around the effect (checkpoint, contract, hypothesis). */
    interruption: string;
    /** Plain sentence naming what decided and what follows. */
    explain: string;
    /**
     * True when this write executed WITHOUT a per-effect prompt because the
     * policy said so. It still crossed the broker, still has a snapshot and still
     * has a rollback — Yolo changes when the IDE asks, never whether the effect
     * is governed.
     */
    autoApproved?: boolean;
}

/**
 * Governed file write over the real workspace filesystem, proxied to the
 * frontend over JSON-RPC. Paths are confined to the workspace root (traversal
 * is rejected). `proposeWrite` never writes; `approve` writes the new bytes;
 * `rollback` restores the pre-write snapshot.
 */
export interface GovernedWriteService {
    /**
     * Snapshot the current bytes of `<rootUri>/<relPath>`, compute the diff to
     * `newContent` via the real Rust `ide-diff` sidecar, and return an
     * awaiting-approval record. Does NOT modify the file.
     */
    proposeWrite(rootUri: string, relPath: string, newContent: string): Promise<WriteProposal>;

    /** Apply the proposed bytes to the real file. */
    approve(id: string): Promise<WriteProposal>;

    /** Restore the snapshot taken at propose time. */
    rollback(id: string): Promise<WriteProposal>;

    /**
     * Every proposal this backend is currently holding for the project, newest
     * first. An agent (through MCP) proposes without any UI involved, so the
     * frontend has to be able to ASK what is waiting — otherwise a write proposed
     * by an agent would sit in the broker with nobody able to decide it.
     */
    pending(rootUri: string): Promise<WriteProposal[]>;

    /**
     * The broker's own raw audit trail for this project: every propose,
     * awaiting-approval, snapshot, execute and rollback it recorded. Read on
     * demand — this is the evidence that a governed write is inspectable, not a
     * claim the UI makes on the broker's behalf.
     */
    activity(rootUri: string): Promise<BrokerActivity[]>;

    /**
     * What the IDE escreveu no projeto só por ter sido aberto, e se o Git vê isso.
     *
     * Abrir um projeto cria `.instrument/` — banco de efeitos, baseline, config —
     * porque o broker e a linha de base precisam existir antes do primeiro efeito.
     * Isso é defensável; ser SILENCIOSO não é: num repositório de verdade a pessoa
     * ganha um diretório não rastreado e um `git status` sujo sem nunca ter sido
     * avisada. Aqui o IDE declara o que fez, e o painel oferece o conserto —
     * ignorar o diretório — como efeito GOVERNADO, decidido por ela.
     */
    runtimeState(rootUri: string): Promise<RuntimeStateNotice>;

    /**
     * Propõe (nunca escreve) acrescentar `.instrument/` ao `.gitignore`.
     *
     * Consertar uma escrita silenciosa com outra escrita silenciosa seria o mesmo
     * defeito de novo: isto vai ao broker como qualquer efeito.
     */
    proposeIgnoreRuntimeState(rootUri: string): Promise<WriteProposal>;
}

/** O que o IDE criou no projeto ao abrir, e o que o Git faz com isso. */
export interface RuntimeStateNotice {
    /** Diretório de estado, relativo à raiz. */
    dir: string;
    /** Existe em disco (o IDE já o criou). */
    exists: boolean;
    /** O projeto é um repositório Git — sem isso, ignorar não faz sentido. */
    gitRepo: boolean;
    /** Já está coberto por alguma regra de `.gitignore`. */
    ignored: boolean;
    /** O que existe lá dentro, em linguagem de gente, para o aviso não ser vago. */
    contents: string[];
}
