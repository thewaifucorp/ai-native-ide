// Tests for the external-write observer (WORK-05).
//
// The behaviour under test is the one that matters for agent-driven work: a write
// the IDE did not perform — the person's agent using its own file tools — must
// become visible, diffed, and reconcilable, and undoing it must go through the
// governed broker instead of the observer editing the file itself.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { ObserverServiceImpl } from './observer-service';
import { GovernedWriteService, WriteProposal } from '../common/governed-protocol';
import { BrokerActivity, EngineService, Hunk } from 'engine-extension';

/** Real-enough diff: one hunk with the added/removed lines counted honestly. */
class FakeEngine implements Partial<EngineService> {
    async diff(original: string, proposed: string): Promise<Hunk[]> {
        const before = original.split('\n');
        const after = proposed.split('\n');
        const lines = [
            ...before.filter(l => !after.includes(l)).map(text => ({ tag: 'removed' as const, text })),
            ...after.filter(l => !before.includes(l)).map(text => ({ tag: 'added' as const, text }))
        ];
        return [{ id: 0, oldStart: 1, newStart: 1, lines }];
    }
}

class FakeGoverned implements GovernedWriteService {
    readonly proposals: { relPath: string; content: string }[] = [];
    async proposeWrite(_rootUri: string, relPath: string, newContent: string): Promise<WriteProposal> {
        this.proposals.push({ relPath, content: newContent });
        return {
            id: `p${this.proposals.length}`,
            relPath,
            addedLines: 1,
            removedLines: 1,
            hunkCount: 1,
            state: 'awaiting',
            preview: []
        };
    }
    async approve(): Promise<WriteProposal> { throw new Error('não usado'); }
    async rollback(): Promise<WriteProposal> { throw new Error('não usado'); }
    async activity(): Promise<BrokerActivity[]> { return []; }
    async pending(): Promise<WriteProposal[]> { return []; }
}

interface Fixture {
    service: ObserverServiceImpl;
    governed: FakeGoverned;
    root: string;
    rootUri: string;
}

function fixture(): Fixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'const a = 1;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'README.md'), '# projeto\n', 'utf8');
    const service = new ObserverServiceImpl();
    const governed = new FakeGoverned();
    (service as unknown as { engine: unknown }).engine = new FakeEngine();
    (service as unknown as { governed: GovernedWriteService }).governed = governed;
    return { service, governed, root, rootUri: FileUri.create(root).toString() };
}

/** Simulate the person's agent writing with its own tools. */
function agentWrites(root: string, relPath: string, content: string): void {
    const file = path.join(root, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
}

describe('ObserverServiceImpl — sees writes the IDE did not make', () => {

    it('first scan establishes the baseline instead of reporting everything as drift', async () => {
        const { service, rootUri } = fixture();
        const report = await service.scan(rootUri);
        assert.strictEqual(report.baselineExists, true);
        assert.strictEqual(report.drifts.length, 0, 'projeto intacto não é drift');
        assert.ok(report.trackedFiles >= 2);
    });

    it('detects a modification made outside the IDE, with real line counts', async () => {
        const { service, root, rootUri } = fixture();
        await service.baseline(rootUri);
        agentWrites(root, 'src/a.ts', 'const a = 1;\nconst b = 2;\n');

        const report = await service.scan(rootUri);
        const drift = report.drifts.find(d => d.relPath === path.join('src', 'a.ts'))!;
        assert.strictEqual(drift.kind, 'modified');
        assert.strictEqual(drift.addedLines, 1);
        assert.strictEqual(drift.revertible, true);
    });

    it('detects a file the agent created and says it cannot be reverted', async () => {
        const { service, root, rootUri } = fixture();
        await service.baseline(rootUri);
        agentWrites(root, 'src/novo.ts', 'export const novo = true;\n');

        const report = await service.scan(rootUri);
        const drift = report.drifts.find(d => d.relPath === path.join('src', 'novo.ts'))!;
        assert.strictEqual(drift.kind, 'created');
        assert.strictEqual(drift.revertible, false);
        assert.match(drift.detail ?? '', /não existia na referência/);
    });

    it('detects a deletion and can still restore it', async () => {
        const { service, root, rootUri } = fixture();
        await service.baseline(rootUri);
        fs.unlinkSync(path.join(root, 'README.md'));

        const report = await service.scan(rootUri);
        const drift = report.drifts.find(d => d.relPath === 'README.md')!;
        assert.strictEqual(drift.kind, 'deleted');
        assert.strictEqual(drift.revertible, true);
    });

    it('never touches project files while observing', async () => {
        const { service, root, rootUri } = fixture();
        await service.baseline(rootUri);
        agentWrites(root, 'src/a.ts', 'mudou\n');
        await service.scan(rootUri);
        assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8'), 'mudou\n');
    });

    it('ignores build output and dependency directories', async () => {
        const { service, root, rootUri } = fixture();
        await service.baseline(rootUri);
        agentWrites(root, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
        agentWrites(root, 'target/debug/bin', 'bin\n');
        const report = await service.scan(rootUri);
        assert.deepStrictEqual(report.drifts, []);
    });

    it('reports a binary file as tracked-but-not-restorable instead of hiding it', async () => {
        const { service, root, rootUri } = fixture();
        fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([1, 0, 2, 0, 3]));
        const first = await service.baseline(rootUri);
        assert.ok(first.skipped.some(s => s.relPath === 'blob.bin' && /binário/.test(s.reason)));

        fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([9, 0, 9]));
        const report = await service.scan(rootUri);
        const drift = report.drifts.find(d => d.relPath === 'blob.bin')!;
        assert.strictEqual(drift.revertible, false);
        assert.match(drift.detail ?? '', /não foram guardados/);
    });
});

describe('ObserverServiceImpl — reconciliation goes through governance', () => {

    it('accept adopts the new bytes without writing anything', async () => {
        const { service, root, rootUri, governed } = fixture();
        await service.baseline(rootUri);
        agentWrites(root, 'src/a.ts', 'const a = 1;\nconst b = 2;\n');

        const after = await service.accept(rootUri, path.join('src', 'a.ts'));
        assert.deepStrictEqual(after.drifts, [], 'aceitar zera o drift daquele arquivo');
        assert.strictEqual(
            fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8'),
            'const a = 1;\nconst b = 2;\n',
            'aceitar não altera o arquivo'
        );
        assert.strictEqual(governed.proposals.length, 0, 'aceitar não é um efeito');
        assert.ok(after.receipts.some(r => r.action === 'accepted'));
    });

    it('revert PROPOSES the previous bytes through the broker and writes nothing', async () => {
        const { service, root, rootUri, governed } = fixture();
        await service.baseline(rootUri);
        const original = fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8');
        agentWrites(root, 'src/a.ts', 'apagou tudo\n');

        const result = await service.proposeRevert(rootUri, path.join('src', 'a.ts'));
        assert.strictEqual(result.proposalId, 'p1');
        // The restore is a governed proposal: the file still holds the agent's write
        // until a human decides.
        assert.strictEqual(governed.proposals.length, 1);
        assert.strictEqual(governed.proposals[0].content, original);
        assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8'), 'apagou tudo\n');
    });

    it('refuses to propose a revert it cannot honour', async () => {
        const { service, root, rootUri } = fixture();
        await service.baseline(rootUri);
        agentWrites(root, 'src/novo.ts', 'novo\n');
        await assert.rejects(
            () => service.proposeRevert(rootUri, path.join('src', 'novo.ts')),
            /não está na referência/
        );
    });

    it('refuses a path that escapes the project root', async () => {
        const { service, rootUri } = fixture();
        await service.baseline(rootUri);
        await assert.rejects(
            () => service.accept(rootUri, '../fora.md'),
            /escapa da raiz do projeto/
        );
    });
});
