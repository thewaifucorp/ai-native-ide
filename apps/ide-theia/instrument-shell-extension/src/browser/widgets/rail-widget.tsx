// 001/003 PROJECT RAIL — 56px far-left column, IDENTITY ONLY (per sketch 003):
// logo, home, the project switchers (with health beacons), new-project, the
// single discreet Store/Extensions door, then the bottom global cluster
// (notifications bell · settings · avatar). It is NOT an activity bar — view
// switching lives in the navigator "modes" row (NavModesWidget). The native
// Theia activity bar is hidden; the ONE real wire here is the Store button,
// which opens the real Extensions (Open VSX) view-container.

import * as React from 'react';
import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { AbstractInstrumentWidget } from './abstract-instrument-widget';
import { Icon, IconDefs } from './icons';

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

    protected render(): React.ReactNode {
        return (
            <>
                <IconDefs />
                <aside className="rail">
                    <div className="logo">/i</div>
                    <button className="rail-btn home" title="Início · todos os projetos, recentes e publicados">
                        <svg className="i" viewBox="0 0 16 16"><path d="M2.5 7.5 8 2.5l5.5 5M4 6.7V13h8V6.7" /></svg>
                    </button>
                    <div className="rail-div" />
                    {/* REAL: the active project button reflects the opened workspace
                        (name + initials from WorkspaceService). The second button is a
                        still-mock secondary project (multi-project switching is M4). */}
                    <button className="rail-btn on" title={`${this.store.workspaceName || 'workspace'} — projeto aberto`}>{this.store.railInitials}<span className="hb run" /></button>
                    <button className="rail-btn" title="Loja Aurora — projeto de exemplo (mock)">LA<span className="hb need" /></button>
                    <button className="rail-btn" title="Novo projeto"><Icon name="plus" /></button>
                    <div className="rail-div" />
                    <button className="rail-btn store" title="Extensões & Loja" onClick={() => this.openStore()}>
                        <svg className="i" viewBox="0 0 16 16"><path d="M6 2h4v2.2a1.6 1.6 0 0 0 3.2 0V2h1.3v3h-2.4a1.6 1.6 0 0 0 0 3.2H16v5.8h-3V13a1.6 1.6 0 0 0-3.2 0v1H6Z" transform="translate(-1,-1) scale(.9)" /></svg>
                    </button>
                    <div className="sp" />
                    <button className="rail-btn" title="Notificações">
                        <svg className="i" viewBox="0 0 16 16"><path d="M4.5 7a3.5 3.5 0 0 1 7 0c0 3 1.2 3.8 1.2 3.8H3.3S4.5 10 4.5 7Z" /><path d="M6.6 12.5a1.5 1.5 0 0 0 2.8 0" /></svg>
                        <span className="cbadge">1</span>
                    </button>
                    <button className="rail-btn" title="Configurações"><Icon name="gear" /></button>
                    <div className="avatar">MA<span className="lvl-badge">7</span></div>
                </aside>
            </>
        );
    }
}
