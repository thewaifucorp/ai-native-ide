// FERRAMENTAS — the navigator mode that shows the project's CAPABILITY PLATFORM
// and its HARNESS PROVIDER, both rendered purely from backend-detected state.
//
// Before this, "Ferramentas" revealed whatever plugin view happened to be
// deployed (SQLTools, else the Open VSX list) — nothing to do with the IDE's own
// capabilities. Now it is the real registry surface:
//
//  • one card per hosted capability, with its honest status, the evidence-based
//    detail line, the tool version detection actually read, the degradations it
//    declares, and its providers with real availability;
//  • actions offered ONLY when the backend says they exist: the generate/install
//    action (`installable`), re-detect, open surface (`surface.kind === iframe`),
//    and `Conectar Katsui` exclusively on capabilities that declare a Katsui
//    provider;
//  • the harness panel: slot bindings (exclusive), registered providers with
//    their preserved item counts, composed extensions attributed per provider,
//    and the receipt trail.

import * as React from 'react';
import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { AbstractInstrumentWidget } from './abstract-instrument-widget';
import { CapabilityState } from '../../common/capability-protocol';
import { HarnessProviderState, HarnessSnapshot } from '../../common/harness-protocol';
import { CONFLICT_PROVIDER_ID, TEST_PROVIDER_ID } from '../../common/harness-test-provider';
import {
    CMD_BROKER_TRAIL,
    CMD_DURABLE_ATTACH,
    CMD_DURABLE_INTENT,
    CMD_DURABLE_READ,
    CMD_DURABLE_REGISTER,
    CMD_LIBRARY_CAPTURE,
    CMD_LIBRARY_LIFECYCLE,
    CMD_LIBRARY_READ,
    CMD_LIFECYCLE_DELETE_EXPORT,
    CMD_LIFECYCLE_EXPORT,
    CMD_LIFECYCLE_CONSOLIDATE,
    CMD_RELEASE_DELETE_TAG,
    CMD_RELEASE_GITHUB,
    CMD_RELEASE_PUSH,
    CMD_RELEASE_READ,
    CMD_RELEASE_TAG,
    CMD_LIFECYCLE_READ,
    CMD_LIFECYCLE_RELATE,
    CMD_LIFECYCLE_REOPEN,
    CMD_REFS_LINK,
    CMD_REFS_READ,
    CMD_REFS_UNLINK,
    CMD_WORK_ADD,
    CMD_WORK_PROVIDER,
    CMD_WORK_READ,
    CMD_SETTINGS_PROFILE,
    CMD_SETTINGS_PATCH,
    CMD_SETTINGS_READ,
    CMD_SETTINGS_RESET,
    CMD_TRUTH_DECLARE,
    CMD_TRUTH_SYNC,
    CMD_PACKS_APPLY,
    CMD_PACKS_INSTALL,
    CMD_PACKS_REFRESH,
    CMD_PACKS_REVERT,
    CMD_EXT_ACCEPT,
    CMD_EXT_BASELINE,
    CMD_EXT_REVERT,
    CMD_EXT_SCAN,
    CMD_CAP_DETECT,
    CMD_CAP_INSTALL,
    CMD_CAP_KATSUI,
    CMD_CAP_REFRESH,
    CMD_HARNESS_ACTIVATE,
    CMD_HARNESS_EFFECT,
    CMD_HARNESS_MIGRATE,
    CMD_HARNESS_REGISTER,
    CMD_HARNESS_SEED,
    CMD_HARNESS_SUSPEND
} from '../instrument-capability-contribution';
import { ReopenedExport } from 'engine-extension';
import {
    CMD_EXTERNAL_SURFACE,
    CMD_SHOW_SURFACE,
    ExternalSurface
} from '../instrument-shell-contribution';

/** Short human label per status — the pill text stays the raw status. */
const STATUS_HINT: Record<string, string> = {
    ready: 'pronta neste projeto',
    degraded: 'usável com limites',
    'not-installed': 'ainda não gerada aqui',
    'tool-missing': 'ferramenta ausente na máquina',
    unavailable: 'sondagem respondeu não',
    unknown: 'detecção falhou'
};

@injectable()
export class ToolsWidget extends AbstractInstrumentWidget {
    static readonly ID = 'instrument.ferramentas';

    @inject(CommandService) protected readonly commands!: CommandService;

    protected configure(): void {
        this.id = ToolsWidget.ID;
        this.addClass('iws-tools-host');
        this.title.label = 'Ferramentas';
        this.title.caption = 'Ferramentas — capabilities e harness do projeto';
        this.title.closable = false;
    }

    protected render(): React.ReactNode {
        return (
            <div className="nav">
                <div className="proj-head">
                    <div className="name">Ferramentas</div>
                    <div className="meta">
                        {this.store.workspaceName || 'sem projeto'} · registry real
                    </div>
                </div>
                {this.renderCapabilities()}
                {this.renderExternal()}
                {this.renderWorkbench()}
                {this.renderLibrary()}
                {this.renderSettings()}
                {this.renderDurable()}
                {this.renderWork()}
                {this.renderLifecycle()}
                {this.renderRelease()}
                {this.renderPacks()}
                {this.renderBrokerTrail()}
                {this.renderHarness()}
            </div>
        );
    }

    /** One collapsible section. Four full panels stacked in a 240px column was a
     *  scroll with no landmarks; the header carries a summary so the state of a
     *  collapsed section is still readable, and only Capabilities starts open. */
    protected section(
        id: string,
        title: string,
        summary: string,
        body: () => React.ReactNode,
        action?: React.ReactNode
    ): React.ReactNode {
        const open = !this.store.isSectionCollapsed(id);
        return (
            <div className="nav-sec">
                <button
                    className={`sec-head${open ? ' open' : ''}`}
                    aria-expanded={open}
                    onClick={() => this.store.toggleSection(id)}
                >
                    <span className="chev">▶</span>
                    <span className="sec-title">{title}</span>
                    <span className="sec-sum">{summary}</span>
                </button>
                {open && action}
                {open && body()}
            </div>
        );
    }

    /** Compact status summary for the collapsed Capabilities header. */
    protected capabilitySummary(): string {
        if (!this.store.capabilitiesDetected) {
            return 'detectando…';
        }
        const all = this.store.capabilities;
        if (all.length === 0) {
            return 'nenhuma';
        }
        const ready = all.filter(c => c.status === 'ready').length;
        return `${ready}/${all.length} prontas`;
    }

    // ── capabilities ────────────────────────────────────────────────────────

    protected renderCapabilities(): React.ReactNode {
        const capabilities = this.store.capabilities;
        return this.section(
            'capabilities',
            'Capabilities',
            this.capabilitySummary(),
            () => (
                <>
                    {!this.store.capabilitiesDetected && (
                        <div className="cap-card"><small>detectando capabilities do projeto…</small></div>
                    )}
                    {this.store.capabilitiesDetected && capabilities.length === 0 && (
                        <div className="cap-card"><small>nenhuma capability registrada</small></div>
                    )}
                    {capabilities.map(c => this.renderCapability(c))}
                </>
            ),
            <div className="cap-actions" style={{ margin: '0 6px 6px' }}>
                <button
                    className="cap-btn"
                    title="Re-detectar tudo"
                    onClick={() => this.commands.executeCommand(CMD_CAP_REFRESH)}
                >
                    Re-detectar tudo
                </button>
            </div>
        );
    }

    protected renderCapability(capability: CapabilityState): React.ReactNode {
        const busy = this.store.isCapabilityBusy(capability.id);
        const katsui = capability.providers.find(p => p.kind === 'katsui');
        const openable = capability.status === 'ready' && capability.surface.kind === 'iframe';
        return (
            <div className="cap-card" key={capability.id}>
                <div className="cap-head">
                    <b>{capability.label}</b>
                    <span className={`cap-pill ${capability.status}`}>{capability.status}</span>
                </div>
                <small className="cap-hint">{STATUS_HINT[capability.status] ?? capability.status}</small>
                <p className="cap-detail">{capability.detail}</p>
                {capability.detectedVersion && (
                    <small className="cap-ver">detectado: {capability.detectedVersion}</small>
                )}

                <div className="cap-providers">
                    {capability.providers.map(p => (
                        <div className="cap-provider" key={p.id} title={p.detail}>
                            <span className={`st ${p.available ? 'ok' : 'idle'}`} />
                            <span className="cap-provider-name">
                                {p.label}{p.active ? ' · ativo' : ''}
                            </span>
                            <span className="cap-provider-kind">{p.kind}</span>
                        </div>
                    ))}
                </div>

                {capability.degradations.length > 0 && (
                    <ul className="cap-degr">
                        {capability.degradations.map(d => <li key={d}>{d}</li>)}
                    </ul>
                )}

                <div className="cap-actions">
                    {capability.installable && capability.installLabel && (
                        <button
                            className="cap-btn primary"
                            disabled={busy}
                            onClick={() => this.commands.executeCommand(CMD_CAP_INSTALL, capability.id)}
                        >
                            {busy ? 'executando…' : capability.installLabel}
                        </button>
                    )}
                    {openable && (
                        <button
                            className="cap-btn"
                            onClick={() => this.commands.executeCommand(CMD_SHOW_SURFACE, capability.id)}
                        >
                            Abrir
                        </button>
                    )}
                    <button
                        className="cap-btn"
                        disabled={busy}
                        onClick={() => this.commands.executeCommand(CMD_CAP_DETECT, capability.id)}
                    >
                        Re-detectar
                    </button>
                    {/* Katsui action exists ONLY where a Katsui provider is declared. */}
                    {katsui && (
                        <button
                            className="cap-btn"
                            title={katsui.detail}
                            onClick={() => this.commands.executeCommand(CMD_CAP_KATSUI, capability.id)}
                        >
                            Conectar Katsui
                        </button>
                    )}
                </div>
            </div>
        );
    }

    /** Writes the IDE did not make — the person's agent, a script, the terminal.
     *  This is the normal case in agent-driven work, so it sits right under the
     *  capabilities instead of being buried. */
    protected renderExternal(): React.ReactNode {
        const report = this.store.observer;
        const summary = this.store.observerBusy
            ? 'olhando…'
            : !report
                ? 'não observado'
                : report.drifts.length === 0
                    ? `${report.trackedFiles} arquivos em dia`
                    : `${report.drifts.length} para conciliar`;
        return this.section(
            'external',
            'Escritas fora do IDE',
            summary,
            () => (
                <>
                    {!report && (
                        <div className="cap-card"><small>a referência do projeto ainda não foi lida</small></div>
                    )}
                    {report && report.drifts.length === 0 && (
                        <div className="cap-card">
                            <small>
                                nenhuma diferença contra a referência · {report.trackedFiles} arquivos
                                acompanhados{report.baselineAt ? ` · referência de ${report.baselineAt.slice(11, 19)}` : ''}
                            </small>
                        </div>
                    )}
                    {report && report.drifts.map(d => (
                        <div className="cap-card" key={d.relPath}>
                            <div className="cap-head">
                                <b>{d.relPath}</b>
                                <span className={`cap-pill ${d.kind === 'deleted' ? 'tool-missing' : d.kind === 'created' ? 'not-installed' : 'degraded'}`}>
                                    {d.kind}
                                </span>
                            </div>
                            <small className="cap-hint">
                                +{d.addedLines} / -{d.removedLines} · visto em {d.observedAt.slice(11, 19)} ·
                                autoria: {d.source === 'unknown' ? 'não identificada' : d.source}
                            </small>
                            {d.detail && <p className="cap-detail">{d.detail}</p>}
                            <div className="cap-actions">
                                <button
                                    className="cap-btn primary"
                                    disabled={this.store.observerBusy}
                                    title="Adota os bytes atuais como referência. Não altera o arquivo."
                                    onClick={() => this.commands.executeCommand(CMD_EXT_ACCEPT, d.relPath)}
                                >
                                    Aceitar
                                </button>
                                {d.revertible && (
                                    <button
                                        className="cap-btn"
                                        disabled={this.store.observerBusy}
                                        title="Propõe restaurar os bytes anteriores pelo broker — você decide no dock."
                                        onClick={() => this.commands.executeCommand(CMD_EXT_REVERT, d.relPath)}
                                    >
                                        Propor reversão
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                    {report && report.reconciled.length > 0 && (
                        <div className="cap-card">
                            <div className="cap-head"><b>Conciliado automaticamente</b></div>
                            <small>escritas do próprio IDE, absorvidas na referência</small>
                            {report.reconciled.slice(0, 6).map(r => (
                                <div className="cap-receipt" key={r.relPath}>
                                    <span className="cap-receipt-action">{r.source}</span>
                                    <span className="cap-receipt-detail">{r.relPath}</span>
                                    <small>{r.sourceDetail ?? ''}</small>
                                </div>
                            ))}
                        </div>
                    )}
                    {report && report.skipped.length > 0 && (
                        <div className="cap-card">
                            <div className="cap-head"><b>Fora da cobertura</b></div>
                            <ul className="cap-degr">
                                {report.skipped.slice(0, 6).map(sk => (
                                    <li key={sk.relPath}>{sk.relPath} — {sk.reason}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </>
            ),
            <div className="cap-actions" style={{ margin: '0 6px 6px' }}>
                <button
                    className="cap-btn"
                    disabled={this.store.observerBusy}
                    onClick={() => this.commands.executeCommand(CMD_EXT_SCAN)}
                >
                    Procurar agora
                </button>
                <button
                    className="cap-btn"
                    disabled={this.store.observerBusy}
                    title="Tudo que está no disco agora passa a ser a referência"
                    onClick={() => this.commands.executeCommand(CMD_EXT_BASELINE)}
                >
                    Refazer referência
                </button>
            </div>
        );
    }

    // ── technical workbench: the real surfaces the bespoke shell would hide ──

    protected renderWorkbench(): React.ReactNode {
        const surfaces: { surface: ExternalSurface; label: string; hint: string }[] = [
            { surface: 'terminal', label: 'Terminal', hint: 'PTY real no painel inferior' },
            { surface: 'output', label: 'Saída raw', hint: 'canais crus: adaptadores, plugins, tasks' },
            { surface: 'extensions', label: 'Open VSX', hint: 'marketplace de extensões' },
            { surface: 'sqltools', label: 'SQLTools', hint: 'só se o plugin estiver instalado' }
        ];
        return this.section(
            'workbench',
            'Workspace técnico',
            'debug · terminal · saída',
            () => (
                <>
                <div className="cap-card">
                    <div className="cap-head"><b>Depuração</b></div>
                    <small>
                        DAP real via ms-vscode.js-debug · configurações em .theia/launch.json ·
                        breakpoints no Monaco, pilha e variáveis no modo Depuração
                    </small>
                    <div className="cap-actions">
                        <button
                            className="cap-btn primary"
                            onClick={() => this.commands.executeCommand('instrument.mode.depuracao')}
                        >
                            Abrir Depuração
                        </button>
                        <button
                            className="cap-btn"
                            title="Inicia a configuração selecionada em .theia/launch.json"
                            onClick={() => this.commands.executeCommand('debug:start')}
                        >
                            Iniciar sessão
                        </button>
                    </div>
                </div>
                <div className="cap-card">
                    <div className="cap-head"><b>Superfícies</b></div>
                    <div className="cap-actions">
                        {surfaces.map(s => (
                            <button
                                key={s.surface}
                                className="cap-btn"
                                title={s.hint}
                                onClick={() => this.commands.executeCommand(CMD_EXTERNAL_SURFACE, s.surface)}
                            >
                                {s.label}
                            </button>
                        ))}
                    </div>
                    <small>a casca esconde a barra nativa — estas são as portas explícitas</small>
                </div>
                </>
            )
        );
    }

    /** The broker's raw trail: what governance actually recorded, unedited. */
    /**
     * PACKS LOCAIS (§4).
     *
     * Três estados, nunca colapsados em um: DISPONÍVEL é um arquivo no projeto,
     * INSTALADO é o registry conhecendo o pack e não valendo nada, APLICADO é o
     * pack contando em checkpoint. E nem aplicado fica verde: check de pack sem
     * resultado observado BLOQUEIA readiness — regra do `ide_packs`, e a razão
     * pela qual um pack de domínio não consegue abençoar projeto nenhum.
     */
    protected renderPacks(): React.ReactNode {
        const snapshot = this.store.packs;
        const busy = this.store.packsBusy;
        const summary = busy
            ? 'lendo…'
            : !snapshot
                ? 'não lidos'
                : `${snapshot.applied.length}/${snapshot.installed.length} aplicados`;

        return this.section(
            'packs',
            'Packs de domínio',
            summary,
            () => (
                <div className="cap-card">
                    {!snapshot && <small>não lidos — clique em “ler” para abrir o registry do projeto</small>}
                    {snapshot && (
                        <>
                            <small>
                                procurados em `{snapshot.lookedIn}/` · {snapshot.available.length}{' '}
                                arquivo(s) de pack no projeto
                            </small>
                            {snapshot.noObservedResults && (
                                <p className="cap-detail">{snapshot.noObservedResults}</p>
                            )}
                            {snapshot.available.map(a => (
                                <div className="cap-receipt" key={a.path}>
                                    <span className="cap-receipt-action">
                                        {a.problem ? 'ilegível' : a.installed ? 'instalado' : 'disponível'}
                                    </span>
                                    <span className="cap-receipt-detail">
                                        {a.name ?? a.path} {a.id && `· ${a.id}`}
                                    </span>
                                    <small>
                                        {a.path}
                                        {!a.problem && ` · ${a.checks} check(s), ${a.guides} guia(s)`}
                                    </small>
                                    {a.problem && <small className="cap-remediation">{a.problem}</small>}
                                    {!a.problem && !a.installed && (
                                        <div className="cap-actions">
                                            <button
                                                className="cap-btn primary"
                                                disabled={busy}
                                                title="Instalar não aplica: o pack fica inerte até você aplicar"
                                                onClick={() =>
                                                    this.commands.executeCommand(CMD_PACKS_INSTALL, a.path)
                                                }
                                            >
                                                Instalar
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ))}
                            {snapshot.installed.map(pack => {
                                const applied = snapshot.applied.includes(pack.id);
                                const verdict = snapshot.readiness.find(v => v.packId === pack.id);
                                return (
                                    <div className="cap-receipt" key={pack.id}>
                                        <span
                                            className={`cap-receipt-action ${
                                                applied ? 'check-unknown' : ''
                                            }`}
                                        >
                                            {applied ? 'aplicado' : 'inerte'}
                                        </span>
                                        <span className="cap-receipt-detail">{pack.name}</span>
                                        <small>
                                            {pack.checks.length} check(s) de domínio ·{' '}
                                            {pack.guides.length} guia(s) ·{' '}
                                            {pack.reversible ? 'reversível' : 'NÃO reversível'}
                                        </small>
                                        <small>
                                            capacidades: {pack.capabilities.join(', ') || 'nenhuma'}
                                        </small>
                                        {verdict && (
                                            <small className="cap-remediation">
                                                readiness {verdict.ready ? 'liberada' : 'bloqueada'} ·{' '}
                                                {verdict.note}
                                                {verdict.missingChecks.length > 0 &&
                                                    ` · sem resultado: ${verdict.missingChecks.join(', ')}`}
                                            </small>
                                        )}
                                        <div className="cap-actions">
                                            <button
                                                className="cap-btn"
                                                disabled={busy}
                                                onClick={() =>
                                                    this.commands.executeCommand(
                                                        applied ? CMD_PACKS_REVERT : CMD_PACKS_APPLY,
                                                        pack.id
                                                    )
                                                }
                                            >
                                                {applied ? 'Reverter' : 'Aplicar'}
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </>
                    )}
                </div>
            ),
            <div className="cap-actions" style={{ margin: '0 6px 6px' }}>
                <button
                    className="cap-btn"
                    disabled={busy}
                    onClick={() => this.commands.executeCommand(CMD_PACKS_REFRESH)}
                >
                    {busy ? 'lendo…' : 'Ler packs'}
                </button>
            </div>
        );
    }

    // ── §13 biblioteca de guidance, autoridade, config e projeto durável ────

    /** Campos em digitação (captura de guidance, registro de projeto). */
    protected drafts: Record<string, string> = {};

    protected draft(key: string): string {
        return this.drafts[key] ?? '';
    }

    protected setDraft(key: string, value: string): void {
        this.drafts[key] = value;
        this.update();
    }

    protected input(key: string, placeholder: string): React.ReactNode {
        return (
            <input
                className="cap-input"
                placeholder={placeholder}
                value={this.draft(key)}
                onChange={event => this.setDraft(key, event.target.value)}
            />
        );
    }

    /**
     * A GUIDANCE LIBRARY e o TRUTH REGISTRY (§13).
     *
     * A distinção que a tela existe para manter visível: `candidata` NÃO dirige
     * agente. Importar (arquivo de steering, detecção do §5) cria candidata;
     * promover é um ato, e só depois dele a orientação entra no contexto
     * compilado. Por isso cada linha mostra o estado, e as ativas dizem
     * explicitamente que estão no contexto de agora.
     *
     * Higiene e conflito de autoridade são exibidos, nunca resolvidos sozinhos:
     * duplicata, regra pontual salva como permanente e obsolescência são
     * findings do motor para alguém revisar.
     */
    protected renderLibrary(): React.ReactNode {
        const library = this.store.library;
        const busy = this.store.libraryBusy;
        const summary = busy
            ? 'lendo…'
            : !library
                ? 'não lida'
                : `${library.appliedNow.length} no contexto · ${
                      library.guidance.filter(g => g.state === 'candidate').length
                  } candidata(s)`;

        return this.section(
            'library',
            'Guidance e autoridade',
            summary,
            () => (
                <div className="cap-card">
                    {!library && <small>não lida — clique em “ler” para abrir a biblioteca</small>}
                    {library && (
                        <>
                            <small>
                                biblioteca versionada em `{library.libraryPath}/` · candidata não
                                entra em contexto de agente até ser promovida
                            </small>
                            {library.guidance.length === 0 && (
                                <small>nenhuma orientação neste projeto</small>
                            )}
                            {library.guidance.map(entry => {
                                const applied = library.appliedNow.find(
                                    a => a.guidance.id === entry.id
                                );
                                return (
                                    <div className="cap-receipt" key={entry.id}>
                                        <span
                                            className={`cap-receipt-action ${
                                                entry.state === 'active'
                                                    ? ''
                                                    : entry.state === 'candidate'
                                                        ? 'check-unknown'
                                                        : 'check-not_run'
                                            }`}
                                        >
                                            {entry.state}
                                        </span>
                                        <span className="cap-receipt-detail">{entry.name}</span>
                                        <small>
                                            {entry.strength} · {entry.set} · {entry.origin}
                                            {applied ? ` · no contexto: ${applied.reason}` : ''}
                                        </small>
                                        <small className="cap-evidence">
                                            {entry.provenance}
                                            {entry.lastUsedMs > 0
                                                ? ` · usada em ${new Date(
                                                      entry.lastUsedMs
                                                  ).toLocaleString()}`
                                                : ' · nunca usada em um contexto'}
                                        </small>
                                        <div className="cap-actions">
                                            {entry.state !== 'active' && (
                                                <button
                                                    className="cap-btn primary"
                                                    disabled={busy}
                                                    title="A partir daqui entra no contexto compilado para o agente"
                                                    onClick={() =>
                                                        this.commands.executeCommand(
                                                            CMD_LIBRARY_LIFECYCLE,
                                                            entry.id,
                                                            'active'
                                                        )
                                                    }
                                                >
                                                    Promover
                                                </button>
                                            )}
                                            {entry.state === 'active' && (
                                                <button
                                                    className="cap-btn"
                                                    disabled={busy}
                                                    title="Para de dirigir agente e continua recuperável"
                                                    onClick={() =>
                                                        this.commands.executeCommand(
                                                            CMD_LIBRARY_LIFECYCLE,
                                                            entry.id,
                                                            'suspended'
                                                        )
                                                    }
                                                >
                                                    Suspender
                                                </button>
                                            )}
                                            <button
                                                className="cap-btn"
                                                disabled={busy}
                                                title="Sai do caminho de steering e fica como histórico"
                                                onClick={() =>
                                                    this.commands.executeCommand(
                                                        CMD_LIBRARY_LIFECYCLE,
                                                        entry.id,
                                                        'archived'
                                                    )
                                                }
                                            >
                                                Arquivar
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}

                            {library.hygiene.length > 0 && (
                                <>
                                    <small>
                                        higiene — findings para revisar, nada é removido sozinho
                                        (janela de{' '}
                                        {Math.round(library.stalenessWindowMs / 86400000)} dias)
                                    </small>
                                    {library.hygiene.map((finding, index) => (
                                        <small className="cap-remediation" key={`hyg:${index}`}>
                                            {finding.kind === 'duplicate' &&
                                                `duplicada: ${finding.name} (${finding.ids.join(', ')})`}
                                            {finding.kind === 'point_rule_as_permanent' &&
                                                `regra pontual salva como permanente: ${finding.name}`}
                                            {finding.kind === 'obsolete' &&
                                                `ociosa desde o último uso há ${Math.round(
                                                    finding.idle_ms / 86400000
                                                )} dia(s): ${finding.name}`}
                                        </small>
                                    ))}
                                </>
                            )}

                            <div className="cap-actions">
                                {this.input('guidance-name', 'nome da orientação')}
                            </div>
                            <div className="cap-actions">
                                {this.input('guidance-text', 'texto — o que vale a partir de agora')}
                                <button
                                    className="cap-btn"
                                    disabled={
                                        busy ||
                                        this.draft('guidance-name').trim().length === 0 ||
                                        this.draft('guidance-text').trim().length === 0
                                    }
                                    title="Capturada como estável e ativa: é texto que você escreveu, no destino que você escolheu"
                                    onClick={() => {
                                        this.commands.executeCommand(CMD_LIBRARY_CAPTURE, {
                                            name: this.draft('guidance-name'),
                                            text: this.draft('guidance-text'),
                                            destination: 'create_stable'
                                        });
                                        this.setDraft('guidance-name', '');
                                        this.setDraft('guidance-text', '');
                                    }}
                                >
                                    Capturar (estável)
                                </button>
                                <button
                                    className="cap-btn"
                                    disabled={
                                        busy ||
                                        this.draft('guidance-name').trim().length === 0 ||
                                        this.draft('guidance-text').trim().length === 0
                                    }
                                    title="Vale só nesta tarefa: destino diferente, lifecycle diferente"
                                    onClick={() => {
                                        this.commands.executeCommand(CMD_LIBRARY_CAPTURE, {
                                            name: this.draft('guidance-name'),
                                            text: this.draft('guidance-text'),
                                            destination: 'use_now'
                                        });
                                        this.setDraft('guidance-name', '');
                                        this.setDraft('guidance-text', '');
                                    }}
                                >
                                    Só agora
                                </button>
                            </div>

                            <small>
                                autoridade — quem manda em cada assunto, e quem consome
                            </small>
                            {library.truth.length === 0 && (
                                <small>nenhuma autoridade declarada</small>
                            )}
                            {library.truth.map(entry => (
                                <div className="cap-receipt" key={entry.id}>
                                    <span className="cap-receipt-action">autoridade</span>
                                    <span className="cap-receipt-detail">
                                        {entry.subject} → {entry.authorityPath}
                                    </span>
                                    <small>
                                        precedência {entry.precedence} · consumidores:{' '}
                                        {entry.consumers.join(', ') || 'nenhum'}
                                    </small>
                                    <div className="cap-actions">
                                        <button
                                            className="cap-btn"
                                            disabled={busy}
                                            title="Descreve o trabalho de sincronizar e não faz nada"
                                            onClick={() =>
                                                this.commands.executeCommand(CMD_TRUTH_SYNC, entry.id)
                                            }
                                        >
                                            Propor sincronização
                                        </button>
                                    </div>
                                </div>
                            ))}
                            {library.conflicts.map((conflict, index) => (
                                <small className="cap-remediation" key={`conf:${index}`}>
                                    conflito de autoridade em {conflict.subject}:{' '}
                                    {conflict.ids.join(' × ')} — precedência não resolve isso
                                    sozinha
                                </small>
                            ))}
                            <div className="cap-actions">
                                {this.input('truth-subject', 'assunto')}
                                {this.input('truth-path', 'arquivo que manda')}
                                <button
                                    className="cap-btn"
                                    disabled={
                                        busy ||
                                        this.draft('truth-subject').trim().length === 0 ||
                                        this.draft('truth-path').trim().length === 0
                                    }
                                    onClick={() => {
                                        this.commands.executeCommand(
                                            CMD_TRUTH_DECLARE,
                                            this.draft('truth-subject'),
                                            this.draft('truth-path')
                                        );
                                        this.setDraft('truth-subject', '');
                                        this.setDraft('truth-path', '');
                                    }}
                                >
                                    Declarar autoridade
                                </button>
                            </div>
                        </>
                    )}
                </div>
            ),
            <div className="cap-actions" style={{ margin: '0 6px 6px' }}>
                <button
                    className="cap-btn"
                    disabled={busy}
                    onClick={() => this.commands.executeCommand(CMD_LIBRARY_READ)}
                >
                    {busy ? 'lendo…' : 'Ler biblioteca'}
                </button>
            </div>
        );
    }

    /**
     * CONFIGURAÇÃO (§13): um schema para o painel e para o arquivo.
     *
     * Cada campo mostra de onde o valor veio — default reversível, detecção, ou
     * escolha de pessoa — e a consequência em linguagem simples. Escolha de
     * pessoa nunca é sobrescrita por detecção; é para isso que a origem existe.
     * Campo que ninguém consome ainda aparece marcado, não escondido: esconder
     * faria o painel e o arquivo discordarem.
     */
    protected renderSettings(): React.ReactNode {
        const settings = this.store.settings;
        const busy = this.store.settingsBusy;
        const summary = busy
            ? 'lendo…'
            : !settings
                ? 'não lida'
                : `${settings.rows.filter(r => r.source === 'user').length} escolha(s) de pessoa`;

        return this.section(
            'settings',
            'Configuração do projeto',
            summary,
            () => (
                <div className="cap-card">
                    {!settings && <small>não lida — clique em “ler” para abrir a configuração</small>}
                    {settings && (
                        <>
                            <small>
                                o painel e `{settings.path}` são a mesma coisa · origem de cada
                                valor fica dita
                            </small>
                            {settings.rows.map(row => (
                                <div className="cap-receipt" key={row.field}>
                                    <span
                                        className={`cap-receipt-action ${
                                            row.source === 'user' ? '' : 'check-not_run'
                                        }`}
                                    >
                                        {row.source}
                                    </span>
                                    <span className="cap-receipt-detail">
                                        {row.label}: {row.value}
                                    </span>
                                    <small>{row.explain}</small>
                                    {row.declaredNotWired && (
                                        <small className="cap-remediation">
                                            declarado e ainda não consumido por nada
                                        </small>
                                    )}
                                    {/* §14 — trocar de modo é ato de painel, não de
                                        editar JSON na mão. As opções são as que o
                                        MOTOR declarou, na grafia do arquivo: o
                                        botão manda exatamente o que o parser
                                        aceita. A opção em vigor aparece marcada e
                                        desabilitada — reaplicar o valor atual não
                                        é uma troca, e oferecer isso como ação
                                        sugeriria que algo aconteceria. */}
                                    {(row.options.length > 0 || row.source !== 'default') && (
                                        <div className="cap-actions">
                                            {row.options.map(option => {
                                                const current =
                                                    option === row.value.toLowerCase();
                                                return (
                                                    <button
                                                        className={`cap-btn${current ? ' primary' : ''}`}
                                                        key={option}
                                                        disabled={busy || current}
                                                        title={
                                                            current
                                                                ? `${option} é o valor em vigor`
                                                                : `passa ${row.field} para ${option} em ${settings.path}`
                                                        }
                                                        onClick={() =>
                                                            this.commands.executeCommand(
                                                                CMD_SETTINGS_PATCH,
                                                                { [row.field]: option }
                                                            )
                                                        }
                                                    >
                                                        {option}
                                                    </button>
                                                );
                                            })}
                                            {row.source !== 'default' && (
                                                <button
                                                    className="cap-btn"
                                                    disabled={busy}
                                                    onClick={() =>
                                                        this.commands.executeCommand(
                                                            CMD_SETTINGS_RESET,
                                                            row.field
                                                        )
                                                    }
                                                >
                                                    Voltar ao default
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))}
                            <small>perfis de layout — só reorganizam painéis</small>
                            <div className="cap-actions">
                                {settings.profiles.map(profile => (
                                    <button
                                        className="cap-btn"
                                        key={profile.name}
                                        disabled={busy}
                                        title={`layout ${profile.layout} · profundidade ${profile.depth}`}
                                        onClick={() =>
                                            this.commands.executeCommand(
                                                CMD_SETTINGS_PROFILE,
                                                profile.name
                                            )
                                        }
                                    >
                                        {profile.name}
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                </div>
            ),
            <div className="cap-actions" style={{ margin: '0 6px 6px' }}>
                <button
                    className="cap-btn"
                    disabled={busy}
                    onClick={() => this.commands.executeCommand(CMD_SETTINGS_READ)}
                >
                    {busy ? 'lendo…' : 'Ler configuração'}
                </button>
            </div>
        );
    }

    /**
     * PROJETO DURÁVEL (§13).
     *
     * Abrir uma pasta não é escolher um projeto. Um projeto durável tem título,
     * uma intenção que alguém escreveu, e os recursos que ele abrange — pode ser
     * mais de uma pasta ou repo. É o que reabrir recupera sem transcript nenhum.
     */
    protected renderDurable(): React.ReactNode {
        const durable = this.store.durable;
        const busy = this.store.durableBusy;
        const summary = busy
            ? 'lendo…'
            : !durable
                ? 'não lido'
                : durable.project
                    ? `${durable.resources.length} recurso(s)`
                    : 'não registrado';

        return this.section(
            'durable',
            'Projeto durável',
            summary,
            () => (
                <div className="cap-card">
                    {!durable && <small>não lido — clique em “ler” para abrir o registro</small>}
                    {durable && !durable.project && (
                        <>
                            <p className="cap-detail">{durable.notRegisteredReason}</p>
                            <div className="cap-actions">{this.input('durable-title', 'título')}</div>
                            <div className="cap-actions">
                                {this.input('durable-intent', 'intenção — para que este projeto existe')}
                                <button
                                    className="cap-btn primary"
                                    disabled={
                                        busy ||
                                        this.draft('durable-title').trim().length === 0 ||
                                        this.draft('durable-intent').trim().length === 0
                                    }
                                    onClick={() =>
                                        this.commands.executeCommand(
                                            CMD_DURABLE_REGISTER,
                                            this.draft('durable-title'),
                                            this.draft('durable-intent')
                                        )
                                    }
                                >
                                    Registrar projeto
                                </button>
                            </div>
                        </>
                    )}
                    {durable?.project && (
                        <>
                            <div className="cap-head">
                                <b>{durable.project.title}</b>
                                <span className="cap-pill ready">registrado</span>
                            </div>
                            <small>{durable.project.intent}</small>
                            <small className="cap-evidence">
                                {durable.storePath} · id {durable.project.id}
                            </small>
                            {durable.resources.map(resource => (
                                <div className="cap-receipt" key={resource.id}>
                                    <span className="cap-receipt-action">{resource.kind}</span>
                                    <span className="cap-receipt-detail">
                                        {resource.canonical_path}
                                    </span>
                                </div>
                            ))}
                            <div className="cap-actions">
                                {this.input('durable-attach', 'caminho de outra pasta ou repo')}
                                <button
                                    className="cap-btn"
                                    disabled={busy || this.draft('durable-attach').trim().length === 0}
                                    onClick={() => {
                                        this.commands.executeCommand(
                                            CMD_DURABLE_ATTACH,
                                            this.draft('durable-attach'),
                                            'repository'
                                        );
                                        this.setDraft('durable-attach', '');
                                    }}
                                >
                                    Anexar recurso
                                </button>
                            </div>
                            <div className="cap-actions">
                                {this.input('durable-new-intent', 'reescrever a intenção')}
                                <button
                                    className="cap-btn"
                                    disabled={
                                        busy || this.draft('durable-new-intent').trim().length === 0
                                    }
                                    onClick={() => {
                                        this.commands.executeCommand(
                                            CMD_DURABLE_INTENT,
                                            this.draft('durable-new-intent')
                                        );
                                        this.setDraft('durable-new-intent', '');
                                    }}
                                >
                                    Reescrever intenção
                                </button>
                            </div>
                        </>
                    )}
                    {durable?.project && this.renderReferences()}
                    {durable?.gaps.map((gap, index) => (
                        <small className="cap-remediation" key={`gap:${index}`}>
                            ainda não: {gap}
                        </small>
                    ))}
                </div>
            ),
            <div className="cap-actions" style={{ margin: '0 6px 6px' }}>
                <button
                    className="cap-btn"
                    disabled={busy}
                    onClick={() => this.commands.executeCommand(CMD_DURABLE_READ)}
                >
                    {busy ? 'lendo…' : 'Ler projeto'}
                </button>
            </div>
        );
    }

    /**
     * REFERÊNCIAS (§13), dentro do projeto durável porque é onde elas vivem.
     *
     * Serviço e ambiente não são recurso: recurso do motor é diretório canônico,
     * e um serviço não tem diretório. Eles têm ENDEREÇO. Ligar declara que este
     * projeto depende deles — e é só isso: nada aqui chama o endpoint, então não
     * existe (e não deve existir) selo de "no ar" nesta lista.
     */
    protected renderReferences(): React.ReactNode {
        const refs = this.store.references;
        const busy = this.store.referencesBusy;
        return (
            <>
                <div className="cap-head">
                    <b>Referências</b>
                    <span className="cap-pill ready">
                        {refs ? `${refs.references.length}` : 'não lidas'}
                    </span>
                </div>
                <small className="cap-hint">
                    {refs?.note ??
                        'serviço e ambiente entram por endereço, não por caminho — ligar declara dependência, não verifica nada'}
                </small>
                {refs?.blockedReason && <p className="cap-detail">{refs.blockedReason}</p>}
                {refs?.references.map(reference => (
                    <div className="cap-receipt" key={reference.id}>
                        <span className="cap-receipt-action">{reference.kind}</span>
                        <span className="cap-receipt-detail">
                            {reference.name} · {reference.endpoint}
                        </span>
                        <small>
                            {reference.projects.length > 1
                                ? `compartilhada com ${reference.projects.length - 1} outro(s) projeto(s)`
                                : 'só deste projeto'}
                        </small>
                        <button
                            className="cap-btn"
                            disabled={busy}
                            title="Desliga daqui; outros projetos que a usam continuam com ela"
                            onClick={() =>
                                this.commands.executeCommand(CMD_REFS_UNLINK, reference.id)
                            }
                        >
                            Desligar
                        </button>
                    </div>
                ))}
                <div className="cap-actions">
                    {this.input('ref-id', 'id (ex.: svc:api)')}
                    {this.input('ref-name', 'nome')}
                </div>
                <div className="cap-actions">
                    {this.input('ref-endpoint', 'endpoint ou rótulo do ambiente')}
                    <button
                        className="cap-btn"
                        disabled={
                            busy ||
                            this.draft('ref-id').trim().length === 0 ||
                            this.draft('ref-name').trim().length === 0 ||
                            this.draft('ref-endpoint').trim().length === 0
                        }
                        onClick={() => {
                            this.commands.executeCommand(
                                CMD_REFS_LINK,
                                this.draft('ref-id').trim(),
                                'service',
                                this.draft('ref-name').trim(),
                                this.draft('ref-endpoint').trim()
                            );
                            this.setDraft('ref-id', '');
                            this.setDraft('ref-name', '');
                            this.setDraft('ref-endpoint', '');
                        }}
                    >
                        Ligar serviço
                    </button>
                    <button
                        className="cap-btn"
                        disabled={
                            busy ||
                            this.draft('ref-id').trim().length === 0 ||
                            this.draft('ref-name').trim().length === 0 ||
                            this.draft('ref-endpoint').trim().length === 0
                        }
                        onClick={() => {
                            this.commands.executeCommand(
                                CMD_REFS_LINK,
                                this.draft('ref-id').trim(),
                                'environment',
                                this.draft('ref-name').trim(),
                                this.draft('ref-endpoint').trim()
                            );
                            this.setDraft('ref-id', '');
                            this.setDraft('ref-name', '');
                            this.setDraft('ref-endpoint', '');
                        }}
                    >
                        Ligar ambiente
                    </button>
                    <button
                        className="cap-btn"
                        disabled={busy}
                        onClick={() => this.commands.executeCommand(CMD_REFS_READ)}
                    >
                        {busy ? 'lendo…' : 'Ler referências'}
                    </button>
                </div>
            </>
        );
    }

    /** Rótulo humano dos sete status calculados. */
    protected statusLabel(status: string): string {
        switch (status) {
            case 'not_started': return 'não iniciado';
            case 'in_progress': return 'em andamento';
            case 'implemented_not_verified': return 'implementado, não verificado';
            case 'partially_verified': return 'parcialmente verificado';
            case 'verified': return 'verificado';
            case 'blocked': return 'bloqueado';
            case 'evidence_stale': return 'evidência desatualizada';
            default: return status;
        }
    }

    /**
     * TRABALHO (§9).
     *
     * Feature → Task → Subtask, com task direta e task servindo mais de uma
     * feature. O que esta tela mostra de status NUNCA foi escrito por ninguém: o
     * motor derivou de critério, implementação declarada e frescor da prova, e a
     * razão vem junto — status sem razão é indistinguível de status digitado.
     *
     * O provider é o padrão do harness, não um sistema paralelo: ele toma os
     * slots pelo mesmo registro que qualquer provider, e um projeto que use GSD
     * ou Scrum suspende este e ativa o dele.
     */
    protected renderWork(): React.ReactNode {
        const work = this.store.work;
        const busy = this.store.workBusy;
        const summary = busy
            ? 'lendo…'
            : !work
                ? 'não lido'
                : `${work.items.length} item(ns)`;
        const statusOf = (id: string) => work?.statuses.find(s => s.id === id);

        return this.section(
            'work',
            'Trabalho',
            summary,
            () => (
                <div className="cap-card">
                    {!work && <small>não lido — clique em “ler” para calcular os status</small>}
                    {work && (
                        <>
                            <small className="cap-hint">
                                status é calculado, não escrito: o artefato não tem campo de status ·
                                task concluída não promove feature · material que muda torna prova
                                antiga desatualizada · critério proposto por agente aparece e não conta
                            </small>
                            <small className="cap-evidence">
                                itens em {work.itemsDir} · {Object.keys(work.observed).length} assunto(s)
                                medidos agora
                            </small>

                            <div className="cap-actions">
                                {this.input('work-id', 'id do item (sem / nem .)')}
                                {this.input('work-title', 'título')}
                            </div>
                            <div className="cap-actions">
                                {this.input('work-parent', 'id da feature que ele serve (opcional)')}
                                <button
                                    className="cap-btn"
                                    disabled={
                                        busy ||
                                        this.draft('work-id').trim().length === 0 ||
                                        this.draft('work-title').trim().length === 0
                                    }
                                    onClick={() => {
                                        this.commands.executeCommand(
                                            CMD_WORK_ADD,
                                            this.draft('work-id').trim(),
                                            this.draft('work-title').trim(),
                                            'task',
                                            this.draft('work-parent').trim() || undefined
                                        );
                                        this.setDraft('work-id', '');
                                        this.setDraft('work-title', '');
                                    }}
                                >
                                    Declarar task
                                </button>
                                <button
                                    className="cap-btn"
                                    disabled={
                                        busy ||
                                        this.draft('work-id').trim().length === 0 ||
                                        this.draft('work-title').trim().length === 0
                                    }
                                    onClick={() => {
                                        this.commands.executeCommand(
                                            CMD_WORK_ADD,
                                            this.draft('work-id').trim(),
                                            this.draft('work-title').trim(),
                                            'feature'
                                        );
                                        this.setDraft('work-id', '');
                                        this.setDraft('work-title', '');
                                    }}
                                >
                                    Declarar feature
                                </button>
                            </div>

                            {work.items.map(item => {
                                const status = statusOf(item.id);
                                return (
                                    <div className="cap-receipt" key={item.id}>
                                        <span className="cap-receipt-action">
                                            {item.kind}
                                        </span>
                                        <span className="cap-receipt-detail">
                                            {item.title} · {this.statusLabel(status?.status ?? '—')}
                                        </span>
                                        <small>{status?.reason}</small>
                                        {status && status.criteriaTotal > 0 && (
                                            <small className="cap-evidence">
                                                {status.criteriaVerified}/{status.criteriaTotal} critérios
                                                {status.proposedCriteria > 0 &&
                                                    ` · ${status.proposedCriteria} proposto(s) por agente, não contam`}
                                                {status.staleCriteria.length > 0 &&
                                                    ` · prova velha em ${status.staleCriteria.join(', ')}`}
                                            </small>
                                        )}
                                        {item.parents && item.parents.length > 0 && (
                                            <small className="cap-evidence">
                                                serve {item.parents.join(', ')}
                                            </small>
                                        )}
                                    </div>
                                );
                            })}

                            {work.problems.map((problem, index) => (
                                <small className="cap-remediation" key={`p:${index}`}>
                                    {problem.id}: {problem.problem}
                                </small>
                            ))}
                            {work.unreadable.map((problem, index) => (
                                <small className="cap-remediation" key={`u:${index}`}>
                                    {problem.path}: {problem.problem}
                                </small>
                            ))}
                        </>
                    )}
                </div>
            ),
            <div className="cap-actions" style={{ margin: '0 6px 6px' }}>
                <button
                    className="cap-btn"
                    disabled={busy}
                    onClick={() => this.commands.executeCommand(CMD_WORK_READ)}
                >
                    {busy ? 'lendo…' : 'Ler trabalho'}
                </button>
                <button
                    className="cap-btn"
                    disabled={busy}
                    title="Registra e ativa o provider padrão pelos mesmos slots exclusivos do §1"
                    onClick={() => this.commands.executeCommand(CMD_WORK_PROVIDER)}
                >
                    Usar provider padrão
                </button>
            </div>
        );
    }

    /**
     * VERSÕES (§16) — consolidar, exportar, reabrir.
     *
     * A seção se chamava "Publicar" e essa palavra prometia deploy: a pessoa
     * clicava esperando ver o produto no ar e o que acontecia era uma linha num
     * registro local. Agora cada ato tem o seu nome e a sua classe de efeito:
     *
     *  • CONSOLIDAR congela a versão no registro do projeto. Local.
     *  • EXPORTAR grava um manifesto portátil. Local, com undo de verdade.
     *  • PUBLICAR leva a versão a um destino real, por adapter — o único com
     *    efeito externo, e o único sem undo. Nenhum adapter existe ainda, e o
     *    botão fica desabilitado DIZENDO isso em vez de fingir.
     *
     * A tela mostra a classe que o motor calculou; não inventa rollback nem
     * esconde a falta de um.
     */
    /**
     * O EXPORT REABERTO (LIFE-03).
     *
     * O ciclo só fecha quando um problema visto depois de publicar volta para o
     * projeto. Reabrir mostra o que aquela versão dizia e o que mudou desde ela;
     * marcar um recurso é o que LIGA o problema observado ao projeto — sem isso a
     * versão seguinte sai com um texto solto no registro e ninguém consegue,
     * depois, responder "o que essa correção tocou".
     *
     * Um recurso que sumiu do projeto continua marcável de propósito: ele pode
     * ser exatamente a causa do problema.
     */
    protected renderReopened(reopened: ReopenedExport, busy: boolean): React.ReactNode {
        const related = this.store.lifecycleRelated;
        const steering = [
            ...reopened.guidanceAdded.map(id => `+guidance ${id}`),
            ...reopened.guidanceRemoved.map(id => `−guidance ${id}`),
            ...reopened.packsAdded.map(id => `+pack ${id}`),
            ...reopened.packsRemoved.map(id => `−pack ${id}`)
        ];
        return (
            <div className="cap-card">
                <div className="cap-head">
                    <b>reaberto: {reopened.title} {reopened.version}</b>
                    <span className={reopened.recorded ? 'cap-pill ready' : 'cap-pill'}>
                        {reopened.recorded ? 'versão consolidada' : 'ensaio local'}
                    </span>
                </div>
                <small className="cap-evidence">{reopened.summary}</small>
                <small className="cap-evidence">{reopened.path} · {reopened.portabilityNote}</small>

                <p className="cap-detail">intenção no export: {reopened.intent}</p>
                {reopened.intentNow && (
                    <p className="cap-remediation">intenção hoje: {reopened.intentNow}</p>
                )}
                {reopened.titleNow && (
                    <p className="cap-remediation">título hoje: {reopened.titleNow}</p>
                )}

                <small className="cap-hint">
                    marque os recursos que o problema observado atinge · é o vínculo que a
                    próxima versão grava, e o que responde depois “o que essa correção tocou”
                </small>
                {reopened.resources.length === 0 && (
                    <small className="cap-evidence">o export não listou recurso nenhum</small>
                )}
                {reopened.resources.map(resource => (
                    <div className="cap-receipt" key={resource.id}>
                        <span className="cap-receipt-action">
                            <input
                                type="checkbox"
                                checked={related.includes(resource.id)}
                                disabled={busy}
                                onChange={() =>
                                    this.commands.executeCommand(CMD_LIFECYCLE_RELATE, resource.id)
                                }
                            />
                        </span>
                        <span className="cap-receipt-detail">
                            {resource.label} · {resource.kind}
                        </span>
                        <small>
                            {resource.stillPresent ? 'ainda no projeto' : 'sumiu do projeto'}
                        </small>
                    </div>
                ))}
                {reopened.appeared.length > 0 && (
                    <small className="cap-evidence">
                        depois deste export apareceram: {reopened.appeared.join(', ')}
                    </small>
                )}
                {steering.length > 0 && (
                    <small className="cap-evidence">
                        guidance/packs desde o export: {steering.join(' · ')}
                    </small>
                )}
                {related.length > 0 && (
                    <small className="cap-hint">
                        {related.length} recurso(s) serão gravados na próxima versão
                    </small>
                )}
            </div>
        );
    }

    /**
     * PUBLICAR (§16) — o adapter Git, e os três atos que ele tem.
     *
     * Esta seção é o "publicar" de verdade, separado do consolidar: aqui a
     * versão sai da máquina. Ela existe porque um botão "Publicar" genérico
     * mentiria de novo — publicar é sempre POR ALGUM destino, e cada destino tem
     * a sua classe de efeito e a sua compensação:
     *
     *  • criar a tag é local e apagar desfaz;
     *  • empurrar é externo e apagar no remoto apenas MITIGA;
     *  • a release do GitHub exige `gh` autenticado — instalado não basta.
     *
     * O estado das ferramentas é dito pelo motor, com a remediação de cada
     * ausência. Nenhum botão aparece habilitado sobre uma ferramenta que não
     * respondeu.
     */
    protected renderRelease(): React.ReactNode {
        const release = this.store.release;
        const busy = this.store.releaseBusy;
        const summary = busy
            ? 'lendo…'
            : !release
                ? 'não lido'
                : release.blockedReason
                    ? 'indisponível'
                    : `${release.versions.filter(v => v.pushed).length}/${release.versions.length} no remoto`;

        return this.section(
            'release',
            'Publicar (Git)',
            summary,
            () => (
                <div className="cap-card">
                    {!release && <small>não lido — clique em “ler” para ver git, gh e as versões</small>}
                    {release?.blockedReason && <p className="cap-detail">{release.blockedReason}</p>}
                    {release && (
                        <>
                            <div className="cap-receipt">
                                <span className="cap-receipt-action">git</span>
                                <span className="cap-receipt-detail">{release.git.detail}</span>
                                <small>{release.git.usable ? 'pronto' : 'não utilizável'}</small>
                            </div>
                            {release.git.remediation && (
                                <small className="cap-remediation">{release.git.remediation}</small>
                            )}
                            <div className="cap-receipt">
                                <span className="cap-receipt-action">gh</span>
                                <span className="cap-receipt-detail">{release.gh.detail}</span>
                                <small>{release.gh.usable ? 'autenticado' : 'não utilizável'}</small>
                            </div>
                            {release.gh.remediation && (
                                <small className="cap-remediation">{release.gh.remediation}</small>
                            )}
                            {/* A ÁRVORE SUJA MUDA O QUE A TAG SIGNIFICA.
                                A tag aponta para o último COMMIT; o que está
                                aberto no editor fica de fora. Descobrir isso
                                depois de empurrar é tarde. */}
                            {release.dirty && (
                                <small className="cap-remediation">
                                    árvore suja: a tag apontaria para o último commit
                                    {release.headCommit ? ` (${release.headCommit})` : ''}, não para o
                                    que está aberto no editor
                                </small>
                            )}

                            {release.versions.map(version => (
                                <div className="cap-receipt" key={version.version}>
                                    <span className="cap-receipt-action">{version.tag}</span>
                                    <span className="cap-receipt-detail">
                                        {version.tagged
                                            ? `tag local${version.tagCommit ? ` em ${version.tagCommit}` : ''}`
                                            : 'sem tag'}
                                        {version.pushed ? ' · no remoto' : ''}
                                        {version.releaseUrl ? ` · release: ${version.releaseUrl}` : ''}
                                    </span>
                                    {!version.tagged && (
                                        <button
                                            className="cap-btn"
                                            disabled={busy || !release.git.usable}
                                            title="Cria a tag anotada nesta máquina, com as notas do registro da versão"
                                            onClick={() =>
                                                this.commands.executeCommand(CMD_RELEASE_TAG, version.version)
                                            }
                                        >
                                            Criar tag
                                        </button>
                                    )}
                                    {version.tagged && !version.pushed && (
                                        <button
                                            className="cap-btn"
                                            disabled={busy}
                                            title="Compensação da tag local: apagar desfaz por completo"
                                            onClick={() =>
                                                this.commands.executeCommand(
                                                    CMD_RELEASE_DELETE_TAG,
                                                    version.version
                                                )
                                            }
                                        >
                                            Apagar tag
                                        </button>
                                    )}
                                    {version.tagged && !version.pushed && (
                                        <button
                                            className="cap-btn primary"
                                            disabled={busy || !release.remote}
                                            title={release.remote
                                                ? `Empurra ${version.tag} para ${release.remote}. Efeito externo: apagar no remoto mitiga, não desfaz`
                                                : 'Nenhum remoto configurado neste repositório'}
                                            onClick={() =>
                                                this.commands.executeCommand(CMD_RELEASE_PUSH, version.version)
                                            }
                                        >
                                            Empurrar
                                        </button>
                                    )}
                                    {version.pushed && !version.releaseUrl && (
                                        <button
                                            className="cap-btn primary"
                                            disabled={busy || !release.gh.usable}
                                            title={release.gh.usable
                                                ? 'Cria a release no GitHub com as notas do registro'
                                                : release.gh.remediation ?? 'gh não está utilizável'}
                                            onClick={() =>
                                                this.commands.executeCommand(CMD_RELEASE_GITHUB, version.version)
                                            }
                                        >
                                            Release no GitHub
                                        </button>
                                    )}
                                </div>
                            ))}
                        </>
                    )}
                </div>
            ),
            <div className="cap-actions" style={{ margin: '0 6px 6px' }}>
                <button
                    className="cap-btn"
                    disabled={busy}
                    onClick={() => this.commands.executeCommand(CMD_RELEASE_READ)}
                >
                    {busy ? 'lendo…' : 'Ler'}
                </button>
            </div>
        );
    }

    protected renderLifecycle(): React.ReactNode {
        const cycle = this.store.lifecycle;
        const busy = this.store.lifecycleBusy;
        const attempt = this.store.lifecycleAttempt;
        const reopened = this.store.lifecycleReopened;
        const summary = busy
            ? 'lendo…'
            : !cycle
                ? 'não lido'
                : cycle.blockedReason
                    ? 'sem projeto durável'
                    : `${cycle.history.length} versão(ões) · ${cycle.exports.length} export(s)`;

        return this.section(
            'lifecycle',
            'Versões',
            summary,
            () => (
                <div className="cap-card">
                    {!cycle && <small>não lido — clique em “ler” para abrir o histórico</small>}
                    {cycle?.blockedReason && <p className="cap-detail">{cycle.blockedReason}</p>}
                    {cycle && !cycle.blockedReason && (
                        <>
                            <div className="cap-head">
                                <b>{cycle.title}</b>
                                <span className="cap-pill ready">próxima: {cycle.nextVersion}</span>
                            </div>
                            <small className="cap-evidence">
                                {cycle.logPath} · exports em {cycle.exportsPath}
                            </small>
                            <small className="cap-hint">
                                consolidar é local: congela “esta é a versão X, corrige tal
                                problema, tocou tais recursos” · export grava um arquivo portátil e
                                apagar desfaz · publicar num destino real é outro passo, por
                                adapter, e é o único com efeito externo · nada aqui exige ShinAI ou
                                Katsui
                            </small>

                            <div className="cap-actions">
                                <button
                                    className="cap-btn"
                                    disabled={busy}
                                    onClick={() => this.commands.executeCommand(CMD_LIFECYCLE_EXPORT)}
                                >
                                    Exportar (local)
                                </button>
                                <button
                                    className="cap-btn primary"
                                    disabled={busy || (cycle.history.length > 0 &&
                                        this.draft('lifecycle-problem').trim().length === 0)}
                                    title={cycle.history.length > 0
                                        ? 'Uma versão sobre outra pede o problema observado que ela corrige'
                                        : 'Congela a primeira versão no registro local do projeto'}
                                    onClick={() =>
                                        this.commands.executeCommand(
                                            CMD_LIFECYCLE_CONSOLIDATE,
                                            this.draft('lifecycle-problem') || undefined
                                        )
                                    }
                                >
                                    Consolidar {cycle.nextVersion}
                                </button>
                                {/* PUBLICAR NÃO EXISTE AINDA, E O BOTÃO DIZ ISSO.
                                    Enquanto os dois atos eram um só, a tela prometia
                                    deploy e entregava registro local. Um botão
                                    desabilitado com o motivo é honesto; um botão que
                                    grava no caderno e diz "publicado" não é. */}
                                <button
                                    className="cap-btn"
                                    disabled={true}
                                    title="Nenhum destino configurado: publicar exige um adapter (release Git, provider, servidor local) e nenhum existe ainda neste projeto"
                                >
                                    Publicar… (sem destino)
                                </button>
                            </div>
                            {cycle.history.length > 0 && (
                                <div className="cap-actions">
                                    {this.input('lifecycle-problem', 'problema observado que esta versão corrige')}
                                </div>
                            )}

                            {attempt && (
                                <small className={attempt.needsConfirmation ? 'cap-remediation' : 'cap-evidence'}>
                                    {attempt.needsConfirmation ? 'aguardando confirmação: ' : ''}
                                    {attempt.explain}
                                </small>
                            )}

                            {reopened && this.renderReopened(reopened, busy)}

                            {cycle.exports.map(file => (
                                <div className="cap-receipt" key={file.path}>
                                    <span className="cap-receipt-action">export</span>
                                    <span className="cap-receipt-detail">
                                        {file.path} · {file.version ?? 'versão ilegível'} ·{' '}
                                        {Math.max(1, Math.round(file.bytes / 1024))} KiB
                                    </span>
                                    <button
                                        className="cap-btn"
                                        disabled={busy}
                                        title="Reabrir este export e ver o que mudou desde ele"
                                        onClick={() =>
                                            this.commands.executeCommand(
                                                CMD_LIFECYCLE_REOPEN,
                                                file.path
                                            )
                                        }
                                    >
                                        Reabrir
                                    </button>
                                    <button
                                        className="cap-btn"
                                        disabled={busy}
                                        title="Compensação do export: apagar o arquivo desfaz por completo"
                                        onClick={() =>
                                            this.commands.executeCommand(
                                                CMD_LIFECYCLE_DELETE_EXPORT,
                                                file.path
                                            )
                                        }
                                    >
                                        Apagar
                                    </button>
                                </div>
                            ))}

                            {/* A LINHA DIZ QUAL DOS DOIS ATOS ELA FOI.
                                Sem isto a separação só existiria no arquivo: na
                                tela, uma versão apenas consolidada e uma que
                                saiu para um destino teriam a mesma cara — que é
                                exatamente a confusão que esta seção deixou de
                                fazer. `published` aparece em linhas gravadas
                                quando o passo se dizia externo. */}
                            {cycle.history.map(record => (
                                <div className="cap-receipt" key={record.version}>
                                    <span className="cap-receipt-action">v{record.version}</span>
                                    <span
                                        className={
                                            record.kind === 'published'
                                                ? 'cap-pill ready'
                                                : 'cap-pill'
                                        }
                                        title={
                                            record.kind === 'published'
                                                ? 'gravada como publicação externa'
                                                : 'consolidada localmente; não foi para nenhum destino'
                                        }
                                    >
                                        {record.kind === 'published' ? 'externa' : 'local'}
                                    </span>
                                    <span className="cap-receipt-detail">
                                        {record.problem ? `corrige: ${record.problem}` : record.note}
                                        {record.relatedResources.length > 0 &&
                                            ` · ligado a ${record.relatedResources.length} recurso(s)`}
                                    </span>
                                    <small>
                                        {/* Onde a versão FOI PARAR, que é outra
                                            pergunta que a linha precisa responder:
                                            consolidada e em lugar nenhum é o estado
                                            normal, e some se a tela calar. */}
                                        {record.deployments?.length
                                            ? record.deployments
                                                .map(d => `${d.target}: ${d.reference}`)
                                                .join(' · ')
                                            : 'em nenhum destino'}
                                    </small>
                                    <small>
                                        {record.reversibility === 'irreversible'
                                            ? 'irreversível, sem compensação'
                                            : record.compensation?.note ?? record.reversibility}
                                    </small>
                                </div>
                            ))}
                        </>
                    )}
                </div>
            ),
            <div className="cap-actions" style={{ margin: '0 6px 6px' }}>
                <button
                    className="cap-btn"
                    disabled={busy}
                    onClick={() => this.commands.executeCommand(CMD_LIFECYCLE_READ)}
                >
                    {busy ? 'lendo…' : 'Ler versões'}
                </button>
            </div>
        );
    }

    protected renderBrokerTrail(): React.ReactNode {
        const trail = this.store.brokerActivity;
        const summary = this.store.brokerActivityBusy
            ? 'lendo…'
            : trail === undefined ? 'não lida' : `${trail.length} eventos`;
        return this.section(
            'broker',
            'Trilha do broker (raw)',
            summary,
            () => (
                <div className="cap-card">
                    {/* §6: escopo dito na tela. Esta trilha é dos efeitos Bastion
                        DESTE projeto — não é feed de frota, e o Control Tower não
                        é lido aqui. Evento com caminho fora da raiz é descartado
                        e contado no log do backend. */}
                    <small>
                        efeitos Bastion deste projeto · Control Tower não é lido aqui
                    </small>
                    {trail === undefined && <small>não lida — clique em “ler” para buscar do broker</small>}
                    {trail && trail.length === 0 && <small>o broker não registrou eventos neste projeto</small>}
                    {trail && trail.map((entry, index) => (
                        <div className="cap-receipt" key={`${entry.effect_id}:${entry.kind}:${index}`}>
                            <span className="cap-receipt-action">{entry.kind}</span>
                            <span className="cap-receipt-detail">{entry.path ?? '—'}</span>
                            <small>{entry.effect_id}</small>
                        </div>
                    ))}
                </div>
            ),
            <div className="cap-actions" style={{ margin: '0 6px 6px' }}>
                <button
                    className="cap-btn"
                    disabled={this.store.brokerActivityBusy}
                    onClick={() => this.commands.executeCommand(CMD_BROKER_TRAIL)}
                >
                    {this.store.brokerActivityBusy ? 'lendo…' : 'Ler do broker'}
                </button>
            </div>
        );
    }

    // ── harness provider ────────────────────────────────────────────────────

    protected renderHarness(): React.ReactNode {
        const snapshot = this.store.harness;
        const taken = snapshot ? snapshot.bindings.filter(b => b.providerId).length : 0;
        const summary = !snapshot
            ? 'lendo…'
            : `${snapshot.providers.length} providers · ${taken}/3 slots`;
        return this.section(
            'harness',
            'Harness Provider',
            summary,
            () => (
                <>
                    {!snapshot && <div className="cap-card"><small>lendo o harness do projeto…</small></div>}
                    {snapshot && this.renderSlots(snapshot)}
                    {snapshot && this.renderProviders(snapshot)}
                    {snapshot && this.renderExtensions(snapshot)}
                    {snapshot && this.renderReceipts(snapshot)}
                </>
            )
        );
    }

    protected renderSlots(snapshot: HarnessSnapshot): React.ReactNode {
        return (
            <div className="cap-card">
                <div className="cap-head"><b>Slots exclusivos</b></div>
                {snapshot.bindings.map(b => (
                    <div className="cap-slot" key={b.slot}>
                        <span className="cap-slot-name">{b.slot}</span>
                        <span className={`cap-slot-owner${b.providerId ? ' taken' : ''}`}>
                            {b.providerId ?? 'livre'}
                        </span>
                    </div>
                ))}
                <small className="cap-hint">
                    um dono por slot, por projeto · segunda reivindicação é recusada, nunca mesclada
                </small>
            </div>
        );
    }

    protected renderProviders(snapshot: HarnessSnapshot): React.ReactNode {
        const busy = this.store.harnessBusy;
        const test = snapshot.providers.find(p => p.manifest.id === TEST_PROVIDER_ID);
        const rival = snapshot.providers.find(p => p.manifest.id === CONFLICT_PROVIDER_ID);
        return (
            <div className="cap-card">
                <div className="cap-head"><b>Providers registrados</b></div>
                {snapshot.providers.length === 0 && (
                    <small>nenhum provider registrado neste projeto</small>
                )}
                {snapshot.providers.map(p => this.renderProvider(p))}
                <div className="cap-actions">
                    {!test && (
                        <button
                            className="cap-btn primary"
                            disabled={busy}
                            onClick={() => this.commands.executeCommand(CMD_HARNESS_REGISTER)}
                        >
                            Registrar provider de prova
                        </button>
                    )}
                    {test && test.status !== 'active' && (
                        <button
                            className="cap-btn primary"
                            disabled={busy}
                            onClick={() => this.commands.executeCommand(CMD_HARNESS_ACTIVATE, TEST_PROVIDER_ID)}
                        >
                            Ativar
                        </button>
                    )}
                    {test && test.status === 'active' && (
                        <>
                            <button
                                className="cap-btn"
                                disabled={busy}
                                onClick={() => this.commands.executeCommand(CMD_HARNESS_SUSPEND, TEST_PROVIDER_ID)}
                            >
                                Suspender
                            </button>
                            <button
                                className="cap-btn"
                                disabled={busy}
                                onClick={() => this.commands.executeCommand(CMD_HARNESS_MIGRATE, TEST_PROVIDER_ID)}
                            >
                                Migrar v2
                            </button>
                            <button
                                className="cap-btn"
                                disabled={busy}
                                title="O provider propõe uma escrita real; ela para no broker aguardando aprovação"
                                onClick={() => this.commands.executeCommand(CMD_HARNESS_EFFECT, TEST_PROVIDER_ID)}
                            >
                                Propor efeito
                            </button>
                        </>
                    )}
                    {test && (
                        <button
                            className="cap-btn"
                            disabled={busy}
                            onClick={() => this.commands.executeCommand(CMD_HARNESS_SEED, TEST_PROVIDER_ID)}
                        >
                            Semear itens
                        </button>
                    )}
                    {!rival && (
                        <button
                            className="cap-btn"
                            disabled={busy}
                            title="Registra um provider rival que reivindica o slot workflow"
                            onClick={() => this.commands.executeCommand(CMD_HARNESS_REGISTER, 'conflict')}
                        >
                            Registrar rival
                        </button>
                    )}
                    {rival && rival.status !== 'active' && (
                        <button
                            className="cap-btn"
                            disabled={busy}
                            title="Deve ser recusado enquanto outro provider detiver workflow"
                            onClick={() => this.commands.executeCommand(CMD_HARNESS_ACTIVATE, CONFLICT_PROVIDER_ID)}
                        >
                            Ativar rival
                        </button>
                    )}
                </div>
            </div>
        );
    }

    protected renderProvider(provider: HarnessProviderState): React.ReactNode {
        const m = provider.manifest;
        return (
            <div className="cap-provider-row" key={m.id}>
                <div className="cap-head">
                    <b>{m.label}</b>
                    <span className={`cap-pill ${provider.status === 'active' ? 'ready' : 'not-installed'}`}>
                        {provider.status}
                    </span>
                </div>
                <small>
                    manifesto v{m.manifestVersion} · provider {m.version} ·
                    estado escrito por {provider.stateVersion} · {provider.items.length} artefatos
                </small>
                <small>manifesto: {provider.manifestPath}</small>
                <small>reivindica: {m.claims.join(', ') || 'nada'}</small>
                <small>artefatos: {m.artifacts.itemsDir}/*{m.artifacts.itemExtension}</small>
                {m.workflow && <small>workflow: {m.workflow.states.join(' → ')}</small>}
                {m.hierarchy && <small>hierarquia: {m.hierarchy.levels.join(' / ')}</small>}
                {m.primaryStatus && (
                    <small>{m.primaryStatus.label}: {m.primaryStatus.values.join(' · ')}</small>
                )}
                {m.limitations && m.limitations.length > 0 && (
                    <ul className="cap-degr">
                        {m.limitations.map(l => <li key={l}>{l}</li>)}
                    </ul>
                )}
                {provider.items.length > 0 && (
                    <div className="cap-providers">
                        {provider.items.map(item => (
                            <div className="cap-provider" key={item.id} title={item.path}>
                                <span className="st ok" />
                                <span className="cap-provider-name">{item.title}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    protected renderExtensions(snapshot: HarnessSnapshot): React.ReactNode {
        return (
            <div className="cap-card">
                <div className="cap-head"><b>Extensões compostas</b></div>
                {snapshot.composedExtensions.length === 0 && (
                    <small>nenhuma — só providers ativos contribuem</small>
                )}
                {snapshot.composedExtensions.map(e => (
                    <div className="cap-slot" key={`${e.providerId}:${e.kind}:${e.name}`}>
                        <span className="cap-slot-name">{e.kind}</span>
                        <span className="cap-slot-owner taken">{e.name}</span>
                        <span className="cap-provider-kind">{e.providerId}</span>
                    </div>
                ))}
            </div>
        );
    }

    protected renderReceipts(snapshot: HarnessSnapshot): React.ReactNode {
        const receipts = snapshot.receipts.slice(-6).reverse();
        return (
            <div className="cap-card">
                <div className="cap-head"><b>Recibos</b></div>
                {receipts.length === 0 && <small>nenhum evento registrado</small>}
                {receipts.map(r => (
                    <div className="cap-receipt" key={`${r.at}:${r.action}:${r.providerId}`}>
                        <span className="cap-receipt-action">{r.action}</span>
                        <span className="cap-receipt-detail">{r.detail}</span>
                        <small>{r.at.slice(11, 19)} · {r.providerId}</small>
                    </div>
                ))}
            </div>
        );
    }
}
