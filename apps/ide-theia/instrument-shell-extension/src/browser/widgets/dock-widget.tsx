// 001 CONTEXT DOCK — 288px right column: the active-agent card (real ide-agent
// probe) and the decision card.
//
// HONESTY PASS (M10): the gamified progression block was removed — level 7, a
// 64%-full bar, "Rendeu hoje +1 intenção esclarecida", "também presente:
// Architect". None of it was measured anywhere, and it sat directly under the one
// card that reports real adapter health, which made the real card read as decor
// too. Progression only comes back when something actually computes it.
//
// The decision card is the canonical surface of the REAL governed write: awaiting
// → approved → rolled back, driven by the broker. There is no mock decision any
// more — with nothing proposed it says so, instead of showing an invented
// migration whose "verified" state used to mask the real state.

import * as React from 'react';
import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { AbstractInstrumentWidget } from './abstract-instrument-widget';
import {
    CMD_GOVERNED_PROPOSE,
    CMD_GOVERNED_APPROVE,
    CMD_GOVERNED_ROLLBACK
} from '../instrument-data-contribution';
import { WriteProposal } from '../../common/governed-protocol';

@injectable()
export class DockWidget extends AbstractInstrumentWidget {
    static readonly ID = 'instrument.dock';

    @inject(CommandService) protected readonly commands!: CommandService;
    protected configure(): void {
        this.id = DockWidget.ID;
        this.title.label = 'Contexto';
        this.title.caption = 'Contexto ativo';
        this.title.closable = false;
        this.addClass('iws-dock-host');
    }

    protected render(): React.ReactNode {
        return (
            <aside className="dock">
                <span className="tag">Contexto ativo</span>
                {this.renderAgentCard()}
                {this.renderDecision()}
            </aside>
        );
    }

    /** REAL (M5): the active-agent identity + honest availability, from the
     *  ide-agent AcpxAgentFacade probe (descriptor + health) via the sidecar.
     *  While probing, `agent` is undefined → a "conectando" placeholder. A missing
     *  acpx/agent binary shows "indisponível" + the reason, never a fake "pronto". */
    protected renderAgentCard(): React.ReactNode {
        const a = this.store.agent;
        if (!a) {
            return (
                <div className="agent-card">
                    <div className="agent-top">
                        <div className="agent-orb">…</div>
                        <div><span className="nm">Agente</span><small>conectando ao adaptador…</small></div>
                    </div>
                </div>
            );
        }
        const name = a.agent.charAt(0).toUpperCase() + a.agent.slice(1);
        const orb = a.agent.charAt(0).toUpperCase() || 'A';
        const color =
            a.availability === 'ready' ? 'var(--ok)'
                : a.availability === 'degraded' ? 'var(--need)'
                    : 'var(--bad)';
        const statusLabel =
            a.availability === 'ready' ? 'pronto'
                : a.availability === 'degraded' ? 'degradado'
                    : 'indisponível';
        const transport = a.transport ? a.transport.toUpperCase() : 'ACP';
        const sub = a.availability === 'ready' && a.supportsResume
            ? `${transport} · sessão retomável`
            : `${transport} · ${statusLabel}`;
        return (
            <div className="agent-card">
                <div className="agent-top">
                    <div className="agent-orb">{orb}</div>
                    <div><span className="nm">{name}</span><small>{sub}</small></div>
                    <span className="agent-status" style={{ marginLeft: 'auto', color, fontWeight: 600, fontSize: '11px' }}>
                        ● {statusLabel}
                    </span>
                </div>
                {a.detail && (
                    <div className="krow"><span>Estado</span><b style={{ color }}>{a.detail}</b></div>
                )}
                {a.detectedVersion && (
                    <div className="krow"><span>Versão detectada</span><b>{a.detectedVersion}</b></div>
                )}
                {(a.adapterVersion || a.targetVersion) && (
                    <div className="krow"><span>Adaptador</span><b>{a.adapterVersion || '—'} → {a.targetVersion || '—'}</b></div>
                )}
                <div className="krow"><span>Resume / steer</span><b>{a.supportsResume ? 'sim' : 'não'} / {a.supportsSteer ? 'sim' : 'não'}</b></div>
                {a.degradations.length > 0 && (
                    <div className="agent-degr">
                        <span className="tag">fora do gate da IDE</span>
                        {a.degradations.map((d, i) => <div key={i} className="e">{d}</div>)}
                    </div>
                )}
            </div>
        );
    }

    protected renderDecision(): React.ReactNode {
        // REAL (M3): once a governed write has been proposed, the decision card is
        // the canonical surface of that real pending write over a real file.
        if (this.store.proposal) {
            return this.renderGovernedDecision();
        }
        return this.renderNoProposal();
    }

    /** The REAL governed-write decision card: path + real ide-diff summary +
     *  Permitir (approve → real file write) and Reverter (rollback → snapshot). */
    protected renderGovernedDecision(): React.ReactNode {
        const p = this.store.proposal!;
        const summary = `+${p.addedLines} / -${p.removedLines} · ${p.hunkCount} hunk(s)`;
        const diff = (
            <div className="diff">
                {p.preview.map((l, i) => (
                    <div key={i} className={`dl ${l.tag}`}>
                        {l.tag === 'added' ? '+ ' : l.tag === 'removed' ? '- ' : '  '}{l.text}
                    </div>
                ))}
            </div>
        );
        if (p.state === 'approved') {
            const auto = p.policy?.autoApproved === true;
            return (
                <div className="decision resolved" id="iws-decision-card">
                    <div className="st-row">
                        {auto ? 'ESCRITA APLICADA SEM PERGUNTAR' : 'ESCRITA APLICADA'}
                    </div>
                    <h4>{p.relPath} — gravado no arquivo real</h4>
                    <p>{summary}. Os bytes propostos foram escritos no disco (visível no Monaco). O snapshot anterior continua restaurável.</p>
                    {auto && (
                        <p>
                            Ninguém foi perguntado porque a política do projeto disse para não
                            perguntar. A escrita passou pelo broker do mesmo jeito: tem snapshot,
                            tem recibo na trilha e o Reverter abaixo funciona.
                        </p>
                    )}
                    {this.renderPolicy(p)}
                    {diff}
                    <div className="acts">
                        <button className="btn" onClick={() => this.commands.executeCommand(CMD_GOVERNED_ROLLBACK)}>Reverter (rollback)</button>
                    </div>
                </div>
            );
        }
        if (p.state === 'rolledback') {
            return (
                <div className="decision resolved" id="iws-decision-card">
                    <div className="st-row">REVERTIDA</div>
                    <h4>{p.relPath} — snapshot restaurado</h4>
                    <p>O arquivo real voltou ao conteúdo de antes da escrita. Proponha novamente para repetir o ciclo.</p>
                    <div className="acts">
                        <button className="btn pri" onClick={() => this.commands.executeCommand(CMD_GOVERNED_PROPOSE)}>Propor de novo</button>
                    </div>
                </div>
            );
        }
        // awaiting
        return (
            <div className="decision" id="iws-decision-card">
                <div className="st-row">AGUARDANDO VOCÊ</div>
                {/* "Criar" e "gravar" são decisões diferentes, e o diff não as
                    distingue: criar arquivo produz o mesmo todo-adicionado que
                    reescrever apagando tudo. Quem decide tem de ver qual é. */}
                <h4>
                    {p.creating ? 'Criar arquivo' : 'Gravar mudança em'} {p.relPath}?
                </h4>
                <p>
                    Escrita governada sobre um arquivo real. Diff calculado pelo engine Rust
                    ide-diff · {summary}.{' '}
                    {p.creating
                        ? 'O arquivo ainda não existe: reverter apaga o que foi criado.'
                        : 'Um snapshot reversível é tirado antes — nada foi escrito ainda.'}
                </p>
                {p.warning && <p style={{ color: 'var(--need)' }}>{p.warning}</p>}
                {this.renderPolicy(p)}
                {diff}
                <div className="acts">
                    <button className="btn" onClick={() => this.commands.executeCommand(CMD_GOVERNED_PROPOSE)}>Recalcular</button>
                    <button className="btn pri" onClick={() => this.commands.executeCommand(CMD_GOVERNED_APPROVE)}>Permitir<span className="kbd">⏎</span></button>
                </div>
            </div>
        );
    }

    /**
     * §14 — the rule in force, named on the card that obeys it.
     *
     * Without this the button reads as a law of nature; with it, "Permitir"
     * visibly comes from a mode and a permission the person set and can change.
     * When the policy engine did not answer, that is said too — the card never
     * implies a rule was applied when none was consulted.
     */
    protected renderPolicy(p: WriteProposal): React.ReactNode {
        if (!p.policy) {
            return (
                <p className="pol">
                    política de efeito indisponível — esta proposta ficou aguardando decisão,
                    que é o lado que não perde dado
                </p>
            );
        }
        return (
            <p className="pol">
                modo <b>{p.policy.mode}</b> · permissões <b>{p.policy.permissions}</b>
                {p.policy.scoped ? ' (regra com escopo próprio)' : ''} — {p.policy.explain}
            </p>
        );
    }

    /** No governed write proposed yet. The dock says exactly that and offers the
     *  real action — it does NOT invent a pending migration to look busy. */
    protected renderNoProposal(): React.ReactNode {
        return (
            <div className="decision resolved" id="iws-decision-card">
                <div className="st-row" style={{ color: 'var(--faint)' }}>NADA AGUARDANDO</div>
                <h4>Nenhuma escrita proposta</h4>
                <p>
                    Toda escrita de agente ou provider passa pelo broker e aparece aqui antes
                    de tocar o disco. Proponha uma para ver o ciclo: diff, aprovação, snapshot
                    e rollback.
                </p>
                <div className="acts">
                    <button
                        className="btn pri"
                        onClick={() => this.commands.executeCommand(CMD_GOVERNED_PROPOSE)}
                    >
                        Propor mudança (governed)
                    </button>
                </div>
            </div>
        );
    }
}
