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
//  • STATE PRESERVED — items live in `<root>/.instrument/harness.json` and are
//    never touched by activate/suspend/migrate. Suspending frees slots only.
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
    HARNESS_MANIFEST_VERSION,
    HARNESS_SLOTS,
    HarnessBinding,
    HarnessEffectResult,
    HarnessExtensions,
    HarnessManifest,
    HarnessProviderState,
    HarnessReceipt,
    HarnessService,
    HarnessSlot,
    HarnessSnapshot
} from '../common/harness-protocol';
import { GovernedWriteService } from '../common/governed-protocol';

/** Directory (relative to the project root) holding IDE-owned metadata. */
const META_DIR = '.instrument';
const STATE_FILE = 'harness.json';

/** Cap on the receipt trail kept in the state file. */
const RECEIPT_CAP = 200;

interface PersistedState {
    providers: Record<string, HarnessProviderState>;
    bindings: Record<string, string | undefined>;
    receipts: HarnessReceipt[];
}

function emptyState(): PersistedState {
    return { providers: {}, bindings: {}, receipts: [] };
}

@injectable()
export class HarnessRegistryService implements HarnessService {

    @inject(GovernedWriteService) protected readonly governed!: GovernedWriteService;

    // ── public API ─────────────────────────────────────────────────────────

    async snapshot(rootUri: string): Promise<HarnessSnapshot> {
        return this.compose(this.load(this.rootPath(rootUri)));
    }

    async register(rootUri: string, manifest: HarnessManifest): Promise<HarnessSnapshot> {
        const root = this.rootPath(rootUri);
        this.validate(manifest);
        const state = this.load(root);
        const existing = state.providers[manifest.id];
        state.providers[manifest.id] = {
            manifest,
            // Re-registering never resurrects slots by itself.
            status: existing?.status === 'active' ? 'active' : existing ? existing.status : 'registered',
            // STATE PRESERVED across re-registration.
            items: existing?.items ?? [],
            stateVersion: existing?.stateVersion ?? manifest.version
        };
        this.receipt(state, manifest.id, 'register', `manifesto ${manifest.version} registrado`);
        return this.persist(root, state);
    }

    async activate(rootUri: string, providerId: string): Promise<HarnessSnapshot> {
        const root = this.rootPath(rootUri);
        const state = this.load(root);
        const provider = this.requireProvider(state, providerId);
        this.assertSlotsFree(state, provider.manifest, providerId);
        for (const slot of provider.manifest.claims) {
            state.bindings[slot] = providerId;
        }
        provider.status = 'active';
        this.receipt(
            state,
            providerId,
            'activate',
            `assumiu ${provider.manifest.claims.join(', ') || 'nenhum slot'} · ${provider.items.length} itens preservados`
        );
        return this.persist(root, state);
    }

    async suspend(rootUri: string, providerId: string): Promise<HarnessSnapshot> {
        const root = this.rootPath(rootUri);
        const state = this.load(root);
        const provider = this.requireProvider(state, providerId);
        for (const slot of HARNESS_SLOTS) {
            if (state.bindings[slot] === providerId) {
                state.bindings[slot] = undefined;
            }
        }
        provider.status = 'suspended';
        // provider.items is deliberately untouched.
        this.receipt(
            state,
            providerId,
            'suspend',
            `slots liberados · ${provider.items.length} itens preservados`
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
        const provider = this.requireProvider(state, providerId);
        const wasActive = provider.status === 'active';
        if (wasActive) {
            // The new version may claim different slots; validate before moving.
            this.assertSlotsFree(state, manifest, providerId);
        }
        const previousVersion = provider.manifest.version;
        provider.manifest = manifest;
        provider.stateVersion = manifest.version;
        // provider.items survives the version change untouched.
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
            `${previousVersion} → ${manifest.version} · ${provider.items.length} itens preservados`
        );
        return this.persist(root, state);
    }

    async addItems(rootUri: string, providerId: string, items: string[]): Promise<HarnessSnapshot> {
        const root = this.rootPath(rootUri);
        const state = this.load(root);
        const provider = this.requireProvider(state, providerId);
        for (const item of items) {
            if (!provider.items.includes(item)) {
                provider.items.push(item);
            }
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
        const provider = this.requireProvider(state, providerId);
        if (provider.status !== 'active') {
            throw new Error(`provider '${providerId}' não está ativo — não pode propor efeitos`);
        }
        // THE ONLY OUTWARD PATH: through the governed write service, i.e. the
        // real broker. Nothing here writes a workspace file.
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

    protected requireProvider(state: PersistedState, providerId: string): HarnessProviderState {
        const provider = state.providers[providerId];
        if (!provider) {
            throw new Error(`provider de harness não registrado: ${providerId}`);
        }
        return provider;
    }

    // ── persistence ────────────────────────────────────────────────────────

    protected statePath(root: string): string {
        return path.join(root, META_DIR, STATE_FILE);
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
        fs.writeFileSync(file, JSON.stringify(state, undefined, 2), 'utf8');
    }

    protected persist(root: string, state: PersistedState): HarnessSnapshot {
        this.persistOnly(root, state);
        return this.compose(state);
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

    protected compose(state: PersistedState): HarnessSnapshot {
        const providers = Object.values(state.providers);
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
