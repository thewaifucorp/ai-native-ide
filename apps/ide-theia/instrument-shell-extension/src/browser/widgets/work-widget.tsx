// WORK SURFACE — the central column: Overview ("what is true about this project
// right now") and Build ("intention ↔ agent session").
//
// HONESTY PASS (M10). What used to be here was a sketch rendered as if it were
// live: a goal sentence about an auction nobody had stated, an "Agora" list
// claiming Codex was on step 3 of 4 and a preview was live on localhost:3000, a
// "Marco atual" bar at "3 de 5 critérios verificados", four timestamped
// "Recentes" entries, two fake editor tabs, and a Build view with an invented
// conversation plus a fake rendered website. None of it came from the project.
//
// Overview now renders only what the IDE actually knows: the real workspace, the
// capability states the backend detected, the real agent probe, the broker's own
// trail, the harness slot bindings, and the real pending governed write. Where a
// surface is genuinely queued work (checks/preview/evidence, the semantic product
// model), it is drawn as an explicit placeholder — never as data.

import * as React from 'react';
import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { AbstractInstrumentWidget } from './abstract-instrument-widget';
import { CMD_OPEN_RESOURCE } from '../instrument-data-contribution';
import { CMD_BROKER_TRAIL } from '../instrument-capability-contribution';
import { CapabilityState } from '../../common/capability-protocol';

/** Short label per broker event kind, for the recent-activity list. */
const KIND_LABEL: Record<string, string> = {
    proposed: 'proposta',
    awaiting_approval: 'decisão',
    snapshot_created: 'checkpoint',
    executed: 'escrita',
    rolled_back: 'rollback'
};

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
                </div>
                {this.renderHome(view === 'home')}
                {this.renderBuild(view === 'build')}
            </main>
        );
    }

    // ── Overview ────────────────────────────────────────────────────────────

    protected renderHome(on: boolean): React.ReactNode {
        return (
            <section className={`view${on ? ' on' : ''}`} id="view-home">
                <div className="home-main">
                    {this.renderProjectHeader()}
                    {this.renderNeedsYou()}
                    {this.renderCapabilitySummary()}
                    {this.renderQueuedSurfaces()}
                </div>
                <div className="home-side">
                    {this.renderResources()}
                    {this.renderRecent()}
                    {this.renderHarnessSummary()}
                </div>
            </section>
        );
    }

    /** The real opened project: name, root path, resource count. */
    protected renderProjectHeader(): React.ReactNode {
        const root = this.store.workspaceRootUri;
        const path = root ? decodeURIComponent(root.replace(/^file:\/\//, '')) : 'nenhum projeto aberto';
        return (
            <div className="h-sec continue">
                <h1 className="goal">{this.store.workspaceName || 'nenhum projeto aberto'}</h1>
                <div className="next">
                    <span title={path}>{path}</span>
                </div>
            </div>
        );
    }

    /** Real pending work only: the governed write awaiting a human. */
    protected renderNeedsYou(): React.ReactNode {
        const proposal = this.store.proposal;
        const awaiting = proposal && proposal.state === 'awaiting' ? proposal : undefined;
        const drifts = this.store.observer?.drifts ?? [];
        return (
            <div className="h-sec">
                <span className="tag">Precisa de você</span>
                <div className="need">
                    {drifts.length > 0 && (
                        <div className="need-item">
                            <div className="txt">
                                <b>
                                    {drifts.length} arquivo(s) mudaram fora do IDE
                                </b>
                                <small>
                                    {drifts.slice(0, 3).map(d => `${d.relPath} (${d.kind})`).join(' · ')}
                                    {drifts.length > 3 ? ' …' : ''} — escrita de agente, script ou
                                    terminal. Aceite como nova referência ou proponha a reversão.
                                </small>
                            </div>
                            <div className="acts">
                                <button
                                    className="btn"
                                    onClick={() => this.commands.executeCommand('instrument.mode.ferramentas')}
                                >
                                    Conciliar
                                </button>
                            </div>
                        </div>
                    )}
                    {!awaiting && drifts.length === 0 && (
                        <div className="need-item">
                            <div className="txt">
                                <b>Nada aguardando decisão</b>
                                <small>
                                    Escritas de agente ou de provider param no broker e aparecem aqui
                                    e no dock antes de tocar o disco.
                                </small>
                            </div>
                        </div>
                    )}
                    {awaiting && (
                        <div className="need-item">
                            <div className="txt">
                                <b>Gravar mudança em {awaiting.relPath}?</b>
                                <small>
                                    +{awaiting.addedLines} / -{awaiting.removedLines} · {awaiting.hunkCount} hunk(s),
                                    calculados pelo engine Rust. Nada foi escrito ainda.
                                </small>
                            </div>
                            <div className="acts">
                                <button className="btn" onClick={() => this.store.focusDecision()}>Revisar no dock</button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    /** The capability states the backend registry actually detected. */
    protected renderCapabilitySummary(): React.ReactNode {
        const capabilities = this.store.capabilities;
        return (
            <div className="h-sec">
                <span className="tag">Capabilities deste projeto</span>
                <div className="prod-map">
                    {!this.store.capabilitiesDetected && (
                        <div className="prod-row"><span className="st idle" /><span className="nm">—</span><span className="ds">detectando…</span></div>
                    )}
                    {this.store.capabilitiesDetected && capabilities.length === 0 && (
                        <div className="prod-row"><span className="st idle" /><span className="nm">—</span><span className="ds">nenhuma capability registrada</span></div>
                    )}
                    {capabilities.map(c => (
                        <div
                            key={c.id}
                            className="prod-row"
                            role="button"
                            style={{ cursor: 'pointer' }}
                            title={c.detail}
                            onClick={() => this.commands.executeCommand('instrument.mode.ferramentas')}
                        >
                            <span className={`st ${this.dotFor(c)}`} />
                            <span className="nm">{c.label}</span>
                            <span className="ds">{c.status}</span>
                            <span className="lb">ver</span>
                        </div>
                    ))}
                    {this.renderAgentRow()}
                </div>
            </div>
        );
    }

    /** Honest dot: only a genuinely ready capability gets the healthy colour. */
    protected dotFor(capability: CapabilityState): string {
        return capability.status === 'ready' ? 'ok' : capability.status === 'degraded' ? 'run' : 'idle';
    }

    protected renderAgentRow(): React.ReactNode {
        const agent = this.store.agent;
        return (
            <div className="prod-row" title={agent?.detail ?? 'sondando o adaptador'}>
                <span className={`st ${agent?.availability === 'ready' ? 'ok' : agent ? 'run' : 'idle'}`} />
                <span className="nm">Agente {agent ? agent.agent : ''}</span>
                <span className="ds">{agent ? agent.availability : 'sondando…'}</span>
            </div>
        );
    }

    /** What this surface will hold, stated as queued work instead of faked. */
    protected renderQueuedSurfaces(): React.ReactNode {
        return (
            <div className="h-sec">
                <span className="tag">Ainda não medido<span className="queued">na fila</span></span>
                <div className="placeholder">
                    <b>Checks, preview e evidência</b>
                    <p>
                        Nenhum motor de checks, preview ou reconciliação roda aqui ainda, então esta
                        área não mostra números. Quando rodar, cada resultado vem com o comando cru
                        que o produziu — e `unknown` / `não executado` não vira verde.
                    </p>
                </div>
                <div className="placeholder">
                    <b>Produto semântico e divergências</b>
                    <p>
                        Recursos, autoridades, consumidores e o arquivo causal do projeto (a visão
                        Produto ainda é um esboço). A divergência plantada neste workspace — o
                        desempate por ordem de criação em `auction.ts` contra o que
                        `docs/product-intent.md` declara — é o caso de prova.
                    </p>
                </div>
            </div>
        );
    }

    // ── side column ─────────────────────────────────────────────────────────

    protected renderResources(): React.ReactNode {
        return (
            <div className="h-sec">
                <span className="tag">Recursos do workspace</span>
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
        );
    }

    /** Recent = the broker's real trail for this project, read on demand. */
    protected renderRecent(): React.ReactNode {
        const trail = this.store.brokerActivity;
        return (
            <div className="recent">
                <span className="tag">
                    Efeitos governados
                    <button
                        className="cap-btn tiny"
                        disabled={this.store.brokerActivityBusy}
                        onClick={() => this.commands.executeCommand(CMD_BROKER_TRAIL)}
                    >
                        {this.store.brokerActivityBusy ? '…' : 'ler'}
                    </button>
                </span>
                {trail === undefined && <div className="r"><span>trilha não lida</span></div>}
                {trail && trail.length === 0 && <div className="r"><span>nenhum efeito registrado neste projeto</span></div>}
                {trail && trail.slice(-6).reverse().map((e, i) => (
                    <div className="r" key={`${e.effect_id}:${e.kind}:${i}`}>
                        <time>{KIND_LABEL[e.kind] ?? e.kind}</time>
                        <span>{e.path ? e.path.split('/').slice(-2).join('/') : e.effect_id}</span>
                    </div>
                ))}
            </div>
        );
    }

    /** Who owns the project's exclusive harness slots, if anyone. */
    protected renderHarnessSummary(): React.ReactNode {
        const harness = this.store.harness;
        const taken = harness ? harness.bindings.filter(b => b.providerId) : [];
        return (
            <div className="quest">
                <span className="tag">Harness do projeto</span>
                {!harness && <p>lendo o registry…</p>}
                {harness && taken.length === 0 && (
                    <p>Nenhum provider assumiu os slots de workflow, hierarquia ou status principal.</p>
                )}
                {harness && taken.length > 0 && (
                    <p>
                        {taken.map(b => `${b.slot}: ${b.providerId}`).join(' · ')}
                    </p>
                )}
                {harness && (
                    <small>{harness.composedExtensions.length} extensões compostas</small>
                )}
            </div>
        );
    }

    // ── Build ───────────────────────────────────────────────────────────────

    /** The agent-session surface. It has a real probe and no session wiring yet,
     *  so it says exactly that instead of replaying an invented conversation. */
    protected renderBuild(on: boolean): React.ReactNode {
        const agent = this.store.agent;
        return (
            <section className={`view${on ? ' on' : ''}`} id="view-build">
                <div className="conv">
                    <div className="conv-scroll">
                        <h2 className="goal">Sessão de agente</h2>
                        <div className="placeholder">
                            <b>Adaptador detectado, sessão ainda não ligada</b>
                            <p>
                                {agent
                                    ? `${agent.agent} · ${agent.availability}${agent.detectedVersion ? ` · ${agent.detectedVersion}` : ''}` +
                                    `${agent.transport ? ` · transporte ${agent.transport}` : ''}.`
                                    : 'Sondando o adaptador de agente…'}
                            </p>
                            <p>
                                O IDE já sonda o adaptador de verdade e já governa toda escrita pelo
                                broker. O que falta aqui é a sessão: mandar intenção, receber passos e
                                ligar cada efeito ao seu recibo. Enquanto isso, este painel não simula
                                conversa — use o modo Agentes na view Ferramentas para ver o estado real
                                do adaptador.
                            </p>
                        </div>
                        {agent && agent.degradations.length > 0 && (
                            <div className="placeholder">
                                <b>Fora do gate do IDE</b>
                                <ul className="cap-degr">
                                    {agent.degradations.map(d => <li key={d}>{d}</li>)}
                                </ul>
                            </div>
                        )}
                    </div>
                </div>

                <div className="preview">
                    <div className="pv-bar">
                        <span className="pv-url">preview não configurado</span>
                    </div>
                    <div className="pv-body">
                        <div className="placeholder">
                            <b>Sem preview</b>
                            <p>
                                Nenhum servidor de preview foi detectado ou iniciado para este projeto.
                                Um preview falso já ocupou este espaço; agora o espaço fica vazio até
                                existir um processo real para mostrar.
                            </p>
                        </div>
                    </div>
                </div>
            </section>
        );
    }
}
