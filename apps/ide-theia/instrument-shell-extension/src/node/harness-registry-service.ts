// HARNESS PROVIDER REGISTRY (TASKS.md §1).
//
// Implements the contract in common/harness-protocol.ts for one project at a
// time. What is real here:
//
//  • VERSIONED MANIFEST — `manifestVersion` is validated against the format
//    version this IDE understands; a provider's own `version` is what `migrate`
//    moves state between.
//  • EXCLUSIVE SLOTS — `workflow`, `work-hierarchy` and `primary-status` have at
//    most one owner per project. A second claim on an owned slot is rejected
//    with a conflict naming both providers. Nothing is merged silently.
//  • COMPOSABLE EXTENSIONS — checks/packs/importers/views from every ACTIVE
//    provider are composed and attributed.
//  • ARTIFACTS, NOT CODE — a provider is a manifest FILE under
//    `.harness/providers/<id>.json` (committed, reviewable), and its items are FILES in
//    the directory that manifest declares. The registry discovers whatever is on
//    disk, so an agent registers a provider by writing JSON and creates work by
//    writing markdown. `register`/`addItems` are conveniences that write those
//    same files; neither is a privileged path.
//  • STATE PRESERVED — lifecycle bookkeeping (status, slot bindings, receipts)
//    lives in `.harness/state.json`; the items live as artifacts and
//    are never touched by activate/suspend/migrate. Suspending frees slots only.
//  • NO BYPASS — there is no method that writes a workspace file. The single
//    outward path, `providerEffect`, delegates to the governed write service,
//    i.e. the real Rust broker (approval gate → snapshot → rollback → activity
//    trail). It returns an `awaiting` proposal: a provider can propose, never
//    write.
//
// The registry's OWN state file is IDE metadata under `<root>/.instrument/`
// (same place the broker keeps `effects.sqlite3`), not project content — so it
// is not, and must not be, an effect that needs human approval.

import { injectable, inject } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { FileUri } from '@theia/core/lib/common/file-uri';
import * as fs from 'fs';
import * as path from 'path';
import {
    HarnessItem,
    HARNESS_MANIFEST_VERSION,
    HARNESS_SLOTS,
    HarnessBinding,
    HarnessEffectResult,
    HarnessExtensions,
    HarnessManifest,
    HarnessProviderState,
    HarnessProviderStatus,
    HarnessReceipt,
    HarnessService,
    HarnessSlot,
    HarnessSnapshot
} from '../common/harness-protocol';
import { GovernedWriteService } from '../common/governed-protocol';

/**
 * Where harness artifacts live, relative to the project root.
 *
 * Deliberately NOT under `.instrument/`: that directory is IDE runtime state
 * (the broker's sqlite, tokens) and is git-ignored. A provider manifest and its
 * work items are project artifacts — they belong in review, in a PR, in the
 * history of how the project chose to work. So they live in `.harness/`, which
 * is committed like `.github/` or `.vscode/`.
 */
const HARNESS_DIR = '.harness';
const PROVIDERS_DIR = path.join(HARNESS_DIR, 'providers');
const STATE_FILE = path.join(HARNESS_DIR, 'state.json');
const MANIFEST_EXT = '.json';

/** Cap on the receipt trail kept in the state file. */
const RECEIPT_CAP = 200;

/** Lifecycle bookkeeping for one provider — everything that is NOT an artifact. */
interface ProviderRecord {
    status: HarnessProviderStatus;
    /** Manifest version that last wrote this provider's artifacts. */
    stateVersion: string;
}

interface PersistedState {
    providers: Record<string, ProviderRecord>;
    bindings: Record<string, string | undefined>;
    receipts: HarnessReceipt[];
}

function emptyState(): PersistedState {
    return { providers: {}, bindings: {}, receipts: [] };
}

/** A provider as it exists on disk: manifest artifact + its item artifacts. */
interface DiscoveredProvider {
    manifest: HarnessManifest;
    manifestPath: string;
    items: HarnessItem[];
}

@injectable()
export class HarnessRegistryService implements HarnessService {

    @inject(GovernedWriteService) protected readonly governed!: GovernedWriteService;

    // ── public API ─────────────────────────────────────────────────────────

    async snapshot(rootUri: string): Promise<HarnessSnapshot> {
        const root = this.rootPath(rootUri);
        return this.compose(root, this.load(root));
    }

    /** Write the manifest artifact + its items directory. Equivalent to an agent
     *  dropping the same JSON at `.harness/providers/<id>.json`. */
    async register(rootUri: string, manifest: HarnessManifest): Promise<HarnessSnapshot> {
        const root = this.rootPath(rootUri);
        this.validate(manifest);
        const manifestPath = path.join(root, PROVIDERS_DIR, `${manifest.id}${MANIFEST_EXT}`);
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n', 'utf8');
        fs.mkdirSync(this.itemsDir(root, manifest), { recursive: true });

        const state = this.load(root);
        const existing = state.providers[manifest.id];
        state.providers[manifest.id] = {
            // Re-registering never resurrects slots by itself.
            status: existing?.status ?? 'registered',
            stateVersion: existing?.stateVersion ?? manifest.version
        };
        this.receipt(
            state,
            manifest.id,
            'register',
            `manifesto ${manifest.version} gravado em ${path.relative(root, manifestPath)}`
        );
        return this.persist(root, state);
    }

    async activate(rootUri: string, providerId: string): Promise<HarnessSnapshot> {
        const root = this.rootPath(rootUri);
        const state = this.load(root);
        const provider = this.requireDiscovered(root, providerId);
        this.assertSlotsFree(state, provider.manifest, providerId);
        for (const slot of provider.manifest.claims) {
            state.bindings[slot] = providerId;
        }
        this.record(state, providerId, provider.manifest).status = 'active';
        this.receipt(
            state,
            providerId,
            'activate',
            `assumiu ${provider.manifest.claims.join(', ') || 'nenhum slot'} · ` +
            `${provider.items.length} artefatos preservados`
        );
        return this.persist(root, state);
    }

    async suspend(rootUri: string, providerId: string): Promise<HarnessSnapshot> {
        const root = this.rootPath(rootUri);
        const state = this.load(root);
        const provider = this.requireDiscovered(root, providerId);
        for (const slot of HARNESS_SLOTS) {
            if (state.bindings[slot] === providerId) {
                state.bindings[slot] = undefined;
            }
        }
        this.record(state, providerId, provider.manifest).status = 'suspended';
        // The item artifacts are deliberately untouched on disk.
        this.receipt(
            state,
            providerId,
            'suspend',
            `slots liberados · ${provider.items.length} artefatos preservados`
        );
        return this.persist(root, state);
    }

    async migrate(
        rootUri: string,
        providerId: string,
        manifest: HarnessManifest
    ): Promise<HarnessSnapshot> {
        const root = this.rootPath(rootUri);
        this.validate(manifest);
        if (manifest.id !== providerId) {
            throw new Error(
                `migração inválida: manifesto '${manifest.id}' não corresponde ao provider '${providerId}'`
            );
        }
        const state = this.load(root);
        const current = this.requireDiscovered(root, providerId);
        const record = this.record(state, providerId, current.manifest);
        const wasActive = record.status === 'active';
        if (wasActive) {
            // The new version may claim different slots; validate before moving.
            this.assertSlotsFree(state, manifest, providerId);
        }
        const previousVersion = current.manifest.version;

        // The manifest artifact is replaced; the item artifacts are not touched,
        // and if the new version declares a different items directory the existing
        // artifacts are MOVED there rather than abandoned.
        const previousItemsDir = this.itemsDir(root, current.manifest);
        const nextItemsDir = this.itemsDir(root, manifest);
        if (path.resolve(previousItemsDir) !== path.resolve(nextItemsDir)) {
            fs.mkdirSync(nextItemsDir, { recursive: true });
            for (const item of current.items) {
                fs.renameSync(
                    path.join(root, item.path),
                    path.join(nextItemsDir, `${item.id}${manifest.artifacts.itemExtension}`)
                );
            }
        }
        const manifestPath = path.join(root, PROVIDERS_DIR, `${manifest.id}${MANIFEST_EXT}`);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n', 'utf8');
        record.stateVersion = manifest.version;

        if (wasActive) {
            for (const slot of HARNESS_SLOTS) {
                if (state.bindings[slot] === providerId && !manifest.claims.includes(slot)) {
                    state.bindings[slot] = undefined;
                }
            }
            for (const slot of manifest.claims) {
                state.bindings[slot] = providerId;
            }
        }
        this.receipt(
            state,
            providerId,
            'migrate',
            `${previousVersion} → ${manifest.version} · ${current.items.length} artefatos preservados`
        );
        return this.persist(root, state);
    }

    /** Create one item artifact per title. Writing the files directly — which is
     *  what an agent doing the work would do — has the same effect. */
    async addItems(rootUri: string, providerId: string, items: string[]): Promise<HarnessSnapshot> {
        const root = this.rootPath(rootUri);
        const state = this.load(root);
        const provider = this.requireDiscovered(root, providerId);
        const dir = this.itemsDir(root, provider.manifest);
        fs.mkdirSync(dir, { recursive: true });
        for (const title of items) {
            const id = this.slug(title);
            const file = path.join(dir, `${id}${provider.manifest.artifacts.itemExtension}`);
            if (fs.existsSync(file)) {
                continue;
            }
            const initial = provider.manifest.workflow?.initial ?? 'aberto';
            fs.writeFileSync(
                file,
                `# ${title}\n\n` +
                `- provider: ${providerId}\n` +
                `- estado: ${initial}\n\n` +
                'Artefato de trabalho. Edite este arquivo (pessoa ou agente); o registry\n' +
                'lê o que está no disco.\n',
                'utf8'
            );
        }
        return this.persist(root, state);
    }

    async providerEffect(
        rootUri: string,
        providerId: string,
        relPath: string,
        content: string
    ): Promise<HarnessEffectResult> {
        const root = this.rootPath(rootUri);
        const state = this.load(root);
        const provider = this.requireDiscovered(root, providerId);
        const record = state.providers[providerId];
        if (!record || record.status !== 'active') {
            throw new Error(`provider '${providerId}' não está ativo — não pode propor efeitos`);
        }
        void provider;
        // THE ONLY OUTWARD PATH: through the governed write service, i.e. the
        // real broker. Nothing here writes a project file.
        const proposal = await this.governed.proposeWrite(rootUri, relPath, content);
        if (proposal.state !== 'awaiting') {
            throw new Error(
                `broker retornou estado '${proposal.state}' — um efeito de provider precisa aguardar aprovação`
            );
        }
        this.receipt(
            state,
            providerId,
            'effect-proposed',
            `escrita em ${relPath} aguardando aprovação (proposta ${proposal.id})`
        );
        this.persistOnly(root, state);
        return { proposal };
    }

    // ── discovery ──────────────────────────────────────────────────────────

    /** Read every manifest artifact in the project, with its item artifacts. */
    protected discover(root: string): DiscoveredProvider[] {
        const dir = path.join(root, PROVIDERS_DIR);
        if (!fs.existsSync(dir)) {
            return [];
        }
        const found: DiscoveredProvider[] = [];
        for (const entry of fs.readdirSync(dir).sort()) {
            if (!entry.endsWith(MANIFEST_EXT)) {
                continue;
            }
            const file = path.join(dir, entry);
            let manifest: HarnessManifest;
            try {
                manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as HarnessManifest;
                this.validate(manifest);
            } catch (err) {
                // A malformed manifest is reported, never silently skipped: it is
                // someone's (or some agent's) file, and they need to know.
                console.warn(
                    `[harness] manifesto inválido em ${file}: ` +
                    (err instanceof Error ? err.message : String(err))
                );
                continue;
            }
            found.push({
                manifest,
                manifestPath: path.relative(root, file),
                items: this.readItems(root, manifest)
            });
        }
        return found;
    }

    protected itemsDir(root: string, manifest: HarnessManifest): string {
        const declared = manifest.artifacts.itemsDir;
        const absolute = path.resolve(root, declared);
        const rel = path.relative(root, absolute);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error(
                `provider '${manifest.id}' declara artefatos fora do projeto: ${declared}`
            );
        }
        return absolute;
    }

    /** Item artifacts as they exist on disk, in name order. */
    protected readItems(root: string, manifest: HarnessManifest): HarnessItem[] {
        let dir: string;
        try {
            dir = this.itemsDir(root, manifest);
        } catch {
            return [];
        }
        if (!fs.existsSync(dir)) {
            return [];
        }
        const ext = manifest.artifacts.itemExtension;
        return fs.readdirSync(dir)
            .filter(name => name.endsWith(ext))
            .sort()
            .map(name => {
                const file = path.join(dir, name);
                let title = name.slice(0, -ext.length);
                try {
                    const first = fs.readFileSync(file, 'utf8')
                        .split('\n')
                        .map(l => l.trim())
                        .find(l => l.length > 0);
                    if (first) {
                        title = first.replace(/^#+\s*/, '');
                    }
                } catch { /* unreadable artifact keeps its file name as the title */ }
                return { id: name.slice(0, -ext.length), path: path.relative(root, file), title };
            });
    }

    // ── validation ─────────────────────────────────────────────────────────

    protected validate(manifest: HarnessManifest): void {
        if (manifest.manifestVersion !== HARNESS_MANIFEST_VERSION) {
            throw new Error(
                `manifesto de harness na versão ${manifest.manifestVersion}; ` +
                `este IDE entende a versão ${HARNESS_MANIFEST_VERSION}`
            );
        }
        if (!manifest.id || !manifest.version) {
            throw new Error('manifesto de harness precisa de `id` e `version`');
        }
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(manifest.id)) {
            throw new Error(`id de provider inválido para um nome de arquivo: ${manifest.id}`);
        }
        if (!manifest.artifacts || !manifest.artifacts.itemsDir || !manifest.artifacts.itemExtension) {
            throw new Error('manifesto precisa declarar `artifacts.itemsDir` e `artifacts.itemExtension`');
        }
        if (!manifest.artifacts.itemExtension.startsWith('.')) {
            throw new Error('`artifacts.itemExtension` precisa começar com ponto (ex: `.md`)');
        }
        for (const claim of manifest.claims) {
            if (!HARNESS_SLOTS.includes(claim)) {
                throw new Error(`slot desconhecido reivindicado: ${claim}`);
            }
        }
        if (manifest.claims.includes('workflow') && !manifest.workflow) {
            throw new Error('provider reivindica `workflow` sem declarar seus estados');
        }
        if (manifest.claims.includes('work-hierarchy') && !manifest.hierarchy) {
            throw new Error('provider reivindica `work-hierarchy` sem declarar seus níveis');
        }
        if (manifest.claims.includes('primary-status') && !manifest.primaryStatus) {
            throw new Error('provider reivindica `primary-status` sem declarar seus valores');
        }
    }

    /** Exclusivity gate: reject a claim on a slot another provider owns. */
    protected assertSlotsFree(
        state: PersistedState,
        manifest: HarnessManifest,
        providerId: string
    ): void {
        for (const slot of manifest.claims) {
            const owner = state.bindings[slot];
            if (owner && owner !== providerId) {
                throw new Error(
                    `conflito de slot: '${slot}' já pertence ao provider '${owner}'; ` +
                    `suspenda-o antes de ativar '${providerId}'`
                );
            }
        }
    }

    protected requireDiscovered(root: string, providerId: string): DiscoveredProvider {
        const provider = this.discover(root).find(p => p.manifest.id === providerId);
        if (!provider) {
            throw new Error(
                `provider de harness não registrado: ${providerId} ` +
                `(nenhum manifesto em ${PROVIDERS_DIR})`
            );
        }
        return provider;
    }

    /** Bookkeeping record for a discovered provider, created on first sight so a
     *  manifest dropped in by hand is a first-class provider. */
    protected record(
        state: PersistedState,
        providerId: string,
        manifest: HarnessManifest
    ): ProviderRecord {
        let record = state.providers[providerId];
        if (!record) {
            record = { status: 'registered', stateVersion: manifest.version };
            state.providers[providerId] = record;
        }
        return record;
    }

    protected slug(title: string): string {
        return title
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 64) || 'item';
    }

    // ── persistence ────────────────────────────────────────────────────────

    protected statePath(root: string): string {
        return path.join(root, STATE_FILE);
    }

    protected load(root: string): PersistedState {
        const file = this.statePath(root);
        if (!fs.existsSync(file)) {
            return emptyState();
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as PersistedState;
            return {
                providers: parsed.providers ?? {},
                bindings: parsed.bindings ?? {},
                receipts: parsed.receipts ?? []
            };
        } catch (err) {
            throw new Error(
                `estado do harness ilegível em ${file}: ` +
                (err instanceof Error ? err.message : String(err))
            );
        }
    }

    protected persistOnly(root: string, state: PersistedState): void {
        const file = this.statePath(root);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state, undefined, 2) + '\n', 'utf8');
    }

    protected persist(root: string, state: PersistedState): HarnessSnapshot {
        this.persistOnly(root, state);
        return this.compose(root, state);
    }

    protected receipt(
        state: PersistedState,
        providerId: string,
        action: HarnessReceipt['action'],
        detail: string
    ): void {
        state.receipts.push({ at: new Date().toISOString(), providerId, action, detail });
        if (state.receipts.length > RECEIPT_CAP) {
            state.receipts.splice(0, state.receipts.length - RECEIPT_CAP);
        }
    }

    /** Merge what is on disk (manifests + items) with the lifecycle bookkeeping. */
    protected compose(root: string, state: PersistedState): HarnessSnapshot {
        const discovered = this.discover(root);
        const providers: HarnessProviderState[] = discovered.map(p => ({
            manifest: p.manifest,
            manifestPath: p.manifestPath,
            items: p.items,
            status: state.providers[p.manifest.id]?.status ?? 'registered',
            stateVersion: state.providers[p.manifest.id]?.stateVersion ?? p.manifest.version
        }));
        const bindings: HarnessBinding[] = HARNESS_SLOTS.map(slot => ({
            slot,
            providerId: state.bindings[slot] || undefined
        }));
        const kinds: (keyof HarnessExtensions)[] = ['checks', 'packs', 'importers', 'views'];
        const composedExtensions: HarnessSnapshot['composedExtensions'] = [];
        for (const provider of providers) {
            if (provider.status !== 'active') {
                continue;
            }
            for (const kind of kinds) {
                for (const name of provider.manifest.extensions?.[kind] ?? []) {
                    composedExtensions.push({ providerId: provider.manifest.id, kind, name });
                }
            }
        }
        return { providers, bindings, composedExtensions, receipts: state.receipts.slice(-40) };
    }

    /** Accept a `file://` URI or a plain path. */
    protected rootPath(rootUri: string): string {
        if (!rootUri) {
            throw new Error('nenhum projeto aberto: o harness é por projeto');
        }
        const raw = rootUri.includes('://') ? FileUri.fsPath(new URI(rootUri)) : rootUri;
        const resolved = path.resolve(raw);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            throw new Error(`raiz de projeto inexistente: ${resolved}`);
        }
        return resolved;
    }
}
