// M3 frontend wiring — turns the bespoke 001 chrome from static mock into REAL
// state, and drives the governed-write loop end-to-end on real files.
//
// Two jobs:
//
//  1. WORKSPACE MODEL (real, no mock): on `ready`, read the opened workspace via
//     WorkspaceService + FileService and push the real name + top-level resources
//     into InstrumentStore. Crumb / Produto / Overview / Rail render from that.
//     `instrument.openResource` opens any resource in the real Monaco/explorer.
//
//  2. GOVERNED LOOP (real, no mock): `instrument.governed.propose` snapshots a
//     real workspace file and asks the backend GovernedWriteService (which uses
//     the real Rust ide-diff engine) for an awaiting-approval record — WITHOUT
//     writing. `.approve` writes the bytes to the real file (visible in Monaco);
//     `.rollback` restores the snapshot. The dock decision card + pulse strip
//     render this real proposal from the store.
//
// See governed-write-service.ts for the honest Node-stand-in vs Rust-broker line.

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { OpenerService, open } from '@theia/core/lib/browser/opener-service';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { EditorManager } from '@theia/editor/lib/browser';
import { GovernedWriteService } from '../common/governed-protocol';
import { EngineService } from 'engine-extension';
import { InstrumentStore } from './instrument-store';

/** Agent adapter probed for the "Contexto ativo" card. */
const DEFAULT_AGENT = 'codex';

/** Default real file the demo proposes a governed write on. */
const DEFAULT_REL = 'docs/product-intent.md';

/** The reversible, thematically-on-point change the demo proposes / toggles. */
const GOVERNED_MARKER = '<!-- governed-edit-m3 -->';
const GOVERNED_BLOCK =
    '\n' + GOVERNED_MARKER + '\n' +
    '> Tie-break resolved by the governed loop: the highest sealed amount wins;\n' +
    '> creation order is never the tie-breaker. (written via the M3 effect loop)\n';

export const CMD_OPEN_RESOURCE = 'instrument.openResource';
export const CMD_GOVERNED_PROPOSE = 'instrument.governed.propose';
export const CMD_GOVERNED_APPROVE = 'instrument.governed.approve';
export const CMD_GOVERNED_ROLLBACK = 'instrument.governed.rollback';

@injectable()
export class InstrumentDataContribution implements FrontendApplicationContribution, CommandContribution {

    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(FileService) protected readonly files!: FileService;
    @inject(OpenerService) protected readonly openers!: OpenerService;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(FrontendApplicationStateService) protected readonly stateService!: FrontendApplicationStateService;
    @inject(GovernedWriteService) protected readonly governed!: GovernedWriteService;
    @inject(EngineService) protected readonly engine!: EngineService;
    @inject(InstrumentStore) protected readonly store!: InstrumentStore;

    onStart(): void {
        this.stateService.reachedState('ready').then(() => {
            this.loadWorkspace();
            this.probeAgent();
        });
        this.workspace.onWorkspaceChanged(() => this.loadWorkspace());
    }

    /** M5: probe the real agent adapter (ide-agent AcpxAgentFacade via the sidecar)
     *  and push descriptor + honest health into the store. A missing acpx/agent
     *  binary — or a sidecar error — becomes an honest `unavailable` card, never a
     *  fabricated "ready". */
    protected async probeAgent(): Promise<void> {
        try {
            const probe = await this.engine.agentProbe(DEFAULT_AGENT);
            this.store.setAgentProbe(probe);
        } catch (err) {
            this.store.setAgentProbe({
                agent: DEFAULT_AGENT,
                available: false,
                availability: 'unavailable',
                detail: this.msg(err),
                degradations: []
            });
        }
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand({ id: CMD_OPEN_RESOURCE, label: 'Instrument: abrir recurso' }, {
            execute: (uri?: string) => (uri ? this.open(new URI(uri)) : undefined)
        });
        commands.registerCommand({ id: CMD_GOVERNED_PROPOSE, label: 'Instrument: propor mudança (governed)' }, {
            execute: () => this.propose()
        });
        commands.registerCommand({ id: CMD_GOVERNED_APPROVE, label: 'Instrument: permitir escrita (governed)' }, {
            execute: () => this.approve()
        });
        commands.registerCommand({ id: CMD_GOVERNED_ROLLBACK, label: 'Instrument: reverter escrita (governed)' }, {
            execute: () => this.rollback()
        });
    }

    // ── Workspace model (real) ──────────────────────────────────────────────

    protected async loadWorkspace(): Promise<void> {
        const roots = this.workspace.tryGetRoots();
        if (roots.length === 0) {
            this.store.setWorkspace('(sem workspace)', '', []);
            return;
        }
        const rootStat = roots[0];
        const rootUri = rootStat.resource;
        const name = rootStat.name || rootUri.path.base || 'workspace';
        let entries: { name: string; uri: string; isDir: boolean }[] = [];
        try {
            const dir = await this.files.resolve(rootUri);
            entries = (dir.children || [])
                .filter(c => !c.name.startsWith('.'))
                .map(c => ({ name: c.name, uri: c.resource.toString(), isDir: !!c.isDirectory }))
                .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
        } catch { /* directory unreadable — leave the resource list empty */ }
        this.store.setWorkspace(name, rootUri.toString(), entries);
    }

    protected async open(uri: URI): Promise<void> {
        try {
            await open(this.openers, uri);
        } catch (err) {
            this.messages.error(`Não foi possível abrir ${uri.path.base}: ${this.msg(err)}`);
        }
    }

    // ── Governed loop (real) ────────────────────────────────────────────────

    /** Pick the real file to act on: the active editor if it is inside the
     *  workspace, otherwise the default product-intent doc. */
    protected pickTarget(rootUri: URI): { fileUri: URI; relPath: string } {
        const active = this.editors.currentEditor?.editor.uri;
        if (active) {
            const rel = rootUri.relative(active);
            if (rel && !rel.toString().startsWith('..') && rel.toString() !== '') {
                return { fileUri: active, relPath: rel.toString() };
            }
        }
        return { fileUri: rootUri.resolve(DEFAULT_REL), relPath: DEFAULT_REL };
    }

    protected async propose(): Promise<void> {
        const rootUriStr = this.store.workspaceRootUri;
        if (!rootUriStr) {
            this.messages.warn('Nenhum workspace aberto — abra uma pasta para propor uma mudança.');
            return;
        }
        const rootUri = new URI(rootUriStr);
        const { fileUri, relPath } = this.pickTarget(rootUri);
        try {
            // Show the real file in Monaco first, so the approved write is visible.
            await this.open(fileUri);
            const current = (await this.files.read(fileUri)).value;
            const newContent = current.includes(GOVERNED_MARKER)
                ? current.split(GOVERNED_BLOCK).join('')   // toggle: propose removal
                : current + GOVERNED_BLOCK;                 // propose the addition
            const proposal = await this.governed.proposeWrite(rootUriStr, relPath, newContent);
            this.store.governedProposed(proposal);
        } catch (err) {
            this.messages.error(`Falha ao propor mudança: ${this.msg(err)}`);
        }
    }

    protected async approve(): Promise<void> {
        const proposal = this.store.proposal;
        if (!proposal || proposal.state !== 'awaiting') {
            return;
        }
        try {
            const updated = await this.governed.approve(proposal.id);
            this.store.governedApproved(updated);
        } catch (err) {
            this.messages.error(`Falha ao aplicar escrita: ${this.msg(err)}`);
        }
    }

    protected async rollback(): Promise<void> {
        const proposal = this.store.proposal;
        if (!proposal || proposal.state !== 'approved') {
            return;
        }
        try {
            const updated = await this.governed.rollback(proposal.id);
            this.store.governedRolledBack(updated);
        } catch (err) {
            this.messages.error(`Falha ao reverter escrita: ${this.msg(err)}`);
        }
    }

    protected msg(err: unknown): string {
        return err instanceof Error ? err.message : String(err);
    }
}
