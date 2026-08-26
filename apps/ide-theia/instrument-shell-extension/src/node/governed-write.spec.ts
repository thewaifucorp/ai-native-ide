// Tests for the governed-write adapter, focused on one invariant: a propose must
// never leave a write applied.
//
// The bug these pin down was real and reproducible against the sidecar. The
// broker's approval gate persists in `.instrument/effects.sqlite3` and matches a
// grant by (owner, effect id, path, content). Effect ids used to be `w1, w2, …`
// from a counter that restarted at 1 every backend boot, so an approval left
// unconsumed in one session matched the NEXT session's first proposal and the
// broker executed it on the first propose — nobody deciding. Two guarantees are
// tested here: ids are process-unique (a stale grant cannot match), and if a
// queueing propose ever comes back executed anyway, the adapter reverts it and
// reports instead of calling it `awaiting`.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { GovernedWriteServiceImpl } from './governed-write-service';
import { EngineService, Hunk } from 'engine-extension';

type ProposeResult = { awaiting_approval?: boolean; written?: boolean; path?: string };

/** Scriptable EngineService stand-in; records the call order. */
class FakeEngine implements Partial<EngineService> {
    readonly calls: string[] = [];
    /** Queue of answers `brokerPropose` returns, in order. */
    proposeAnswers: ProposeResult[] = [];

    async diff(original: string, proposed: string): Promise<Hunk[]> {
        this.calls.push('diff');
        void original;
        return [{
            id: 0,
            oldStart: 1,
            newStart: 1,
            lines: [{ tag: 'added', text: proposed.split('\n')[0] ?? '' }]
        }];
    }

    async brokerPropose(
        _root: string,
        _owner: string,
        effectId: string
    ): Promise<ProposeResult> {
        this.calls.push(`propose:${effectId}`);
        return this.proposeAnswers.shift() ?? { awaiting_approval: true };
    }

    /** Flip to simulate a broker that lost its snapshot (e.g. after a restart). */
    rollbackFails = false;

    async brokerRollback(
        _root: string,
        _owner: string,
        effectId: string
    ): Promise<{ rolledback: boolean }> {
        this.calls.push(`rollback:${effectId}`);
        if (this.rollbackFails) {
            throw new Error(`no snapshot exists for ${effectId}`);
        }
        return { rolledback: true };
    }

    async brokerApprove(): Promise<{ approved_id: number }> {
        this.calls.push('approve');
        return { approved_id: 1 };
    }
}

interface Fixture {
    service: GovernedWriteServiceImpl;
    engine: FakeEngine;
    rootUri: string;
    file: string;
}

function fixture(): Fixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'governed-'));
    const file = path.join(root, 'alvo.md');
    fs.writeFileSync(file, 'antes\n', 'utf8');
    const service = new GovernedWriteServiceImpl();
    const engine = new FakeEngine();
    (service as unknown as { engine: unknown }).engine = engine;
    return { service, engine, rootUri: FileUri.create(root).toString(), file };
}

describe('GovernedWriteServiceImpl — propose never leaves a write applied', () => {

    it('queues normally when the broker has no outstanding grant', async () => {
        const { service, engine, rootUri } = fixture();
        engine.proposeAnswers = [{ awaiting_approval: true }];
        const proposal = await service.proposeWrite(rootUri, 'alvo.md', 'antes\ndepois\n');
        assert.strictEqual(proposal.state, 'awaiting');
        assert.strictEqual(proposal.warning, undefined);
        assert.strictEqual(engine.calls.length, 2);
        assert.strictEqual(engine.calls[0], 'diff');
        assert.match(engine.calls[1], /^propose:w[a-z0-9]+-1$/);
    });

    it('never reuses an effect id across processes (the actual root cause)', async () => {
        const { service, engine, rootUri } = fixture();
        engine.proposeAnswers = [{ awaiting_approval: true }, { awaiting_approval: true }];
        const first = await service.proposeWrite(rootUri, 'alvo.md', 'a\n');
        const second = await service.proposeWrite(rootUri, 'alvo.md', 'b\n');
        assert.notStrictEqual(first.id, second.id);
        // The id carries a per-process prefix, so `w1` from an earlier session can
        // never be produced again — a stale grant has nothing to match.
        assert.ok(!/^w\d+$/.test(first.id), `id previsível: ${first.id}`);
    });

    it('reverts, re-proposes and WARNS when a queueing propose came back executed', async () => {
        const { service, engine, rootUri } = fixture();
        engine.proposeAnswers = [
            { written: true, path: '/tmp/alvo.md' },
            { awaiting_approval: true }
        ];
        const proposal = await service.proposeWrite(rootUri, 'alvo.md', 'antes\ndepois\n');
        assert.strictEqual(proposal.state, 'awaiting', 'o usuário ainda precisa decidir');
        assert.match(proposal.warning ?? '', /autorização pendente de uma sessão anterior/);
        // Reverted through the broker's own snapshot, then re-proposed under a
        // fresh id — never reported as awaiting without undoing the write.
        const kinds = engine.calls.map(c => c.split(':')[0]);
        assert.deepStrictEqual(kinds, ['diff', 'propose', 'rollback', 'propose']);
        assert.notStrictEqual(proposal.id, engine.calls[1].split(':')[1]);
    });

    it('reports an APPROVED proposal when the write stands and rollback failed', async () => {
        const { service, engine, rootUri, file } = fixture();
        engine.proposeAnswers = [{ written: true, path: file }];
        engine.rollbackFails = true;
        // The broker executed it and cannot undo it: the bytes really are on disk.
        fs.writeFileSync(file, 'antes\ndepois\n', 'utf8');
        const proposal = await service.proposeWrite(rootUri, 'alvo.md', 'antes\ndepois\n');
        assert.strictEqual(proposal.state, 'approved', 'não pode dizer que aguarda decisão');
        assert.match(proposal.warning ?? '', /rollback do broker falhou/);
    });

    it('fails loudly if the broker still refuses to queue after recovery', async () => {
        const { service, engine, rootUri } = fixture();
        engine.proposeAnswers = [
            { written: true, path: '/tmp/alvo.md' },
            { written: true, path: '/tmp/alvo.md' }
        ];
        await assert.rejects(
            () => service.proposeWrite(rootUri, 'alvo.md', 'x'),
            /did not queue effect/
        );
    });

    it('refuses a path that escapes the workspace root', async () => {
        const { service, rootUri } = fixture();
        await assert.rejects(
            () => service.proposeWrite(rootUri, '../fora.md', 'x'),
            /escapes the workspace root/
        );
    });

    it('refuses a target that is not an existing file', async () => {
        const { service, rootUri } = fixture();
        await assert.rejects(
            () => service.proposeWrite(rootUri, 'nao-existe.md', 'x'),
            /no such workspace file/
        );
    });
});
