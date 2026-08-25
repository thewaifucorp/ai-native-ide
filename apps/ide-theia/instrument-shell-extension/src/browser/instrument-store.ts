// Shared, observable client state for the sketch-001 instrument shell.
//
// Each 001 region is a separate Theia ReactWidget (separate React root), so they
// cannot share React state directly. This singleton is the cross-widget bus: it
// holds the small amount of interaction state 001 needs (which work-surface view
// is active, whether Game Mode is on, whether the timeline drawer is open, the
// decision-card lifecycle, the transient toast) and fires `onDidChange` so every
// mounted widget re-renders via `widget.update()`.

import { injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { WriteProposal } from '../common/governed-protocol';
import { AgentProbe } from 'engine-extension';

export type WorkView = 'home' | 'build';
export type DecisionState = 'pending' | 'executing' | 'verified';

/** Which real (or bespoke) view-container the navigator "modes" row is showing. */
export type NavMode = 'produto' | 'arquivos' | 'busca' | 'git' | 'grafo' | 'ferramentas';

/** A real top-level workspace resource (file or folder), from FileService. */
export interface WorkspaceResource {
    name: string;
    /** `toString()` of the resource URI — passed to `instrument.openResource`. */
    uri: string;
    isDir: boolean;
}

@injectable()
export class InstrumentStore {
    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    view: WorkView = 'home';
    navMode: NavMode = 'arquivos';
    gameMode = true;
    drawerOpen = false;
    decision: DecisionState = 'pending';
    needMigrationDismissed = false;
    toastText = '';

    // ── REAL workspace model (M3): populated by InstrumentDataContribution from
    //    WorkspaceService + FileService. Crumb / Produto / Overview / Rail read it.
    workspaceName = '';
    workspaceRootUri = '';
    resources: WorkspaceResource[] = [];

    // ── REAL governed-write proposal (M3): the current awaiting/approved/rolled-
    //    back write over a real file. Drives the dock decision card + pulse strip.
    proposal: WriteProposal | undefined;

    // ── REAL agent probe (M5): descriptor + honest health of the agent adapter,
    //    from ide-agent's AcpxAgentFacade via the sidecar. `undefined` = probing.
    //    Drives the dock's "Contexto ativo" identity + availability badge.
    agent: AgentProbe | undefined;

    protected toastTimer: number | undefined;
    protected pulseNow = 'codex · testando concorrência';
    protected stage = 'VERIFICANDO';
    protected lvlBar = 64;
    protected lvlNext = '3 marcos verificados para o nível 8';
    protected pendingCount = '1 decisão';

    get nowText(): string { return this.pulseNow; }
    get stageText(): string { return this.stage; }
    get lvlBarPct(): number { return this.lvlBar; }
    get lvlNextText(): string { return this.lvlNext; }
    get pendingText(): string { return this.pendingCount; }
    get pendingIsWarn(): boolean { return this.pendingCount !== '0 decisões'; }

    protected emit(): void {
        this.onDidChangeEmitter.fire();
    }

    setView(view: WorkView): void {
        if (this.view !== view) {
            this.view = view;
            this.emit();
        }
    }

    setNavMode(mode: NavMode): void {
        if (this.navMode !== mode) {
            this.navMode = mode;
            this.emit();
        }
    }

    // ── REAL workspace model ────────────────────────────────────────────────

    setWorkspace(name: string, rootUri: string, resources: WorkspaceResource[]): void {
        this.workspaceName = name;
        this.workspaceRootUri = rootUri;
        this.resources = resources;
        this.emit();
    }

    // ── REAL agent probe ────────────────────────────────────────────────────

    setAgentProbe(probe: AgentProbe): void {
        this.agent = probe;
        this.emit();
    }

    /** Two-letter identity for the active project button on the rail. */
    get railInitials(): string {
        const n = (this.workspaceName || 'workspace').replace(/[^\p{L}\p{N} ]/gu, ' ').trim();
        const words = n.split(/[\s._-]+/).filter(Boolean);
        const initials = words.length >= 2 ? words[0][0] + words[1][0] : n.slice(0, 2);
        return (initials || 'ws').toUpperCase();
    }

    // ── REAL governed-write loop ────────────────────────────────────────────

    governedProposed(proposal: WriteProposal): void {
        this.proposal = proposal;
        this.pulseNow = `governança · escrita proposta em ${proposal.relPath}`;
        this.stage = 'AGUARDANDO';
        this.pendingCount = '1 decisão';
        this.emit();
    }

    governedApproved(proposal: WriteProposal): void {
        this.proposal = proposal;
        this.pulseNow = `governança · escrita aplicada em ${proposal.relPath}`;
        this.stage = 'APLICADO';
        this.pendingCount = '0 decisões';
        this.emit();
        this.toast(`Escrita aplicada no arquivo real · ${proposal.relPath}`);
    }

    governedRolledBack(proposal: WriteProposal): void {
        this.proposal = proposal;
        this.pulseNow = `governança · rollback restaurou ${proposal.relPath}`;
        this.stage = 'REVERTIDO';
        this.pendingCount = '0 decisões';
        this.emit();
        this.toast(`Snapshot restaurado · ${proposal.relPath}`);
    }

    toggleGame(): void {
        this.gameMode = !this.gameMode;
        // The ported 001 CSS keys game-mode rules off a `game` class on <body>.
        document.body.classList.toggle('game', this.gameMode);
        this.emit();
    }

    toggleDrawer(): void {
        this.drawerOpen = !this.drawerOpen;
        this.emit();
    }

    toast(message: string): void {
        this.toastText = message;
        this.emit();
        if (this.toastTimer !== undefined) {
            window.clearTimeout(this.toastTimer);
        }
        this.toastTimer = window.setTimeout(() => {
            this.toastText = '';
            this.emit();
        }, 2200);
    }

    focusDecision(): void {
        const card = document.getElementById('iws-decision-card');
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.animate(
                [
                    { background: 'var(--panel-2)' },
                    { background: 'rgba(217,160,60,.14)' },
                    { background: 'var(--panel-2)' }
                ],
                { duration: 700 }
            );
        }
    }

    // The 001 "approve" flow: the decision resolves everywhere at once, then
    // verifies after the checks + preview come back healthy.
    approve(): void {
        this.decision = 'executing';
        this.needMigrationDismissed = true;
        this.pulseNow = 'codex · aplicando migration';
        this.stage = 'CONSTRUINDO';
        this.pendingCount = '0 decisões';
        this.toast('Permissão registrada · executando migration após checkpoint');
        this.emit();
        window.setTimeout(() => {
            this.decision = 'verified';
            this.pulseNow = 'codex · migration verificada';
            this.stage = 'VERIFICADO';
            this.lvlBar = 72;
            this.lvlNext = '2 outcomes verificados para o nível 8';
            this.toast('Outcome verificado · progresso +1');
            this.emit();
        }, 1400);
    }
}
