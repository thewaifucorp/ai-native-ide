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
    CMD_ADOPT_COMMAND,
    CMD_MATERIALS_ANALYZE,
    CMD_ADOPT_CONFIG,
    CMD_PROPOSE_GUIDANCE,
    CMD_REGISTER_REFERENCE,
    CMD_CHECKS_RUN,
    CMD_CONTEXT_COMPILE,
    CMD_INTENT_DECIDE,
    CMD_INTENT_REVIEW,
    CMD_NOTES_CREATE,
    CMD_NOTES_MERGE,
    CMD_NOTES_PROMOTE,
    CMD_NOTES_READ,
    CMD_NOTES_RESOLVE,
    CMD_IGNORE_RUNTIME_STATE,
    CMD_PREVIEW_RESTART,
    CMD_PREVIEW_START,
    CMD_PREVIEW_STATUS,
    CMD_PREVIEW_STOP,
    CMD_RECONCILE_SCAN,
    CMD_RECONCILE_DECIDE,
    CMD_SESSION_ADAPTERS,
    CMD_SESSION_CANCEL,
    CMD_SESSION_DISCARD,
    CMD_SESSION_SWAP,
    CMD_SESSION_PERMISSION,
    CMD_SESSION_HARVEST,
    CMD_SESSION_START,
    CMD_SESSION_SUBMIT
} from '../instrument-capability-contribution';
import { CapabilityState } from '../../common/capability-protocol';
import { AdapterCard, DivergenceView, PreviewHealth } from 'engine-extension';

/** Word shown for each preview health. `stale` is a preview that WAS healthy and
 *  stopped answering — recoverable, and deliberately not the same word as broken. */
const PREVIEW_HEALTH_LABEL: Record<PreviewHealth, string> = {
    starting: 'iniciando',
    healthy: 'saudável',
    stale: 'sem responder',
    broken: 'quebrado',
    reconnecting: 'reconectando'
};

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
                    <button
                        className={`tab${view === 'notas' ? ' on' : ''}`}
                        onClick={() => this.store.setView('notas')}
                        title="Notas por tema, e os conflitos entre elas, guidance e SoTs"
                    >
                        Notas
                        {this.store.noteConflictCount > 0 && ` (${this.store.noteConflictCount})`}
                    </button>
                </div>
                {this.renderHome(view === 'home')}
                {this.renderBuild(view === 'build')}
                {this.renderNotes(view === 'notas')}
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
        // Abrir o projeto CRIA `.instrument/`, e num repositório de verdade isso
        // aparece como diretório não rastreado. Enquanto ninguém disse isso, a
        // pessoa descobre pelo `git status` — que é a pior forma de descobrir.
        const runtime = this.store.runtimeState;
        const avisaRuntime = !!runtime && runtime.exists && runtime.gitRepo && !runtime.ignored;
        return (
            <div className="h-sec">
                <span className="tag">Precisa de você</span>
                <div className="need">
                    {avisaRuntime && (
                        <div className="need-item">
                            <div className="txt">
                                <b>
                                    O IDE criou <code>{runtime!.dir}/</code> neste repositório
                                </b>
                                <small>
                                    {runtime!.contents.length > 0
                                        ? `Guarda ${runtime!.contents.join('; ')}. `
                                        : ''}
                                    Precisa existir antes do primeiro efeito, e o Git ainda não o
                                    ignora — então ele aparece no seu <code>git status</code>. Ignorar
                                    é uma escrita como qualquer outra: vai ao broker e espera você.
                                </small>
                            </div>
                            <div className="acts">
                                <button
                                    className="btn"
                                    onClick={() =>
                                        this.commands.executeCommand(CMD_IGNORE_RUNTIME_STATE)
                                    }
                                >
                                    Propor ignorar
                                </button>
                            </div>
                        </div>
                    )}
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
                    {!awaiting && drifts.length === 0 && !avisaRuntime && (
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
                                <b>
                                    {awaiting.creating ? 'Criar arquivo' : 'Gravar mudança em'}{' '}
                                    {awaiting.relPath}?
                                </b>
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
    /**
     * O que o projeto JÁ declara sobre si, ligado ao lugar onde a falta aparece.
     *
     * Achado num projeto cru: ele tinha `npm test` e `npm start` no
     * `package.json`, e o cartão dizia "nenhum comando declarado em
     * `.instrument/checks.json`" e parava ali. Build, testes e tipos ficavam NÃO
     * EXECUTADO. A detecção existia — em "Materiais do projeto" — mas a pessoa
     * tinha de saber que existia, e ir procurar. Distância entre o problema e o
     * conserto é o que separa produto de demonstração.
     *
     * Detectar não é ativar: o candidato é mostrado com a origem, e declarar é um
     * clique da pessoa. Sem análise ainda, o botão ANALISA — não adivinha.
     */
    protected renderUndeclaredCommands(nadaDeclarado: boolean): React.ReactNode {
        if (!nadaDeclarado) {
            return null;
        }
        const analysis = this.store.analysis;
        if (!analysis) {
            return (
                <div className="cap-actions">
                    <button
                        className="cap-btn"
                        disabled={this.store.analysisBusy}
                        title="Lê package.json, Makefile e afins para descobrir os comandos deste projeto"
                        onClick={() => this.commands.executeCommand(CMD_MATERIALS_ANALYZE)}
                    >
                        {this.store.analysisBusy ? 'analisando…' : 'Procurar comandos do projeto'}
                    </button>
                </div>
            );
        }
        const candidatos = analysis.commands.filter(
            candidate => candidate.runnableByChecks && !candidate.alreadyDeclared
        );
        if (candidatos.length === 0) {
            return (
                <small className="cap-hint">
                    a análise não encontrou build, testes ou tipos declarados neste projeto —
                    declarar em <code>.instrument/checks.json</code> é o que faz o harness medir
                </small>
            );
        }
        return (
            <>
                <small className="cap-hint">
                    o projeto já declara estes, e o harness ainda não os conhece:
                </small>
                {candidatos.map(candidate => (
                    <div className="cap-receipt" key={`${candidate.slug}:${candidate.command}`}>
                        <span className="cap-receipt-action check-not_run">{candidate.slug}</span>
                        <span className="cap-receipt-detail">
                            {candidate.command}
                            {candidate.cwd ? ` (em ${candidate.cwd})` : ''}
                        </span>
                        <small>{candidate.provenance.path}{candidate.provenance.line ? `:${candidate.provenance.line}` : ''} — “{candidate.provenance.excerpt}”</small>
                        <div className="cap-actions">
                            <button
                                className="cap-btn"
                                disabled={this.store.analysisBusy}
                                title={`escreve ${candidate.slug} em .instrument/checks.json`}
                                onClick={() =>
                                    this.commands.executeCommand(CMD_ADOPT_COMMAND, candidate.slug)
                                }
                            >
                                Declarar
                            </button>
                        </div>
                    </div>
                ))}
            </>
        );
    }

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
                {this.renderUndeclaredCommands(run.declared.length === 0)}
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

    /**
     * O CONTEXTO DO AGENTE (§6): o que ele receberia, e o que não receberia.
     *
     * A tela é dividida assim de propósito, porque é a divisão que responde a
     * pergunta do item — "a pessoa sabe o que o agente recebeu":
     *  • INCLUÍDO — cada segmento com origem, escopo, motivo e se é verbatim.
     *  • FORA — material real deixado de fora, com o motivo, mais a contagem de
     *    arquivos do projeto que não entraram. "Nada foi despejado" é número.
     *  • DESCONHECIDO — o que material declarado não responde. Retrieval
     *    governado não existe ainda, então isto fica desconhecido em vez de ser
     *    preenchido por varredura.
     *  • POLICY e LIMITES — as regras que valeram nesta compilação e os cortes.
     */
    protected renderContext(): React.ReactNode {
        const pkg = this.store.context;
        const busy = this.store.contextBusy;

        if (!pkg) {
            return (
                <div className="cap-card">
                    <div className="cap-head">
                        <b>Contexto do agente</b>
                        <span className="cap-pill not-installed">não compilado</span>
                    </div>
                    <small className="cap-hint">
                        pacote mínimo a partir de material declarado — guidance ATIVA de
                        `.guidance/` e autoridade de `.product/sot/` — mais a evidência
                        observada · o projeto inteiro nunca entra, e candidata não entra
                    </small>
                    <div className="cap-actions">
                        <button
                            className="cap-btn"
                            disabled={busy}
                            onClick={() => this.commands.executeCommand(CMD_CONTEXT_COMPILE)}
                        >
                            {busy ? 'compilando…' : 'Compilar contexto'}
                        </button>
                    </div>
                </div>
            );
        }

        const { compiled } = pkg;
        return (
            <div className="cap-card">
                <div className="cap-head">
                    <b>Contexto do agente</b>
                    <span className={`cap-pill ${compiled.segments.length > 0 ? 'ready' : 'not-installed'}`}>
                        {compiled.segments.length} segmento(s)
                    </span>
                </div>
                <small className="cap-hint">
                    {compiled.usedChars} de {compiled.budgetChars} caracteres ·{' '}
                    {pkg.projectFilesNotIncluded} arquivo(s) do projeto fora do pacote
                </small>

                {compiled.segments.map(segment => (
                    <div className="cap-receipt" key={segment.origin}>
                        <span className="cap-receipt-action">
                            {segment.verbatim ? 'verbatim' : 'incluído'}
                        </span>
                        <span className="cap-receipt-detail">{segment.origin}</span>
                        <small>
                            escopo {segment.scope} · {segment.reason} · prioridade{' '}
                            {segment.priority}
                        </small>
                        <small className="cap-evidence">{segment.text}</small>
                    </div>
                ))}

                {compiled.droppedForBudget.length > 0 && (
                    <p className="cap-detail">
                        cortado pelo orçamento: {compiled.droppedForBudget.join(', ')}
                    </p>
                )}

                <small className="cap-hint">Origem e versão do material lido</small>
                {pkg.sources.map((source, index) => (
                    <small className="cap-evidence" key={`${source.path}:${index}`}>
                        {source.kind} · {source.path} · {source.version}
                    </small>
                ))}

                <small className="cap-hint">Fora do pacote</small>
                {pkg.excluded.map((exclusion, index) => (
                    <div className="cap-receipt" key={`${exclusion.what}:${index}`}>
                        <span className="cap-receipt-action check-not_run">fora</span>
                        <span className="cap-receipt-detail">{exclusion.what}</span>
                        <small>{exclusion.reason}</small>
                    </div>
                ))}

                {pkg.unknown.length > 0 && (
                    <>
                        <small className="cap-hint">
                            Desconhecido — só retrieval governado responderia, e ele não existe
                            ainda
                        </small>
                        {pkg.unknown.map((item, index) => (
                            <div className="cap-receipt" key={`unknown:${index}`}>
                                <span className="cap-receipt-action check-unknown">desconhecido</span>
                                <span className="cap-receipt-detail">{item}</span>
                            </div>
                        ))}
                    </>
                )}

                {pkg.policy.map((rule, index) => (
                    <small className="cap-hint" key={`policy:${index}`}>
                        policy: {rule}
                    </small>
                ))}
                {pkg.limits.map((limit, index) => (
                    <small className="cap-remediation" key={`limit:${index}`}>
                        limite: {limit}
                    </small>
                ))}

                <div className="cap-actions">
                    <button
                        className="cap-btn"
                        disabled={busy}
                        onClick={() => this.commands.executeCommand(CMD_CONTEXT_COMPILE)}
                    >
                        {busy ? 'compilando…' : 'Compilar de novo'}
                    </button>
                </div>
            </div>
        );
    }

    /**
     * O PREVIEW (§4), supervisionado pelo motor do `ide-reconciliation`.
     *
     * Quatro estados que a tela não pode misturar, e é por isso que existem
     * quatro ramos em vez de um badge:
     *  • NÃO DECLARADO — o projeto não pediu preview nenhum. Não é falha.
     *  • DECLARADO E NÃO INICIADO — ninguém mandou subir. Também não é falha.
     *  • DE PÉ — e aí a linha da sonda mostra a resposta crua que sustenta isso.
     *  • QUEBRADO — com a evidência que o motor aceitou registrar, incluindo o
     *    rastro causal. Saída limpa NÃO aparece aqui como falha: o motor recusa,
     *    e o detalhe diz que terminou sozinho.
     */
    protected renderPreview(): React.ReactNode {
        const snapshot = this.store.preview;
        const busy = this.store.previewBusy;

        if (!snapshot) {
            return (
                <div className="cap-card">
                    <div className="cap-head">
                        <b>Preview</b>
                        <span className="cap-pill not-installed">não consultado</span>
                    </div>
                    <small className="cap-hint">
                        subir o processo que o projeto declara em `.instrument/preview.json` é ato
                        explícito · atualizar painel nunca sobe servidor
                    </small>
                    <div className="cap-actions">
                        <button
                            className="cap-btn"
                            disabled={busy}
                            onClick={() => this.commands.executeCommand(CMD_PREVIEW_STATUS)}
                        >
                            {busy ? 'lendo…' : 'Ler estado'}
                        </button>
                        <button
                            className="cap-btn primary"
                            disabled={busy}
                            onClick={() => this.commands.executeCommand(CMD_PREVIEW_START)}
                        >
                            Iniciar preview
                        </button>
                    </div>
                </div>
            );
        }

        const declared = snapshot.declared;
        const health = snapshot.state?.health;
        const pill = !declared
            ? 'not-installed'
            : health === 'healthy'
                ? 'ready'
                : health === 'broken'
                    ? 'unavailable'
                    : 'not-installed';
        const verdict = !declared
            ? 'não declarado'
            : !snapshot.state
                ? 'não iniciado'
                : snapshot.stopped
                    ? 'parado por você'
                    : PREVIEW_HEALTH_LABEL[health!];

        return (
            <div className="cap-card">
                <div className="cap-head">
                    <b>Preview</b>
                    <span className={`cap-pill ${pill}`}>{verdict}</span>
                </div>
                {!declared && <p className="cap-detail">{snapshot.notDeclaredReason}</p>}
                {declared && (
                    <small className="cap-hint">
                        declarado: `{declared.command}`
                        {declared.cwd && ` (cwd ${declared.cwd})`}
                        {declared.url ? ` · saúde em ${declared.url}` : ' · sem url de saúde'}
                    </small>
                )}
                {snapshot.state?.detail && <p className="cap-detail">{snapshot.state.detail}</p>}
                {snapshot.lastProbe && (
                    <small className="cap-hint">última sonda: {snapshot.lastProbe}</small>
                )}
                {snapshot.failures.map(f => (
                    <div className="cap-receipt" key={f.id}>
                        <span className="cap-receipt-action check-failed">falha</span>
                        <span className="cap-receipt-detail">{f.message}</span>
                        <small>
                            evidência {f.evidence_id} · rastro:{' '}
                            {[...f.causal_links.file_paths, ...f.causal_links.effect_ids].join(', ')}
                        </small>
                    </div>
                ))}
                {snapshot.logTail && (
                    <details>
                        <summary>saída crua ({snapshot.logPath})</summary>
                        <pre className="cap-raw">{snapshot.logTail}</pre>
                    </details>
                )}
                <div className="cap-actions">
                    <button
                        className="cap-btn"
                        disabled={busy}
                        onClick={() => this.commands.executeCommand(CMD_PREVIEW_STATUS)}
                    >
                        {busy ? 'lendo…' : 'Reler'}
                    </button>
                    <button
                        className="cap-btn primary"
                        disabled={busy || !declared}
                        onClick={() =>
                            this.commands.executeCommand(
                                snapshot.running ? CMD_PREVIEW_RESTART : CMD_PREVIEW_START
                            )
                        }
                    >
                        {snapshot.running ? 'Reiniciar' : 'Iniciar'}
                    </button>
                    <button
                        className="cap-btn"
                        disabled={busy || !snapshot.running}
                        onClick={() => this.commands.executeCommand(CMD_PREVIEW_STOP)}
                    >
                        Parar
                    </button>
                </div>
            </div>
        );
    }

    /**
     * RECONCILIAÇÃO (§4): o que o projeto DECLAROU contra o que foi OBSERVADO.
     *
     * Este eixo não é o do §3. Lá a intenção é conferida contra a implementação
     * (claims de `.product/` contra arquivos reais); aqui uma DECLARAÇÃO é
     * conferida contra COMPORTAMENTO observado, e a observação só existe porque o
     * ledger do preview aceitou registrar evidência para ela.
     *
     * Três decisões, e nenhuma delas "resolve" sozinha:
     *  • mudar a implementação fica PENDENTE DE VERIFICAÇÃO — falta código novo e
     *    evidência nova. Só é oferecida quando existe um efeito proposto para
     *    nomear, porque o motor recusa a decisão sem efeito.
     *  • aceitar o observado como intenção grava a revisão no arquivo humano.
     *  • exceção exige justificativa escrita, e vale só no escopo declarado.
     */
    protected renderReconciliation(): React.ReactNode {
        const snapshot = this.store.reconciliation;
        const busy = this.store.reconcileBusy;

        if (!snapshot) {
            return (
                <div className="cap-card">
                    <div className="cap-head">
                        <b>Declarado × observado</b>
                        <span className="cap-pill not-installed">não comparado</span>
                    </div>
                    <small className="cap-hint">
                        compara `.instrument/intents.json` (e a url de saúde declarada) com o que o
                        preview registrou como evidência
                    </small>
                    <div className="cap-actions">
                        <button
                            className="cap-btn"
                            disabled={busy}
                            onClick={() => this.commands.executeCommand(CMD_RECONCILE_SCAN)}
                        >
                            {busy ? 'comparando…' : 'Comparar'}
                        </button>
                    </div>
                </div>
            );
        }

        const open = snapshot.divergences.filter(d => !d.reconciliation).length;
        const pill = open > 0 ? 'unavailable' : 'not-installed';

        return (
            <div className="cap-card">
                <div className="cap-head">
                    <b>Declarado × observado</b>
                    <span className={`cap-pill ${pill}`}>
                        {open > 0 ? `${open} divergência(s) aberta(s)` : 'nenhuma divergência aberta'}
                    </span>
                </div>
                <small className="cap-hint">
                    {snapshot.intents.length} expectativa(s) declarada(s) ·{' '}
                    {snapshot.observations.length} comportamento(s) observado(s)
                </small>
                {snapshot.nothingToCompare && (
                    <p className="cap-detail">{snapshot.nothingToCompare}</p>
                )}
                {snapshot.problem && <p className="cap-detail">{snapshot.problem}</p>}
                {snapshot.intents.map(i => (
                    <small className="cap-hint" key={i.id}>
                        {i.subject} espera {JSON.stringify(i.expected)} — dito em {i.source_path}{' '}
                        (revisão {i.revision})
                    </small>
                ))}
                {snapshot.divergences.map(d => this.renderDivergence(d, busy))}
                <div className="cap-actions">
                    <button
                        className="cap-btn"
                        disabled={busy}
                        onClick={() => this.commands.executeCommand(CMD_RECONCILE_SCAN)}
                    >
                        {busy ? 'comparando…' : 'Comparar de novo'}
                    </button>
                </div>
            </div>
        );
    }

    /** Justificativas em digitação, por divergência. Exceção sem justificativa é
     *  recusada pelo motor, então o botão fica desabilitado até haver texto. */
    protected justifications: Record<string, string> = {};

    protected renderDivergence(view: DivergenceView, busy: boolean): React.ReactNode {
        const d = view.divergence;
        const decision = view.reconciliation;
        // O efeito que a decisão "mudar implementação" nomeia é o efeito REAL
        // proposto ao broker. Sem proposta aberta não há o que nomear, e o motor
        // recusaria — então o botão diz isso em vez de tentar e falhar.
        const effectId = this.store.proposal?.id;
        const justification = this.justifications[d.id] ?? '';

        return (
            <div className="cap-receipt" key={d.id}>
                <span className={`cap-receipt-action ${decision ? 'check-unknown' : 'check-failed'}`}>
                    {decision
                        ? decision.status === 'pending_verification'
                            ? 'pendente de verificação'
                            : 'exceção aceita'
                        : 'aberta'}
                </span>
                <span className="cap-receipt-detail">
                    {d.subject}: declarado {JSON.stringify(d.expected)}, observado{' '}
                    {JSON.stringify(d.actual)}
                </span>
                <small>evidência: {d.evidence_ids.join(', ')}</small>
                {decision && (
                    <small>
                        decisão: {decision.choice.kind}
                        {decision.status === 'pending_verification' &&
                            ' — não está resolvida: falta código novo e evidência nova'}
                    </small>
                )}
                {!decision && (
                    <>
                        <div className="cap-actions">
                            <button
                                className="cap-btn"
                                disabled={busy || !effectId}
                                title={
                                    effectId
                                        ? `Nomeia o efeito proposto ${effectId}`
                                        : 'Nenhum efeito proposto para nomear — proponha a mudança primeiro'
                                }
                                onClick={() =>
                                    this.commands.executeCommand(CMD_RECONCILE_DECIDE, d.id, {
                                        kind: 'change_implementation',
                                        proposed_effect_id: effectId
                                    })
                                }
                            >
                                Mudar implementação
                            </button>
                            <button
                                className="cap-btn"
                                disabled={busy}
                                title="Grava o observado como a expectativa, em .instrument/intents.json"
                                onClick={() =>
                                    this.commands.executeCommand(CMD_RECONCILE_DECIDE, d.id, {
                                        kind: 'change_intent',
                                        revised_expected: d.actual
                                    })
                                }
                            >
                                Aceitar o observado como intenção
                            </button>
                        </div>
                        <div className="cap-actions">
                            <input
                                className="cap-input"
                                placeholder="justificativa da exceção (obrigatória)"
                                value={justification}
                                onChange={event => {
                                    this.justifications[d.id] = event.target.value;
                                    this.update();
                                }}
                            />
                            <button
                                className="cap-btn"
                                disabled={busy || justification.trim().length === 0}
                                onClick={() =>
                                    this.commands.executeCommand(CMD_RECONCILE_DECIDE, d.id, {
                                        kind: 'accept_scoped_exception',
                                        scope: { preview: { preview_id: 'preview' } },
                                        justification
                                    })
                                }
                            >
                                Registrar exceção escopada
                            </button>
                        </div>
                    </>
                )}
            </div>
        );
    }

    /**
     * Materiais do projeto (§5): stack, comandos, Git, serviços, integrações.
     *
     * Toda linha mostra a evidência junto da afirmação — arquivo, linha quando
     * há, e o trecho lido. Sem isso a análise seria indistinguível de um palpite,
     * e um palpite de detector é a mesma confiança inventada que o resto do
     * painel recusa.
     *
     * Nada aqui liga nada. Adotar um comando é um clique próprio, por comando.
     */
    protected renderMaterials(): React.ReactNode {
        const analysis = this.store.analysis;
        const busy = this.store.analysisBusy;

        if (!analysis) {
            return (
                <div className="cap-card">
                    <div className="cap-head">
                        <b>Materiais do projeto</b>
                        <span className="cap-pill not-installed">não analisado</span>
                    </div>
                    <small className="cap-hint">
                        stack, comandos, Git, serviços e integrações · candidato não é ativação:
                        ler não grava nem liga nada
                    </small>
                    <div className="cap-actions">
                        <button
                            className="cap-btn primary"
                            disabled={busy}
                            onClick={() => this.commands.executeCommand(CMD_MATERIALS_ANALYZE)}
                        >
                            {busy ? 'lendo…' : 'Analisar'}
                        </button>
                    </div>
                </div>
            );
        }

        const evidence = (p: { path: string; line?: number; excerpt: string }) => (
            <small className="cap-evidence">
                {p.path}
                {typeof p.line === 'number' ? `:${p.line}` : ''} — {p.excerpt}
            </small>
        );

        return (
            <div className="cap-card">
                <div className="cap-head">
                    <b>Materiais do projeto</b>
                    <span className="cap-pill ready">analisado</span>
                </div>
                <small className="cap-hint">
                    cada afirmação mostra de onde veio · nada foi gravado nem ativado
                    {analysis.skipped.length > 0 &&
                        ` · não abertos: ${analysis.skipped.join(', ')}`}
                </small>

                {analysis.stack.length > 0 && (
                    <>
                        <div className="cap-head"><b>Stack</b></div>
                        {analysis.stack.map(s => (
                            <div className="cap-receipt" key={s.id}>
                                <span className="cap-receipt-action">stack</span>
                                <span className="cap-receipt-detail">{s.label}</span>
                                {s.provenance.map((p, i) => (
                                    <React.Fragment key={i}>{evidence(p)}</React.Fragment>
                                ))}
                            </div>
                        ))}
                    </>
                )}

                {analysis.commands.length > 0 && (
                    <>
                        <div className="cap-head"><b>Comandos declarados pelo projeto</b></div>
                        {analysis.commands.map((c, i) => (
                            <div className="cap-receipt" key={`${c.slug}:${i}`}>
                                <span className="cap-receipt-action">{c.slug}</span>
                                <span className="cap-receipt-detail">{c.command}</span>
                                {evidence(c.provenance)}
                                {!c.runnableByChecks ? (
                                    // Detectado porque descreve o projeto, mas os
                                    // checks não executam este papel — então não
                                    // se oferece uma adoção que seria recusada.
                                    <small>os checks não executam este papel</small>
                                ) : c.alreadyDeclared ? (
                                    <small>já declarado em .instrument/checks.json</small>
                                ) : (
                                    <div className="cap-actions">
                                        <button
                                            className="cap-btn"
                                            disabled={busy}
                                            title="Escreve este comando em .instrument/checks.json para os checks usarem"
                                            onClick={() =>
                                                this.commands.executeCommand(CMD_ADOPT_COMMAND, c.slug)
                                            }
                                        >
                                            Adotar para os checks
                                        </button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </>
                )}

                <div className="cap-head"><b>Git</b></div>
                {analysis.git.isRepo ? (
                    <div className="cap-receipt">
                        <span className="cap-receipt-action">git</span>
                        <span className="cap-receipt-detail">
                            {analysis.git.branch ?? 'branch não identificado'}
                            {analysis.git.remotes.length > 0 &&
                                ` · ${analysis.git.remotes.map(r => r.name).join(', ')}`}
                        </span>
                        {analysis.git.provenance.map((p, i) => (
                            <React.Fragment key={i}>{evidence(p)}</React.Fragment>
                        ))}
                    </div>
                ) : (
                    <div className="cap-receipt">
                        <span className="cap-receipt-action">git</span>
                        <span className="cap-receipt-detail">não é um repositório Git</span>
                    </div>
                )}

                {analysis.services.map(s => (
                    <div className="cap-receipt" key={s.id}>
                        <span className="cap-receipt-action">{s.kind}</span>
                        <span className="cap-receipt-detail">{s.label}</span>
                        {evidence(s.provenance)}
                    </div>
                ))}

                {analysis.integrations.map(i => (
                    <div className="cap-receipt" key={i.id}>
                        <span className="cap-receipt-action">{i.kind}</span>
                        <span className="cap-receipt-detail">{i.label}</span>
                        {evidence(i.provenance)}
                    </div>
                ))}

                {analysis.instructions.length > 0 && (
                    <>
                        <small className="cap-hint">Instruções que o projeto mantém</small>
                        {analysis.instructions.map(i => (
                            <div className="cap-receipt" key={i.id}>
                                <span className="cap-receipt-action">{i.kind}</span>
                                <span className="cap-receipt-detail">{i.label}</span>
                                <small>
                                    {i.bytes} byte(s) lidos ·{' '}
                                    {i.headings.length > 0
                                        ? `seções: ${i.headings.join(' · ')}`
                                        : 'sem seções'}
                                </small>
                                {evidence(i.provenance)}
                            </div>
                        ))}
                    </>
                )}

                {analysis.guidance.length > 0 && (
                    <>
                        <small className="cap-hint">
                            Orientações candidatas — sempre como <b>sugestão</b>: detector não sabe
                            que uma frase é bloqueante, quem escreveu sabe. Importar coloca na
                            biblioteca como candidata; promover é ato separado.
                        </small>
                        {analysis.guidance.map(g => (
                            <div className="cap-receipt" key={g.id}>
                                <span className="cap-receipt-action">{g.strength}</span>
                                <span className="cap-receipt-detail">{g.title}</span>
                                <small>{g.text}</small>
                                {evidence(g.provenance)}
                                {g.alreadyDeclared ? (
                                    <small>já está na biblioteca do projeto</small>
                                ) : (
                                    <div className="cap-actions">
                                        <button
                                            className="cap-btn"
                                            disabled={busy}
                                            title="Entra na Guidance Library como CANDIDATA — não dirige agente nenhum até você promover, em Ferramentas"
                                            onClick={() =>
                                                this.commands.executeCommand(CMD_PROPOSE_GUIDANCE, g.id)
                                            }
                                        >
                                            Importar para a biblioteca (candidata)
                                        </button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </>
                )}

                {analysis.config.length > 0 && (
                    <>
                        <small className="cap-hint">Configuração do IDE que o projeto já declara</small>
                        {analysis.config.map(c => (
                            <div className="cap-receipt" key={c.id}>
                                <span className="cap-receipt-action">
                                    {c.alreadyDeclared ? 'declarado' : 'candidato'}
                                </span>
                                <span className="cap-receipt-detail">
                                    {c.label} → {c.target}
                                </span>
                                <small>{JSON.stringify(c.proposed)}</small>
                                {c.provenance.map((p, index) => (
                                    <React.Fragment key={`${c.id}:${index}`}>{evidence(p)}</React.Fragment>
                                ))}
                                {c.gap && <small className="cap-remediation">{c.gap}</small>}
                                <div className="cap-actions">
                                    <button
                                        className="cap-btn"
                                        disabled={busy}
                                        title="Grava direto: .instrument/ é estado de runtime do IDE, não conteúdo do projeto"
                                        onClick={() =>
                                            this.commands.executeCommand(CMD_ADOPT_CONFIG, c.id)
                                        }
                                    >
                                        {c.alreadyDeclared ? 'Regravar' : 'Adotar configuração'}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </>
                )}

                {analysis.references.length > 0 && (
                    <>
                        <small className="cap-hint">
                            Referências citadas · URL não é baixada, e arquivo do projeto já é asset
                            versionado aqui
                        </small>
                        {analysis.references.map(r => (
                            <div className="cap-receipt" key={r.id}>
                                <span className="cap-receipt-action">{r.kind}</span>
                                <span className="cap-receipt-detail">{r.label}</span>
                                {evidence(r.provenance)}
                                {r.assetNote && <small className="cap-remediation">{r.assetNote}</small>}
                                {r.alreadyRegistered ? (
                                    <small>já registrada em .product/references/</small>
                                ) : (
                                    <div className="cap-actions">
                                        <button
                                            className="cap-btn"
                                            disabled={busy}
                                            onClick={() =>
                                                this.commands.executeCommand(CMD_REGISTER_REFERENCE, r.id)
                                            }
                                        >
                                            Registrar (vai ao broker)
                                        </button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </>
                )}

                {analysis.relations.length > 0 && (
                    <>
                        <small className="cap-hint">
                            Relações literais entre materiais — nada de semântica adivinhada
                        </small>
                        {analysis.relations.map(r => (
                            <div className="cap-receipt" key={r.id}>
                                <span className="cap-receipt-action">{r.kind}</span>
                                <span className="cap-receipt-detail">
                                    {r.from} → {r.to}
                                </span>
                                {evidence(r.provenance)}
                            </div>
                        ))}
                    </>
                )}

                {analysis.limits.length > 0 && (
                    <small className="cap-hint">limites da varredura: {analysis.limits.join(' · ')}</small>
                )}

                <div className="cap-actions">
                    <button
                        className="cap-btn"
                        disabled={busy}
                        onClick={() => this.commands.executeCommand(CMD_MATERIALS_ANALYZE)}
                    >
                        {busy ? 'lendo…' : 'Analisar de novo'}
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
                {this.renderContext()}
                {this.renderPreview()}
                {this.renderReconciliation()}
                {this.renderMaterials()}
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
                        <h2 className="goal">Intenção e sessão de agente</h2>
                        {this.renderComposer()}
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
                            {session?.baseline && (
                                <small className="cap-hint">
                                    baseline: {session.baseline.files} arquivo(s) em{' '}
                                    {session.baseline.at}
                                    {session.baseline.commit
                                        ? ` (commit ${session.baseline.commit.slice(0, 7)})`
                                        : ' (projeto sem git — cópia isolada)'}
                                    {session.baseline.reused &&
                                        ' · worktree de sessão anterior: o agente vê o projeto daquele momento'}
                                    {session.baseline.recovered &&
                                        ' · baseline RECUPERADA: mudança anterior a ela não é distinguível da sua'}
                                </small>
                            )}
                            {session?.usage && (
                                <small className="cap-evidence">
                                    {session.usage.reported
                                        ? `custo: ${session.usage.inputTokens} tokens de entrada · ${session.usage.outputTokens} de saída`
                                        : 'custo: este adaptador não reporta uso — zero aqui significa NÃO MEDIDO, não barato'}
                                </small>
                            )}
                            {session?.lastSwap && (
                                <small className={session.lastSwap.resumed ? 'cap-evidence' : 'cap-remediation'}>
                                    {session.lastSwap.from} → {session.lastSwap.to} ·{' '}
                                    {session.lastSwap.resumed
                                        ? `reatada: ${session.lastSwap.preserved.join(', ')}`
                                        : `recomeçada — perdido: ${session.lastSwap.dropped.join(', ')}`}
                                </small>
                            )}
                            {session?.lastError && <p className="cap-detail">{session.lastError}</p>}
                            <small className="cap-hint">
                                o agente trabalha na worktree e só o broker traz mudança de ARQUIVO para o
                                projeto · comando que o agente roda não deixa recibo no broker e não tem
                                rollback: só o portão de permissão o cobre, e só nos bridges que perguntam ·
                                exclusão é vista mas não é proposta (o broker não tem efeito de exclusão) ·
                                não é jaula: o adapter não aplica sandbox · permissão do agente é
                                decidida aqui, e o agente fica parado até a decisão — a menos que a
                                permissão do projeto seja Yolo, e aí o IDE responde sozinho e
                                registra o pedido e a regra que decidiu
                            </small>
                            <div className="cap-actions">
                                {phase === 'none' || phase === 'failed' ? (
                                    <>
                                        <button
                                            className="cap-btn primary"
                                            disabled={busy}
                                            onClick={() => this.commands.executeCommand(CMD_SESSION_START, 'claude')}
                                        >
                                            {busy ? 'abrindo…' : 'Abrir sessão'}
                                        </button>
                                        {session?.worktree && (
                                            <button
                                                className="cap-btn"
                                                disabled={busy}
                                                title="Apaga a worktree e a baseline; o que não foi colhido é perdido"
                                                onClick={() => this.commands.executeCommand(CMD_SESSION_DISCARD)}
                                            >
                                                Descartar worktree
                                            </button>
                                        )}
                                    </>
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
                                        <button
                                            className="cap-btn"
                                            disabled={busy}
                                            title="Encerra a sessão e apaga a worktree; o que não foi colhido é perdido"
                                            onClick={() => this.commands.executeCommand(CMD_SESSION_DISCARD)}
                                        >
                                            Descartar worktree
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>

                        {this.renderAdapters()}

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
                                <div className="cap-head"><b>Mudanças do agente na worktree</b></div>
                                <small className="cap-hint">
                                    só edição e criação de arquivo passam pelo broker · exclusão e
                                    conflito com o seu trabalho ficam reportados, sem proposta
                                </small>
                                {session.changes.map(c => (
                                    <div className="cap-receipt" key={c.relPath}>
                                        <span className="cap-receipt-action">
                                            {c.proposed
                                                ? 'proposto'
                                                : c.kind === 'delete'
                                                    ? 'exclusão'
                                                    : c.conflict
                                                        ? 'conflito'
                                                        : 'na fila'}
                                        </span>
                                        <span className="cap-receipt-detail">
                                            {c.kind === 'create' ? 'criar ' : c.kind === 'delete' ? 'apagar ' : ''}
                                            {c.relPath} +{c.addedLines}/-{c.removedLines}
                                        </span>
                                        <small>{c.detail ?? c.proposalId ?? ''}</small>
                                    </div>
                                ))}
                            </div>
                        )}

                        {session && session.skipped.length > 0 && (
                            <div className="cap-card">
                                <div className="cap-head">
                                    <b>Não comparados</b>
                                    <span className="cap-pill not-installed">
                                        {session.skipped.length}
                                    </span>
                                </div>
                                <small className="cap-hint">
                                    a colheita não leu estes arquivos — se o agente mudou algum, você
                                    NÃO está vendo
                                </small>
                                {session.skipped.map(s => (
                                    <div className="cap-receipt" key={s.relPath}>
                                        <span className="cap-receipt-action">pulado</span>
                                        <span className="cap-receipt-detail">{s.relPath}</span>
                                        <small>{s.reason}</small>
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

    /**
     * Quem decide a permissão deste adaptador — e não é o mesmo que "ele fala o
     * protocolo".
     *
     * DEFEITO QUE APARECEU NA TELA: esta linha vinha de
     * `supportsPermissionBridge`, que é true para os quatro bridges porque todos
     * SABEM falar `session/request_permission`. Com isso o `codex` aparecia como
     * "pergunta antes de agir" quando o `approvals: harness_owned` dele diz
     * exatamente o contrário: quem decide é o harness do agente, e o card do IDE
     * não governa nada ali. Era a promessa de um portão que aquele agente não usa
     * — o §1e já tinha MEDIDO isso e a tela desmentia a medição.
     *
     * Quem responde a pergunta é `policy.approvals`, sempre.
     */
    protected approvalSentence(adapter: AdapterCard): string {
        switch (adapter.policy?.approvals) {
            case 'enforced':
                return 'o portão do IDE decide: o agente para no card';
            case 'harness_owned':
                return 'o HARNESS DO AGENTE decide — o card do IDE não governa este';
            case 'declared_only':
                return 'só declarado: ninguém confere se o portão foi respeitado';
            default:
                return 'quem decide a permissão não está declarado';
        }
    }

    /**
     * §10 — os adaptadores que o MOTOR conhece, com o que cada um cobre.
     *
     * A lista vem de `bridge_command_for`, nunca desta tela: oferecer um
     * adaptador inventado seria oferecer um caminho que não existe. E o
     * `PolicyCoverage` aparece ANTES de rodar, porque a diferença entre o IDE
     * GARANTIR o portão (`enforced`) e o adaptador apenas dizer que tem
     * (`declared_only`) muda o que a pessoa está aceitando.
     */
    protected renderAdapters(): React.ReactNode {
        const adapters = this.store.adapters;
        const session = this.store.session;
        const busy = this.store.sessionBusy;
        return (
            <div className="cap-card">
                <div className="cap-head">
                    <b>Adaptadores</b>
                    <button
                        className="cap-btn"
                        disabled={busy}
                        onClick={() => this.commands.executeCommand(CMD_SESSION_ADAPTERS)}
                    >
                        {adapters ? 'Sondar de novo' : 'Sondar adaptadores'}
                    </button>
                </div>
                <small className="cap-hint">
                    trocar de adaptador NÃO escreve no projeto e não contorna o broker · conversa
                    pertence ao harness do agente e não é portável entre backends: a troca diz o
                    que perdeu
                </small>
                {!adapters && <small>não sondados — nenhuma disponibilidade é presumida</small>}
                {adapters?.map(adapter => (
                    <div className="cap-receipt" key={adapter.agent}>
                        <span className="cap-receipt-action">{adapter.availability}</span>
                        <span className="cap-receipt-detail">
                            {adapter.agent}
                            {session?.agent === adapter.agent ? ' · em uso' : ''}
                        </span>
                        {adapter.detail && <small>{adapter.detail}</small>}
                        {adapter.policy && (
                            <small className="cap-evidence">
                                aprovação: {adapter.policy.approvals} · sandbox: {adapter.policy.sandbox} ·
                                egress: {adapter.policy.egress} · budget: {adapter.policy.budget}
                            </small>
                        )}
                        <small className={
                            adapter.policy?.approvals === 'enforced' ? 'cap-evidence' : 'cap-remediation'
                        }>
                            {adapter.supportsResume ? 'retoma sessão' : 'não retoma sessão'} ·{' '}
                            {this.approvalSentence(adapter)}
                        </small>
                        {adapter.degradations.map((degradation, index) => (
                            <small className="cap-remediation" key={index}>{degradation}</small>
                        ))}
                        {session?.sessionId && session.agent !== adapter.agent && (
                            <button
                                className="cap-btn"
                                disabled={busy || adapter.availability === 'unavailable'}
                                title="Entrega a sessão viva a este adaptador; diz o que sobrevive"
                                onClick={() =>
                                    this.commands.executeCommand(CMD_SESSION_SWAP, adapter.agent)
                                }
                            >
                                Trocar para este
                            </button>
                        )}
                    </div>
                ))}
            </div>
        );
    }

    /**
     * Submits what the COMPOSER holds — the person's own text, verbatim.
     *
     * It used to be a `window.prompt`, which meant the intent existed for one
     * modal and then vanished: nothing could evaluate it, and nothing could show
     * what was sent. The composer keeps it, and §8 evaluates it WITHOUT editing
     * it. If the box is empty there is nothing to send, and saying so beats
     * sending an empty prompt to an agent.
     */
    protected submitPrompt(codeChange: boolean): void {
        const intent = this.store.intentDraft.trim();
        if (intent.length === 0) {
            this.store.toast('Escreva a intenção no composer antes de enviar.');
            return;
        }
        this.commands.executeCommand(CMD_SESSION_SUBMIT, intent, codeChange);
    }

    /** Texto editado por hipótese, antes de virar artefato, e o motivo de dispensa. */
    protected findingDrafts: Record<string, string> = {};

    protected findingDraft(id: string, fallback: string): string {
        return this.findingDrafts[id] ?? fallback;
    }

    /** Campos em digitação da view Notas. */
    protected noteDrafts: Record<string, string> = {};

    protected noteDraft(key: string, fallback = ''): string {
        return this.noteDrafts[key] ?? fallback;
    }

    protected noteInput(key: string, placeholder: string): React.ReactNode {
        return (
            <input
                className="cap-input"
                placeholder={placeholder}
                value={this.noteDraft(key)}
                onChange={event => {
                    this.noteDrafts[key] = event.target.value;
                    this.update();
                }}
            />
        );
    }

    /**
     * NOTAS E RECONCILIAÇÃO (§7) — a Work Surface das notas.
     *
     * O motor compara e não decide. Cada conflito é uma comparação que dá para
     * refazer lendo duas notas: duas decisões abertas sobre o mesmo assunto com
     * textos diferentes, uma nota que diz literalmente o que um SoT proíbe, uma
     * pergunta aberta sobre assunto já decidido, ligação apontando para o que não
     * existe, e nota apoiada em guidance que deixou de ser ativa.
     *
     * Promover, conciliar e descartar são atos separados, cada um com motivo.
     * Conciliar escreve uma nota NOVA que substitui as originais — nada é editado
     * no lugar, então a história continua legível.
     */
    protected renderNotes(on: boolean): React.ReactNode {
        const snapshot = this.store.notes;
        const busy = this.store.notesBusy;
        const kind = this.noteDraft('note-kind', 'decision');

        return (
            <section className={`view${on ? ' on' : ''}`} id="view-notas">
                <div className="home-main">
                    <div className="cap-card">
                        <div className="cap-head">
                            <b>Notas</b>
                            <span
                                className={`cap-pill ${
                                    !snapshot
                                        ? 'not-installed'
                                        : snapshot.conflicts.length > 0
                                            ? 'unavailable'
                                            : 'ready'
                                }`}
                            >
                                {!snapshot
                                    ? 'não lidas'
                                    : snapshot.conflicts.length > 0
                                        ? `${snapshot.conflicts.length} conflito(s)`
                                        : 'sem conflito'}
                            </span>
                        </div>
                        <small className="cap-hint">
                            {snapshot
                                ? `versionadas em ${snapshot.notesPath}/ · o motor compara e não decide: promover, conciliar e descartar são atos seus, cada um com motivo`
                                : 'notas por tema — proposta, decisão, pergunta, alternativa'}
                        </small>

                        <div className="cap-actions">
                            {this.noteInput('note-theme', 'tema')}
                            {this.noteInput('note-subject', 'assunto — o que a nota decide ou pergunta')}
                        </div>
                        <div className="cap-actions">
                            <select
                                className="cap-input"
                                value={kind}
                                onChange={event => {
                                    this.noteDrafts['note-kind'] = event.target.value;
                                    this.update();
                                }}
                            >
                                <option value="decision">decisão</option>
                                <option value="proposal">proposta</option>
                                <option value="question">pergunta</option>
                                <option value="alternative">alternativa</option>
                            </select>
                            {this.noteInput('note-text', 'texto da nota')}
                            <button
                                className="cap-btn primary"
                                disabled={
                                    busy ||
                                    this.noteDraft('note-theme').trim().length === 0 ||
                                    this.noteDraft('note-subject').trim().length === 0 ||
                                    this.noteDraft('note-text').trim().length === 0
                                }
                                onClick={() => {
                                    this.commands.executeCommand(CMD_NOTES_CREATE, {
                                        theme: this.noteDraft('note-theme'),
                                        kind,
                                        subject: this.noteDraft('note-subject'),
                                        text: this.noteDraft('note-text')
                                    });
                                    this.noteDrafts['note-text'] = '';
                                    this.update();
                                }}
                            >
                                Escrever nota
                            </button>
                            <button
                                className="cap-btn"
                                disabled={busy}
                                onClick={() => this.commands.executeCommand(CMD_NOTES_READ)}
                            >
                                {busy ? 'lendo…' : 'Reler'}
                            </button>
                        </div>
                    </div>

                    {snapshot && snapshot.conflicts.length > 0 && (
                        <div className="cap-card">
                            <div className="cap-head">
                                <b>Conciliar</b>
                                <span className="cap-pill unavailable">
                                    {snapshot.conflicts.length} para decidir
                                </span>
                            </div>
                            {snapshot.conflicts.map((conflict, index) => (
                                <div className="cap-receipt" key={`conf:${index}`}>
                                    <span className="cap-receipt-action check-failed">
                                        {conflict.kind}
                                    </span>
                                    <span className="cap-receipt-detail">
                                        {conflict.kind === 'decisions_disagree' &&
                                            `duas decisões abertas sobre "${conflict.subject}": ${conflict.note_ids.join(' × ')}`}
                                        {conflict.kind === 'contradicts_declaration' &&
                                            `${conflict.note_id} diz "${conflict.forbidden}", que ${conflict.source} proíbe`}
                                        {conflict.kind === 'question_on_decided_subject' &&
                                            `pergunta ${conflict.question_id} sobre "${conflict.subject}", já decidido em ${conflict.decision_id}`}
                                        {conflict.kind === 'dangling_link' &&
                                            `${conflict.note_id} aponta ${conflict.link}, que não existe aqui`}
                                        {conflict.kind === 'stale_guidance_link' &&
                                            `${conflict.note_id} se apoia em ${conflict.guidance_id}, que não está ativa`}
                                    </span>
                                    {conflict.kind === 'contradicts_declaration' && (
                                        <small>{conflict.statement}</small>
                                    )}
                                    {conflict.kind === 'decisions_disagree' && (
                                        <>
                                            <div className="cap-actions">
                                                {this.noteInput(
                                                    `merge-text:${conflict.subject}`,
                                                    'texto da nota conciliada'
                                                )}
                                            </div>
                                            <div className="cap-actions">
                                                {this.noteInput(
                                                    `merge-reason:${conflict.subject}`,
                                                    'motivo da conciliação (obrigatório)'
                                                )}
                                                <button
                                                    className="cap-btn primary"
                                                    disabled={
                                                        busy ||
                                                        this.noteDraft(
                                                            `merge-text:${conflict.subject}`
                                                        ).trim().length === 0 ||
                                                        this.noteDraft(
                                                            `merge-reason:${conflict.subject}`
                                                        ).trim().length === 0
                                                    }
                                                    title="Escreve uma nota NOVA e marca as originais como substituídas por ela"
                                                    onClick={() =>
                                                        this.commands.executeCommand(
                                                            CMD_NOTES_MERGE,
                                                            conflict.note_ids,
                                                            snapshot.notes.find(
                                                                n => n.id === conflict.note_ids[0]
                                                            )?.theme ?? 'geral',
                                                            conflict.subject,
                                                            this.noteDraft(
                                                                `merge-text:${conflict.subject}`
                                                            ),
                                                            this.noteDraft(
                                                                `merge-reason:${conflict.subject}`
                                                            )
                                                        )
                                                    }
                                                >
                                                    Conciliar em nota nova
                                                </button>
                                            </div>
                                        </>
                                    )}
                                </div>
                            ))}
                            <small className="cap-hint">
                                comparado contra: {snapshot.known.files.length} arquivo(s),{' '}
                                {snapshot.known.sots.length} SoT(s),{' '}
                                {snapshot.known.activeGuidance.length} guidance ativa(s),{' '}
                                {snapshot.known.forbidden.length} declaração(ões) com texto proibido
                            </small>
                        </div>
                    )}

                    {snapshot && snapshot.themes.map(theme => (
                        <div className="cap-card" key={`theme:${theme}`}>
                            <div className="cap-head">
                                <b>{theme}</b>
                                <span className="cap-pill not-installed">
                                    {snapshot.notes.filter(n => n.theme === theme).length} nota(s)
                                </span>
                            </div>
                            {snapshot.notes
                                .filter(note => note.theme === theme)
                                .map(note => (
                                    <div className="cap-receipt" key={note.id}>
                                        <span
                                            className={`cap-receipt-action ${
                                                note.state === 'open'
                                                    ? ''
                                                    : note.state === 'resolved'
                                                        ? 'check-not_run'
                                                        : 'check-unknown'
                                            }`}
                                        >
                                            {note.kind} · {note.state}
                                        </span>
                                        <span className="cap-receipt-detail">{note.subject}</span>
                                        <small>{note.text}</small>
                                        {note.links.length > 0 && (
                                            <small className="cap-evidence">
                                                ligada a:{' '}
                                                {note.links
                                                    .map(link => `${link.kind}:${link.id}`)
                                                    .join(', ')}
                                            </small>
                                        )}
                                        {note.stateReason && (
                                            <small>
                                                {note.state === 'superseded'
                                                    ? `substituída por ${note.supersededBy}: `
                                                    : 'fechada: '}
                                                {note.stateReason}
                                            </small>
                                        )}
                                        {note.state === 'open' && (
                                            <>
                                                <div className="cap-actions">
                                                    <button
                                                        className="cap-btn"
                                                        disabled={busy}
                                                        title="Vira guidance CANDIDATA na biblioteca — ainda precisa ser promovida lá"
                                                        onClick={() =>
                                                            this.commands.executeCommand(
                                                                CMD_NOTES_PROMOTE,
                                                                note.id
                                                            )
                                                        }
                                                    >
                                                        Promover a guidance
                                                    </button>
                                                </div>
                                                <div className="cap-actions">
                                                    {this.noteInput(
                                                        `close:${note.id}`,
                                                        'motivo para fechar (obrigatório)'
                                                    )}
                                                    <button
                                                        className="cap-btn"
                                                        disabled={
                                                            busy ||
                                                            this.noteDraft(
                                                                `close:${note.id}`
                                                            ).trim().length === 0
                                                        }
                                                        onClick={() =>
                                                            this.commands.executeCommand(
                                                                CMD_NOTES_RESOLVE,
                                                                note.id,
                                                                this.noteDraft(`close:${note.id}`)
                                                            )
                                                        }
                                                    >
                                                        Fechar com motivo
                                                    </button>
                                                </div>
                                            </>
                                        )}
                                    </div>
                                ))}
                        </div>
                    ))}

                    {snapshot && snapshot.notes.length === 0 && (
                        <div className="cap-card">
                            <small>
                                nenhuma nota ainda · nota sem assunto não existe aqui: é o assunto
                                que permite comparar duas notas
                            </small>
                        </div>
                    )}
                </div>
            </section>
        );
    }

    /**
     * O COMPOSER (§8): a intenção da pessoa, e o que ela esconde.
     *
     * Três regras visíveis na tela, porque são elas que fazem "a intenção melhora
     * sem rewrite oculto ou estado silencioso":
     *  • o texto é da pessoa — nada aqui reescreve o campo, e o que é enviado ao
     *    agente é exatamente o que está nele.
     *  • cada hipótese é editável antes de virar artefato, e o que vira artefato é
     *    a versão dela, não a remediação crua do avaliador.
     *  • dispensar exige motivo, e decisão tomada sobre OUTRA versão do texto
     *    aparece marcada em vez de valer em silêncio.
     */
    protected renderComposer(): React.ReactNode {
        const review = this.store.intentReview;
        const busy = this.store.intentBusy;

        return (
            <div className="cap-card">
                <div className="cap-head">
                    <b>Intenção</b>
                    <span className={`cap-pill ${review ? (this.store.openFindingCount > 0 ? 'not-installed' : 'ready') : 'not-installed'}`}>
                        {!review
                            ? 'não avaliada'
                            : this.store.openFindingCount > 0
                                ? `${this.store.openFindingCount} hipótese(s) aberta(s)`
                                : 'sem hipótese aberta'}
                    </span>
                </div>
                <textarea
                    className="cap-textarea"
                    placeholder="o que este projeto tem de fazer — com as suas palavras"
                    value={this.store.intentDraft}
                    onChange={event => this.store.setIntentDraft(event.target.value)}
                />
                <small className="cap-hint">
                    este texto é seu · o que vai ao agente é exatamente ele, e avaliar não o
                    reescreve
                </small>
                <div className="cap-actions">
                    <button
                        className="cap-btn"
                        disabled={busy || this.store.intentDraft.trim().length === 0}
                        onClick={() => this.commands.executeCommand(CMD_INTENT_REVIEW)}
                    >
                        {busy ? 'avaliando…' : 'Avaliar intenção'}
                    </button>
                </div>

                {review?.nothingFound && <p className="cap-detail">{review.nothingFound}</p>}

                {review && review.reviewed.map(entry => {
                    const finding = entry.finding;
                    const decision = entry.decision;
                    const draftKey = `finding:${finding.id}`;
                    const noteKey = `note:${finding.id}`;
                    return (
                        <div className="cap-receipt" key={finding.id}>
                            <span
                                className={`cap-receipt-action ${
                                    decision?.state === 'accepted'
                                        ? ''
                                        : decision?.state === 'dismissed'
                                            ? 'check-not_run'
                                            : finding.category === 'contradiction'
                                                ? 'check-failed'
                                                : 'check-unknown'
                                }`}
                            >
                                {decision?.state ?? finding.category}
                            </span>
                            <span className="cap-receipt-detail">{finding.claim}</span>
                            <small>
                                {finding.evaluator} · severidade {finding.severity} · confiança{' '}
                                {Math.round(finding.confidence * 100)}%
                            </small>
                            <small className="cap-evidence">{finding.evidence}</small>
                            <small className="cap-remediation">{finding.remediation}</small>
                            {decision && (
                                <small>
                                    decidida: {decision.note || 'sem nota'}
                                    {decision.artifact && ` · virou ${decision.artifact}`}
                                    {entry.decidedOnOtherIntent &&
                                        ' · DECIDIDA SOBRE OUTRA VERSÃO DO TEXTO'}
                                </small>
                            )}
                            {!decision && (
                                <>
                                    <div className="cap-actions">
                                        <input
                                            className="cap-input"
                                            value={this.findingDraft(draftKey, finding.remediation)}
                                            onChange={event => {
                                                this.findingDrafts[draftKey] = event.target.value;
                                                this.update();
                                            }}
                                        />
                                        <button
                                            className="cap-btn primary"
                                            disabled={busy}
                                            title="Vira guidance CANDIDATA na biblioteca — ainda precisa ser promovida para dirigir agente"
                                            onClick={() =>
                                                this.commands.executeCommand(
                                                    CMD_INTENT_DECIDE,
                                                    finding.id,
                                                    'accepted',
                                                    'aceita na revisão da intenção',
                                                    this.findingDraft(draftKey, finding.remediation)
                                                )
                                            }
                                        >
                                            Aceitar como guidance
                                        </button>
                                    </div>
                                    <div className="cap-actions">
                                        <input
                                            className="cap-input"
                                            placeholder="motivo da dispensa (obrigatório)"
                                            value={this.findingDraft(noteKey, '')}
                                            onChange={event => {
                                                this.findingDrafts[noteKey] = event.target.value;
                                                this.update();
                                            }}
                                        />
                                        <button
                                            className="cap-btn"
                                            disabled={
                                                busy ||
                                                this.findingDraft(noteKey, '').trim().length === 0
                                            }
                                            onClick={() =>
                                                this.commands.executeCommand(
                                                    CMD_INTENT_DECIDE,
                                                    finding.id,
                                                    'dismissed',
                                                    this.findingDraft(noteKey, '')
                                                )
                                            }
                                        >
                                            Dispensar
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    );
                })}

                {review && (
                    <>
                        <small className="cap-hint">
                            {review.report.evaluatorsRun.length} avaliador(es) ·{' '}
                            {review.report.withheldForBudget} retido(s) pelo orçamento ·{' '}
                            {review.declared.length} declaração(ões) usada(s) na checagem de
                            contradição
                        </small>
                        {review.consequences.map((line, index) => (
                            <small className="cap-hint" key={`cons:${index}`}>
                                {line}
                            </small>
                        ))}
                    </>
                )}
            </div>
        );
    }
}
