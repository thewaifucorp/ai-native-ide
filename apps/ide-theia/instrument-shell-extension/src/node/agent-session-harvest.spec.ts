// Tests for the COLHEITA, which is the only governed way an agent's change
// reaches the project — and therefore the place where being wrong is expensive.
//
// The bug these exist for: the comparison used to be two-sided (worktree bytes
// against project bytes), so it could not tell the agent's work from the
// person's, and it walked only the worktree, so a deletion was invisible. The
// invariants below are the ones that make a "Permitir" button honest:
//
//  • what the agent changed is proposed through the broker;
//  • what the PERSON changed after the baseline is not — proposing it would offer
//    to revert their own work;
//  • both changed = conflict: reported, never proposed;
//  • a file the agent deleted is REPORTED even though the broker has no delete
//    effect, instead of vanishing from the list;
//  • what was not compared (binary, too large) is named with its reason;
//  • no baseline = refuse to harvest, rather than guess.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { AgentSessionServiceImpl } from './agent-session-service';

const WORKTREE = path.join('.instrument', 'agent-worktree');
const BASELINE = path.join('.instrument', 'agent-worktree.baseline.json');

class FakeEngine {
    async agentStartSession(): Promise<{ session_id: string }> {
        return { session_id: 'sess-1' };
    }
    async agentNextEvent(): Promise<{ event: unknown | null }> {
        return { event: null };
    }
    async agentCancel(): Promise<{ cancelled: boolean }> {
        return { cancelled: true };
    }
}

/** Broker double: records what was proposed. It never writes anything. */
class FakeGoverned {
    readonly proposed: { relPath: string; content: string }[] = [];
    async proposeWrite(_rootUri: string, relPath: string, newContent: string): Promise<{ id: string }> {
        this.proposed.push({ relPath, content: newContent });
        return { id: `p${this.proposed.length}` };
    }
}

interface Fixture {
    service: AgentSessionServiceImpl;
    governed: FakeGoverned;
    root: string;
    rootUri: string;
    worktree: string;
}

/** A project (plain directory, so the isolated-copy path runs), a session opened
 *  through the real `start`, and therefore a real baseline on disk. */
async function fixture(files: Record<string, string> = { 'a.txt': 'um\n' }): Promise<Fixture> {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-harvest-')));
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content, 'utf8');
    }
    const service = new AgentSessionServiceImpl();
    const governed = new FakeGoverned();
    (service as unknown as { engine: FakeEngine }).engine = new FakeEngine();
    (service as unknown as { governed: FakeGoverned }).governed = governed;

    const rootUri = FileUri.create(root).toString();
    await service.start(rootUri, 'claude');
    return { service, governed, root, rootUri, worktree: path.join(root, WORKTREE) };
}

/** What the agent does: write inside the worktree, never in the project. */
function agentWrites(f: Fixture, rel: string, content: string): void {
    const abs = path.join(f.worktree, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
}

describe('AgentSessionServiceImpl — colheita separa o ato do agente do ato da pessoa', () => {
    it('abrir a sessão registra a baseline em disco', async () => {
        const f = await fixture();

        const stored = JSON.parse(fs.readFileSync(path.join(f.root, BASELINE), 'utf8'));
        assert.ok(stored.hashes['a.txt'], 'a baseline precisa saber de que bytes a worktree nasceu');
        const snapshot = await f.service.snapshot(f.rootUri);
        assert.strictEqual(snapshot.baseline?.reused, false);
        assert.strictEqual(snapshot.baseline?.files, 1);
    });

    it('mudança do agente é proposta pelo broker, com os bytes dele', async () => {
        const f = await fixture();
        agentWrites(f, 'a.txt', 'um\ndois\n');

        const snapshot = await f.service.harvest(f.rootUri);

        assert.deepStrictEqual(f.governed.proposed, [{ relPath: 'a.txt', content: 'um\ndois\n' }]);
        assert.strictEqual(snapshot.changes.length, 1);
        assert.strictEqual(snapshot.changes[0].kind, 'modify');
        assert.strictEqual(snapshot.changes[0].proposed, true);
    });

    it('arquivo novo do agente é `create`, não `modify`', async () => {
        const f = await fixture();
        agentWrites(f, 'novo.txt', 'oi\n');

        const snapshot = await f.service.harvest(f.rootUri);

        assert.strictEqual(snapshot.changes[0].kind, 'create');
        assert.strictEqual(snapshot.changes[0].proposed, true);
    });

    // O defeito que motivou a baseline: sem ela, isto virava "mudança do agente"
    // e aprovar reverteria o trabalho da pessoa.
    it('mudança da PESSOA no projeto não é proposta como se fosse do agente', async () => {
        const f = await fixture();
        fs.writeFileSync(path.join(f.root, 'a.txt'), 'um\neditado por mim\n', 'utf8');

        const snapshot = await f.service.harvest(f.rootUri);

        assert.deepStrictEqual(f.governed.proposed, [], 'o broker não pode receber uma reversão disfarçada');
        assert.strictEqual(snapshot.changes.length, 0);
    });

    it('os dois mudaram o mesmo arquivo: conflito reportado, nada proposto', async () => {
        const f = await fixture();
        agentWrites(f, 'a.txt', 'um\ndo agente\n');
        fs.writeFileSync(path.join(f.root, 'a.txt'), 'um\nmeu\n', 'utf8');

        const snapshot = await f.service.harvest(f.rootUri);

        assert.deepStrictEqual(f.governed.proposed, []);
        assert.strictEqual(snapshot.changes.length, 1);
        assert.strictEqual(snapshot.changes[0].conflict, true);
        assert.ok(snapshot.changes[0].detail?.includes('sobrescreveria'));
    });

    it('exclusão pelo agente APARECE, e diz que não passa pelo broker', async () => {
        const f = await fixture();
        fs.rmSync(path.join(f.worktree, 'a.txt'));

        const snapshot = await f.service.harvest(f.rootUri);

        assert.strictEqual(snapshot.changes.length, 1, 'apagar é escrever: não pode desaparecer da lista');
        assert.strictEqual(snapshot.changes[0].kind, 'delete');
        assert.strictEqual(snapshot.changes[0].proposed, false);
        assert.ok(snapshot.changes[0].detail?.includes('exclusão'));
        assert.deepStrictEqual(f.governed.proposed, []);
    });

    it('exclusão de arquivo que o projeto já não tem não vira decisão', async () => {
        const f = await fixture();
        fs.rmSync(path.join(f.worktree, 'a.txt'));
        fs.rmSync(path.join(f.root, 'a.txt'));

        const snapshot = await f.service.harvest(f.rootUri);

        assert.strictEqual(snapshot.changes.length, 0);
    });

    it('binário não é comparado, e o motivo aparece em vez de silêncio', async () => {
        const f = await fixture();
        fs.writeFileSync(path.join(f.worktree, 'bin.dat'), Buffer.from([1, 0, 2, 0, 3]));

        const snapshot = await f.service.harvest(f.rootUri);

        assert.deepStrictEqual(f.governed.proposed, []);
        const skipped = snapshot.skipped.find(s => s.relPath === 'bin.dat');
        assert.ok(skipped, 'o usuário precisa saber que este arquivo não foi olhado');
        assert.ok(skipped.reason.includes('binário'));
    });

    it('arquivo grande demais entra em `skipped` com o tamanho, não é proposto', async () => {
        const f = await fixture();
        agentWrites(f, 'grande.txt', 'x'.repeat(600 * 1024));

        const snapshot = await f.service.harvest(f.rootUri);

        assert.deepStrictEqual(f.governed.proposed, []);
        const skipped = snapshot.skipped.find(s => s.relPath === 'grande.txt');
        assert.ok(skipped?.reason.includes('grande demais'));
    });

    it('uma decisão por vez: a segunda mudança fica na fila, não é proposta', async () => {
        const f = await fixture({ 'a.txt': 'um\n', 'b.txt': 'dois\n' });
        agentWrites(f, 'a.txt', 'um\nmais\n');
        agentWrites(f, 'b.txt', 'dois\nmais\n');

        const snapshot = await f.service.harvest(f.rootUri);

        assert.strictEqual(f.governed.proposed.length, 1);
        const queued = snapshot.changes.find(c => !c.proposed);
        assert.strictEqual(queued?.detail, 'aguardando a decisão anterior');
    });

    it('sem baseline a colheita RECUSA, em vez de comparar dois lados e chutar', async () => {
        const f = await fixture();
        agentWrites(f, 'a.txt', 'um\ndois\n');
        fs.rmSync(path.join(f.root, BASELINE));

        const snapshot = await f.service.harvest(f.rootUri);

        assert.deepStrictEqual(f.governed.proposed, []);
        assert.ok(snapshot.lastError?.includes('sem baseline'));
    });

    it('worktree preexistente sem baseline é reusada com a perda declarada', async () => {
        const f = await fixture();
        fs.rmSync(path.join(f.root, BASELINE));

        const snapshot = await f.service.start(f.rootUri, 'claude');

        assert.strictEqual(snapshot.baseline?.recovered, true);
        assert.strictEqual(snapshot.baseline?.reused, true);
        const note = snapshot.events.find(e => e.text.includes('não é distinguível'));
        assert.ok(note, 'reusar sem baseline tem custo, e o custo tem de estar na tela');
    });

    it('descartar apaga worktree e baseline, e conta o que se perdeu', async () => {
        const f = await fixture();
        agentWrites(f, 'a.txt', 'um\ndois\n');
        fs.rmSync(path.join(f.root, BASELINE));   // força mudança não colhida
        await f.service.harvest(f.rootUri);

        const snapshot = await f.service.discard(f.rootUri);

        assert.strictEqual(fs.existsSync(f.worktree), false);
        assert.strictEqual(fs.existsSync(path.join(f.root, BASELINE)), false);
        assert.strictEqual(snapshot.worktree, undefined);
        assert.strictEqual(snapshot.baseline, undefined);
        assert.deepStrictEqual(snapshot.changes, []);
    });

    it('worktree deixada por outra execução do IDE aparece antes de qualquer sessão', async () => {
        const f = await fixture();
        const fresh = new AgentSessionServiceImpl();
        (fresh as unknown as { engine: FakeEngine }).engine = new FakeEngine();

        const snapshot = await fresh.snapshot(f.rootUri);

        assert.ok(snapshot.worktree, 'o painel não pode parecer limpo em cima de sobra');
        assert.strictEqual(snapshot.baseline?.reused, true);
    });
});
