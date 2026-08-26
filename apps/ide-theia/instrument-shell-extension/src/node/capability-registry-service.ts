// CAPABILITY REGISTRY — the generic chassis (TASKS.md §1).
//
// It owns detection, install dispatch, provider composition, degradation
// reporting and the same-origin surface URL. It contains NO knowledge of any
// specific capability: everything specific lives in capability-definitions.ts.
//
// Honesty is structural here, not a convention:
//  • `list`/`detect` always re-run the definition's detector; nothing is cached
//    and there is no writable `status`.
//  • `install` refuses unless the freshly detected state says `installable`, and
//    it re-detects AFTER the action — so a failed generation cannot leave a
//    "ready" state behind.
//  • Detection failures become `unknown` with the thrown message, never `ready`.
//
// It also owns the allow-list of project roots the surface route may read from:
// only a root this registry has actually detected for can be served.

import { injectable, inject } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { FileUri } from '@theia/core/lib/common/file-uri';
import * as fs from 'fs';
import * as path from 'path';
import { EngineService } from 'engine-extension';
import { CapabilityService, CapabilityState } from '../common/capability-protocol';
import {
    CAPABILITY_DEFINITIONS,
    CapabilityDefinition,
    composeState
} from './capability-definitions';

/** Public prefix of the same-origin surface route (see capability-site-contribution). */
export const CAPABILITY_SITE_PREFIX = '/capability';

@injectable()
export class CapabilityRegistryService implements CapabilityService {

    @inject(EngineService) protected readonly engine!: EngineService;

    /** Definitions are injected-by-module in tests; the app uses the real set. */
    protected definitions: CapabilityDefinition[] = CAPABILITY_DEFINITIONS;

    /** Roots this registry has evaluated — the allow-list for surface reads. */
    protected readonly knownRoots = new Set<string>();

    /**
     * Monotonic detection counter. The ISO stamp alone is not enough: two
     * detections can land in the same millisecond, and an unchanged surface URL
     * would let the iframe keep serving the previous document.
     */
    protected detectionSeq = 0;

    /** Test seam: replace the hosted definitions. */
    setDefinitions(definitions: CapabilityDefinition[]): void {
        this.definitions = definitions;
    }

    /** True when `fsPath` is a root this registry has actually detected for. */
    isKnownRoot(fsPath: string): boolean {
        return this.knownRoots.has(path.resolve(fsPath));
    }

    async list(rootUri: string): Promise<CapabilityState[]> {
        const rootFsPath = this.rootPath(rootUri);
        const states: CapabilityState[] = [];
        for (const definition of this.definitions) {
            states.push(await this.detectOne(definition, rootFsPath));
        }
        return states;
    }

    async detect(rootUri: string, id: string): Promise<CapabilityState> {
        const rootFsPath = this.rootPath(rootUri);
        return this.detectOne(this.require(id), rootFsPath);
    }

    async install(rootUri: string, id: string): Promise<CapabilityState> {
        const rootFsPath = this.rootPath(rootUri);
        const definition = this.require(id);
        if (!definition.install) {
            throw new Error(`a capability '${id}' não declara ação de instalação`);
        }
        // Precondition check from EVIDENCE, right now — not from a cached flag.
        const before = await this.detectOne(definition, rootFsPath);
        if (!before.installable) {
            throw new Error(
                `a capability '${id}' não pode ser instalada aqui: ${before.detail}`
            );
        }
        await definition.install({ rootFsPath, engine: this.engine });
        // Re-detect: the post-action state is whatever the evidence now says.
        return this.detectOne(definition, rootFsPath);
    }

    // ── internals ──────────────────────────────────────────────────────────

    protected async detectOne(
        definition: CapabilityDefinition,
        rootFsPath: string
    ): Promise<CapabilityState> {
        const detectedAt = new Date().toISOString();
        const stamp = `${detectedAt}#${++this.detectionSeq}`;
        const resolver = (token: string) => this.surfaceUrl(definition.id, token, rootFsPath, stamp);
        try {
            const detected = await definition.detect({ rootFsPath, engine: this.engine });
            return composeState(definition, detected, resolver, detectedAt);
        } catch (err) {
            // A detector that throws yields `unknown` — never a healthy state.
            return composeState(
                definition,
                {
                    status: 'unknown',
                    detail:
                        'A detecção falhou: ' +
                        (err instanceof Error ? err.message : String(err)),
                    installable: false
                },
                resolver,
                detectedAt
            );
        }
    }

    /**
     * Same-origin URL for a capability artifact, carrying the project root and
     * the detection timestamp. The timestamp is what makes a freshly generated
     * artifact render without a manual reload: the URL changes, so the iframe
     * cannot serve a cached document.
     */
    protected surfaceUrl(id: string, token: string, rootFsPath: string, stamp: string): string {
        const file = token === 'graph' ? 'graph.html' : token;
        const query =
            `root=${encodeURIComponent(rootFsPath)}` +
            `&t=${encodeURIComponent(stamp)}`;
        return `${CAPABILITY_SITE_PREFIX}/${id}/site/${file}?${query}`;
    }

    protected require(id: string): CapabilityDefinition {
        const definition = this.definitions.find(d => d.id === id);
        if (!definition) {
            throw new Error(`capability desconhecida: ${id}`);
        }
        return definition;
    }

    /** Accept a `file://` URI or a plain path; remember it as a known root. */
    protected rootPath(rootUri: string): string {
        if (!rootUri) {
            throw new Error('nenhum projeto aberto: a detecção de capabilities precisa de uma raiz');
        }
        const raw = rootUri.includes('://') ? FileUri.fsPath(new URI(rootUri)) : rootUri;
        const resolved = path.resolve(raw);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            throw new Error(`raiz de projeto inexistente: ${resolved}`);
        }
        this.knownRoots.add(resolved);
        return resolved;
    }
}
