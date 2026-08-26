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
                {this.renderWorkbench()}
                {this.renderBrokerTrail()}
                {this.renderHarness()}
            </div>
        );
    }

    // ── capabilities ────────────────────────────────────────────────────────

    protected renderCapabilities(): React.ReactNode {
        const capabilities = this.store.capabilities;
        return (
            <div className="nav-sec">
                <span className="tag">
                    Capabilities (real)
                    <button
                        className="cap-btn tiny"
                        title="Re-detectar tudo"
                        onClick={() => this.commands.executeCommand(CMD_CAP_REFRESH)}
                    >
                        detectar
                    </button>
                </span>
                {!this.store.capabilitiesDetected && (
                    <div className="cap-card"><small>detectando capabilities do projeto…</small></div>
                )}
                {this.store.capabilitiesDetected && capabilities.length === 0 && (
                    <div className="cap-card"><small>nenhuma capability registrada</small></div>
                )}
                {capabilities.map(c => this.renderCapability(c))}
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

    // ── technical workbench: the real surfaces the bespoke shell would hide ──

    protected renderWorkbench(): React.ReactNode {
        const surfaces: { surface: ExternalSurface; label: string; hint: string }[] = [
            { surface: 'terminal', label: 'Terminal', hint: 'PTY real no painel inferior' },
            { surface: 'output', label: 'Saída raw', hint: 'canais crus: adaptadores, plugins, tasks' },
            { surface: 'extensions', label: 'Open VSX', hint: 'marketplace de extensões' },
            { surface: 'sqltools', label: 'SQLTools', hint: 'só se o plugin estiver instalado' }
        ];
        return (
            <div className="nav-sec">
                <span className="tag">Workspace técnico (real)</span>
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
            </div>
        );
    }

    /** The broker's raw trail: what governance actually recorded, unedited. */
    protected renderBrokerTrail(): React.ReactNode {
        const trail = this.store.brokerActivity;
        return (
            <div className="nav-sec">
                <span className="tag">
                    Trilha do broker (raw)
                    <button
                        className="cap-btn tiny"
                        disabled={this.store.brokerActivityBusy}
                        onClick={() => this.commands.executeCommand(CMD_BROKER_TRAIL)}
                    >
                        {this.store.brokerActivityBusy ? '…' : 'ler'}
                    </button>
                </span>
                <div className="cap-card">
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
            </div>
        );
    }

    // ── harness provider ────────────────────────────────────────────────────

    protected renderHarness(): React.ReactNode {
        const snapshot = this.store.harness;
        return (
            <div className="nav-sec">
                <span className="tag">Harness Provider (contrato)</span>
                {!snapshot && <div className="cap-card"><small>lendo o harness do projeto…</small></div>}
                {snapshot && this.renderSlots(snapshot)}
                {snapshot && this.renderProviders(snapshot)}
                {snapshot && this.renderExtensions(snapshot)}
                {snapshot && this.renderReceipts(snapshot)}
            </div>
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
                    estado escrito por {provider.stateVersion} · {provider.items.length} itens preservados
                </small>
                <small>reivindica: {m.claims.join(', ') || 'nada'}</small>
                {m.workflow && <small>workflow: {m.workflow.states.join(' → ')}</small>}
                {m.hierarchy && <small>hierarquia: {m.hierarchy.levels.join(' / ')}</small>}
                {m.primaryStatus && (
                    <small>{m.primaryStatus.label}: {m.primaryStatus.values.join(' · ')}</small>
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
