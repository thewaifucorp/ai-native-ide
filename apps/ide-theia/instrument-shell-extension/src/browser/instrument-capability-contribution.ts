// Frontend driver of the CAPABILITY PLATFORM and the HARNESS PROVIDER contract.
//
// It owns the commands the Ferramentas view and the Grafo surface fire, and it
// pushes every result into the shared store so all widgets re-render from one
// truth. Two rules it enforces on the UI side:
//
//  • NOTHING IS ASSUMED INSTALLED. Detection runs on `ready` and on every
//    workspace change; until it answers, widgets render "detectando". After an
//    install the backend re-detects, and the store receives that fresh state —
//    the frontend never marks anything ready by itself.
//  • KATSUI IS NOT FAKED. `Conectar Katsui` exists only for capabilities that
//    declare a Katsui provider, and it reports the real requirement instead of
//    flipping a flag. Katsui products are not implemented in this IDE.

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { MonacoWorkspace } from '@theia/monaco/lib/browser/monaco-workspace';
import URI from '@theia/core/lib/common/uri';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { CapabilityService } from '../common/capability-protocol';
import { GovernedWriteService } from '../common/governed-protocol';
import { ObserverService } from '../common/observer-protocol';
import { ChecksService } from '../common/checks-protocol';
import { AnalysisService } from '../common/analysis-protocol';
import { AgentSessionService } from '../common/agent-session-protocol';
import { ProductService } from '../common/product-protocol';
import { HarnessService, HarnessManifest } from '../common/harness-protocol';
import {
    CONFLICT_PROVIDER,
    TEST_PROVIDER_ID,
    TEST_PROVIDER_V1,
    TEST_PROVIDER_V2
} from '../common/harness-test-provider';
import {
    CaptureRequest,
    EngineService,
    GuidanceState,
    ReconciliationChoice,
    SettingsPatch
} from 'engine-extension';
import { InstrumentStore } from './instrument-store';

export const CMD_CAP_REFRESH = 'instrument.capability.refresh';
export const CMD_CAP_DETECT = 'instrument.capability.detect';
export const CMD_CAP_INSTALL = 'instrument.capability.install';
export const CMD_CAP_KATSUI = 'instrument.capability.katsui';

export const CMD_HARNESS_REFRESH = 'instrument.harness.refresh';
export const CMD_HARNESS_REGISTER = 'instrument.harness.register';
export const CMD_HARNESS_ACTIVATE = 'instrument.harness.activate';
export const CMD_HARNESS_SUSPEND = 'instrument.harness.suspend';
export const CMD_HARNESS_MIGRATE = 'instrument.harness.migrate';
export const CMD_HARNESS_SEED = 'instrument.harness.seed';
export const CMD_HARNESS_EFFECT = 'instrument.harness.effect';

/** Reads the broker's own raw audit trail for this project, on demand. */
export const CMD_BROKER_TRAIL = 'instrument.broker.trail';

/** Observation of writes made outside the IDE (WORK-05). */
export const CMD_EXT_SCAN = 'instrument.external.scan';
export const CMD_EXT_BASELINE = 'instrument.external.baseline';
export const CMD_EXT_ACCEPT = 'instrument.external.accept';
export const CMD_EXT_REVERT = 'instrument.external.revert';

/** Hosted ACP session — the pre-disk path. */
export const CMD_SESSION_START = 'instrument.session.start';
export const CMD_SESSION_SUBMIT = 'instrument.session.submit';
export const CMD_SESSION_HARVEST = 'instrument.session.harvest';
export const CMD_SESSION_CANCEL = 'instrument.session.cancel';
export const CMD_SESSION_PERMISSION = 'instrument.session.permission';
export const CMD_CHECKS_RUN = 'instrument.checks.run';

// §4 — preview, reconciliação e packs locais.
export const CMD_PREVIEW_START = 'instrument.preview.start';
export const CMD_PREVIEW_STATUS = 'instrument.preview.status';
export const CMD_PREVIEW_STOP = 'instrument.preview.stop';
export const CMD_RECONCILE_SCAN = 'instrument.reconcile.scan';
export const CMD_RECONCILE_DECIDE = 'instrument.reconcile.decide';
export const CMD_CONTEXT_COMPILE = 'instrument.context.compile';

// §13 — biblioteca de guidance, truth registry, configuração e projeto durável.
// §8 — composer de intenção guiada.
export const CMD_INTENT_REVIEW = 'instrument.intent.review';
export const CMD_INTENT_DECIDE = 'instrument.intent.decide';

export const CMD_LIBRARY_READ = 'instrument.library.read';
export const CMD_LIBRARY_CAPTURE = 'instrument.library.capture';
export const CMD_LIBRARY_LIFECYCLE = 'instrument.library.lifecycle';
export const CMD_TRUTH_DECLARE = 'instrument.truth.declare';
export const CMD_TRUTH_CONSUMER = 'instrument.truth.consumer';
export const CMD_TRUTH_SYNC = 'instrument.truth.sync';
export const CMD_SETTINGS_READ = 'instrument.settings.read';
export const CMD_SETTINGS_PATCH = 'instrument.settings.patch';
export const CMD_SETTINGS_PROFILE = 'instrument.settings.profile';
export const CMD_SETTINGS_RESET = 'instrument.settings.reset';
export const CMD_DURABLE_READ = 'instrument.durable.read';
export const CMD_DURABLE_REGISTER = 'instrument.durable.register';
export const CMD_DURABLE_INTENT = 'instrument.durable.intent';
export const CMD_DURABLE_ATTACH = 'instrument.durable.attach';
export const CMD_PACKS_REFRESH = 'instrument.packs.refresh';
export const CMD_PACKS_INSTALL = 'instrument.packs.install';
export const CMD_PACKS_APPLY = 'instrument.packs.apply';
export const CMD_PACKS_REVERT = 'instrument.packs.revert';
export const CMD_MATERIALS_ANALYZE = 'instrument.project.materials';
export const CMD_ADOPT_COMMAND = 'instrument.project.adoptCommand';
export const CMD_ADOPT_CONFIG = 'instrument.project.adoptConfig';
export const CMD_PROPOSE_GUIDANCE = 'instrument.project.proposeGuidance';
export const CMD_REGISTER_REFERENCE = 'instrument.project.registerReference';

/** Projeto semântico (§3). */
export const CMD_PRODUCT_REFRESH = 'instrument.product.refresh';
export const CMD_PRODUCT_RESOLVE = 'instrument.product.resolve';
export const CMD_PRODUCT_ANALYZE = 'instrument.product.analyze';

/** Items the proof provider seeds, so slot lifecycle has state to preserve. */
const SEED_ITEMS = ['prova/marco-1', 'prova/fase-1', 'prova/tarefa-1'];

/** Real workspace file the proof provider proposes an effect on. */
const EFFECT_REL = 'docs/product-intent.md';

@injectable()
export class InstrumentCapabilityContribution
    implements FrontendApplicationContribution, CommandContribution {

    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(FileService) protected readonly files!: FileService;
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(FrontendApplicationStateService) protected readonly stateService!: FrontendApplicationStateService;
    @inject(CapabilityService) protected readonly capabilities!: CapabilityService;
    @inject(HarnessService) protected readonly harness!: HarnessService;
    @inject(GovernedWriteService) protected readonly governed!: GovernedWriteService;
    @inject(ObserverService) protected readonly observer!: ObserverService;
    @inject(ChecksService) protected readonly checks!: ChecksService;
    @inject(AnalysisService) protected readonly analysis!: AnalysisService;
    @inject(MonacoWorkspace) protected readonly monaco!: MonacoWorkspace;
    @inject(AgentSessionService) protected readonly session!: AgentSessionService;
    @inject(ProductService) protected readonly product!: ProductService;
    @inject(EngineService) protected readonly engine!: EngineService;

    /** Polling handle while a task is running. */
    protected pollTimer: number | undefined;

    /** Debounce handle for watcher-driven scans. */
    protected scanTimer: number | undefined;
    @inject(InstrumentStore) protected readonly store!: InstrumentStore;

    onStart(): void {
        this.stateService.reachedState('ready').then(() => {
            this.refreshCapabilities();
            this.refreshHarness();
            this.brokerTrail();
            this.adoptPendingProposal();
            this.scanExternal();
            this.watchForExternalWrites();
            this.refreshProduct();
            this.readLibrary();
            this.readSettings();
            this.readDurable();
            // Agent proposals arrive out of band; ask periodically. A push channel
            // over the RPC connection would be better and is not built yet.
            window.setInterval(() => this.adoptPendingProposal(), 5000);
        });
        this.workspace.onWorkspaceChanged(() => {
            this.refreshCapabilities();
            this.refreshHarness();
        });
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(
            { id: CMD_CAP_REFRESH, label: 'Instrument: detectar capabilities do projeto' },
            { execute: () => this.refreshCapabilities() }
        );
        commands.registerCommand(
            { id: CMD_CAP_DETECT, label: 'Instrument: detectar uma capability' },
            { execute: (id?: string) => (id ? this.detect(id) : undefined) }
        );
        commands.registerCommand(
            { id: CMD_CAP_INSTALL, label: 'Instrument: instalar/gerar uma capability' },
            { execute: (id?: string) => (id ? this.install(id) : undefined) }
        );
        commands.registerCommand(
            { id: CMD_CAP_KATSUI, label: 'Instrument: conectar Katsui em uma capability' },
            { execute: (id?: string) => (id ? this.connectKatsui(id) : undefined) }
        );

        commands.registerCommand(
            { id: CMD_HARNESS_REFRESH, label: 'Instrument: ler o harness do projeto' },
            { execute: () => this.refreshHarness() }
        );
        commands.registerCommand(
            { id: CMD_HARNESS_REGISTER, label: 'Instrument: registrar provider de harness' },
            { execute: (which?: string) => this.registerProvider(which) }
        );
        commands.registerCommand(
            { id: CMD_HARNESS_ACTIVATE, label: 'Instrument: ativar provider de harness' },
            { execute: (id?: string) => this.activate(id ?? TEST_PROVIDER_ID) }
        );
        commands.registerCommand(
            { id: CMD_HARNESS_SUSPEND, label: 'Instrument: suspender provider de harness' },
            { execute: (id?: string) => this.suspend(id ?? TEST_PROVIDER_ID) }
        );
        commands.registerCommand(
            { id: CMD_HARNESS_MIGRATE, label: 'Instrument: migrar provider de harness (v2)' },
            { execute: (id?: string) => this.migrate(id ?? TEST_PROVIDER_ID) }
        );
        commands.registerCommand(
            { id: CMD_HARNESS_SEED, label: 'Instrument: semear itens do provider' },
            { execute: (id?: string) => this.seed(id ?? TEST_PROVIDER_ID) }
        );
        commands.registerCommand(
            { id: CMD_HARNESS_EFFECT, label: 'Instrument: provider propõe efeito (via broker)' },
            { execute: (id?: string) => this.effect(id ?? TEST_PROVIDER_ID) }
        );
        commands.registerCommand(
            { id: CMD_BROKER_TRAIL, label: 'Instrument: ler a trilha raw do broker' },
            { execute: () => this.brokerTrail() }
        );
        commands.registerCommand(
            { id: CMD_EXT_SCAN, label: 'Instrument: procurar escritas externas' },
            { execute: () => this.scanExternal(true) }
        );
        commands.registerCommand(
            { id: CMD_EXT_BASELINE, label: 'Instrument: refazer a referência do projeto' },
            { execute: () => this.rebaseline() }
        );
        commands.registerCommand(
            { id: CMD_EXT_ACCEPT, label: 'Instrument: aceitar uma escrita externa' },
            { execute: (relPath?: string) => (relPath ? this.acceptExternal(relPath) : undefined) }
        );
        commands.registerCommand(
            { id: CMD_EXT_REVERT, label: 'Instrument: propor reverter uma escrita externa' },
            { execute: (relPath?: string) => (relPath ? this.revertExternal(relPath) : undefined) }
        );
        commands.registerCommand(
            { id: CMD_SESSION_START, label: 'Instrument: abrir sessão de agente' },
            { execute: (agent?: string) => this.sessionStart(agent ?? 'claude') }
        );
        commands.registerCommand(
            { id: CMD_SESSION_SUBMIT, label: 'Instrument: enviar intenção ao agente' },
            { execute: (prompt?: string, codeChange?: boolean) => this.sessionSubmit(prompt, codeChange) }
        );
        commands.registerCommand(
            { id: CMD_SESSION_HARVEST, label: 'Instrument: colher mudanças do agente (via broker)' },
            { execute: () => this.sessionHarvest() }
        );
        commands.registerCommand(
            { id: CMD_SESSION_CANCEL, label: 'Instrument: encerrar sessão de agente' },
            { execute: () => this.sessionCancel() }
        );
        commands.registerCommand(
            { id: CMD_MATERIALS_ANALYZE, label: 'Instrument: analisar materiais do projeto (§5)' },
            { execute: () => this.analyzeMaterials() }
        );
        commands.registerCommand(
            { id: CMD_ADOPT_COMMAND, label: 'Instrument: adotar comando detectado' },
            { execute: (slug?: string) => (slug ? this.adoptCommand(slug) : undefined) }
        );
        commands.registerCommand(
            {
                id: CMD_CHECKS_RUN,
                label: 'Instrument: rodar checks determinísticos (§4)'
            },
            { execute: (runTools?: boolean) => this.runChecks(runTools === true) }
        );
        commands.registerCommand(
            { id: CMD_ADOPT_CONFIG, label: 'Instrument: adotar configuração detectada (§5)' },
            { execute: (id?: string) => (id ? this.adoptConfig(id) : undefined) }
        );
        commands.registerCommand(
            {
                id: CMD_PROPOSE_GUIDANCE,
                label: 'Instrument: importar guidance detectada para a biblioteca (§5→§13)'
            },
            { execute: (id?: string) => (id ? this.importGuidance(id) : undefined) }
        );
        commands.registerCommand(
            { id: CMD_REGISTER_REFERENCE, label: 'Instrument: registrar referência detectada (§5)' },
            { execute: (id?: string) => (id ? this.registerReference(id) : undefined) }
        );
        commands.registerCommand(
            { id: CMD_PREVIEW_START, label: 'Instrument: iniciar preview declarado (§4)' },
            { execute: () => this.previewStart() }
        );
        commands.registerCommand(
            { id: CMD_PREVIEW_STATUS, label: 'Instrument: reler estado do preview (§4)' },
            { execute: () => this.previewStatus() }
        );
        commands.registerCommand(
            { id: CMD_PREVIEW_STOP, label: 'Instrument: parar preview (§4)' },
            { execute: () => this.previewStop() }
        );
        commands.registerCommand(
            { id: CMD_RECONCILE_SCAN, label: 'Instrument: comparar declarado com observado (§4)' },
            { execute: () => this.reconcileScan() }
        );
        commands.registerCommand(
            { id: CMD_RECONCILE_DECIDE, label: 'Instrument: decidir uma divergência (§4)' },
            {
                execute: (divergenceId?: string, choice?: ReconciliationChoice) =>
                    divergenceId && choice ? this.reconcileDecide(divergenceId, choice) : undefined
            }
        );
        commands.registerCommand(
            { id: CMD_CONTEXT_COMPILE, label: 'Instrument: compilar contexto do agente (§6)' },
            { execute: (budget?: number) => this.compileContext(budget) }
        );
        commands.registerCommand(
            { id: CMD_INTENT_REVIEW, label: 'Instrument: avaliar a intenção escrita (§8)' },
            { execute: () => this.reviewIntent() }
        );
        commands.registerCommand(
            { id: CMD_INTENT_DECIDE, label: 'Instrument: decidir uma hipótese da intenção (§8)' },
            {
                execute: (
                    findingId?: string,
                    state?: 'accepted' | 'dismissed',
                    note?: string,
                    text?: string
                ) =>
                    findingId && state
                        ? this.decideFinding(findingId, state, note ?? '', text)
                        : undefined
            }
        );
        commands.registerCommand(
            { id: CMD_LIBRARY_READ, label: 'Instrument: ler biblioteca de guidance (§13)' },
            { execute: () => this.readLibrary() }
        );
        commands.registerCommand(
            { id: CMD_LIBRARY_CAPTURE, label: 'Instrument: capturar guidance (§13)' },
            { execute: (request?: CaptureRequest) => (request ? this.captureGuidance(request) : undefined) }
        );
        commands.registerCommand(
            { id: CMD_LIBRARY_LIFECYCLE, label: 'Instrument: mudar estado de uma guidance (§13)' },
            {
                execute: (id?: string, to?: GuidanceState, by?: string) =>
                    id && to ? this.guidanceLifecycle(id, to, by) : undefined
            }
        );
        commands.registerCommand(
            { id: CMD_TRUTH_DECLARE, label: 'Instrument: declarar autoridade sobre um assunto (§13)' },
            {
                execute: (subject?: string, authorityPath?: string) =>
                    subject && authorityPath ? this.declareTruth(subject, authorityPath) : undefined
            }
        );
        commands.registerCommand(
            { id: CMD_TRUTH_CONSUMER, label: 'Instrument: registrar consumidor de um assunto (§13)' },
            {
                execute: (id?: string, consumer?: string) =>
                    id && consumer ? this.addConsumer(id, consumer) : undefined
            }
        );
        commands.registerCommand(
            { id: CMD_TRUTH_SYNC, label: 'Instrument: propor sincronizar consumidores (§13)' },
            { execute: (id?: string) => (id ? this.proposeSync(id) : undefined) }
        );
        commands.registerCommand(
            { id: CMD_SETTINGS_READ, label: 'Instrument: ler configuração do projeto (§13)' },
            { execute: () => this.readSettings() }
        );
        commands.registerCommand(
            { id: CMD_SETTINGS_PATCH, label: 'Instrument: mudar configuração (§13)' },
            { execute: (patch?: SettingsPatch) => (patch ? this.patchSettings(patch) : undefined) }
        );
        commands.registerCommand(
            { id: CMD_SETTINGS_PROFILE, label: 'Instrument: aplicar perfil de layout (§13)' },
            { execute: (name?: string) => (name ? this.applyProfile(name) : undefined) }
        );
        commands.registerCommand(
            { id: CMD_SETTINGS_RESET, label: 'Instrument: voltar um campo ao default (§13)' },
            { execute: (field?: string) => (field ? this.resetSetting(field) : undefined) }
        );
        commands.registerCommand(
            { id: CMD_DURABLE_READ, label: 'Instrument: ler projeto durável (§13)' },
            { execute: () => this.readDurable() }
        );
        commands.registerCommand(
            { id: CMD_DURABLE_REGISTER, label: 'Instrument: registrar projeto durável (§13)' },
            {
                execute: (title?: string, intent?: string) =>
                    title && intent ? this.registerDurable(title, intent) : undefined
            }
        );
        commands.registerCommand(
            { id: CMD_DURABLE_INTENT, label: 'Instrument: reescrever a intenção do projeto (§13)' },
            { execute: (intent?: string) => (intent ? this.setDurableIntent(intent) : undefined) }
        );
        commands.registerCommand(
            { id: CMD_DURABLE_ATTACH, label: 'Instrument: anexar recurso ao projeto (§13)' },
            {
                execute: (path?: string, kind?: 'directory' | 'repository') =>
                    path ? this.attachResource(path, kind ?? 'directory') : undefined
            }
        );
        commands.registerCommand(
            { id: CMD_PACKS_REFRESH, label: 'Instrument: ler packs do projeto (§4)' },
            { execute: () => this.packsRefresh() }
        );
        commands.registerCommand(
            { id: CMD_PACKS_INSTALL, label: 'Instrument: instalar pack local (§4)' },
            { execute: (relPath?: string) => (relPath ? this.packsInstall(relPath) : undefined) }
        );
        commands.registerCommand(
            { id: CMD_PACKS_APPLY, label: 'Instrument: aplicar pack instalado (§4)' },
            { execute: (packId?: string) => (packId ? this.packsSet(packId, true) : undefined) }
        );
        commands.registerCommand(
            { id: CMD_PACKS_REVERT, label: 'Instrument: reverter pack aplicado (§4)' },
            { execute: (packId?: string) => (packId ? this.packsSet(packId, false) : undefined) }
        );
        commands.registerCommand(
            { id: CMD_SESSION_PERMISSION, label: 'Instrument: decidir permissão do agente' },
            {
                execute: (requestId?: number, allow?: boolean, denyEndsTurn?: boolean) =>
                    typeof requestId === 'number' && typeof allow === 'boolean'
                        ? this.sessionPermission(requestId, allow, denyEndsTurn ?? true)
                        : undefined
            }
        );
        commands.registerCommand(
            { id: CMD_PRODUCT_REFRESH, label: 'Instrument: reler o projeto semântico' },
            { execute: () => this.refreshProduct(true) }
        );
        commands.registerCommand(
            { id: CMD_PRODUCT_RESOLVE, label: 'Instrument: resolver divergência (via broker)' },
            {
                execute: (sotId?: string, claimId?: string, optionId?: string) =>
                    sotId && claimId && optionId
                        ? this.resolveDivergence(sotId, claimId, optionId)
                        : undefined
            }
        );
        commands.registerCommand(
            { id: CMD_PRODUCT_ANALYZE, label: 'Instrument: analisar projeto (candidatos)' },
            { execute: () => this.analyzeProject() }
        );
    }

    // ── capabilities ────────────────────────────────────────────────────────

    protected get root(): string {
        return this.store.workspaceRootUri;
    }

    async refreshCapabilities(): Promise<void> {
        const root = this.root;
        if (!root) {
            this.store.setCapabilities([]);
            return;
        }
        try {
            this.store.setCapabilities(await this.capabilities.list(root));
            // §13: the config's reversible defaults follow what was ACTUALLY
            // detected. A user choice is never touched — that is what recording
            // each value's origin is for.
            this.applyDetectedSettings();
        } catch (err) {
            this.messages.error(`Falha ao detectar capabilities: ${this.msg(err)}`);
        }
    }

    async detect(id: string): Promise<void> {
        const root = this.root;
        if (!root) {
            return;
        }
        this.store.setCapabilityBusy(id, true);
        try {
            this.store.setCapability(await this.capabilities.detect(root, id));
        } catch (err) {
            this.messages.error(`Falha ao detectar '${id}': ${this.msg(err)}`);
        } finally {
            this.store.setCapabilityBusy(id, false);
        }
    }

    /** Run the capability's REAL install/generate action, then take the backend's
     *  freshly detected state — the surface URL it returns carries a new
     *  detection stamp, so an embedded artifact renders with no manual reload. */
    async install(id: string): Promise<void> {
        const root = this.root;
        if (!root) {
            this.messages.warn('Nenhum projeto aberto — abra uma pasta primeiro.');
            return;
        }
        const before = this.store.capability(id);
        if (before && !before.installable) {
            this.messages.warn(`'${before.label}' não pode ser instalada aqui: ${before.detail}`);
            return;
        }
        this.store.setCapabilityBusy(id, true);
        try {
            const state = await this.capabilities.install(root, id);
            this.store.setCapability(state);
            this.store.toast(`${state.label} · ${state.status}`);
        } catch (err) {
            this.messages.error(`Falha ao instalar '${id}': ${this.msg(err)}`);
            // Re-detect so the UI shows the real post-failure state, not a guess.
            await this.detect(id);
        } finally {
            this.store.setCapabilityBusy(id, false);
        }
    }

    /** Honest Katsui action: it states the real requirement and changes nothing.
     *  The IDE hosts the provider slot; it does not implement Katsui. */
    protected connectKatsui(capabilityId: string): void {
        const capability = this.store.capability(capabilityId);
        const provider = capability?.providers.find(p => p.kind === 'katsui');
        if (!capability || !provider) {
            this.messages.warn(
                `'${capabilityId}' não declara provider Katsui — não há o que conectar.`
            );
            return;
        }
        this.messages.info(
            `Katsui em '${capability.label}': ${provider.detail ?? 'provider declarado'} ` +
            '· nenhuma conexão foi criada — o IDE não implementa produtos Katsui localmente.'
        );
    }

    /** The broker's raw trail, verbatim. On failure the store is cleared rather
     *  than showing a stale trail as if it were current. */
    /** Adopt a proposal created outside this frontend — typically by an agent over
     *  MCP. Without this the dock would only ever show proposals the UI itself
     *  started, and an agent's write would wait for a decision nobody could see. */
    async adoptPendingProposal(): Promise<void> {
        const root = this.root;
        if (!root) {
            return;
        }
        try {
            const pending = await this.governed.pending(root);
            const current = this.store.proposal;
            const awaiting = pending.find(p => p.state === 'awaiting');
            const next = awaiting ?? pending[0];
            if (!next) {
                return;
            }
            if (!current || current.id !== next.id) {
                // Only adopt when the local card has nothing live to lose.
                if (!current || current.state === 'rolledback' || current.state === 'approved') {
                    this.store.governedProposed(next);
                    this.messages.info(
                        `Proposta de escrita em ${next.relPath} aguardando você ` +
                        '(criada fora desta janela — provavelmente por um agente).'
                    );
                }
            }
        } catch { /* backend not ready yet — the next tick tries again */ }
    }

    async brokerTrail(): Promise<void> {
        const root = this.root;
        if (!root) {
            this.store.setBrokerActivity(undefined);
            return;
        }
        this.store.setBrokerActivityBusy(true);
        try {
            this.store.setBrokerActivity(await this.governed.activity(root));
        } catch (err) {
            this.store.setBrokerActivity(undefined);
            this.messages.error(`Falha ao ler a trilha do broker: ${this.msg(err)}`);
        } finally {
            this.store.setBrokerActivityBusy(false);
        }
    }

    // ── projeto semântico (§3) ──────────────────────────────────────────────

    async refreshProduct(loud = false): Promise<void> {
        const root = this.root;
        if (!root) {
            this.store.setProduct(undefined);
            return;
        }
        this.store.setProductBusy(true);
        try {
            this.store.setProduct(await this.product.model(root));
        } catch (err) {
            if (loud) {
                this.messages.error(`Falha ao ler o projeto semântico: ${this.msg(err)}`);
            }
        } finally {
            this.store.setProductBusy(false);
        }
    }

    /** Resolver é sempre uma proposta: cai no dock, com diff, para você decidir. */
    protected async resolveDivergence(sotId: string, claimId: string, optionId: string): Promise<void> {
        const root = this.root;
        if (!root) {
            return;
        }
        this.store.setProductBusy(true);
        try {
            const result = await this.product.resolve(root, sotId, claimId, optionId);
            await this.adoptPendingProposal();
            this.messages.info(
                `Resolução proposta em ${result.relPath} — decida no dock. Nada foi escrito ainda.`
            );
        } catch (err) {
            this.messages.error(`Falha ao resolver: ${this.msg(err)}`);
        } finally {
            this.store.setProductBusy(false);
        }
    }

    /** Candidatos revisáveis; nenhuma ativação silenciosa. */
    protected async analyzeProject(): Promise<void> {
        const root = this.root;
        if (!root) {
            return;
        }
        try {
            const found = await this.product.candidates(root);
            this.messages.info(
                `Análise: ${found.resources.length} recurso(s) e ${found.sots.length} fonte(s) da ` +
                'verdade candidatas. Nada foi declarado — escreva os artefatos em `.product/` ' +
                'para adotá-los.'
            );
        } catch (err) {
            this.messages.error(`Falha ao analisar: ${this.msg(err)}`);
        }
    }

    // ── hosted agent session (pre-disk path) ────────────────────────────────

    protected async sessionStart(agent: string): Promise<void> {
        const root = this.root;
        if (!root) {
            this.messages.warn('Abra um projeto para hospedar uma sessão de agente.');
            return;
        }
        this.store.setSessionBusy(true);
        try {
            const snapshot = await this.session.start(root, agent);
            this.store.setSession(snapshot);
            if (snapshot.lastError) {
                this.messages.error(snapshot.lastError);
            }
        } catch (err) {
            this.messages.error(`Falha ao abrir sessão: ${this.msg(err)}`);
        } finally {
            this.store.setSessionBusy(false);
        }
    }

    protected async sessionSubmit(prompt?: string, codeChange?: boolean): Promise<void> {
        const root = this.root;
        if (!root || !prompt) {
            return;
        }
        this.store.setSessionBusy(true);
        try {
            this.store.setSession(await this.session.submit(root, prompt, !!codeChange));
            this.startPolling();
        } catch (err) {
            // A refused submit (agent busy, session gone) has to be visible; the
            // panel must not keep the old state as if the prompt had landed.
            const detail = this.msg(err);
            this.messages.error(`Falha ao enviar: ${detail}`);
            const current = this.store.session;
            if (current) {
                this.store.setSession({ ...current, lastError: detail });
            }
        } finally {
            this.store.setSessionBusy(false);
        }
    }

    /** Drain events while the agent works; stop when it goes idle.
     *
     *  Poll failures are NOT swallowed: swallowing them left the panel showing
     *  `working` forever while nothing was arriving, which is the panel lying.
     *  Three consecutive failures stop the loop and say why. */
    protected startPolling(): void {
        if (this.pollTimer !== undefined) {
            return;
        }
        let failures = 0;
        this.pollTimer = window.setInterval(async () => {
            const root = this.root;
            if (!root) {
                return;
            }
            try {
                const snapshot = await this.session.poll(root);
                failures = 0;
                this.store.setSession(snapshot);
                if (snapshot.phase !== 'working') {
                    this.stopPolling();
                }
            } catch (err) {
                failures++;
                if (failures >= 3) {
                    this.stopPolling();
                    this.messages.error(
                        `A sessão parou de responder: ${this.msg(err)}. ` +
                        'Encerre e abra de novo.'
                    );
                    const current = this.store.session;
                    if (current) {
                        this.store.setSession({
                            ...current,
                            phase: 'failed',
                            lastError: this.msg(err)
                        });
                    }
                }
            }
        }, 1200);
    }

    protected stopPolling(): void {
        if (this.pollTimer !== undefined) {
            window.clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
    }

    /**
     * Answers one parked permission. The agent's turn is blocked until this
     * lands, so the result is reported plainly instead of optimistically: a
     * failure leaves the card on screen because the agent is still waiting.
     */
    protected async sessionPermission(
        requestId: number,
        allow: boolean,
        denyEndsTurn: boolean
    ): Promise<void> {
        const root = this.root;
        if (!root) {
            return;
        }
        this.store.setSessionBusy(true);
        try {
            const before = this.store.session?.pending.find(p => p.requestId === requestId);
            const snapshot = await this.session.respondPermission(root, requestId, allow, denyEndsTurn);
            this.store.setSession(snapshot);
            const stillPending = snapshot.pending.some(p => p.requestId === requestId);
            if (stillPending) {
                this.messages.error(
                    `A decisão não chegou ao agente: ${snapshot.lastError ?? 'motivo desconhecido'}`
                );
                return;
            }
            const what = before ? `${before.action}: ${before.detail}` : `pedido ${requestId}`;
            this.messages.info(
                allow
                    ? `${what} — aprovado, o agente seguiu.`
                    : denyEndsTurn
                        ? `${what} — negado e turno encerrado.`
                        : `${what} — negado; o turno continua.`
            );
        } catch (err) {
            this.messages.error(`Falha ao decidir permissão: ${this.msg(err)}`);
        } finally {
            this.store.setSessionBusy(false);
        }
    }

    /**
     * Lê os MATERIAIS do projeto — stack, comandos, Git, serviços, integrações —
     * e mostra candidatos com evidência. Não grava e não ativa nada.
     *
     * Nome distinto de `analyzeProject`, que é a análise de RECURSOS e SoT
     * (o embrião PROJ-06). São dois eixos diferentes do mesmo projeto, e
     * confundi-los na chamada seria confundi-los na tela.
     */
    protected async analyzeMaterials(): Promise<void> {
        const root = this.root;
        if (!root) {
            return;
        }
        this.store.setAnalysisBusy(true);
        try {
            this.store.setAnalysis(await this.analysis.analyze(root));
        } catch (err) {
            this.messages.error(`Falha ao analisar: ${this.msg(err)}`);
            this.store.setAnalysis(undefined);
        } finally {
            this.store.setAnalysisBusy(false);
        }
    }

    /**
     * Adota um comando detectado para `.instrument/checks.json`.
     *
     * Ato explícito, um slug por vez: a análise nunca liga nada sozinha.
     */
    protected async adoptCommand(slug: string): Promise<void> {
        const root = this.root;
        if (!root) {
            return;
        }
        this.store.setAnalysisBusy(true);
        try {
            const after = await this.analysis.adoptCommands(root, [slug]);
            this.store.setAnalysis(after);
            const adopted = after.commands.find(c => c.slug === slug && c.alreadyDeclared);
            if (adopted) {
                this.messages.info(
                    `${slug} adotado: ${adopted.command}. Rode os checks para medir com ele.`
                );
            } else {
                // Nunca reportar adoção que não teve efeito.
                this.messages.error(
                    `${slug} não foi adotado — os checks executam apenas build, test e typecheck.`
                );
            }
        } catch (err) {
            this.messages.error(`Falha ao adotar: ${this.msg(err)}`);
        } finally {
            this.store.setAnalysisBusy(false);
        }
    }

    /**
     * Runs the deterministic Layer-0 checks.
     *
     * `runTools` executes the commands declared in `.instrument/checks.json`.
     * It is false unless the person asked for it: a repository file must never
     * get its commands run just because a panel refreshed.
     */
    // ── §5 adoção de configuração, guidance e referência ──────────────────
    //
    // Dois regimes de escrita, e a diferença é o ponto: `.instrument/` é estado
    // de runtime do IDE e é gravado direto; `.product/` é conteúdo do projeto e
    // só entra por proposta no broker, com diff para revisar.

    protected async adoptConfig(id: string): Promise<void> {
        const root = this.root;
        if (!root) {
            return;
        }
        this.store.setAnalysisBusy(true);
        try {
            const after = await this.analysis.adoptConfig(root, id);
            this.store.setAnalysis(after);
            const adopted = after.config.find(c => c.id === id);
            if (adopted?.alreadyDeclared) {
                this.messages.info(`Gravado em ${adopted.target}.`);
            }
        } catch (err) {
            this.messages.error(`Configuração não adotada: ${this.msg(err)}`);
        } finally {
            this.store.setAnalysisBusy(false);
        }
    }

    protected async importGuidance(id: string): Promise<void> {
        const root = this.root;
        if (!root) {
            return;
        }
        this.store.setAnalysisBusy(true);
        try {
            const { state } = await this.analysis.importGuidance(root, id);
            // `candidate` é o ponto, não um detalhe: a orientação entrou na
            // biblioteca e NÃO dirige agente nenhum até alguém promover.
            this.messages.info(
                `Importada para a biblioteca como ${state} — não entra em contexto de agente ` +
                    'até você promover.'
            );
            this.readLibrary();
            this.analyzeMaterials();
        } catch (err) {
            this.messages.error(`Guidance não importada: ${this.msg(err)}`);
        } finally {
            this.store.setAnalysisBusy(false);
        }
    }

    protected async registerReference(id: string): Promise<void> {
        const root = this.root;
        if (!root) {
            return;
        }
        this.store.setAnalysisBusy(true);
        try {
            const { relPath } = await this.analysis.registerReference(root, id);
            this.messages.info(
                `Referência proposta em ${relPath} — nada foi escrito: decida no dock.`
            );
            this.adoptPendingProposal();
        } catch (err) {
            this.messages.error(`Referência não registrada: ${this.msg(err)}`);
        } finally {
            this.store.setAnalysisBusy(false);
        }
    }

    // ── §4 preview ────────────────────────────────────────────────────────
    //
    // Three separate commands because they are three different acts. `status`
    // never starts anything: a panel refresh that could spawn a dev server would
    // be the same mistake §4 refused for declared commands.

    /** Path of the workspace root, as the sidecar needs it (not a URI). */
    protected get rootPath(): string | undefined {
        const root = this.root;
        return root ? FileUri.fsPath(new URI(root)) : undefined;
    }

    protected async previewStart(): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setPreviewBusy(true);
        try {
            const snapshot = await this.engine.previewStart(root);
            this.store.setPreview(snapshot);
            const health = snapshot.state?.health;
            if (health === 'healthy') {
                this.messages.info(`Preview saudável · ${snapshot.lastProbe ?? ''}`);
            } else if (snapshot.failures.length > 0) {
                this.messages.error(
                    `Preview não subiu: ${snapshot.failures[snapshot.failures.length - 1].message}`
                );
            }
            // Uma falha registrada é observação nova; a comparação tem de refletir.
            await this.reconcileScan();
        } catch (err) {
            // Nada declarado é motivo, não erro de sistema: mostrar o motivo e
            // manter o painel dizendo que não há preview.
            this.messages.warn(`Preview não iniciado: ${this.msg(err)}`);
            this.store.setPreview(await this.safePreviewStatus(root));
        } finally {
            this.store.setPreviewBusy(false);
        }
    }

    protected async previewStatus(): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setPreviewBusy(true);
        try {
            this.store.setPreview(await this.engine.previewStatus(root));
            await this.reconcileScan();
        } catch (err) {
            this.messages.error(`Falha ao ler o preview: ${this.msg(err)}`);
            this.store.setPreview(undefined);
        } finally {
            this.store.setPreviewBusy(false);
        }
    }

    protected async previewStop(): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setPreviewBusy(true);
        try {
            this.store.setPreview(await this.engine.previewStop(root));
        } catch (err) {
            this.messages.error(`Falha ao parar o preview: ${this.msg(err)}`);
        } finally {
            this.store.setPreviewBusy(false);
        }
    }

    protected async safePreviewStatus(root: string): Promise<undefined | Awaited<ReturnType<EngineService['previewStatus']>>> {
        try {
            return await this.engine.previewStatus(root);
        } catch {
            return undefined;
        }
    }

    // ── §4 reconciliação ──────────────────────────────────────────────────

    protected async reconcileScan(): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setReconcileBusy(true);
        try {
            this.store.setReconciliation(await this.engine.reconcileScan(root));
        } catch (err) {
            this.messages.error(`Falha ao comparar declarado com observado: ${this.msg(err)}`);
            this.store.setReconciliation(undefined);
        } finally {
            this.store.setReconcileBusy(false);
        }
    }

    protected async reconcileDecide(
        divergenceId: string,
        choice: ReconciliationChoice
    ): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setReconcileBusy(true);
        try {
            const after = await this.engine.reconcileDecide(root, divergenceId, choice);
            this.store.setReconciliation(after);
            const decided = after.divergences.find(d => d.divergence.id === divergenceId);
            // "Pendente de verificação" NÃO é resolvido, e a mensagem diz isso —
            // senão a decisão parece fechar o assunto que ela apenas encaminhou.
            if (decided?.reconciliation?.status === 'pending_verification') {
                this.messages.info(
                    'Decisão registrada como pendente de verificação: falta mudar o código e ' +
                        'produzir evidência nova.'
                );
            } else if (decided?.reconciliation?.status === 'accepted_scoped_exception') {
                this.messages.info('Exceção escopada registrada, com justificativa, no projeto.');
            } else if (!decided) {
                // Revisar a intenção faz a divergência deixar de existir.
                this.messages.info('Intenção revisada em .instrument/intents.json — a divergência fechou.');
            }
        } catch (err) {
            this.messages.error(`Decisão recusada: ${this.msg(err)}`);
        } finally {
            this.store.setReconcileBusy(false);
        }
    }

    // ── §8 intenção guiada ────────────────────────────────────────────────
    //
    // Nenhum caminho aqui escreve a intenção da pessoa. Avaliar lê o texto e
    // devolve hipóteses; aceitar cria uma guidance CANDIDATA (que ainda precisa
    // da promoção do §13 para dirigir qualquer agente); dispensar exige motivo.

    protected async reviewIntent(): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setIntentBusy(true);
        try {
            this.store.setIntentReview(
                await this.engine.intentReview(root, this.store.intentDraft)
            );
        } catch (err) {
            this.messages.error(`Falha ao avaliar a intenção: ${this.msg(err)}`);
            this.store.setIntentReview(undefined);
        } finally {
            this.store.setIntentBusy(false);
        }
    }

    /**
     * Decide uma hipótese.
     *
     * `text` é o texto EDITADO pela pessoa quando ela aceita — o candidato é
     * editável, e o que vira artefato é a versão dela, não a remediação crua do
     * avaliador. O artefato é uma guidance candidata, e o id dela fica no
     * registro da decisão para o rastro fechar.
     */
    protected async decideFinding(
        findingId: string,
        state: 'accepted' | 'dismissed',
        note: string,
        text?: string
    ): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setIntentBusy(true);
        try {
            let artifact: string | undefined;
            if (state === 'accepted') {
                const body = (text ?? '').trim();
                if (body.length === 0) {
                    this.messages.error('Aceitar precisa do texto que vai virar guidance.');
                    return;
                }
                const imported = await this.engine.libraryImport(
                    root,
                    `Intenção · ${findingId.split(':').slice(1).join(':')}`,
                    body,
                    `revisão de intenção · ${findingId}`,
                    'pessoa'
                );
                artifact = imported.id;
            }
            const after = await this.engine.intentDecide(
                root,
                this.store.intentDraft,
                findingId,
                state,
                note,
                artifact
            );
            this.store.setIntentReview(after);
            if (artifact) {
                this.messages.info(
                    `Aceita: virou guidance candidata (${artifact}) — promover em Ferramentas é ` +
                        'o que a coloca no contexto do agente.'
                );
                this.readLibrary();
            }
        } catch (err) {
            this.messages.error(`Decisão não registrada: ${this.msg(err)}`);
        } finally {
            this.store.setIntentBusy(false);
        }
    }

    // ── §13 biblioteca de guidance e truth registry ───────────────────────
    //
    // A biblioteca não passa pelo broker, e a linha é explícita: o broker existe
    // para barrar escrita que a pessoa NÃO escreveu (agente, provider, detector).
    // Guidance capturada é texto que a pessoa acabou de digitar, no destino que
    // ela nomeou. O que protege o outro caso — guidance vinda de arquivo ou de
    // detector — é o lifecycle do motor: importar cria CANDIDATA, e candidata não
    // entra em contexto de agente até alguém promover.

    protected async readLibrary(): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setLibraryBusy(true);
        try {
            this.store.setLibrary(await this.engine.librarySnapshot(root));
        } catch (err) {
            this.messages.error(`Falha ao ler a biblioteca: ${this.msg(err)}`);
            this.store.setLibrary(undefined);
        } finally {
            this.store.setLibraryBusy(false);
        }
    }

    protected async captureGuidance(request: CaptureRequest): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setLibraryBusy(true);
        try {
            const after = await this.engine.libraryCapture(root, request);
            this.store.setLibrary(after);
            this.messages.info(
                `Guidance capturada em ${after.libraryPath}/ — destino ${request.destination}.`
            );
        } catch (err) {
            this.messages.error(`Guidance não capturada: ${this.msg(err)}`);
        } finally {
            this.store.setLibraryBusy(false);
        }
    }

    protected async guidanceLifecycle(id: string, to: GuidanceState, by?: string): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setLibraryBusy(true);
        try {
            this.store.setLibrary(await this.engine.libraryLifecycle(root, id, to, by));
            if (to === 'active') {
                // Promover é o ato que deixa a guidance dirigir agente; dizer isso
                // é o ponto da separação candidata/ativa.
                this.messages.info(
                    'Promovida: a partir de agora entra no contexto compilado para o agente.'
                );
            }
        } catch (err) {
            this.messages.error(`Estado não mudou: ${this.msg(err)}`);
        } finally {
            this.store.setLibraryBusy(false);
        }
    }

    protected async declareTruth(subject: string, authorityPath: string): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setLibraryBusy(true);
        try {
            const after = await this.engine.truthDeclare(
                root,
                subject,
                authorityPath,
                100,
                'declarada no IDE'
            );
            this.store.setLibrary(after);
            const conflicts = after.conflicts.filter(c => c.subject === subject).length;
            if (conflicts > 0) {
                // Conflito de autoridade não é erro de escrita: é fato novo, e
                // fica na tela em vez de ser resolvido por precedência silenciosa.
                this.messages.warn(
                    `${subject} agora tem mais de uma autoridade no mesmo escopo — o conflito está na lista.`
                );
            }
        } catch (err) {
            this.messages.error(`Autoridade não declarada: ${this.msg(err)}`);
        } finally {
            this.store.setLibraryBusy(false);
        }
    }

    protected async addConsumer(id: string, consumer: string): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setLibraryBusy(true);
        try {
            this.store.setLibrary(await this.engine.truthConsumer(root, id, consumer));
        } catch (err) {
            this.messages.error(`Consumidor não registrado: ${this.msg(err)}`);
        } finally {
            this.store.setLibraryBusy(false);
        }
    }

    protected async proposeSync(id: string): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        try {
            const proposal = await this.engine.truthSync(root, id);
            // Proposta descreve o trabalho e não faz nada: dizer isso evita que a
            // mensagem pareça confirmação de sincronização.
            this.messages.info(
                `${proposal.reason} · consumidores a atualizar: ` +
                    `${proposal.consumersToUpdate.join(', ') || 'nenhum'} — nada foi sincronizado.`
            );
        } catch (err) {
            this.messages.error(`Proposta não gerada: ${this.msg(err)}`);
        }
    }

    // ── §13 configuração ──────────────────────────────────────────────────

    protected async readSettings(): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setSettingsBusy(true);
        try {
            this.store.setSettings(await this.engine.settingsSnapshot(root));
        } catch (err) {
            this.messages.error(`Falha ao ler a configuração: ${this.msg(err)}`);
            this.store.setSettings(undefined);
        } finally {
            this.store.setSettingsBusy(false);
        }
    }

    protected async patchSettings(patch: SettingsPatch): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setSettingsBusy(true);
        try {
            this.store.setSettings(await this.engine.settingsPatch(root, patch));
        } catch (err) {
            this.messages.error(`Configuração não mudou: ${this.msg(err)}`);
        } finally {
            this.store.setSettingsBusy(false);
        }
    }

    protected async applyProfile(name: string): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setSettingsBusy(true);
        try {
            this.store.setSettings(await this.engine.settingsProfile(root, name));
        } catch (err) {
            this.messages.error(`Perfil não aplicado: ${this.msg(err)}`);
        } finally {
            this.store.setSettingsBusy(false);
        }
    }

    protected async resetSetting(field: string): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setSettingsBusy(true);
        try {
            this.store.setSettings(await this.engine.settingsReset(root, field));
        } catch (err) {
            this.messages.error(`Campo não voltou ao default: ${this.msg(err)}`);
        } finally {
            this.store.setSettingsBusy(false);
        }
    }

    /** Aplica defaults reversíveis a partir do que o §1 detectou de verdade.
     *  Valor escolhido por pessoa nunca é sobrescrito — é para isso que a origem
     *  de cada valor existe. */
    protected async applyDetectedSettings(): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        // Ids are the ones `capability-definitions.ts` declares. `git` is not a
        // capability there — the §5 analysis reads `.git` directly — so it is
        // reported from the analysis when there is one, and as false otherwise.
        // False here only lowers a still-default setting; it never overrides a
        // choice.
        const ready = (id: string) => this.store.capability(id)?.status === 'ready';
        try {
            this.store.setSettings(
                await this.engine.settingsDetected(
                    root,
                    this.store.analysis?.git.isRepo === true,
                    ready('agentes'),
                    ready('grafo')
                )
            );
        } catch {
            /* silencioso: é um default reversível, não uma ação pedida */
        }
    }

    // ── §13 projeto durável ───────────────────────────────────────────────

    protected async readDurable(): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setDurableBusy(true);
        try {
            this.store.setDurable(await this.engine.projectSnapshot(root));
        } catch (err) {
            this.messages.error(`Falha ao ler o projeto durável: ${this.msg(err)}`);
            this.store.setDurable(undefined);
        } finally {
            this.store.setDurableBusy(false);
        }
    }

    protected async registerDurable(title: string, intent: string): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setDurableBusy(true);
        try {
            const after = await this.engine.projectRegister(root, title, intent);
            this.store.setDurable(after);
            this.messages.info(
                `Projeto durável registrado em ${after.storePath} — reabrir recupera título, ` +
                    'intenção e recursos sem transcript.'
            );
        } catch (err) {
            this.messages.error(`Projeto não registrado: ${this.msg(err)}`);
        } finally {
            this.store.setDurableBusy(false);
        }
    }

    protected async setDurableIntent(intent: string): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setDurableBusy(true);
        try {
            this.store.setDurable(await this.engine.projectIntent(root, intent));
        } catch (err) {
            this.messages.error(`Intenção não mudou: ${this.msg(err)}`);
        } finally {
            this.store.setDurableBusy(false);
        }
    }

    protected async attachResource(
        path: string,
        kind: 'directory' | 'repository'
    ): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setDurableBusy(true);
        try {
            const after = await this.engine.projectAttach(root, path, kind);
            this.store.setDurable(after);
            this.messages.info(`${after.resources.length} recurso(s) no projeto.`);
        } catch (err) {
            this.messages.error(`Recurso não anexado: ${this.msg(err)}`);
        } finally {
            this.store.setDurableBusy(false);
        }
    }

    // ── §6 contexto do agente ─────────────────────────────────────────────

    /** Compila o pacote mínimo e o traz para a tela junto do que ficou fora.
     *  Nada é enviado a agente nenhum aqui: isto é o que ELE receberia. */
    protected async compileContext(budgetChars?: number): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setContextBusy(true);
        try {
            this.store.setContext(await this.engine.contextCompile(root, budgetChars));
        } catch (err) {
            this.messages.error(`Falha ao compilar o contexto: ${this.msg(err)}`);
            this.store.setContext(undefined);
        } finally {
            this.store.setContextBusy(false);
        }
    }

    // ── §4 packs locais ───────────────────────────────────────────────────

    protected async packsRefresh(): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setPacksBusy(true);
        try {
            this.store.setPacks(await this.engine.packsSnapshot(root));
        } catch (err) {
            this.messages.error(`Falha ao ler packs: ${this.msg(err)}`);
            this.store.setPacks(undefined);
        } finally {
            this.store.setPacksBusy(false);
        }
    }

    protected async packsInstall(relPath: string): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setPacksBusy(true);
        try {
            const after = await this.engine.packsInstall(root, relPath);
            this.store.setPacks(after);
            this.messages.info(
                `Pack instalado de ${relPath} — instalado é inerte: aplicar é o próximo ato.`
            );
        } catch (err) {
            this.messages.error(`Pack não instalado: ${this.msg(err)}`);
        } finally {
            this.store.setPacksBusy(false);
        }
    }

    protected async packsSet(packId: string, apply: boolean): Promise<void> {
        const root = this.rootPath;
        if (!root) {
            return;
        }
        this.store.setPacksBusy(true);
        try {
            const after = apply
                ? await this.engine.packsApply(root, packId)
                : await this.engine.packsRevert(root, packId);
            this.store.setPacks(after);
            const verdict = after.readiness.find(v => v.packId === packId);
            if (apply && verdict && !verdict.ready) {
                this.messages.info(
                    `${packId} aplicado. Readiness bloqueada: ${verdict.note}`
                );
            }
        } catch (err) {
            this.messages.error(`Pack não ${apply ? 'aplicado' : 'revertido'}: ${this.msg(err)}`);
        } finally {
            this.store.setPacksBusy(false);
        }
    }

    protected async runChecks(runTools: boolean): Promise<void> {
        const root = this.root;
        if (!root) {
            return;
        }
        this.store.setChecksBusy(true);
        try {
            const run = await this.checks.run(root, runTools);
            this.store.setChecks(run);
            const { failed, unknown, notRun } = run.report;
            if (failed > 0) {
                this.messages.error(`${failed} check(s) falharam.`);
            } else if (unknown > 0 || notRun > 0) {
                // Explicitly NOT a success message: nothing here is an approval.
                this.messages.info(
                    `Nenhuma falha, mas ${unknown + notRun} check(s) sem resultado — não é aprovação.`
                );
            } else {
                this.messages.info('Todos os checks passaram.');
            }
        } catch (err) {
            this.messages.error(`Falha ao rodar checks: ${this.msg(err)}`);
            // Never leave a stale report on screen claiming to describe now.
            this.store.setChecks(undefined);
        } finally {
            this.store.setChecksBusy(false);
        }
    }

    protected async sessionHarvest(): Promise<void> {
        const root = this.root;
        if (!root) {
            return;
        }
        this.store.setSessionBusy(true);
        try {
            const snapshot = await this.session.harvest(root);
            this.store.setSession(snapshot);
            const proposed = snapshot.changes.find(c => c.proposed);
            if (proposed) {
                await this.adoptPendingProposal();
                this.messages.info(
                    `${proposed.relPath} proposto ao broker — decida no dock. ` +
                    `${snapshot.changes.length - 1} mudança(s) na fila.`
                );
            } else if (snapshot.changes.length === 0) {
                this.messages.info('O agente não mudou nada na worktree.');
            }
        } catch (err) {
            this.messages.error(`Falha ao colher: ${this.msg(err)}`);
        } finally {
            this.store.setSessionBusy(false);
        }
    }

    protected async sessionCancel(): Promise<void> {
        const root = this.root;
        if (!root) {
            return;
        }
        try {
            this.store.setSession(await this.session.cancel(root));
        } catch (err) {
            this.messages.error(`Falha ao encerrar: ${this.msg(err)}`);
        }
    }

    // ── external writes (WORK-05) ───────────────────────────────────────────

    /** React to the REAL filesystem watcher instead of polling.
     *
     *  Theia already watches the workspace for the explorer and the editors, so
     *  the observer rides the same events: a write by the person's agent shows up
     *  as soon as the watcher reports it, debounced so a burst of writes produces
     *  one scan. A slow interval stays as a safety net for filesystems where
     *  watching is unreliable (network mounts, containers). */
    protected watchForExternalWrites(): void {
        this.files.onDidFilesChange(event => {
            const relevant = event.changes.some(change => !this.isIdeState(change.resource));
            if (relevant) {
                this.scheduleScan();
                // Uma mudança em arquivo pode criar ou resolver divergência.
                this.refreshProduct();
            }
        });
        // Editor saves are the person's own writes: report them so they are not
        // mistaken for something an agent did behind the IDE's back.
        this.monaco.onDidSaveTextDocument(model => {
            const uri = new URI(model.uri);
            const relPath = this.relativize(uri);
            if (relPath) {
                this.observer.noteEditorSave(this.root, relPath)
                    .then(() => this.scheduleScan())
                    .catch(() => this.scheduleScan());
            }
        });
        window.setInterval(() => this.scanExternal(), 60_000);
    }

    /** Our own runtime state (baseline, broker db) must not trigger scans. */
    protected isIdeState(resource: URI): boolean {
        const raw = resource.toString();
        return raw.includes('/.instrument/') || raw.includes('/.git/');
    }

    protected relativize(uri: URI): string | undefined {
        const roots = this.workspace.tryGetRoots();
        if (roots.length === 0) {
            return undefined;
        }
        const rel = roots[0].resource.relative(uri);
        const value = rel?.toString();
        return value && !value.startsWith('..') ? value : undefined;
    }

    protected scheduleScan(): void {
        if (this.scanTimer !== undefined) {
            window.clearTimeout(this.scanTimer);
        }
        this.scanTimer = window.setTimeout(() => {
            this.scanTimer = undefined;
            this.scanExternal();
        }, 900);
    }

    /** Compare disk against the baseline. `loud` reports failures to the user;
     *  the periodic pass stays quiet so a transient error is not a popup storm. */
    async scanExternal(loud = false): Promise<void> {
        const root = this.root;
        if (!root) {
            this.store.setObserver(undefined);
            return;
        }
        if (this.store.observerBusy) {
            return;
        }
        this.store.setObserverBusy(true);
        try {
            const before = this.store.externalDriftCount;
            const report = await this.observer.scan(root);
            this.store.setObserver(report);
            if (report.drifts.length > before) {
                const fresh = report.drifts.length - before;
                this.store.toast(
                    `${fresh} escrita(s) fora do IDE detectada(s) · ${report.drifts.length} aguardando conciliação`
                );
            }
        } catch (err) {
            if (loud) {
                this.messages.error(`Falha ao observar escritas externas: ${this.msg(err)}`);
            }
        } finally {
            this.store.setObserverBusy(false);
        }
    }

    protected async rebaseline(): Promise<void> {
        const root = this.root;
        if (!root) {
            return;
        }
        this.store.setObserverBusy(true);
        try {
            this.store.setObserver(await this.observer.baseline(root));
            this.store.toast('Referência refeita: o disco de agora é o ponto de comparação');
        } catch (err) {
            this.messages.error(`Falha ao refazer a referência: ${this.msg(err)}`);
        } finally {
            this.store.setObserverBusy(false);
        }
    }

    protected async acceptExternal(relPath: string): Promise<void> {
        const root = this.root;
        if (!root) {
            return;
        }
        this.store.setObserverBusy(true);
        try {
            this.store.setObserver(await this.observer.accept(root, relPath));
            this.store.toast(`Escrita externa aceita · ${relPath}`);
        } catch (err) {
            this.messages.error(`Falha ao aceitar '${relPath}': ${this.msg(err)}`);
        } finally {
            this.store.setObserverBusy(false);
        }
    }

    /** Reverting an external write is a governed effect: it lands on the dock. */
    protected async revertExternal(relPath: string): Promise<void> {
        const root = this.root;
        if (!root) {
            return;
        }
        this.store.setObserverBusy(true);
        try {
            const result = await this.observer.proposeRevert(root, relPath);
            this.messages.info(
                `Restauração de ${result.relPath} proposta ao broker — decida no dock. ` +
                'Nada foi escrito ainda.'
            );
            await this.adoptPendingProposal();
        } catch (err) {
            this.messages.error(`Falha ao propor reversão de '${relPath}': ${this.msg(err)}`);
        } finally {
            this.store.setObserverBusy(false);
        }
    }

    // ── harness provider ────────────────────────────────────────────────────

    async refreshHarness(): Promise<void> {
        const root = this.root;
        if (!root) {
            this.store.setHarness(undefined);
            return;
        }
        try {
            this.store.setHarness(await this.harness.snapshot(root));
        } catch (err) {
            this.messages.error(`Falha ao ler o harness: ${this.msg(err)}`);
        }
    }

    protected manifestFor(which?: string): HarnessManifest {
        return which === 'conflict' ? CONFLICT_PROVIDER : TEST_PROVIDER_V1;
    }

    protected async run(action: () => Promise<void>): Promise<void> {
        this.store.setHarnessBusy(true);
        try {
            await action();
        } finally {
            this.store.setHarnessBusy(false);
        }
    }

    protected registerProvider(which?: string): Promise<void> {
        const root = this.root;
        if (!root) {
            this.messages.warn('Nenhum projeto aberto — o harness é por projeto.');
            return Promise.resolve();
        }
        const manifest = this.manifestFor(which);
        return this.run(async () => {
            try {
                this.store.setHarness(await this.harness.register(root, manifest));
                this.store.toast(`Provider registrado · ${manifest.id} ${manifest.version}`);
            } catch (err) {
                this.messages.error(`Falha ao registrar '${manifest.id}': ${this.msg(err)}`);
            }
        });
    }

    protected activate(providerId: string): Promise<void> {
        const root = this.root;
        return this.run(async () => {
            try {
                this.store.setHarness(await this.harness.activate(root, providerId));
                this.store.toast(`Provider ativo · ${providerId}`);
            } catch (err) {
                // A slot conflict surfaces as-is: the registry refuses to merge.
                this.messages.error(this.msg(err));
                await this.refreshHarness();
            }
        });
    }

    protected suspend(providerId: string): Promise<void> {
        const root = this.root;
        return this.run(async () => {
            try {
                this.store.setHarness(await this.harness.suspend(root, providerId));
                this.store.toast(`Provider suspenso · slots liberados, estado preservado`);
            } catch (err) {
                this.messages.error(this.msg(err));
            }
        });
    }

    protected migrate(providerId: string): Promise<void> {
        const root = this.root;
        return this.run(async () => {
            try {
                this.store.setHarness(await this.harness.migrate(root, providerId, TEST_PROVIDER_V2));
                this.store.toast(`Provider migrado · ${TEST_PROVIDER_V2.version}, estado preservado`);
            } catch (err) {
                this.messages.error(this.msg(err));
            }
        });
    }

    protected seed(providerId: string): Promise<void> {
        const root = this.root;
        return this.run(async () => {
            try {
                this.store.setHarness(await this.harness.addItems(root, providerId, SEED_ITEMS));
            } catch (err) {
                this.messages.error(this.msg(err));
            }
        });
    }

    /** Prove the no-bypass clause: a provider effect comes back AWAITING, having
     *  crossed the real broker (approval gate + snapshot), and the dock's
     *  decision card is where a human resolves it. */
    protected effect(providerId: string): Promise<void> {
        const root = this.root;
        return this.run(async () => {
            try {
                const current = this.store.proposal;
                if (current && current.state === 'awaiting') {
                    this.messages.warn(
                        'Já existe uma escrita aguardando aprovação — resolva-a no dock antes de propor outra.'
                    );
                    return;
                }
                const marker = `\n<!-- harness:${providerId} -->\n`;
                const result = await this.harness.providerEffect(
                    root,
                    providerId,
                    EFFECT_REL,
                    await this.currentPlus(EFFECT_REL, marker)
                );
                // The awaiting proposal lands on the SAME dock decision card as
                // any other governed write, so a human resolves it there.
                this.store.governedProposed(result.proposal);
                await this.refreshHarness();
                this.messages.info(
                    `Efeito do provider em ${result.proposal.relPath}: ${result.proposal.state} ` +
                    `(+${result.proposal.addedLines}/-${result.proposal.removedLines}) ` +
                    '— nada foi escrito sem aprovação; resolva no dock.'
                );
            } catch (err) {
                this.messages.error(`Falha no efeito do provider: ${this.msg(err)}`);
            }
        });
    }

    /** Full proposed bytes for the provider effect: the real current file plus
     *  the provider's marker (or minus it, so the action is reversible). Read
     *  through the real FileService — nothing is guessed. */
    protected async currentPlus(relPath: string, marker: string): Promise<string> {
        const roots = this.workspace.tryGetRoots();
        if (roots.length === 0) {
            throw new Error('nenhum projeto aberto');
        }
        const fileUri = roots[0].resource.resolve(relPath);
        const current = (await this.files.read(fileUri)).value;
        return current.includes(marker.trim())
            ? current.split(marker).join('')
            : current + marker;
    }

    protected msg(err: unknown): string {
        return err instanceof Error ? err.message : String(err);
    }
}
