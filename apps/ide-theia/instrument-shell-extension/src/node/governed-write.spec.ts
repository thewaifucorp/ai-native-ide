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
import { WriteSourceLedger } from './write-source-ledger';
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
        if (this.proposeAnswers.length > 0) {
            return this.proposeAnswers.shift()!;
        }
        // Model the real broker: a grant is held FOR A SPECIFIC EFFECT, so only
        // that effect's next identical propose executes. Any other pending
        // effect stays queued no matter how many grants exist.
        if (this.grants.delete(effectId)) {
            return { written: true, path: 'x' };
        }
        return { awaiting_approval: true };
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

    /** Outstanding approvals, keyed by effect id, as the gate would hold them. */
    grants = new Set<string>();

    async brokerApprove(
        _root: string,
        _owner: string,
        effectId: string
    ): Promise<{ approved_id: number }> {
        this.calls.push(`approve:${effectId}`);
        this.grants.add(effectId);
        return { approved_id: 1 };
    }
}

interface Fixture {
    service: GovernedWriteServiceImpl;
    engine: FakeEngine;
    rootUri: string;
    root: string;
    file: string;
}

function fixture(): Fixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'governed-'));
    const file = path.join(root, 'alvo.md');
    fs.writeFileSync(file, 'antes\n', 'utf8');
    const service = new GovernedWriteServiceImpl();
    const engine = new FakeEngine();
    (service as unknown as { engine: unknown }).engine = engine;
    (service as unknown as { ledger: WriteSourceLedger }).ledger = new WriteSourceLedger();
    return { service, engine, rootUri: FileUri.create(root).toString(), root, file };
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
        const { service, rootUri } = fixture();
        const first = await service.proposeWrite(rootUri, 'alvo.md', 'a\n');
        await service.approve(first.id);     // one decision at a time, per project
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

    // Both of these replace guards this adapter used to carry. The broker's
    // approval was positional (oldest pending first), so the adapter refused to
    // stack proposals and drained stale grants until the decided effect ran.
    // `broker_approve` now takes an effect id, so the guards are gone and what
    // is pinned here is the property they were faking.

    it('propostas podem coexistir: aprovar uma não autoriza a outra', async () => {
        const { service, engine, rootUri } = fixture();
        const first = await service.proposeWrite(rootUri, 'alvo.md', 'a\n');
        const second = await service.proposeWrite(rootUri, 'alvo.md', 'b\n');
        assert.strictEqual(first.state, 'awaiting');
        assert.strictEqual(second.state, 'awaiting', 'empilhar deixou de ser recusado');

        const approved = await service.approve(second.id);

        assert.strictEqual(approved.id, second.id);
        assert.strictEqual(approved.state, 'approved');
        assert.deepStrictEqual(
            engine.calls.filter(c => c.startsWith('approve:')),
            [`approve:${second.id}`],
            'a autorização tem que nomear o efeito decidido, e só ele'
        );
        assert.strictEqual(
            first.state,
            'awaiting',
            'a proposta que ninguém decidiu não pode ter sido aplicada'
        );
    });

    it('aprovar não vira `approved` se o broker ainda deixou o efeito na fila', async () => {
        const { service, engine, rootUri } = fixture();
        const proposal = await service.proposeWrite(rootUri, 'alvo.md', 'a\n');
        // A grant that does not reach this effect (a broker that rejected it, a
        // queue that moved): the write did not run, so the UI must not be told
        // it did.
        engine.proposeAnswers = [{ awaiting_approval: true }];

        await assert.rejects(
            () => service.approve(proposal.id),
            /did not execute approved effect/
        );
        assert.strictEqual(proposal.state, 'awaiting');
    });

    it('refuses a path that escapes the workspace root', async () => {
        const { service, rootUri } = fixture();
        await assert.rejects(
            () => service.proposeWrite(rootUri, '../fora.md', 'x'),
            /escapes the workspace root/
        );
    });

    /** Criar arquivo é proposta como qualquer outra: pré-imagem vazia, diff todo
     *  adicionado, e a marca `creating` — porque "criar" e "reescrever apagando
     *  tudo" produzem o mesmo diff e são decisões diferentes. */
    it('propõe criação de arquivo que ainda não existe, sem escrever nada', async () => {
        const { service, root, rootUri } = fixture();

        const proposal = await service.proposeWrite(
            rootUri,
            '.product/guidance/desempate.json',
            '{"id":"desempate"}\n'
        );

        assert.strictEqual(proposal.state, 'awaiting');
        assert.strictEqual(proposal.creating, true);
        assert.strictEqual(proposal.removedLines, 0, 'não há linha anterior para remover');
        // Nem o arquivo nem a pasta aparecem: proposta recusada não deixa rastro.
        assert.strictEqual(fs.existsSync(path.join(root, '.product/guidance')), false);
    });

    it('recusa alvo que existe e não é arquivo', async () => {
        const { service, root, rootUri } = fixture();
        fs.mkdirSync(path.join(root, 'uma-pasta'));

        await assert.rejects(
            () => service.proposeWrite(rootUri, 'uma-pasta', 'x'),
            /not a workspace file/
        );
    });
});
