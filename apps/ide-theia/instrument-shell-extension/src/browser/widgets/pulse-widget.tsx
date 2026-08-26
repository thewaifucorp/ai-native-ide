// 001 PULSE STRIP — 42px bottom strand: "now" head + notches/wire, the Game Mode
// companion, live stats, and the "timeline ▴" affordance. Clicking the strip
// expands the timeline drawer (which slides over the work surface). Also renders
// the transient toast.

import * as React from 'react';
import { injectable } from '@theia/core/shared/inversify';
import { AbstractInstrumentWidget } from './abstract-instrument-widget';

@injectable()
export class PulseWidget extends AbstractInstrumentWidget {
    static readonly ID = 'instrument.pulse';
    protected configure(): void {
        this.id = PulseWidget.ID;
        this.addClass('iws-pulse-host');
    }

    protected render(): React.ReactNode {
        const { drawerOpen } = this.store;
        return (
            <>
                <div className={`drawer${drawerOpen ? ' open' : ''}`}>
                    <div className="drawer-in">
                        <div className="tl"><time>14:32</time><span className="k">INTENÇÃO</span><span>“ninguém pode pagar depois de ver o lance vencedor” incorporada ao product-intent.md</span></div>
                        <div className="tl"><time>14:35</time><span className="k ed">EDIÇÃO</span><span>auction.ts, bids.schema.ts — endpoint protegido por sessão</span></div>
                        <div className="tl"><time>14:41</time><span className="k ck">CHECKPOINT</span><span>antes da mudança no schema de lances</span><button className="undo" onClick={e => { e.stopPropagation(); this.store.toast('Projeto voltaria para 14:41 — nada foi desfeito neste spike'); }}>restaurar</button></div>
                        <div className="tl"><time>14:42</time><span className="k ed">EDIÇÃO</span><span>migration 0042_sealed_bids preparada, aguardando permissão</span></div>
                        <div className="tl"><time>14:44</time><span className="k dc">DECISÃO</span><span>migration no banco local aguardando você</span></div>
                        <div className="tl"><time>14:44</time><span className="k ev">EVIDENCE</span><span>empate entre lances usa ordem de criação — divergente da intenção</span></div>
                    </div>
                </div>

                <footer className="strip" title="Clique para abrir a timeline" onClick={() => this.store.toggleDrawer()}>
                    <span className="now"><span className="live" /><span>{this.store.nowText}</span></span>
                    <div className="strand">
                        <div className="wire" />
                        <span className="notch ed" style={{ left: '12%' }} />
                        <span className="notch ed" style={{ left: '19%' }} />
                        <span className="notch ck" style={{ left: '30%' }} title="Checkpoint 14:41" />
                        <span className="notch ed" style={{ left: '41%' }} />
                        <span className={`notch dc${this.store.proposal && this.store.proposal.state !== 'awaiting' ? ' done' : ''}`} style={{ left: '54%' }} title="Decisão / escrita governada" />
                        <span className="head" />
                        <div className="buddy"><span className="stage">{this.store.stageText}</span><div className="bod" /></div>
                    </div>
                    <div className="stats">
                        <span>3 arquivos</span>
                        <span className="ok">checks 4/5</span>
                        <span className="ok">preview ✓</span>
                        <span className={this.store.pendingIsWarn ? 'warn' : ''}>{this.store.pendingText}</span>
                        <span className="lvl-strip">nv 7</span>
                        <span className="open-hint">timeline ▴</span>
                    </div>
                </footer>

                <div className={`toast${this.store.toastText ? ' show' : ''}`}><span className="st" /><span>{this.store.toastText}</span></div>
            </>
        );
    }
}
