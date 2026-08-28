// Tests for the capability chassis. They pin the honesty rules, because those
// are the requirement — not the specific capabilities.
//
// The last block is a REAL integration test of the Grafo definition: on a temp
// project with no index it must report `not-installed`, and after the real
// install action (`aag bigbang --no-install`) it must report `ready` with an
// embeddable surface. It skips itself when `aag` is not on PATH, so CI without
// the tool stays honest instead of green-by-omission.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CapabilityRegistryService } from './capability-registry-service';
import { CapabilityDefinition, GRAPH_ARTIFACT, run } from './capability-definitions';
import { CAPABILITY_DEFINITIONS } from './capability-definitions';

/** Minimal EngineService stand-in — the fake definitions never call it. */
const fakeEngine = {} as never;

function tempRoot(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function registry(definitions: CapabilityDefinition[]): CapabilityRegistryService {
    const service = new CapabilityRegistryService();
    (service as unknown as { engine: unknown }).engine = fakeEngine;
    service.setDefinitions(definitions);
    return service;
}

describe('CAPABILITY_DEFINITIONS — ids que a UI procura', () => {

    /// §14 — a cadeia do Produto oferece "ver no grafo" procurando a capability
    /// por id. Eu procurei por `aag-local`, que é o id do PROVIDER, e o find
    /// devolvia undefined sempre: a cadeia dizia "grafo não detectado" com o
    /// grafo pronto. Degradação falsa é tão ruim como esconder a degradação, e um
    /// id errado não quebra compilação — então quebra aqui.
    it('grafo é o id da capability, e aag-local o do provider dentro dela', () => {
        const grafo = CAPABILITY_DEFINITIONS.find(definition => definition.id === 'grafo');
        assert.ok(grafo, 'a UI procura a capability do grafo pelo id `grafo`');
        assert.ok(
            grafo!.providers.some(provider => provider.id === 'aag-local'),
            '`aag-local` é provider desta capability, nunca o id dela'
        );
        assert.ok(
            !CAPABILITY_DEFINITIONS.some(definition => definition.id === 'aag-local'),
            'se um dia `aag-local` virar capability, a busca da cadeia precisa ser revista'
        );
    });
});

describe('CapabilityRegistryService — honesty rules', () => {

    it('reports `unknown` (never ready) when a detector throws', async () => {
        const root = tempRoot('cap-throw-');
        const service = registry([{
            id: 'x', label: 'X', summary: 's', providers: [],
            detect: async () => { throw new Error('sonda quebrou'); }
        }]);
        const [state] = await service.list(root);
        assert.strictEqual(state.status, 'unknown');
        assert.match(state.detail, /sonda quebrou/);
        assert.strictEqual(state.installable, false);
        assert.strictEqual(state.surface.kind, 'none');
    });

    it('never reports `installable` for a definition without an install action', async () => {
        const root = tempRoot('cap-noinstall-');
        const service = registry([{
            id: 'x', label: 'X', summary: 's', providers: [], installLabel: 'Gerar',
            // The detector claims installable; the chassis overrides it because
            // there is no action to run.
            detect: async () => ({ status: 'not-installed', detail: 'd', installable: true })
        }]);
        const [state] = await service.list(root);
        assert.strictEqual(state.installable, false);
        assert.strictEqual(state.installLabel, undefined);
        await assert.rejects(() => service.install(root, 'x'), /não declara ação de instalação/);
    });

    it('refuses to install when fresh detection says the preconditions fail', async () => {
        const root = tempRoot('cap-precond-');
        let installs = 0;
        const service = registry([{
            id: 'x', label: 'X', summary: 's', providers: [], installLabel: 'Gerar',
            detect: async () => ({ status: 'tool-missing', detail: 'binário ausente', installable: false }),
            install: async () => { installs++; }
        }]);
        await assert.rejects(() => service.install(root, 'x'), /não pode ser instalada aqui/);
        assert.strictEqual(installs, 0, 'a ação não deve rodar sem precondição');
    });

    it('re-detects AFTER installing, so a failed action cannot leave a ready state', async () => {
        const root = tempRoot('cap-failed-');
        const service = registry([{
            id: 'x', label: 'X', summary: 's', providers: [], installLabel: 'Gerar',
            detect: async () => ({ status: 'not-installed', detail: 'ainda não', installable: true }),
            install: async () => { throw new Error('indexador falhou'); }
        }]);
        await assert.rejects(() => service.install(root, 'x'), /indexador falhou/);
        const [state] = await service.list(root);
        assert.strictEqual(state.status, 'not-installed');
    });

    it('flips to the post-action state and hands back a FRESH surface URL', async () => {
        const root = tempRoot('cap-flip-');
        let generated = false;
        const service = registry([{
            id: 'x', label: 'X', summary: 's', providers: [], installLabel: 'Gerar',
            detect: async () => generated
                ? { status: 'ready', detail: 'pronto', installable: true, surfaceUrl: 'graph' }
                : { status: 'not-installed', detail: 'ainda não', installable: true },
            install: async () => { generated = true; }
        }]);
        const before = await service.detect(root, 'x');
        assert.strictEqual(before.status, 'not-installed');
        assert.strictEqual(before.surface.kind, 'none');

        const after = await service.install(root, 'x');
        assert.strictEqual(after.status, 'ready');
        assert.strictEqual(after.surface.kind, 'iframe');
        assert.ok(after.surface.url, 'estado ready precisa de URL de superfície');
        assert.match(after.surface.url!, /root=/);
        // The stamp is what makes the iframe remount without a manual reload.
        const again = await service.detect(root, 'x');
        assert.notStrictEqual(again.surface.url, after.surface.url);
    });

    it('merges declared providers with per-detection availability', async () => {
        const root = tempRoot('cap-prov-');
        const service = registry([{
            id: 'x', label: 'X', summary: 's',
            providers: [
                { id: 'local', label: 'local', kind: 'local' },
                { id: 'katsui', label: 'Katsui', kind: 'katsui', detail: 'falta credencial' }
            ],
            detect: async () => ({
                status: 'ready', detail: 'ok',
                providerAvailability: { local: { available: true, active: true } }
            })
        }]);
        const [state] = await service.list(root);
        const local = state.providers.find(p => p.id === 'local')!;
        const katsui = state.providers.find(p => p.id === 'katsui')!;
        assert.strictEqual(local.available, true);
        assert.strictEqual(local.active, true);
        // Declared but not reported by detection → unavailable, with its reason.
        assert.strictEqual(katsui.available, false);
        assert.strictEqual(katsui.active, false);
        assert.strictEqual(katsui.detail, 'falta credencial');
    });

    it('only allow-lists roots it has actually detected for', async () => {
        const root = tempRoot('cap-root-');
        const other = tempRoot('cap-other-');
        const service = registry([{
            id: 'x', label: 'X', summary: 's', providers: [],
            detect: async () => ({ status: 'ready', detail: 'ok' })
        }]);
        assert.strictEqual(service.isKnownRoot(root), false);
        await service.list(root);
        assert.strictEqual(service.isKnownRoot(root), true);
        assert.strictEqual(service.isKnownRoot(other), false);
    });

    it('rejects an unknown capability id and a missing project root', async () => {
        const root = tempRoot('cap-bad-');
        const service = registry([]);
        await assert.rejects(() => service.detect(root, 'nope'), /capability desconhecida/);
        await assert.rejects(() => service.list(''), /nenhum projeto aberto/);
        await assert.rejects(
            () => service.list(path.join(root, 'nao-existe')),
            /raiz de projeto inexistente/
        );
    });
});

describe('Grafo capability — real aag index generation', () => {

    /** The definition under test comes from the real hosted set. */
    const grafo = CAPABILITY_DEFINITIONS.find(d => d.id === 'grafo')!;

    let aagAvailable = false;
    before(async () => {
        const probe = await run('aag', ['--version'], os.tmpdir(), 15_000);
        aagAvailable = probe.code === 0 || probe.stdout.trim().length > 0;
    });

    it('goes ausente → gerar → pronto on a real project', async function (): Promise<void> {
        if (!aagAvailable) {
            // Honest skip: without the tool there is nothing real to prove.
            this.skip();
        }
        this.timeout(300_000);
        const root = tempRoot('cap-grafo-');
        fs.writeFileSync(path.join(root, 'a.ts'), 'export const one = 1;\n', 'utf8');

        const service = new CapabilityRegistryService();
        (service as unknown as { engine: unknown }).engine = fakeEngine;

        const before = await service.detect(root, 'grafo');
        assert.strictEqual(before.status, 'not-installed', before.detail);
        assert.strictEqual(before.installable, true);
        assert.strictEqual(before.installLabel, 'Gerar AAG');
        assert.strictEqual(before.surface.kind, 'none');
        assert.strictEqual(fs.existsSync(path.join(root, GRAPH_ARTIFACT)), false);

        const after = await service.install(root, 'grafo');
        assert.strictEqual(after.status, 'ready', after.detail);
        assert.strictEqual(after.surface.kind, 'iframe');
        assert.ok(fs.statSync(path.join(root, GRAPH_ARTIFACT)).size > 0);
        // The declared limit is stated, not hidden.
        assert.ok(after.degradations.length > 0);
        assert.ok(grafo.install, 'a definição do grafo precisa de ação real');
    });
});
