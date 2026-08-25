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

const EXPLORER_CONTAINER_ID = 'explorer-view-container';

// Real view-container reveal for each navigator mode. Explorer/search/scm/vsx
// each expose an AbstractViewContribution toggle command (opens + activates when
// the view is not already the active one); the modes row guards against firing
// on the already-active mode, so "toggle" here only ever opens.
const MODE_TOGGLE_COMMAND: Partial<Record<NavMode, string>> = {
    arquivos: 'fileNavigator:toggle',
    busca: 'search-in-workspace.toggle',
    git: 'scmView:toggle'
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

    onStart(_app: FrontendApplication): void {
        // The ported 001 CSS keys Game-Mode rules off a `game` class on <body>,
        // and the "hide native activity/menu bar" rules off `iws-shell`.
        document.body.classList.toggle('game', this.store.gameMode);
        document.body.classList.add('iws-shell');

        this.registerModeCommands();

        // Do all area placement once the workbench has fully settled.
        this.stateService.reachedState('ready').then(() => this.arrangeAreas());
    }

    protected registerModeCommands(): void {
        const modes: NavMode[] = ['produto', 'arquivos', 'busca', 'git', 'ferramentas'];
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
        if (mode === 'produto') {
            await this.shell.revealWidget(ProdutoWidget.ID);
            return;
        }
        if (mode === 'ferramentas') {
            await this.revealTools();
            return;
        }
        const command = MODE_TOGGLE_COMMAND[mode];
        if (command) {
            await this.commandService.executeCommand(command);
        }
    }

    /** Ferramentas mode: prefer the SQLTools view-container; fall back to the
     *  Open VSX Extensions view if SQLTools is not deployed/activated.
     *
     *  The plugin (SQLTools) view-container widget is created lazily on first
     *  open, so on the first switch we invoke the plugin-view toggle command that
     *  Theia registers for it (`plugin.view-container.<containerId>.toggle`, which
     *  OPENS it when not yet attached). On later switches the widget already
     *  exists, so we reveal it directly — never the toggle, which would DISPOSE an
     *  already-attached container. */
    protected async revealTools(): Promise<void> {
        const existing = this.shell.widgets.find(w => /sqltools/i.test(w.id));
        if (existing) {
            await this.shell.revealWidget(existing.id);
            return;
        }
        const sqltoolsToggle = 'plugin.view-container.workbench.view.extension.sqltoolsActivityBarContainer.toggle';
        if (this.commandRegistry.getCommand(sqltoolsToggle)) {
            await this.commandService.executeCommand(sqltoolsToggle);
            return;
        }
        // SQLTools not deployed/activated — fall back to the Extensions marketplace.
        await this.commandService.executeCommand('vsxExtensions.toggle');
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

        await this.shell.revealWidget(DockWidget.ID);

        // Reveal the REAL file explorer ("Arquivos" mode) LAST so it is the visible
        // left view on boot, and sync the modes row highlight to it.
        const explorer: Widget | undefined = this.shell.getWidgets('left')
            .find(w => w.id === EXPLORER_CONTAINER_ID || w.id === 'files');
        if (explorer) {
            await this.shell.revealWidget(explorer.id);
        }
        this.store.setNavMode('arquivos');
    }
}
