// Technical workbench switcher. Project places and unlockable sessions live in
// the rail; this row only changes the real left-side tool container.
import * as React from 'react';
import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { AbstractInstrumentWidget } from './abstract-instrument-widget';
import { NavMode } from '../instrument-store';

interface ModeDef {
    mode: NavMode;
    title: string;
    icon: React.ReactNode;
    group: 'workbench' | 'system';
}

const MODES: ModeDef[] = [
    { mode: 'arquivos', title: 'Arquivos', group: 'workbench', icon: <path d="M2.5 3.5h4l1.2 1.5H13.5v7.5h-11Z" /> },
    { mode: 'busca', title: 'Busca', group: 'workbench', icon: <><circle cx="7" cy="7" r="4.2" /><path d="M10.5 10.5 14 14" /></> },
    { mode: 'git', title: 'Git / GitHub', group: 'workbench', icon: <><circle cx="4" cy="4" r="1.8" /><circle cx="4" cy="12" r="1.8" /><circle cx="12" cy="6.5" r="1.8" /><path d="M4 5.8v4.4M4 10.2C4 7 12 9 12 6.5" /></> },
    { mode: 'depuracao', title: 'Depuração', group: 'workbench', icon: <><circle cx="8" cy="8" r="4.2" /><path d="M8 1.6v2.2M8 12.2v2.2M1.6 8h2.2M12.2 8h2.2M3.5 3.5 5 5M12.5 3.5 11 5M3.5 12.5 5 11M12.5 12.5 11 11" /></> },
    { mode: 'sistema', title: 'Skills, integrações e configuração', group: 'system', icon: <path d="M6 2h4v2.2a1.6 1.6 0 0 0 3.2 0V2M6 14h8V8.5h-2.4a1.6 1.6 0 0 0 0-3.2H14" /> }
];

@injectable()
export class NavModesWidget extends AbstractInstrumentWidget {
    static readonly ID = 'instrument.nav-modes';
    @inject(CommandService) protected readonly commands!: CommandService;

    protected configure(): void {
        this.id = NavModesWidget.ID;
        this.addClass('iws-navmodes-host');
    }

    protected select(mode: NavMode): void {
        if (this.store.navMode !== mode) {
            this.commands.executeCommand(`instrument.mode.${mode}`);
        }
    }

    protected render(): React.ReactNode {
        let previous: ModeDef['group'] | undefined;
        return (
            <div className="nav-modes" aria-label="Navegação do projeto">
                {MODES.map(mode => {
                    const separator = previous !== undefined && previous !== mode.group;
                    previous = mode.group;
                    const title = mode.title;
                    return <React.Fragment key={mode.mode}>
                        {separator && <span className="nav-mode-sep" aria-hidden="true" />}
                        <button
                            className={`nav-mode ${mode.group}${this.store.navMode === mode.mode ? ' on' : ''}`}
                            title={title}
                            aria-label={title}
                            onClick={() => this.select(mode.mode)}
                        >
                            <svg className="i" viewBox="0 0 16 16">{mode.icon}</svg>
                        </button>
                    </React.Fragment>;
                })}
            </div>
        );
    }
}
