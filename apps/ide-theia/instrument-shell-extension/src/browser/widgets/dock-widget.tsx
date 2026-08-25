// 001 CONTEXT DOCK — 288px right column: active-agent card (scope, effects,
// context %, budget), the decision card (pending → executing → verified), and the
// Game Mode progression (level with receipt). The decision card is the canonical
// surface of the pending decision; "Permitir" runs the shared approve flow.

import * as React from 'react';
import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { AbstractInstrumentWidget } from './abstract-instrument-widget';
import {
    CMD_GOVERNED_PROPOSE,
    CMD_GOVERNED_APPROVE,
    CMD_GOVERNED_ROLLBACK
} from '../instrument-data-contribution';

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
                <div className="agent-card">
                    <div className="agent-top">
                        <div className="agent-orb">C</div>
                        <div><span className="nm">Codex</span><small>CLI · sessão retomável</small></div>
                    </div>
                    <div className="krow"><span>Escopo</span><b>app-web apenas</b></div>
                    <div className="krow"><span>Efeitos permitidos</span><b>locais e reversíveis</b></div>
                    <div className="krow"><span>Contexto usado</span><b className="em">68%</b></div>
                    <div className="meter"><i style={{ width: '68%' }} /></div>
                    <div className="krow"><span>Budget da sessão</span><b className="em">dentro do limite</b></div>
                    <button className="btn" onClick={() => this.store.toast('Detalhes de uso: R$ 0,84 · 1.8k tokens · nenhuma inferência em idle')}>Ver uso detalhado</button>
                </div>

                {this.renderDecision()}

                <div className="prog">
                    <div className="prog-top">
                        <div className="prog-lvl">7</div>
                        <div className="who">
                            <b>Explorer</b>
                            <small>nível 7 · leitura descritiva</small>
                        </div>
                    </div>
                    <div className="prog-bar"><i style={{ width: `${this.store.lvlBarPct}%` }} /></div>
                    <div className="prog-next">{this.store.lvlNextText}</div>
                    <div className="prog-earn">
                        <span className="tag">Rendeu hoje</span>
                        <div className="e"><em>+1</em>intenção esclarecida</div>
                        <div className="e"><em>+2</em>hipóteses testadas no preview</div>
                        <div className="e"><em>+1</em>finding resolvido sem regressão</div>
                    </div>
                    <div className="prog-never">nunca rende: <b>tokens, horas, linhas, prompts</b></div>
                    <div className="prog-arch">também presente: Architect · <button>ocultar leitura</button></div>
                </div>
            </aside>
        );
    }

    protected renderDecision(): React.ReactNode {
        // REAL (M3): once a governed write has been proposed, the decision card is
        // the canonical surface of that real pending write over a real file.
        if (this.store.proposal) {
            return this.renderGovernedDecision();
        }
        return this.renderMockDecision();
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
            return (
                <div className="decision resolved" id="iws-decision-card">
                    <div className="st-row">ESCRITA APLICADA</div>
                    <h4>{p.relPath} — gravado no arquivo real</h4>
                    <p>{summary}. Os bytes propostos foram escritos no disco (visível no Monaco). O snapshot anterior continua restaurável.</p>
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
                <h4>Gravar mudança em {p.relPath}?</h4>
                <p>Escrita governada sobre um arquivo real. Diff calculado pelo engine Rust ide-diff · {summary}. Um snapshot reversível é tirado antes — nada foi escrito ainda.</p>
                {diff}
                <div className="acts">
                    <button className="btn" onClick={() => this.commands.executeCommand(CMD_GOVERNED_PROPOSE)}>Recalcular</button>
                    <button className="btn pri" onClick={() => this.commands.executeCommand(CMD_GOVERNED_APPROVE)}>Permitir<span className="kbd">⏎</span></button>
                </div>
            </div>
        );
    }

    /** The original bespoke (mock) migration decision — shown until the user
     *  proposes a real governed write. Kept as atmosphere; not wired to disk. */
    protected renderMockDecision(): React.ReactNode {
        const { decision } = this.store;
        if (decision === 'executing') {
            return (
                <div className="decision resolved" id="iws-decision-card">
                    <div className="st-row" style={{ color: 'var(--step)' }}>EXECUTANDO</div>
                    <h4>Aplicando migration local</h4>
                    <p>Checkpoint 14:45 criado. O progresso só será concedido depois dos checks e do preview saudável.</p>
                </div>
            );
        }
        if (decision === 'verified') {
            return (
                <div className="decision resolved" id="iws-decision-card">
                    <div className="st-row">VERIFICADA</div>
                    <h4>Migration aplicada com segurança</h4>
                    <p>Checks passaram e o preview voltou saudável. Checkpoint 14:45 permanece restaurável.</p>
                </div>
            );
        }
        return (
            <div className="decision" id="iws-decision-card">
                <div className="st-row">AGUARDANDO VOCÊ</div>
                <h4>Executar migration no banco local?</h4>
                <p>Altera dados de desenvolvimento. Um checkpoint reversível é criado antes — dá para desfazer em um clique.</p>
                <div className="acts">
                    <button className="btn" onClick={() => this.store.toast('Diff da migration aberto na Work Surface')}>Ver o que muda</button>
                    <button className="btn pri" onClick={() => this.store.approve()}>Permitir<span className="kbd">⏎</span></button>
                </div>
            </div>
        );
    }
}
