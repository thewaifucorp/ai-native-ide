// 001 CRUMB TITLEBAR — 44px top strip: traffic lights, project · session
// breadcrumb, "Hybrid · local" pill, and the Game Mode toggle (drives the shared
// store, which flips the `game` class on <body>).

import * as React from 'react';
import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { AbstractInstrumentWidget } from './abstract-instrument-widget';
import { CMD_GOVERNED_PROPOSE } from '../instrument-data-contribution';

@injectable()
export class CrumbWidget extends AbstractInstrumentWidget {
    static readonly ID = 'instrument.crumb';

    @inject(CommandService) protected readonly commands!: CommandService;

    protected configure(): void {
        this.id = CrumbWidget.ID;
        this.addClass('iws-crumb-host');
    }
    protected render(): React.ReactNode {
        const on = this.store.gameMode;
        // REAL: the opened workspace name (WorkspaceService), not a hardcoded label.
        const proj = this.store.workspaceName || 'workspace';
        const count = this.store.resources.length;
        return (
            <header className="titlebar">
                <div className="traffic"><i /><i /><i /></div>
                <div className="crumb">
                    <span className="proj">{proj}</span>
                    <span className="sep">·</span>
                    <span className="sess">{count > 0 ? `${count} recursos no topo · workspace real` : 'workspace real'}</span>
                </div>
                <div className="tb-right">
                    {/* REAL: fires the governed-write loop on a real workspace file. */}
                    <button className="gm-toggle" title="Propor uma escrita governada em um arquivo real" onClick={() => this.commands.executeCommand(CMD_GOVERNED_PROPOSE)}>Propor mudança</button>
                    <span className="pill"><span className="dot" />Hybrid · local</span>
                    <button className="gm-toggle" aria-pressed={on} onClick={() => this.store.toggleGame()}>Game mode<span className="sw" /></button>
                </div>
            </header>
        );
    }
}
