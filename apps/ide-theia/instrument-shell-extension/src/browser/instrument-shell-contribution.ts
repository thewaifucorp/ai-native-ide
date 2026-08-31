// Wires the reconciled 001 "Instrumento" shell (M2) on top of the REAL Theia
// areas M1 established:
//
//   • Places the bespoke work-surface (MAIN) and context dock (RIGHT), and the
//     bespoke "Produto" semantic view (LEFT) into genuine shell areas.
//   • Owns the `instrument.mode.*` commands that the navigator "modes" row
//     (NavModesWidget) fires. Each reveals a REAL view-container into the native
//     left panel — explorer / search / scm / extensions — or the bespoke Produto
//     view, and records the active mode in the shared store so the modes row and
//     the (now hidden) native activity bar never diverge.
//   • Drives the Game-Mode body class and the `iws-shell` class the ported CSS
//     keys the "hide native chrome" rules off.
//
// The structural regions (rail / crumb / pulse / modes row) are woven into the
// shell's Lumino layout by InstrumentApplicationShell.createLayout(). Area
// placement + reveal is deferred to the `ready` state so it does not race the
// SidePanelHandler's default-collapsed pass or plugin (SQLTools) view creation.

import { injectable, inject } from '@theia/core/shared/inversify';
import {
    FrontendApplication,
    FrontendApplicationContribution,
    ApplicationShell,
    Widget
} from '@theia/core/lib/browser';
import { CommandRegistry, CommandService } from '@theia/core/lib/common/command';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { InstrumentStore, NavMode } from './instrument-store';
import { WorkWidget } from './widgets/work-widget';
import { DockWidget } from './widgets/dock-widget';
import { ProdutoWidget } from './widgets/produto-widget';
import { CapabilitySurfaceWidget, DEFAULT_SURFACE_CAPABILITY } from './widgets/capability-surface-widget';
import { ToolsWidget } from './widgets/tools-widget';
import { ProjectWidget } from './widgets/project-widget';

const EXPLORER_CONTAINER_ID = 'explorer-view-container';

/** Opens the generic capability-surface tab on a given capability id. */
export const CMD_SHOW_SURFACE = 'instrument.capability.showSurface';

/** Opens one of the real external surfaces the shell hides native chrome for. */
export const CMD_EXTERNAL_SURFACE = 'instrument.external';

/** External surfaces reachable from the Ferramentas view, and their real commands.
 *  The instrument shell hides the native menu bar and activity bar, so these have
 *  to be reachable somewhere explicit — otherwise the terminal, the raw output and
 *  the Open VSX marketplace would exist but be unopenable. */
export type ExternalSurface = 'terminal' | 'output' | 'extensions' | 'sqltools';

const EXTERNAL_COMMAND: Record<ExternalSurface, string> = {
    // Real PTY-backed terminal in the bottom area (@theia/terminal + node-pty).
    terminal: 'workbench.action.terminal.toggleTerminal',
    // Raw output channels (adapters, plugins, tasks) — the unfiltered stream.
    output: 'output:toggle',
    extensions: 'vsxExtensions.toggle',
    sqltools: 'plugin.view-container.workbench.view.extension.sqltoolsActivityBarContainer.toggle'
};

// Real view-container reveal for each navigator mode. Explorer/search/scm/vsx
// each expose an AbstractViewContribution toggle command (opens + activates when
// the view is not already the active one); the modes row guards against firing
// on the already-active mode, so "toggle" here only ever opens.
const MODE_TOGGLE_COMMAND: Partial<Record<NavMode, string>> = {
    arquivos: 'fileNavigator:toggle',
    busca: 'search-in-workspace.toggle',
    git: 'scmView:toggle',
    // REAL @theia/debug view container: configurations, threads, call stack,
    // variables, watch and breakpoints, driven by a real DAP adapter.
    depuracao: 'debug:toggle'
};

@injectable()
export class InstrumentShellContribution implements FrontendApplicationContribution {

    @inject(InstrumentStore) protected readonly store!: InstrumentStore;
    @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
    @inject(CommandRegistry) protected readonly commandRegistry!: CommandRegistry;
    @inject(CommandService) protected readonly commandService!: CommandService;
    @inject(FrontendApplicationStateService) protected readonly stateService!: FrontendApplicationStateService;
    @inject(WorkWidget) protected readonly work!: WorkWidget;
    @inject(DockWidget) protected readonly dock!: DockWidget;
    @inject(ProdutoWidget) protected readonly produto!: ProdutoWidget;
    @inject(CapabilitySurfaceWidget) protected readonly surface!: CapabilitySurfaceWidget;
    @inject(ToolsWidget) protected readonly tools!: ToolsWidget;
    @inject(ProjectWidget) protected readonly project!: ProjectWidget;

    onStart(_app: FrontendApplication): void {
        // The ported 001 CSS keys Game-Mode rules off a `game` class on <body>,
        // and the "hide native activity/menu bar" rules off `iws-shell`.
        document.body.classList.toggle('game', this.store.gameMode);
        document.body.classList.add('iws-shell');

        this.registerModeCommands();
        this.commandRegistry.registerCommand(
            { id: CMD_SHOW_SURFACE, label: 'Instrument: abrir superfície de capability' },
            { execute: (id?: string) => this.showSurface(id ?? DEFAULT_SURFACE_CAPABILITY) }
        );
        this.commandRegistry.registerCommand(
            { id: CMD_EXTERNAL_SURFACE, label: 'Instrument: abrir superfície externa' },
            { execute: (surface?: ExternalSurface) => this.openExternal(surface ?? 'terminal') }
        );

        // Do all area placement once the workbench has fully settled.
        this.stateService.reachedState('ready').then(() => this.arrangeAreas());
    }

    protected registerModeCommands(): void {
        const modes: NavMode[] = [
            'criar', 'projeto', 'notas', 'grafo',
            'preview', 'compartilhar', 'entregar',
            'arquivos', 'busca', 'git', 'depuracao', 'sistema'
        ];
        for (const mode of modes) {
            this.commandRegistry.registerCommand(
                { id: `instrument.mode.${mode}`, label: `Instrument: mostrar ${mode}` },
                { execute: () => this.revealMode(mode) }
            );
        }
    }

    /** Record the active mode and reveal its real (or bespoke) view-container. */
    protected async revealMode(mode: NavMode): Promise<void> {
        this.store.setNavMode(mode);
        if (mode === 'criar' || mode === 'notas' || mode === 'preview') {
            if (mode === 'notas' || mode === 'preview') {
                this.store.toggleFloatingPanel(mode === 'notas' ? 'notes' : 'preview');
            }
            this.store.setView('build');
            await this.shell.activateWidget(WorkWidget.ID);
            return;
        }
        if (mode === 'projeto') {
            await this.shell.revealWidget(ProjectWidget.PROJECT_ID);
            await this.shell.activateWidget(WorkWidget.ID);
            return;
        }
        if (mode === 'grafo') {
            await this.showSurface(DEFAULT_SURFACE_CAPABILITY);
            return;
        }
        if (mode === 'compartilhar' || mode === 'entregar' || mode === 'sistema') {
            this.store.setToolsSurface(
                mode === 'compartilhar' ? 'share' : mode === 'entregar' ? 'ship' : 'system'
            );
            await this.shell.revealWidget(ToolsWidget.ID);
            return;
        }
        const command = MODE_TOGGLE_COMMAND[mode];
        if (command) {
            await this.commandService.executeCommand(command);
        }
    }

    /** Open (or re-focus) the GENERIC capability-surface tab on one capability.
     *  Mounted lazily on first use so the heavy iframe is not created until asked
     *  for, then just re-pointed and re-activated. The Grafo nav mode is one
     *  caller of this; the Ferramentas cards are another. */
    protected async showSurface(capabilityId: string): Promise<void> {
        this.store.setSurfaceCapability(capabilityId);
        const already = this.shell.getWidgets('main').some(w => w.id === CapabilitySurfaceWidget.ID);
        if (!already) {
            await this.shell.addWidget(this.surface, { area: 'main', rank: 150 });
        }
        await this.shell.activateWidget(CapabilitySurfaceWidget.ID);
    }

    /** Open a real external surface, honestly: a plugin-backed one (SQLTools) may
     *  simply not be deployed, and then we say so instead of silently opening
     *  something else. An already-attached plugin container is revealed, never
     *  toggled (toggling would DISPOSE it). */
    protected async openExternal(surface: ExternalSurface): Promise<void> {
        if (surface === 'sqltools') {
            const existing = this.shell.widgets.find(w => /sqltools/i.test(w.id));
            if (existing) {
                await this.shell.revealWidget(existing.id);
                return;
            }
        }
        const command = EXTERNAL_COMMAND[surface];
        if (!this.commandRegistry.getCommand(command)) {
            this.store.toast(`'${surface}' não está disponível nesta instalação (${command})`);
            return;
        }
        await this.commandService.executeCommand(command);
    }

    protected async arrangeAreas(): Promise<void> {
        // MAIN: Overview work surface; real editors open as sibling tabs.
        if (!this.shell.getWidgets('main').some(w => w.id === WorkWidget.ID)) {
            await this.shell.addWidget(this.work, { area: 'main', rank: 100 });
        }
        // RIGHT: bespoke Context dock.
        if (!this.shell.getWidgets('right').some(w => w.id === DockWidget.ID)) {
            await this.shell.addWidget(this.dock, { area: 'right', rank: 100 });
        }
        // LEFT: bespoke "Produto" semantic view, alongside the REAL view-containers
        // (explorer/search/scm/extensions). It is added but NOT revealed — the
        // default mode is Arquivos (the real file explorer).
        if (!this.shell.getWidgets('left').some(w => w.id === ProdutoWidget.ID)) {
            await this.shell.addWidget(this.produto, { area: 'left', rank: 0 });
        }
        // LEFT: the Ferramentas view — the project's capability platform + harness.
        // Added, not revealed; the default mode is Arquivos.
        if (!this.shell.getWidgets('left').some(w => w.id === ToolsWidget.ID)) {
            await this.shell.addWidget(this.tools, { area: 'left', rank: 10 });
        }
        if (!this.shell.getWidgets('left').some(w => w.id === ProjectWidget.PROJECT_ID)) {
            await this.shell.addWidget(this.project, { area: 'left', rank: 5 });
        }

        await this.shell.revealWidget(DockWidget.ID);

        // Keep the real file explorer beside the creation surface on boot.
        const explorer: Widget | undefined = this.shell.getWidgets('left')
            .find(w => w.id === EXPLORER_CONTAINER_ID || w.id === 'files');
        if (explorer) {
            await this.shell.revealWidget(explorer.id);
        }
        this.store.setView('build');
        this.store.setNavMode('criar');
        await this.shell.activateWidget(WorkWidget.ID);
    }
}
