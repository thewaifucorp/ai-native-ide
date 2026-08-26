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
import { CapabilityService } from '../common/capability-protocol';
import { GovernedWriteService } from '../common/governed-protocol';
import { ObserverService } from '../common/observer-protocol';
import { HarnessService, HarnessManifest } from '../common/harness-protocol';
import {
    CONFLICT_PROVIDER,
    TEST_PROVIDER_ID,
    TEST_PROVIDER_V1,
    TEST_PROVIDER_V2
} from '../common/harness-test-provider';
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
    @inject(MonacoWorkspace) protected readonly monaco!: MonacoWorkspace;

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
