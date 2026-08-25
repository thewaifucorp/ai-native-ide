// 001/003 NAVIGATOR MODES ROW — a compact strip pinned at the TOP of the left
// panel. It replaces stock Theia's vertical activity bar: the five buttons
// (Produto · Arquivos · Busca · Git · Ferramentas) each switch which Theia
// view-container is revealed in the SAME native left panel below it.
//
// Wiring is decoupled from the shell to avoid an Inversify construction cycle
// (the shell injects this widget). Each button executes a plain command
// (`instrument.mode.<x>`); InstrumentShellContribution owns those commands and
// performs the real reveal (explorer / search / scm / extensions / bespoke
// Produto). The active-mode highlight reads back from the shared store, which
// those command handlers update — so the strip stays in sync no matter how the
// view was opened.

import * as React from 'react';
import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { AbstractInstrumentWidget } from './abstract-instrument-widget';
import { NavMode } from '../instrument-store';

interface ModeDef {
    mode: NavMode;
    title: string;
    icon: React.ReactNode;
    badge?: string;
}

const MODES: ModeDef[] = [
    {
        mode: 'produto', title: 'Produto (semântico)',
        icon: <><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></>
    },
    {
        mode: 'arquivos', title: 'Arquivos',
        icon: <path d="M2.5 3.5h4l1.2 1.5H13.5v7.5h-11Z" />
    },
    {
        mode: 'busca', title: 'Busca',
        icon: <><circle cx="7" cy="7" r="4.2" /><path d="M10.5 10.5 14 14" /></>
    },
    {
        mode: 'git', title: 'Git / GitHub',
        icon: <><circle cx="4" cy="4" r="1.8" /><circle cx="4" cy="12" r="1.8" /><circle cx="12" cy="6.5" r="1.8" /><path d="M4 5.8v4.4M4 10.2C4 7 12 9 12 6.5" /></>
    },
    {
        mode: 'grafo', title: 'Grafo — code intelligence (aag)',
        icon: <><circle cx="8" cy="3.5" r="1.7" /><circle cx="3.5" cy="12" r="1.7" /><circle cx="12.5" cy="12" r="1.7" /><path d="M8 5.2 4.2 10.4M8 5.2l3.8 5.2M5 12h6" /></>
    },
    {
        mode: 'ferramentas', title: 'Ferramentas / extensões',
        icon: <path d="M6 2h4v2.2a1.6 1.6 0 0 0 3.2 0V2M6 14h8V8.5h-2.4a1.6 1.6 0 0 0 0-3.2H14" />
    }
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
        // Clicking the already-active mode is a no-op (prevents the underlying
        // view toggle-command from HIDING the panel on a second click).
        if (this.store.navMode === mode) {
            return;
        }
        this.commands.executeCommand(`instrument.mode.${mode}`);
    }

    protected render(): React.ReactNode {
        const active = this.store.navMode;
        return (
            <div className="nav-modes" title="Produto · Arquivos · Busca · Git · Ferramentas">
                {MODES.map(m => (
                    <button
                        key={m.mode}
                        className={`nav-mode${active === m.mode ? ' on' : ''}`}
                        title={m.title}
                        onClick={() => this.select(m.mode)}
                    >
                        <svg className="i" viewBox="0 0 16 16">{m.icon}</svg>
                        {m.badge ? <span className="b">{m.badge}</span> : null}
                    </button>
                ))}
            </div>
        );
    }
}
