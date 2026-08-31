// 001/003 PROJECT RAIL — 56px far-left column, IDENTITY ONLY (per sketch 003):
// logo, home, the project switchers (with health beacons), new-project, the
// single discreet Store/Extensions door, then the bottom global cluster
// (notifications bell · preferences). It is NOT an activity bar — view
// switching lives in the navigator "modes" row (NavModesWidget). The native
// Theia activity bar is hidden; the ONE real wire here is the Store button,
// which opens the real Extensions (Open VSX) view-container.

import * as React from 'react';
import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { AbstractInstrumentWidget } from './abstract-instrument-widget';
import { Icon, IconDefs } from './icons';
import { NavMode } from '../instrument-store';

@injectable()
export class RailWidget extends AbstractInstrumentWidget {
    static readonly ID = 'instrument.rail';

    @inject(CommandService) protected readonly commands!: CommandService;

    protected configure(): void {
        this.id = RailWidget.ID;
        this.addClass('iws-rail-host');
    }

    protected openStore(): void {
        // Real Open VSX Extensions view-container (@theia/vsx-registry).
        this.commands.executeCommand('vsxExtensions.toggle');
    }

    protected openMode(mode: NavMode): void {
        this.commands.executeCommand(`instrument.mode.${mode}`);
    }

    protected render(): React.ReactNode {
        return (
            <>
                <IconDefs />
                <aside className="rail">
                    <div className="logo">/i</div>
                                    <button className="rail-btn home" title="Início · todos os projetos (ainda não implementado)" disabled>
                        <svg className="i" viewBox="0 0 16 16"><path d="M2.5 7.5 8 2.5l5.5 5M4 6.7V13h8V6.7" /></svg>
                    </button>
                    <div className="rail-div" />
                    {/* REAL: the one project button reflects the opened workspace
                        (name + initials from WorkspaceService). The invented second
                        project ("Loja Aurora") was removed: multi-project switching is
                        a queued item, and a fake sibling made the rail look like a
                        project switcher that switches nothing. */}
                    <button className={`rail-btn${this.store.navMode === 'projeto' ? ' on' : ''}`} title={`${this.store.workspaceName || 'workspace'} — abrir projeto`} onClick={() => this.openMode('projeto')}>{this.store.railInitials}<span className="hb run" /></button>
                    <div className="rail-div" />
                    <button
                        className={`rail-btn${this.store.navMode === 'criar' ? ' on' : ''}`}
                        title="Criar ou modificar software"
                        onClick={() => this.openMode('criar')}
                    >
                        <svg className="i" viewBox="0 0 16 16"><path d="M3 12.8 4 9l7.7-7.7 3 3L7 12l-4 1Z" /><path d="m10.5 2.5 3 3" /></svg>
                    </button>
                    <div className="rail-div" />
                    <button className="rail-btn store" title="Extensões & Loja" onClick={() => this.openStore()}>
                        <svg className="i" viewBox="0 0 16 16"><path d="M6 2h4v2.2a1.6 1.6 0 0 0 3.2 0V2h1.3v3h-2.4a1.6 1.6 0 0 0 0 3.2H16v5.8h-3V13a1.6 1.6 0 0 0-3.2 0v1H6Z" transform="translate(-1,-1) scale(.9)" /></svg>
                    </button>
                    <div className="sp" />
                    {/* Real Theia surfaces; no invented unread count, no level badge. */}
                    <button
                        className="rail-btn"
                        title="Notificações"
                        onClick={() => this.commands.executeCommand('notifications.toggleNotifications')}
                    >
                        <svg className="i" viewBox="0 0 16 16"><path d="M4.5 7a3.5 3.5 0 0 1 7 0c0 3 1.2 3.8 1.2 3.8H3.3S4.5 10 4.5 7Z" /><path d="M6.6 12.5a1.5 1.5 0 0 0 2.8 0" /></svg>
                    </button>
                    <button
                        className="rail-btn"
                        title="Preferências"
                        onClick={() => this.commands.executeCommand('preferences:open')}
                    >
                        <Icon name="gear" />
                    </button>
                </aside>
            </>
        );
    }
}
