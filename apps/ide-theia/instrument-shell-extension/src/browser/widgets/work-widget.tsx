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
import {
    CMD_BROKER_TRAIL,
    CMD_CHECKS_RUN,
    CMD_SESSION_CANCEL,
    CMD_SESSION_PERMISSION,
    CMD_SESSION_HARVEST,
    CMD_SESSION_START,
    CMD_SESSION_SUBMIT
} from '../instrument-capability-contribution';
import { CapabilityState } from '../../common/capability-protocol';

/** State words shown on a finding.
 *
 *  `não executado` and `desconhecido` get their own words on purpose: rendering
 *  either as a neutral tick would make an absence of knowledge look like a
 *  small pass, which is the one thing this surface must never do. */
const CHECK_STATE_LABEL: Record<string, string> = {
    passed: 'passou',
    failed: 'falhou',
    unknown: 'desconhecido',
    not_run: 'não executado'
};

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
                                    {drifts.length > 3 ? ' …' : ''} — autoria não identificada pelo IDE:
                                    agente externo, script ou terminal. Aceite como nova referência ou
                                    proponha a reversão.
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

    /**
     * The deterministic Layer-0 report (§4).
     *
     * Two rules drive every branch below, and both are the point of the surface
     * rather than decoration:
     *  • `unknown` / `não executado` never render as approval. They get their own
     *    state word and their own colour, never the green one.
     *  • a result always shows the observed fact that produced it — for a tool
     *    check that is the raw command and its exit status.
     */
    protected renderChecks(): React.ReactNode {
        const run = this.store.checks;
        const busy = this.store.checksBusy;

        if (!run) {
            return (
                <div className="cap-card">
                    <div className="cap-head">
                        <b>Checks determinísticos</b>
                        <span className="cap-pill not-installed">não executados</span>
                    </div>
                    <small className="cap-hint">
                        nada foi medido nesta sessão · rodar os comandos declarados é ato explícito,
                        nunca automático ao abrir o projeto
                    </small>
                    <div className="cap-actions">
                        <button
                            className="cap-btn primary"
                            disabled={busy}
                            onClick={() => this.commands.executeCommand(CMD_CHECKS_RUN, false)}
                        >
                            {busy ? 'medindo…' : 'Medir'}
                        </button>
                        <button
                            className="cap-btn"
                            disabled={busy}
                            title="Também executa build/testes/tipos declarados em .instrument/checks.json"
                            onClick={() => this.commands.executeCommand(CMD_CHECKS_RUN, true)}
                        >
                            Medir e rodar comandos
                        </button>
                    </div>
                </div>
            );
        }

        const { report } = run;
        // A run with no failures is NOT announced as approval while anything is
        // unknown or not run — that is exactly the conflation the engine avoids.
        const settled = report.unknown === 0 && report.notRun === 0;
        const pill = report.failed > 0 ? 'unavailable' : settled ? 'ready' : 'not-installed';
        const verdict =
            report.failed > 0
                ? `${report.failed} falhando`
                : settled
                    ? 'tudo passou'
                    : 'sem falhas, mas incompleto';

        return (
            <div className="cap-card">
                <div className="cap-head">
                    <b>Checks determinísticos</b>
                    <span className={`cap-pill ${pill}`}>{verdict}</span>
                </div>
                <small className="cap-hint">
                    {report.passed} passou · {report.failed} falhou · {report.unknown} desconhecido ·{' '}
                    {report.notRun} não executado — desconhecido e não executado não são aprovação
                </small>
                {run.not_run_reason && <p className="cap-detail">{run.not_run_reason}</p>}
                <small className="cap-hint">
                    varredura leu {run.files_scanned} arquivo(s)
                    {run.files_skipped > 0 && ` · ${run.files_skipped} pulado(s) por tamanho ou leitura`}
                </small>

                {run.declared.length > 0 && (
                    <small className="cap-hint">
                        declarado: {run.declared.map(d => `${d.slug} → ${d.command}`).join(' · ')}
                    </small>
                )}

                {report.findings.map(f => (
                    <div className="cap-receipt" key={f.id}>
                        <span className={`cap-receipt-action check-${f.state}`}>
                            {CHECK_STATE_LABEL[f.state]}
                        </span>
                        <span className="cap-receipt-detail">{f.title}</span>
                        <small>{f.evidence}</small>
                        {f.remediation && <small className="cap-remediation">{f.remediation}</small>}
                    </div>
                ))}

                <div className="cap-actions">
                    <button
                        className="cap-btn"
                        disabled={busy}
                        onClick={() => this.commands.executeCommand(CMD_CHECKS_RUN, false)}
                    >
                        {busy ? 'medindo…' : 'Medir de novo'}
                    </button>
                    <button
                        className="cap-btn"
                        disabled={busy}
                        title="Também executa build/testes/tipos declarados em .instrument/checks.json"
                        onClick={() => this.commands.executeCommand(CMD_CHECKS_RUN, true)}
                    >
                        Medir e rodar comandos
                    </button>
                </div>
            </div>
        );
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
                {this.renderChecks()}
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

    /** The agent-session surface: a REAL ACP session hosted by the IDE.
     *
     *  The agent works inside a git worktree, so nothing it writes is in the
     *  project. `Colher` compares worktree against project and proposes each
     *  change through the broker — the pre-disk path an external CLI agent cannot
     *  give us. */
    protected renderBuild(on: boolean): React.ReactNode {
        const session = this.store.session;
        const agent = this.store.agent;
        const busy = this.store.sessionBusy;
        const phase = session?.phase ?? 'none';
        return (
            <section className={`view${on ? ' on' : ''}`} id="view-build">
                <div className="conv">
                    <div className="conv-scroll">
                        <h2 className="goal">Sessão de agente</h2>
                        <div className="cap-card">
                            <div className="cap-head">
                                <b>{session?.agent ?? agent?.agent ?? 'claude'}</b>
                                <span className={`cap-pill ${phase === 'idle' || phase === 'working' ? 'ready' : phase === 'failed' ? 'unavailable' : 'not-installed'}`}>
                                    {phase}
                                </span>
                            </div>
                            {session?.worktree && (
                                <small>worktree: {session.worktree.split('/').slice(-3).join('/')}</small>
                            )}
                            {session?.lastError && <p className="cap-detail">{session.lastError}</p>}
                            <small className="cap-hint">
                                o agente trabalha na worktree e só o broker traz mudança para o projeto ·
                                não é jaula: o adapter não aplica sandbox · permissão do agente é
                                decidida aqui, e o agente fica parado até a decisão
                            </small>
                            <div className="cap-actions">
                                {phase === 'none' || phase === 'failed' ? (
                                    <button
                                        className="cap-btn primary"
                                        disabled={busy}
                                        onClick={() => this.commands.executeCommand(CMD_SESSION_START, 'claude')}
                                    >
                                        {busy ? 'abrindo…' : 'Abrir sessão'}
                                    </button>
                                ) : (
                                    <>
                                        <button
                                            className="cap-btn primary"
                                            disabled={busy}
                                            onClick={() => this.submitPrompt(true)}
                                        >
                                            Pedir mudança
                                        </button>
                                        <button
                                            className="cap-btn"
                                            disabled={busy}
                                            onClick={() => this.submitPrompt(false)}
                                        >
                                            Perguntar
                                        </button>
                                        <button
                                            className="cap-btn"
                                            disabled={busy}
                                            title="Compara a worktree com o projeto e propõe pelo broker"
                                            onClick={() => this.commands.executeCommand(CMD_SESSION_HARVEST)}
                                        >
                                            Colher mudanças
                                        </button>
                                        <button
                                            className="cap-btn"
                                            onClick={() => this.commands.executeCommand(CMD_SESSION_CANCEL)}
                                        >
                                            Encerrar
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>

                        {session && session.pending.length > 0 && (
                            <div className="cap-card">
                                <div className="cap-head">
                                    <b>Decisão pendente</b>
                                    <span className="cap-pill not-installed">
                                        agente parado
                                    </span>
                                </div>
                                <small className="cap-hint">
                                    o agente pediu autorização e está bloqueado até você responder ·
                                    sem resposta, o pedido morre no timeout da tarefa e conta como negado
                                </small>
                                {session.pending.map(p => (
                                    <div className="cap-receipt" key={p.requestId}>
                                        <span className="cap-receipt-action">{p.action}</span>
                                        <span className="cap-receipt-detail">{p.detail}</span>
                                        {p.edits.map((edit, i) => (
                                            <div className="cap-diff" key={`${p.requestId}:${i}`}>
                                                <div className="cap-diff-head">
                                                    <span>{edit.path}</span>
                                                    {edit.oldText === undefined && (
                                                        <small title="O agente não informou o conteúdo anterior. Isso não quer dizer que o arquivo seja novo.">
                                                            sem conteúdo anterior informado
                                                        </small>
                                                    )}
                                                    {edit.truncated && (
                                                        <small className="cap-diff-cut">
                                                            preview cortado — você não está vendo o
                                                            diff inteiro
                                                        </small>
                                                    )}
                                                </div>
                                                <pre className="cap-diff-body">{edit.newText}</pre>
                                            </div>
                                        ))}
                                        {p.edits.length === 0 && (
                                            <small className="cap-hint">
                                                sem diff para mostrar — este pedido não é uma escrita
                                            </small>
                                        )}
                                        <div className="cap-actions">
                                            <button
                                                className="cap-btn primary"
                                                disabled={busy}
                                                onClick={() =>
                                                    this.commands.executeCommand(
                                                        CMD_SESSION_PERMISSION,
                                                        p.requestId,
                                                        true
                                                    )
                                                }
                                            >
                                                Permitir
                                            </button>
                                            <button
                                                className="cap-btn"
                                                disabled={busy}
                                                title="Nega e encerra o turno, para o agente não tentar o mesmo por outro caminho"
                                                onClick={() =>
                                                    this.commands.executeCommand(
                                                        CMD_SESSION_PERMISSION,
                                                        p.requestId,
                                                        false,
                                                        true
                                                    )
                                                }
                                            >
                                                Negar e encerrar
                                            </button>
                                            <button
                                                className="cap-btn"
                                                disabled={busy}
                                                title="Nega só este pedido; o turno continua"
                                                onClick={() =>
                                                    this.commands.executeCommand(
                                                        CMD_SESSION_PERMISSION,
                                                        p.requestId,
                                                        false,
                                                        false
                                                    )
                                                }
                                            >
                                                Negar
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {session && session.changes.length > 0 && (
                            <div className="cap-card">
                                <div className="cap-head"><b>Mudanças na worktree</b></div>
                                {session.changes.map(c => (
                                    <div className="cap-receipt" key={c.relPath}>
                                        <span className="cap-receipt-action">
                                            {c.proposed ? 'proposto' : 'na fila'}
                                        </span>
                                        <span className="cap-receipt-detail">
                                            {c.relPath} +{c.addedLines}/-{c.removedLines}
                                        </span>
                                        <small>{c.detail ?? c.proposalId ?? ''}</small>
                                    </div>
                                ))}
                            </div>
                        )}

                        {session && session.events.length > 0 && (
                            <div className="cap-card">
                                <div className="cap-head"><b>Sessão</b></div>
                                {session.events.slice(-24).map((e, i) => (
                                    <div className="cap-receipt" key={`${e.at}:${i}`}>
                                        <span className="cap-receipt-action">{e.kind}</span>
                                        <span className="cap-receipt-detail">{e.text}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {!session && (
                            <div className="placeholder">
                                <b>Nenhuma sessão aberta</b>
                                <p>
                                    O IDE hospeda uma sessão ACP real e é o cliente ACP (ide-agent →
                                    adapter direto → bridge do agente), então a permissão do agente
                                    é decidida aqui. O
                                    agente trabalha numa worktree git do projeto, e cada mudança dele
                                    é proposta pelo broker antes de tocar o projeto.
                                </p>
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
                            </p>
                        </div>
                    </div>
                </div>
            </section>
        );
    }

    /** Ask for the prompt with the platform dialog — the composer is next. */
    protected submitPrompt(codeChange: boolean): void {
        const prompt = window.prompt(
            codeChange
                ? 'O que o agente deve mudar no projeto?'
                : 'O que você quer perguntar ao agente?'
        );
        if (prompt) {
            this.commands.executeCommand(CMD_SESSION_SUBMIT, prompt, codeChange);
        }
    }
}
