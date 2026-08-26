// 001 PULSE STRIP — 42px bottom strand: the "now" line, the strand of real
// events, honest stats, and the timeline drawer.
//
// HONESTY PASS (M10): this strip used to assert facts nobody had measured —
// five decorative notches at fixed percentages, "3 arquivos", a green
// "checks 4/5", a green "preview ✓", "nv 7", and a six-entry timeline of
// invented history with timestamps. All of it is gone.
//
// What is left is real:
//  • the notches and the drawer are the BROKER's own audit trail for this
//    project (propose → awaiting → snapshot → execute → rollback), fetched from
//    the Rust broker; with no events the drawer says so;
//  • the file count is the workspace's real top-level resource count;
//  • checks are reported as NOT RUN (muted, never green) because no check engine
//    exists yet — that is item 4 of the queue;
//  • the pending-decision count comes from the real governed proposal.

import * as React from 'react';
import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { AbstractInstrumentWidget } from './abstract-instrument-widget';
import { BrokerActivity } from 'engine-extension';
import { CMD_BROKER_TRAIL } from '../instrument-capability-contribution';

/** Notch class per broker event kind — the strand's vocabulary, unchanged. */
const NOTCH_CLASS: Record<BrokerActivity['kind'], string> = {
    proposed: 'ed',
    awaiting_approval: 'dc',
    snapshot_created: 'ck',
    executed: 'ed',
    rolled_back: 'ck'
};

/** Human label per broker event kind, for the drawer. */
const KIND_LABEL: Record<BrokerActivity['kind'], string> = {
    proposed: 'PROPOSTA',
    awaiting_approval: 'DECISÃO',
    snapshot_created: 'CHECKPOINT',
    executed: 'ESCRITA',
    rolled_back: 'ROLLBACK'
};

/** Cap on notches drawn on the 42px strand. */
const NOTCH_CAP = 12;

@injectable()
export class PulseWidget extends AbstractInstrumentWidget {
    static readonly ID = 'instrument.pulse';

    @inject(CommandService) protected readonly commands!: CommandService;

    protected configure(): void {
        this.id = PulseWidget.ID;
        this.addClass('iws-pulse-host');
    }

    protected toggleDrawer(): void {
        // Opening the drawer re-reads the broker: the trail shown is the trail
        // the broker has right now, not a cached snapshot.
        if (!this.store.drawerOpen) {
            this.commands.executeCommand(CMD_BROKER_TRAIL);
        }
        this.store.toggleDrawer();
    }

    protected render(): React.ReactNode {
        const { drawerOpen } = this.store;
        return (
            <>
                <div className={`drawer${drawerOpen ? ' open' : ''}`}>
                    <div className="drawer-in">{this.renderTrail()}</div>
                </div>

                <footer className="strip" title="Clique para abrir a trilha do broker" onClick={() => this.toggleDrawer()}>
                    <span className="now"><span className="live" /><span>{this.store.nowText}</span></span>
                    <div className="strand">
                        <div className="wire" />
                        {this.renderNotches()}
                        <span className="head" />
                        <div className="buddy"><span className="stage">{this.store.stageText}</span><div className="bod" /></div>
                    </div>
                    <div className="stats">
                        <span>{this.store.resources.length} recursos</span>
                        {/* No check engine yet (queue item 4) — muted, never green. */}
                        <span className="none" title="Nenhum motor de checks foi executado ainda">checks não executados</span>
                        <span className={this.store.pendingIsWarn ? 'warn' : ''}>{this.store.pendingText}</span>
                        <span className="open-hint">trilha ▴</span>
                    </div>
                </footer>

                <div className={`toast${this.store.toastText ? ' show' : ''}`}><span className="st" /><span>{this.store.toastText}</span></div>
            </>
        );
    }

    /** One notch per real broker event, spread across the strand in order. */
    protected renderNotches(): React.ReactNode {
        const trail = (this.store.brokerActivity ?? []).slice(-NOTCH_CAP);
        if (trail.length === 0) {
            return null;
        }
        const step = 80 / Math.max(trail.length, 2);
        return trail.map((entry, index) => (
            <span
                key={`${entry.effect_id}:${entry.kind}:${index}`}
                className={`notch ${NOTCH_CLASS[entry.kind]}${entry.kind === 'executed' || entry.kind === 'rolled_back' ? ' done' : ''}`}
                style={{ left: `${8 + index * step}%` }}
                title={`${KIND_LABEL[entry.kind]} · ${entry.path ?? entry.effect_id}`}
            />
        ));
    }

    protected renderTrail(): React.ReactNode {
        const trail = this.store.brokerActivity;
        if (trail === undefined) {
            return <div className="tl"><span className="k">TRILHA</span><span>lendo o broker deste projeto…</span></div>;
        }
        if (trail.length === 0) {
            return (
                <div className="tl">
                    <span className="k">TRILHA</span>
                    <span>
                        O broker não registrou nenhum efeito neste projeto. Toda escrita governada
                        aparece aqui — proposta, aprovação, snapshot, execução e rollback.
                    </span>
                </div>
            );
        }
        return trail.slice().reverse().map((entry, index) => (
            <div className="tl" key={`${entry.effect_id}:${entry.kind}:${index}`}>
                <span className={`k ${NOTCH_CLASS[entry.kind]}`}>{KIND_LABEL[entry.kind]}</span>
                <span>{entry.path ?? '—'}</span>
                <span className="meta">{entry.effect_id}</span>
            </div>
        ));
    }
}
