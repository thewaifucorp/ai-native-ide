// 001 WORK SURFACE — the central column: 001 tab bar plus the two views.
//   • Home ("situação"): continue goal, Agora, Precisa de você, Produto map,
//     Marco atual (Game Mode), Recentes.
//   • Build ("intenção ↔ preview"): conversation + steps + composer next to the
//     live product preview.
// Tabs and nav both switch the view via the shared store.

import * as React from 'react';
import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { AbstractInstrumentWidget } from './abstract-instrument-widget';
import { Icon } from './icons';
import { CMD_OPEN_RESOURCE } from '../instrument-data-contribution';

@injectable()
export class WorkWidget extends AbstractInstrumentWidget {
    static readonly ID = 'instrument.work';

    @inject(CommandService) protected readonly commands!: CommandService;

    protected configure(): void {
        this.id = WorkWidget.ID;
        this.title.label = 'Overview';
        this.title.caption = this.store.workspaceName || 'Overview';
        this.title.closable = false;
        this.addClass('iws-work-host');
    }

    protected render(): React.ReactNode {
        const { view } = this.store;
        return (
            <main className="work">
                <div className="tabs">
                    <button className={`tab${view === 'home' ? ' on' : ''}`} onClick={() => this.store.setView('home')}>Overview</button>
                    <button className={`tab${view === 'build' ? ' on' : ''}`} onClick={() => this.store.setView('build')}><span className="mod" />Build</button>
                    <button className="tab file">product-intent.md</button>
                    <button className="tab file">auction.ts</button>
                    <button className="tab new" title="Nova aba"><Icon name="plus" style={{ width: 12, height: 12 }} /></button>
                </div>
                {this.renderHome(view === 'home')}
                {this.renderBuild(view === 'build')}
            </main>
        );
    }

    protected renderHome(on: boolean): React.ReactNode {
        return (
            <section className={`view${on ? ' on' : ''}`} id="view-home">
                <div className="home-main">
                    <div className="h-sec continue">
                        <h1 className="goal">Permitir que aplicações disputem a primeira posição <em>sem ver o lance vencedor</em>.</h1>
                        <div className="next">
                            <button className="btn pri lg" onClick={() => this.store.setView('build')}>Retomar a sessão<span className="kbd">⏎</span></button>
                            <span>próximo resultado: ranking à prova de concorrência, testável no preview</span>
                        </div>
                    </div>

                    <div className="h-sec">
                        <span className="tag">Agora</span>
                        <div className="now-list">
                            <div className="now-row">
                                <span className="live" />
                                <span className="who">Codex · app-web</span>
                                <span className="what">Verificando se dois lances simultâneos podem furar a reserva.</span>
                                <span className="meta">passo 3 de 4</span>
                            </div>
                            <div className="now-row">
                                <span className="live ok" />
                                <span className="who">Preview · localhost:3000</span>
                                <span className="what">Refletindo a última alteração. A campanha já aceita lances de teste.</span>
                                <span className="meta">agora</span>
                            </div>
                        </div>
                    </div>

                    <div className="h-sec">
                        <span className="tag">Precisa de você</span>
                        <div className="need">

                            <div className="need-item">
                                <div className="txt">
                                    <b>Empate entre lances usa ordem de criação</b>
                                    <small>Sua intenção não define desempate. Isso pode favorecer quem chegou antes.</small>
                                </div>
                                <div className="acts">
                                    <button className="btn" onClick={() => this.store.toast('Divergência aberta ao lado do preview')}>Entender</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="home-side">
                    <div className="h-sec">
                        {/* REAL: the opened workspace's top-level resources (WorkspaceService +
                            FileService). Clicking a row opens it in the real Monaco/explorer. */}
                        <span className="tag">Recursos do workspace · {this.store.workspaceName || 'workspace'}</span>
                        <div className="prod-map">
                            {this.store.resources.length === 0 &&
                                <div className="prod-row"><span className="st idle" /><span className="nm">—</span><span className="ds">nenhum recurso no topo</span></div>}
                            {this.store.resources.map(r => (
                                <div
                                    key={r.uri}
                                    className="prod-row"
                                    role="button"
                                    title={r.isDir ? `Abrir pasta ${r.name}` : `Abrir ${r.name}`}
                                    style={{ cursor: 'pointer' }}
                                    onClick={() => this.commands.executeCommand(CMD_OPEN_RESOURCE, r.uri)}
                                >
                                    <span className={`st ${r.isDir ? 'idle' : 'ok'}`} />
                                    <span className="nm">{r.name}</span>
                                    <span className="ds">{r.isDir ? 'pasta' : 'arquivo'}</span>
                                    <span className="lb">abrir</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="quest">
                        <span className="tag">Marco atual</span>
                        <p>Um lance disputado por duas pessoas ao mesmo tempo termina com um único vencedor.</p>
                        <div className="qbar"><i /></div>
                        <small>3 de 5 critérios verificados</small>
                    </div>

                    <div className="recent">
                        <span className="tag">Recentes</span>
                        <div className="r"><time>14:32</time><span>Você pediu: <em>“ninguém pode pagar depois de ver o lance vencedor”</em></span></div>
                        <div className="r"><time>14:35</time><span>Codex protegeu o endpoint de lances por sessão</span></div>
                        <div className="r"><time>14:41</time><span>Checkpoint criado antes da mudança no schema</span></div>
                        <div className="r"><time>14:44</time><span>Preview atualizado com a lista de campanhas</span></div>
                    </div>
                </div>
            </section>
        );
    }

    protected renderBuild(on: boolean): React.ReactNode {
        return (
            <section className={`view${on ? ' on' : ''}`} id="view-build">
                <div className="conv">
                    <div className="conv-scroll">
                        <h2 className="goal">Aplicações disputam a primeira posição sem ver o lance vencedor.</h2>
                        <div className="msg user">
                            <div className="bubble">Quero que a maior oferta fique em primeiro, mas ninguém pode pagar depois de ver o lance vencedor.</div>
                        </div>
                        <div className="msg agent">
                            <div className="head"><span className="live" />CODEX · APP-WEB</div>
                            <div className="body">
                                Entendi como <strong>leilão selado</strong>: o valor de cada lance fica reservado e escondido até o fechamento.
                                Implementei a reserva e agora estou verificando o que acontece se duas pessoas derem lances no mesmo instante.
                                <div className="steps">
                                    <div className="step done"><Icon name="check" />schema de lances com valor selado</div>
                                    <div className="step done"><Icon name="check" />endpoint protegido por sessão</div>
                                    <div className="step run"><Icon name="dot" />teste de concorrência em andamento</div>
                                    <div className="step"><Icon name="circle" />reconciliar desempate com sua intenção</div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="composer">
                        <input placeholder="Peça uma mudança ou pergunte o porquê…" />
                        <div className="foot">
                            <span className="hint"><em>Tab</em> completa o que falta decidir</span>
                            <span>Hybrid · efeitos locais liberados</span>
                        </div>
                    </div>
                </div>

                <div className="preview">
                    <div className="pv-bar">
                        <Icon name="refresh" />
                        <span className="pv-url">localhost:3000/campanhas</span>
                        <Icon name="more" />
                    </div>
                    <div className="pv-body">
                        <div className="site">
                            <div className="site-nav">
                                <span className="site-brand">MELHOR/LANCE</span>
                                <button className="site-cta">Anunciar aplicação</button>
                            </div>
                            <div className="site-hero">
                                <h2>Descubra o que estão construindo.</h2>
                                <p>Aplicações independentes disputam visibilidade de forma transparente.</p>
                            </div>
                            <div className="bids">
                                <div className="bid first"><span className="rk">1</span><span><b>Fluxo Fiscal</b><small>Automação para pequenas empresas</small></span><span className="pr">R$ 84</span></div>
                                <div className="bid"><span className="rk">2</span><span><b>Agenda Clara</b><small>Reservas sem mensalidade</small></span><span className="pr">R$ 61</span></div>
                                <div className="bid"><span className="rk">3</span><span><b>Pedido Zap</b><small>Catálogo e pedidos locais</small></span><span className="pr">R$ 43</span></div>
                            </div>
                        </div>
                    </div>
                    <div className="pv-foot">
                        <span><b>Divergência.</b> O empate ainda usa ordem de criação — sua intenção não define isso.</span>
                        <button className="btn" onClick={() => this.store.toast('Divergência explicada: opções de desempate propostas')}>Entender</button>
                    </div>
                </div>
            </section>
        );
    }
}
