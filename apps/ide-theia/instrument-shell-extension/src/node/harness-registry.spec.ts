// Tests for the HARNESS PROVIDER contract. Each test pins one clause of
// common/harness-protocol.ts: versioned manifest, exclusive slots, composable
// extensions, artifacts preserved across activate/suspend/migrate, and no path
// around the broker.
//
// The artifact tests matter most: a provider must be registrable by WRITING FILES
// (a manifest JSON, item markdown) and not only through this API, because that is
// what makes the contract usable by an agent instead of by a mouse.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HarnessRegistryService } from './harness-registry-service';
import { WriteSourceLedger } from './write-source-ledger';
import {
    GovernedWriteService,
    RuntimeStateNotice,
    WriteProposal
} from '../common/governed-protocol';
import { BrokerActivity } from 'engine-extension';
import {
    CONFLICT_PROVIDER,
    CONFLICT_PROVIDER_ID,
    TEST_PROVIDER_ID,
    TEST_PROVIDER_V1,
    TEST_PROVIDER_V2
} from '../common/harness-test-provider';

/** Records what the registry asked the governed service to do. */
class FakeGovernedWriteService implements GovernedWriteService {
    readonly proposals: { rootUri: string; relPath: string; content: string }[] = [];
    /** Flip to make the fake pretend it wrote immediately (must be rejected). */
    returnState: WriteProposal['state'] = 'awaiting';

    async proposeWrite(rootUri: string, relPath: string, newContent: string): Promise<WriteProposal> {
        this.proposals.push({ rootUri, relPath, content: newContent });
        return {
            id: `p${this.proposals.length}`,
            relPath,
            addedLines: 2,
            removedLines: 0,
            hunkCount: 1,
            state: this.returnState,
            preview: []
        };
    }
    async activity(): Promise<BrokerActivity[]> { return []; }

    async runtimeState(): Promise<RuntimeStateNotice> {
        return { dir: '.instrument', exists: false, gitRepo: false, ignored: true, contents: [] };
    }

    async proposeIgnoreRuntimeState(): Promise<WriteProposal> {
        throw new Error('não usado neste teste');
    }
    async pending(): Promise<WriteProposal[]> { return []; }
    async approve(): Promise<WriteProposal> { throw new Error('não usado'); }
    async rollback(): Promise<WriteProposal> { throw new Error('não usado'); }
}

interface Fixture {
    service: HarnessRegistryService;
    governed: FakeGovernedWriteService;
    root: string;
}

function fixture(prefix: string): Fixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const service = new HarnessRegistryService();
    const governed = new FakeGovernedWriteService();
    (service as unknown as { governed: GovernedWriteService }).governed = governed;
    // The registry notes its own artifact writes so the observer can subtract them.
    (service as unknown as { ledger: WriteSourceLedger }).ledger = new WriteSourceLedger();
    return { service, governed, root };
}

describe('HarnessRegistryService — versioned manifest', () => {

    it('rejects a manifest in an unknown FORMAT version', async () => {
        const { service, root } = fixture('harness-fmt-');
        await assert.rejects(
            () => service.register(root, { ...TEST_PROVIDER_V1, manifestVersion: 99 }),
            /este IDE entende a versão 1/
        );
    });

    it('rejects a claim whose slot shape is not declared', async () => {
        const { service, root } = fixture('harness-shape-');
        await assert.rejects(
            () => service.register(root, { ...TEST_PROVIDER_V1, workflow: undefined }),
            /reivindica `workflow` sem declarar/
        );
    });

    it('rejects an unknown slot', async () => {
        const { service, root } = fixture('harness-slot-');
        await assert.rejects(
            () => service.register(root, {
                ...TEST_PROVIDER_V1,
                claims: ['inventado' as never]
            }),
            /slot desconhecido/
        );
    });
});

describe('HarnessRegistryService — exclusive slots', () => {

    it('registers without taking any slot', async () => {
        const { service, root } = fixture('harness-reg-');
        const snapshot = await service.register(root, TEST_PROVIDER_V1);
        assert.strictEqual(snapshot.providers[0].status, 'registered');
        assert.deepStrictEqual(
            snapshot.bindings.map(b => b.providerId),
            [undefined, undefined, undefined]
        );
    });

    it('activation takes exactly the claimed slots', async () => {
        const { service, root } = fixture('harness-act-');
        await service.register(root, TEST_PROVIDER_V1);
        const snapshot = await service.activate(root, TEST_PROVIDER_ID);
        assert.deepStrictEqual(
            snapshot.bindings.map(b => b.providerId),
            [TEST_PROVIDER_ID, TEST_PROVIDER_ID, TEST_PROVIDER_ID]
        );
    });

    it('REFUSES a rival claim on an owned slot instead of merging', async () => {
        const { service, root } = fixture('harness-conflict-');
        await service.register(root, TEST_PROVIDER_V1);
        await service.activate(root, TEST_PROVIDER_ID);
        await service.register(root, CONFLICT_PROVIDER);
        await assert.rejects(
            () => service.activate(root, CONFLICT_PROVIDER_ID),
            /conflito de slot: 'workflow' já pertence ao provider 'harness-test'/
        );
        // The owner is untouched, and the rival stayed out.
        const snapshot = await service.snapshot(root);
        assert.strictEqual(snapshot.bindings.find(b => b.slot === 'workflow')!.providerId, TEST_PROVIDER_ID);
        assert.strictEqual(
            snapshot.providers.find(p => p.manifest.id === CONFLICT_PROVIDER_ID)!.status,
            'registered'
        );
    });

    it('lets the rival take the slot once the owner is suspended', async () => {
        const { service, root } = fixture('harness-handover-');
        await service.register(root, TEST_PROVIDER_V1);
        await service.activate(root, TEST_PROVIDER_ID);
        await service.register(root, CONFLICT_PROVIDER);
        await service.suspend(root, TEST_PROVIDER_ID);
        const snapshot = await service.activate(root, CONFLICT_PROVIDER_ID);
        assert.strictEqual(
            snapshot.bindings.find(b => b.slot === 'workflow')!.providerId,
            CONFLICT_PROVIDER_ID
        );
        // The slots the rival does NOT claim stay free — never inherited.
        assert.strictEqual(snapshot.bindings.find(b => b.slot === 'primary-status')!.providerId, undefined);
    });
});

describe('HarnessRegistryService — state survives the lifecycle', () => {

    it('suspend frees the slots and keeps every item artifact', async () => {
        const { service, root } = fixture('harness-suspend-');
        await service.register(root, TEST_PROVIDER_V1);
        await service.activate(root, TEST_PROVIDER_ID);
        await service.addItems(root, TEST_PROVIDER_ID, ['Item A', 'Item B', 'Item C']);

        const suspended = await service.suspend(root, TEST_PROVIDER_ID);
        const provider = suspended.providers.find(p => p.manifest.id === TEST_PROVIDER_ID)!;
        assert.strictEqual(provider.status, 'suspended');
        assert.deepStrictEqual(provider.items.map(i => i.title), ['Item A', 'Item B', 'Item C']);
        // The artifacts are still real files after the slots were freed.
        for (const item of provider.items) {
            assert.ok(fs.existsSync(path.join(root, item.path)), item.path);
        }
        assert.deepStrictEqual(suspended.bindings.map(b => b.providerId), [undefined, undefined, undefined]);

        const reactivated = await service.activate(root, TEST_PROVIDER_ID);
        const back = reactivated.providers.find(p => p.manifest.id === TEST_PROVIDER_ID)!;
        assert.strictEqual(back.items.length, 3, 'artefatos não podem ser perdidos');
        assert.strictEqual(reactivated.bindings.find(b => b.slot === 'workflow')!.providerId, TEST_PROVIDER_ID);
    });

    it('migrate keeps the items, moves the version and keeps the slots', async () => {
        const { service, root } = fixture('harness-migrate-');
        await service.register(root, TEST_PROVIDER_V1);
        await service.activate(root, TEST_PROVIDER_ID);
        await service.addItems(root, TEST_PROVIDER_ID, ['Um', 'Dois']);

        const migrated = await service.migrate(root, TEST_PROVIDER_ID, TEST_PROVIDER_V2);
        const provider = migrated.providers.find(p => p.manifest.id === TEST_PROVIDER_ID)!;
        assert.strictEqual(provider.manifest.version, '2.0.0');
        assert.strictEqual(provider.stateVersion, '2.0.0');
        assert.deepStrictEqual(provider.items.map(i => i.title), ['Dois', 'Um']);
        // The manifest artifact on disk is the migrated one.
        const onDisk = JSON.parse(fs.readFileSync(path.join(root, provider.manifestPath), 'utf8'));
        assert.strictEqual(onDisk.version, '2.0.0');
        assert.strictEqual(provider.status, 'active');
        assert.strictEqual(migrated.bindings.find(b => b.slot === 'workflow')!.providerId, TEST_PROVIDER_ID);
        // v2's added workflow state is what the IDE now renders.
        assert.ok(provider.manifest.workflow!.states.includes('arquivado'));
    });

    it('refuses a migration whose manifest is a different provider', async () => {
        const { service, root } = fixture('harness-badmigrate-');
        await service.register(root, TEST_PROVIDER_V1);
        await assert.rejects(
            () => service.migrate(root, TEST_PROVIDER_ID, CONFLICT_PROVIDER),
            /não corresponde ao provider/
        );
    });

    it('persists across service instances (state lives with the project)', async () => {
        const { service, root, governed } = fixture('harness-persist-');
        await service.register(root, TEST_PROVIDER_V1);
        await service.activate(root, TEST_PROVIDER_ID);
        await service.addItems(root, TEST_PROVIDER_ID, ['Único']);

        const reborn = new HarnessRegistryService();
        (reborn as unknown as { governed: GovernedWriteService }).governed = governed;
        (reborn as unknown as { ledger: WriteSourceLedger }).ledger = new WriteSourceLedger();
        const snapshot = await reborn.snapshot(root);
        const provider = snapshot.providers.find(p => p.manifest.id === TEST_PROVIDER_ID)!;
        assert.strictEqual(provider.status, 'active');
        assert.deepStrictEqual(provider.items.map(i => i.title), ['Único']);
    });
});

describe('HarnessRegistryService — providers are artifacts an agent can write', () => {

    /** Write a manifest file the way an agent would, with no API call at all. */
    function writeManifest(root: string, manifest: object, id: string): string {
        const dir = path.join(root, '.harness', 'providers');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${id}.json`);
        fs.writeFileSync(file, JSON.stringify(manifest, undefined, 2), 'utf8');
        return file;
    }

    it('discovers a provider dropped in as a file, with no register() call', async () => {
        const { service, root } = fixture('harness-file-');
        writeManifest(root, {
            id: 'gsd-like',
            label: 'Método externo',
            version: '0.3.1',
            manifestVersion: 1,
            claims: ['workflow'],
            extensions: { checks: ['ext:build'], packs: [], importers: [], views: [] },
            artifacts: { itemsDir: 'trabalho/itens', itemExtension: '.md' },
            coverage: ['workflow do método externo'],
            limitations: ['não cobre evidência'],
            workflow: { states: ['todo', 'doing', 'done'], initial: 'todo' }
        }, 'gsd-like');

        const snapshot = await service.snapshot(root);
        const provider = snapshot.providers.find(p => p.manifest.id === 'gsd-like')!;
        assert.ok(provider, 'manifesto em arquivo tem de ser descoberto');
        assert.strictEqual(provider.status, 'registered');
        assert.strictEqual(provider.manifestPath, path.join('.harness', 'providers', 'gsd-like.json'));
        // …and it can take a slot like any other provider.
        const activated = await service.activate(root, 'gsd-like');
        assert.strictEqual(activated.bindings.find(b => b.slot === 'workflow')!.providerId, 'gsd-like');
        assert.deepStrictEqual(
            activated.composedExtensions.map(e => e.name),
            ['ext:build']
        );
    });

    it('reads item artifacts an agent wrote directly into the declared directory', async () => {
        const { service, root } = fixture('harness-agentitems-');
        writeManifest(root, {
            id: 'externo',
            label: 'Externo',
            version: '1.0.0',
            manifestVersion: 1,
            claims: [],
            extensions: { checks: [], packs: [], importers: [], views: [] },
            artifacts: { itemsDir: 'trabalho', itemExtension: '.md' }
        }, 'externo');
        const dir = path.join(root, 'trabalho');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'corrigir-desempate.md'), '# Corrigir desempate\n\nescrito por um agente\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'nota.txt'), 'ignorado: extensão diferente\n', 'utf8');

        const snapshot = await service.snapshot(root);
        const provider = snapshot.providers.find(p => p.manifest.id === 'externo')!;
        assert.deepStrictEqual(provider.items.map(i => i.id), ['corrigir-desempate']);
        assert.deepStrictEqual(provider.items.map(i => i.title), ['Corrigir desempate']);
        assert.deepStrictEqual(provider.items.map(i => i.path), [path.join('trabalho', 'corrigir-desempate.md')]);
    });

    it('ignores a malformed manifest instead of failing the whole project', async () => {
        const { service, root } = fixture('harness-broken-');
        fs.mkdirSync(path.join(root, '.harness', 'providers'), { recursive: true });
        fs.writeFileSync(path.join(root, '.harness', 'providers', 'ruim.json'), '{ nao json', 'utf8');
        await service.register(root, TEST_PROVIDER_V1);
        const snapshot = await service.snapshot(root);
        assert.deepStrictEqual(snapshot.providers.map(p => p.manifest.id), [TEST_PROVIDER_ID]);
    });

    it('refuses a manifest whose artifacts escape the project root', async () => {
        const { service, root } = fixture('harness-escape-');
        await assert.rejects(
            () => service.register(root, {
                ...TEST_PROVIDER_V1,
                artifacts: { itemsDir: '../fora', itemExtension: '.md' }
            }),
            /declara artefatos fora do projeto/
        );
    });

    it('refuses a manifest with no declared artifacts', async () => {
        const { service, root } = fixture('harness-noart-');
        await assert.rejects(
            () => service.register(root, {
                ...TEST_PROVIDER_V1,
                artifacts: undefined as never
            }),
            /precisa declarar `artifacts\.itemsDir`/
        );
    });
});

describe('HarnessRegistryService — composable extensions', () => {

    it('composes only ACTIVE providers, attributed to each', async () => {
        const { service, root } = fixture('harness-ext-');
        await service.register(root, TEST_PROVIDER_V1);
        let snapshot = await service.snapshot(root);
        assert.deepStrictEqual(snapshot.composedExtensions, [], 'registrado não contribui');

        snapshot = await service.activate(root, TEST_PROVIDER_ID);
        const kinds = snapshot.composedExtensions.map(e => e.kind).sort();
        assert.deepStrictEqual(kinds, ['checks', 'importers', 'packs', 'views']);
        assert.ok(snapshot.composedExtensions.every(e => e.providerId === TEST_PROVIDER_ID));

        // v2 adds a second check — composition grows without touching slots.
        snapshot = await service.migrate(root, TEST_PROVIDER_ID, TEST_PROVIDER_V2);
        assert.strictEqual(snapshot.composedExtensions.filter(e => e.kind === 'checks').length, 2);

        snapshot = await service.suspend(root, TEST_PROVIDER_ID);
        assert.deepStrictEqual(snapshot.composedExtensions, [], 'suspenso não contribui');
    });
});

describe('HarnessRegistryService — no bypass of the broker', () => {

    it('routes a provider effect through the governed service and stops at awaiting', async () => {
        const { service, governed, root } = fixture('harness-effect-');
        fs.writeFileSync(path.join(root, 'alvo.md'), 'antes\n', 'utf8');
        await service.register(root, TEST_PROVIDER_V1);
        await service.activate(root, TEST_PROVIDER_ID);

        const result = await service.providerEffect(root, TEST_PROVIDER_ID, 'alvo.md', 'antes\ndepois\n');
        assert.strictEqual(result.proposal.state, 'awaiting');
        assert.strictEqual(result.proposal.relPath, 'alvo.md');
        assert.strictEqual(governed.proposals.length, 1, 'o efeito precisa passar pelo broker');
        assert.strictEqual(governed.proposals[0].relPath, 'alvo.md');
        // The registry itself wrote nothing to the target file.
        assert.strictEqual(fs.readFileSync(path.join(root, 'alvo.md'), 'utf8'), 'antes\n');
        // And it left a receipt.
        const snapshot = await service.snapshot(root);
        assert.ok(snapshot.receipts.some(r => r.action === 'effect-proposed'));
    });

    it('rejects a broker answer that skipped the approval gate', async () => {
        const { service, governed, root } = fixture('harness-nogate-');
        await service.register(root, TEST_PROVIDER_V1);
        await service.activate(root, TEST_PROVIDER_ID);
        governed.returnState = 'approved';
        await assert.rejects(
            () => service.providerEffect(root, TEST_PROVIDER_ID, 'alvo.md', 'x'),
            /precisa aguardar aprovação/
        );
    });

    it('refuses effects from a provider that is not active', async () => {
        const { service, governed, root } = fixture('harness-inactive-');
        await service.register(root, TEST_PROVIDER_V1);
        await assert.rejects(
            () => service.providerEffect(root, TEST_PROVIDER_ID, 'alvo.md', 'x'),
            /não está ativo/
        );
        assert.strictEqual(governed.proposals.length, 0);
    });

    it('refuses to act on an unregistered provider', async () => {
        const { service, root } = fixture('harness-unknown-');
        await assert.rejects(() => service.activate(root, 'inexistente'), /não registrado/);
    });
});
