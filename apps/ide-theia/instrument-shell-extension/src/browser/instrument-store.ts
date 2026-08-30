// Shared, observable client state for the sketch-001 instrument shell.
//
// Each 001 region is a separate Theia ReactWidget (separate React root), so they
// cannot share React state directly. This singleton is the cross-widget bus: it
// holds the small amount of interaction state 001 needs (which work-surface view
// is active, whether Game Mode is on, whether the timeline drawer is open, the
// decision-card lifecycle, the transient toast) and fires `onDidChange` so every
// mounted widget re-renders via `widget.update()`.

import { injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { RuntimeStateNotice, WriteProposal } from '../common/governed-protocol';
import { CapabilityState } from '../common/capability-protocol';
import {
    BrokerActivity,
    ContextPackage,
    HarnessRun,
    IntentReview,
    LibrarySnapshot,
    LifecycleSnapshot,
    AdapterCard,
    PromotionSnapshot,
    ProvidersSnapshot,
    PublishAttempt,
    ReleaseSnapshot,
    ShareSnapshot,
    VerifyResult,
    ReopenedExport,
    ReferencesSnapshot,
    WorkSnapshot,
    NotesSnapshot,
    ProjectSnapshot,
    SettingsSnapshot,
    PacksSnapshot,
    PreviewSnapshot,
    ReconciliationSnapshot
} from 'engine-extension';
import { HarnessSnapshot } from '../common/harness-protocol';
import { ObserverReport } from '../common/observer-protocol';
import { ProjectAnalysis } from '../common/analysis-protocol';
import { AgentSessionSnapshot } from '../common/agent-session-protocol';
import { ProductModel, ProjectResource, SourceOfTruth } from '../common/product-protocol';
import { AgentProbe } from 'engine-extension';

export type WorkView = 'home' | 'build' | 'notas';

/** Which real (or bespoke) view-container the navigator "modes" row is showing. */
export type NavMode = 'produto' | 'arquivos' | 'busca' | 'git' | 'depuracao' | 'grafo' | 'ferramentas';

/** A real top-level workspace resource (file or folder), from FileService. */
export interface WorkspaceResource {
    name: string;
    /** `toString()` of the resource URI — passed to `instrument.openResource`. */
    uri: string;
    isDir: boolean;
}

@injectable()
export class InstrumentStore {
    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    view: WorkView = 'home';
    navMode: NavMode = 'arquivos';
    gameMode = true;
    drawerOpen = false;
    toastText = '';

    // ── REAL workspace model (M3): populated by InstrumentDataContribution from
    //    WorkspaceService + FileService. Crumb / Produto / Overview / Rail read it.
    workspaceName = '';
    workspaceRootUri = '';
    resources: WorkspaceResource[] = [];

    // ── REAL governed-write proposal (M3): the current awaiting/approved/rolled-
    //    back write over a real file. Drives the dock decision card + pulse strip.
    proposal: WriteProposal | undefined;

    // ── REAL agent probe (M5): descriptor + honest health of the agent adapter,
    //    from ide-agent's AcpxAgentFacade via the sidecar. `undefined` = probing.
    //    Drives the dock's "Contexto ativo" identity + availability badge.
    agent: AgentProbe | undefined;

    // ── REAL capability platform (M8): the states the backend registry detected
    //    for the OPEN project. `undefined` entries never exist — a capability the
    //    registry could not evaluate arrives with status 'unknown'. Empty array =
    //    detection has not run yet (rendered as "detectando", never as healthy).
    capabilities: CapabilityState[] = [];
    capabilitiesDetected = false;
    /** Capability ids with a long-running action in flight (install/detect). */
    busyCapabilities: string[] = [];

    // ── REAL harness provider registry (M8): providers, slot bindings, composed
    //    extensions and the receipt trail for the open project.
    harness: HarnessSnapshot | undefined;
    harnessBusy = false;

    /** Which capability the (generic) surface tab is currently showing. */
    surfaceCapabilityId: string | undefined;

    // ── REAL observation of writes the IDE did not make (WORK-05): the person's
    //    own agent, a script or the terminal. `undefined` = not scanned yet.
    observer: ObserverReport | undefined;
    /** O que o IDE escreveu no projeto só por ter sido aberto (§1/§13). */
    runtimeState: RuntimeStateNotice | undefined;
    observerBusy = false;

    // ── REAL hosted ACP session: the agent works in a worktree and its changes
    //    cross the broker before reaching the project.
    session: AgentSessionSnapshot | undefined;
    sessionBusy = false;

    // ── REAL checks determinísticos (§4). Nome `checks`, não `harness`: o store
    //    já tem `harness`, que é o MANIFESTO de provider do projeto — outro eixo.
    checks: HarnessRun | undefined;
    checksBusy = false;

    // ── REAL preview (§4): o processo que o projeto declara, supervisionado
    //    pelo motor do ide-reconciliation. `undefined` = nem consultado; um
    //    snapshot com `state: null` = declarado mas não iniciado. Não iniciado
    //    não é quebrado, e as duas coisas nunca se misturam na tela.
    preview: PreviewSnapshot | undefined;
    previewBusy = false;

    // ── REAL reconciliação (§4): o que o projeto DECLAROU contra o que foi
    //    OBSERVADO. Outro eixo do §3 (que confere intenção contra implementação
    //    pelos claims de `.product/`) — aqui a observação vem do ledger do
    //    preview, e divergência sem evidência não existe.
    reconciliation: ReconciliationSnapshot | undefined;
    reconcileBusy = false;

    // ── REAL packs locais (§4): disponíveis (arquivo no projeto), instalados
    //    (no registry, inertes) e aplicados (valendo em checkpoint). Três
    //    estados distintos de propósito.
    packs: PacksSnapshot | undefined;
    packsBusy = false;

    // ── REAL notas por tema (§7): propostas, decisões, perguntas e
    //    alternativas, com as ligações e os conflitos que o motor prova.
    //    `undefined` = nem lidas.
    notes: NotesSnapshot | undefined;
    notesBusy = false;

    // ── REAL composer de intenção (§8): o texto que a PESSOA escreveu (nunca
    //    reescrito por nós) e as hipóteses de camada 1 sobre ele, com a decisão
    //    registrada de cada uma. `undefined` = nem avaliado.
    intentDraft = '';
    intentReview: IntentReview | undefined;
    intentBusy = false;

    // ── REAL biblioteca de Guidance + Truth Registry (§13): o que existe, o
    //    que está ATIVO e aplicável agora, a higiene e os conflitos de
    //    autoridade. `undefined` = nem lida.
    library: LibrarySnapshot | undefined;
    libraryBusy = false;

    // ── REAL configuração (§13): um schema para o painel e para o arquivo, com
    //    a origem de cada valor (default/detected/user) e a consequência.
    settings: SettingsSnapshot | undefined;
    settingsBusy = false;

    // ── REAL projeto durável (§13): identidade, intenção escrita e recursos.
    //    Abrir pasta não é registrar projeto.
    durable: ProjectSnapshot | undefined;
    durableBusy = false;

    // ── REAL adaptadores de agente (§10): o que o MOTOR conhece, sondado um a
    //    um, com o PolicyCoverage de cada um. `undefined` = nem sondado.
    adapters: AdapterCard[] | undefined;

    // ── REAL referências (§13): serviço e ambiente do projeto durável. Elas
    //    têm endereço, não caminho — e nada aqui chama o endpoint.
    references: ReferencesSnapshot | undefined;
    referencesBusy = false;

    // ── REAL trabalho (§9): itens em arquivo e status CALCULADO. Nenhum campo
    //    aqui é escrito por alguém: o motor derivou tudo do que os artefatos
    //    dizem e do material medido agora.
    work: WorkSnapshot | undefined;
    workBusy = false;

    // ── REAL ciclo de publicação (§16): versões publicadas, exports em disco e
    //    o que cada efeito PODE desfazer. `lifecycleAttempt` guarda a última
    //    resposta do motor — inclusive a que diz "isto exige confirmação".
    lifecycle: LifecycleSnapshot | undefined;
    lifecycleBusy = false;
    lifecycleAttempt: PublishAttempt | undefined;
    // ── REAL publicação pelo adapter Git (§16): estado de git/gh/remoto e, por
    //    versão consolidada, onde ela chegou. `undefined` = nem lido.
    release: ReleaseSnapshot | undefined;
    releaseBusy = false;

    // ── REAL promoção protótipo → durável (§14): o que virou durável e o que
    //    ainda deve a reconciliação que a própria promoção criou.
    promotion: PromotionSnapshot | undefined;
    promotionBusy = false;

    // ── REAL compartilhamento (§16): o que está exposto, para quem, com que
    //    senha e até quando. `undefined` = nem lido.
    share: ShareSnapshot | undefined;
    shareBusy = false;

    // ── REAL providers (§16): catálogo, o que já existe no projeto e a última
    //    conferência de endereço.
    providers: ProvidersSnapshot | undefined;
    providersBusy = false;
    lastVerify: VerifyResult | undefined;

    /** O export reaberto (LIFE-03) e o que mudou desde ele; `undefined` = nenhum. */
    lifecycleReopened: ReopenedExport | undefined;
    /** Recursos que a pessoa ligou ao problema observado, por id portátil. */
    lifecycleRelated: string[] = [];

    // ── REAL pacote de contexto do agente (§6): o que o agente receberia, o
    //    que ficou de fora com o motivo, e o que ninguém consegue responder a
    //    partir de material declarado. `undefined` = nem compilado.
    context: ContextPackage | undefined;
    contextBusy = false;

    // ── REAL análise do projeto (§5): stack, comandos, Git, serviços e
    //    integrações, cada afirmação com a evidência que a sustenta.
    analysis: ProjectAnalysis | undefined;
    analysisBusy = false;

    // ── REAL modelo semântico (§3): recursos, autoridades e divergências
    //    calculadas a partir dos artefatos em `.product/`.
    product: ProductModel | undefined;
    productBusy = false;

    // ── Candidatos de `.product/` (PROJ-06): o que a análise ENCONTROU num
    //    projeto que ainda não declarou nada. Candidato não é declaração — fica
    //    aqui até alguém adotar, e adotar escreve o artefato.
    productCandidates: { resources: ProjectResource[]; sots: SourceOfTruth[] } | undefined;

    /** Ids of collapsed sections in the Ferramentas view (session-local). */
    collapsedSections: string[] = ['workbench', 'broker', 'harness', 'packs', 'library', 'settings', 'durable'];

    // ── REAL broker trail (M9): the raw audit the Rust broker recorded for this
    //    project — propose / awaiting / snapshot / execute / rollback. Fetched on
    //    demand, so "inspecionável" does not mean "always polling".
    brokerActivity: BrokerActivity[] | undefined;
    brokerActivityBusy = false;

    protected toastTimer: number | undefined;
    // Honest defaults: with no proposal there is nothing pending and nothing
    // running. These only ever move when a REAL governed write does.
    protected pulseNow = 'nenhuma escrita proposta';
    protected stage = 'OCIOSO';
    protected pendingCount = '0 decisões';

    get nowText(): string { return this.pulseNow; }
    get stageText(): string { return this.stage; }
    get pendingText(): string { return this.pendingCount; }
    get pendingIsWarn(): boolean { return this.pendingCount !== '0 decisões'; }

    protected emit(): void {
        this.onDidChangeEmitter.fire();
    }

    setView(view: WorkView): void {
        if (this.view !== view) {
            this.view = view;
            this.emit();
        }
    }

    setNavMode(mode: NavMode): void {
        if (this.navMode !== mode) {
            this.navMode = mode;
            this.emit();
        }
    }

    // ── REAL workspace model ────────────────────────────────────────────────

    setWorkspace(name: string, rootUri: string, resources: WorkspaceResource[]): void {
        this.workspaceName = name;
        this.workspaceRootUri = rootUri;
        this.resources = resources;
        this.emit();
    }

    // ── REAL agent probe ────────────────────────────────────────────────────

    setAgentProbe(probe: AgentProbe): void {
        this.agent = probe;
        this.emit();
    }

    /** Two-letter identity for the active project button on the rail. */
    get railInitials(): string {
        const n = (this.workspaceName || 'workspace').replace(/[^\p{L}\p{N} ]/gu, ' ').trim();
        const words = n.split(/[\s._-]+/).filter(Boolean);
        const initials = words.length >= 2 ? words[0][0] + words[1][0] : n.slice(0, 2);
        return (initials || 'ws').toUpperCase();
    }

    // ── REAL capability platform ────────────────────────────────────────────

    /** Replace the full detected set for the open project. */
    setCapabilities(states: CapabilityState[]): void {
        this.capabilities = states;
        this.capabilitiesDetected = true;
        this.emit();
    }

    /** Replace one capability's state after a targeted detect/install. */
    setCapability(state: CapabilityState): void {
        const index = this.capabilities.findIndex(c => c.id === state.id);
        if (index >= 0) {
            this.capabilities = [
                ...this.capabilities.slice(0, index),
                state,
                ...this.capabilities.slice(index + 1)
            ];
        } else {
            this.capabilities = [...this.capabilities, state];
        }
        this.emit();
    }

    capability(id: string): CapabilityState | undefined {
        return this.capabilities.find(c => c.id === id);
    }

    setCapabilityBusy(id: string, busy: boolean): void {
        const has = this.busyCapabilities.includes(id);
        if (busy && !has) {
            this.busyCapabilities = [...this.busyCapabilities, id];
        } else if (!busy && has) {
            this.busyCapabilities = this.busyCapabilities.filter(c => c !== id);
        } else {
            return;
        }
        this.emit();
    }

    isCapabilityBusy(id: string): boolean {
        return this.busyCapabilities.includes(id);
    }

    // ── REAL harness provider registry ──────────────────────────────────────

    setHarness(snapshot: HarnessSnapshot | undefined): void {
        this.harness = snapshot;
        this.emit();
    }

    /** Point the generic capability-surface tab at one capability. */
    setSurfaceCapability(id: string): void {
        if (this.surfaceCapabilityId !== id) {
            this.surfaceCapabilityId = id;
            this.emit();
        }
    }

    isSectionCollapsed(id: string): boolean {
        return this.collapsedSections.includes(id);
    }

    toggleSection(id: string): void {
        this.collapsedSections = this.collapsedSections.includes(id)
            ? this.collapsedSections.filter(s => s !== id)
            : [...this.collapsedSections, id];
        this.emit();
    }

    setProduct(model: ProductModel | undefined): void {
        this.product = model;
        this.emit();
    }

    setProductBusy(busy: boolean): void {
        this.productBusy = busy;
        this.emit();
    }

    setProductCandidates(
        found: { resources: ProjectResource[]; sots: SourceOfTruth[] } | undefined
    ): void {
        this.productCandidates = found;
        this.emit();
    }

    /** Divergências reais (exceção registrada não conta como divergência aberta). */
    get divergenceCount(): number {
        return this.product ? this.product.claims.filter(c => c.status === 'divergent').length : 0;
    }

    setSession(snapshot: AgentSessionSnapshot | undefined): void {
        this.session = snapshot;
        this.emit();
    }

    setSessionBusy(busy: boolean): void {
        this.sessionBusy = busy;
        this.emit();
    }

    setAnalysis(analysis: ProjectAnalysis | undefined): void {
        this.analysis = analysis;
        this.emit();
    }

    setAnalysisBusy(busy: boolean): void {
        this.analysisBusy = busy;
        this.emit();
    }

    setPreview(snapshot: PreviewSnapshot | undefined): void {
        this.preview = snapshot;
        this.emit();
    }

    setPreviewBusy(busy: boolean): void {
        this.previewBusy = busy;
        this.emit();
    }

    setReconciliation(snapshot: ReconciliationSnapshot | undefined): void {
        this.reconciliation = snapshot;
        this.emit();
    }

    setReconcileBusy(busy: boolean): void {
        this.reconcileBusy = busy;
        this.emit();
    }

    setPacks(snapshot: PacksSnapshot | undefined): void {
        this.packs = snapshot;
        this.emit();
    }

    setPacksBusy(busy: boolean): void {
        this.packsBusy = busy;
        this.emit();
    }

    /** Divergências declarado-vs-observado ainda sem decisão registrada. */
    get openDivergenceCount(): number {
        return this.reconciliation
            ? this.reconciliation.divergences.filter(d => !d.reconciliation).length
            : 0;
    }

    /** O texto é da pessoa: guardar sem tocar é o ponto do item 8. */
    setIntentDraft(text: string): void {
        this.intentDraft = text;
        this.emit();
    }

    setNotes(snapshot: NotesSnapshot | undefined): void {
        this.notes = snapshot;
        this.emit();
    }

    setNotesBusy(busy: boolean): void {
        this.notesBusy = busy;
        this.emit();
    }

    /** Conflitos abertos entre notas, guidance e SoTs. */
    get noteConflictCount(): number {
        return this.notes ? this.notes.conflicts.length : 0;
    }

    setIntentReview(review: IntentReview | undefined): void {
        this.intentReview = review;
        this.emit();
    }

    setIntentBusy(busy: boolean): void {
        this.intentBusy = busy;
        this.emit();
    }

    /** Hipóteses ainda sem decisão nesta intenção. */
    get openFindingCount(): number {
        return this.intentReview
            ? this.intentReview.reviewed.filter(r => !r.decision).length
            : 0;
    }

    setLibrary(snapshot: LibrarySnapshot | undefined): void {
        this.library = snapshot;
        this.emit();
    }

    setLibraryBusy(busy: boolean): void {
        this.libraryBusy = busy;
        this.emit();
    }

    setSettings(snapshot: SettingsSnapshot | undefined): void {
        this.settings = snapshot;
        this.emit();
    }

    setSettingsBusy(busy: boolean): void {
        this.settingsBusy = busy;
        this.emit();
    }

    setAdapters(adapters: AdapterCard[] | undefined): void {
        this.adapters = adapters;
        this.emit();
    }

    setReferences(snapshot: ReferencesSnapshot | undefined): void {
        this.references = snapshot;
        this.emit();
    }

    setReferencesBusy(busy: boolean): void {
        this.referencesBusy = busy;
        this.emit();
    }

    setWork(snapshot: WorkSnapshot | undefined): void {
        this.work = snapshot;
        this.emit();
    }

    setWorkBusy(busy: boolean): void {
        this.workBusy = busy;
        this.emit();
    }

    setLifecycle(snapshot: LifecycleSnapshot | undefined): void {
        this.lifecycle = snapshot;
        this.emit();
    }

    setLifecycleBusy(busy: boolean): void {
        this.lifecycleBusy = busy;
        this.emit();
    }

    /** The engine's last answer about an export/publish, verbatim — including a
     *  refusal to proceed without confirmation. */
    setLifecycleAttempt(attempt: PublishAttempt | undefined): void {
        this.lifecycleAttempt = attempt;
        if (attempt) {
            this.lifecycle = attempt.snapshot;
        }
        this.emit();
    }

    setPromotion(snapshot: PromotionSnapshot | undefined): void {
        this.promotion = snapshot;
        this.emit();
    }

    setPromotionBusy(busy: boolean): void {
        this.promotionBusy = busy;
        this.emit();
    }

    setShare(snapshot: ShareSnapshot | undefined): void {
        this.share = snapshot;
        this.emit();
    }

    setShareBusy(busy: boolean): void {
        this.shareBusy = busy;
        this.emit();
    }

    setProviders(snapshot: ProvidersSnapshot | undefined): void {
        this.providers = snapshot;
        this.emit();
    }

    setProvidersBusy(busy: boolean): void {
        this.providersBusy = busy;
        this.emit();
    }

    setLastVerify(result: VerifyResult | undefined): void {
        this.lastVerify = result;
        this.emit();
    }

    setRelease(snapshot: ReleaseSnapshot | undefined): void {
        this.release = snapshot;
        this.emit();
    }

    setReleaseBusy(busy: boolean): void {
        this.releaseBusy = busy;
        this.emit();
    }

    /** O export reaberto. Trocar de export limpa os recursos ligados: eles são
     *  ids DAQUELE manifesto, e carregá-los para outro ligaria o problema a
     *  recursos que a pessoa não viu. */
    setLifecycleReopened(reopened: ReopenedExport | undefined): void {
        if (reopened?.path !== this.lifecycleReopened?.path) {
            this.lifecycleRelated = [];
        }
        this.lifecycleReopened = reopened;
        this.emit();
    }

    /** Liga ou desliga um recurso do problema observado. */
    toggleLifecycleRelated(id: string): void {
        this.lifecycleRelated = this.lifecycleRelated.includes(id)
            ? this.lifecycleRelated.filter(other => other !== id)
            : [...this.lifecycleRelated, id];
        this.emit();
    }

    setDurable(snapshot: ProjectSnapshot | undefined): void {
        this.durable = snapshot;
        this.emit();
    }

    setDurableBusy(busy: boolean): void {
        this.durableBusy = busy;
        this.emit();
    }

    /** Guidance ativa e aplicável a este projeto agora. */
    get appliedGuidanceCount(): number {
        return this.library ? this.library.appliedNow.length : 0;
    }

    /** Candidatas esperando revisão — nenhuma delas dirige agente. */
    get candidateGuidanceCount(): number {
        return this.library
            ? this.library.guidance.filter(g => g.state === 'candidate').length
            : 0;
    }

    setContext(pkg: ContextPackage | undefined): void {
        this.context = pkg;
        this.emit();
    }

    setContextBusy(busy: boolean): void {
        this.contextBusy = busy;
        this.emit();
    }

    setChecks(run: HarnessRun | undefined): void {
        this.checks = run;
        this.emit();
    }

    setChecksBusy(busy: boolean): void {
        this.checksBusy = busy;
        this.emit();
    }

    /** Failed findings, which is what the status strip counts. */
    get checksFailed(): number {
        return this.checks ? this.checks.report.failed : 0;
    }

    setRuntimeState(notice: RuntimeStateNotice | undefined): void {
        this.runtimeState = notice;
        this.emit();
    }

    setObserver(report: ObserverReport | undefined): void {
        this.observer = report;
        this.emit();
    }

    setObserverBusy(busy: boolean): void {
        this.observerBusy = busy;
        this.emit();
    }

    /** Count of files changed outside the IDE, awaiting reconciliation. */
    get externalDriftCount(): number {
        return this.observer ? this.observer.drifts.length : 0;
    }

    setBrokerActivity(activity: BrokerActivity[] | undefined): void {
        this.brokerActivity = activity;
        this.emit();
    }

    setBrokerActivityBusy(busy: boolean): void {
        this.brokerActivityBusy = busy;
        this.emit();
    }

    setHarnessBusy(busy: boolean): void {
        this.harnessBusy = busy;
        this.emit();
    }

    // ── REAL governed-write loop ────────────────────────────────────────────

    governedProposed(proposal: WriteProposal): void {
        this.proposal = proposal;
        this.pulseNow = `governança · escrita proposta em ${proposal.relPath}`;
        this.stage = 'AGUARDANDO';
        this.pendingCount = '1 decisão';
        this.emit();
    }

    governedApproved(proposal: WriteProposal): void {
        this.proposal = proposal;
        this.pulseNow = `governança · escrita aplicada em ${proposal.relPath}`;
        this.stage = 'APLICADO';
        this.pendingCount = '0 decisões';
        this.emit();
        this.toast(`Escrita aplicada no arquivo real · ${proposal.relPath}`);
    }

    governedRolledBack(proposal: WriteProposal): void {
        this.proposal = proposal;
        this.pulseNow = `governança · rollback restaurou ${proposal.relPath}`;
        this.stage = 'REVERTIDO';
        this.pendingCount = '0 decisões';
        this.emit();
        this.toast(`Snapshot restaurado · ${proposal.relPath}`);
    }

    toggleGame(): void {
        this.gameMode = !this.gameMode;
        // The ported 001 CSS keys game-mode rules off a `game` class on <body>.
        document.body.classList.toggle('game', this.gameMode);
        this.emit();
    }

    toggleDrawer(): void {
        this.drawerOpen = !this.drawerOpen;
        this.emit();
    }

    toast(message: string): void {
        this.toastText = message;
        this.emit();
        if (this.toastTimer !== undefined) {
            window.clearTimeout(this.toastTimer);
        }
        this.toastTimer = window.setTimeout(() => {
            this.toastText = '';
            this.emit();
        }, 2200);
    }

    focusDecision(): void {
        const card = document.getElementById('iws-decision-card');
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.animate(
                [
                    { background: 'var(--panel-2)' },
                    { background: 'rgba(217,160,60,.14)' },
                    { background: 'var(--panel-2)' }
                ],
                { duration: 700 }
            );
        }
    }

}
