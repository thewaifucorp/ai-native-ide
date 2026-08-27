// Tests for the one thing the direct-ACP adapter bought: a permission request is
// a QUESTION the IDE answers, not a notice about a decision someone else took.
//
// Under the previous `acpx` adapter the wrapped client resolved
// `session/request_permission` itself, so `PermissionRequested` could only ever
// be a log line. Now the sidecar is the ACP client, the agent's turn blocks on
// the request, and the Build panel is what unblocks it. The invariants below are
// the ones that make that safe to put a button on:
//
//  • a pending request is visible in the snapshot (otherwise nothing renders);
//  • a failed answer leaves it pending — the agent is still waiting, so the card
//    must stay on screen and the UI must not claim success;
//  • answering something that is not pending is refused, never a silent no-op;
//  • a turn that ends takes its unanswered questions with it, and says so.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { AgentSessionServiceImpl } from './agent-session-service';

interface AnsweredCall {
    agent: string;
    sessionId: string;
    requestId: number;
    allow: boolean;
    denyEndsTurn: boolean;
}

/** Minimal engine double: records answers, replays a scripted event stream. */
class FakeEngine {
    readonly answered: AnsweredCall[] = [];
    events: unknown[] = [];
    /** When set, the next `agentRespondPermission` rejects with this message. */
    failNextAnswer?: string;

    /**
     * §14 policy answer for the agent's gate. Default is the safe side: the
     * project asks, so the card stays on screen.
     */
    policyAnswer: Record<string, unknown> | Error = {
        mode: 'hybrid',
        permissions: 'balanced',
        scoped: false,
        class: 'durable',
        effect: 'require_approval',
        interruption: 'require_checkpoint',
        explain: 'exige aprovação'
    };

    readonly policyAsked: { resource?: string; tool?: string }[] = [];

    async policyDecide(
        _root: string,
        _class: string,
        scope: { resource?: string; tool?: string } = {}
    ): Promise<Record<string, unknown>> {
        this.policyAsked.push(scope);
        if (this.policyAnswer instanceof Error) {
            throw this.policyAnswer;
        }
        return this.policyAnswer;
    }

    async agentStartSession(): Promise<{ session_id: string }> {
        return { session_id: 'sess-1' };
    }

    async agentNextEvent(): Promise<{ event: unknown | null }> {
        return { event: this.events.shift() ?? null };
    }

    async agentRespondPermission(
        agent: string,
        sessionId: string,
        requestId: number,
        allow: boolean,
        denyEndsTurn: boolean
    ): Promise<{ answered: boolean }> {
        if (this.failNextAnswer) {
            const message = this.failNextAnswer;
            this.failNextAnswer = undefined;
            throw new Error(message);
        }
        this.answered.push({ agent, sessionId, requestId, allow, denyEndsTurn });
        return { answered: true };
    }
}

interface Fixture {
    service: AgentSessionServiceImpl;
    engine: FakeEngine;
    rootUri: string;
}

/**
 * Builds a service whose session is already open, without going through `start`
 * — `start` needs a git worktree, and none of these invariants are about git.
 */
function fixture(): Fixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-perm-'));
    const engine = new FakeEngine();
    const service = new AgentSessionServiceImpl();
    (service as unknown as { engine: FakeEngine }).engine = engine;

    const state = (service as unknown as {
        state(root: string): {
            sessionId?: string;
            phase: string;
            worktree?: string;
        };
    }).state(root);
    state.sessionId = 'sess-1';
    state.phase = 'working';
    state.worktree = root;

    return { service, engine, rootUri: FileUri.create(root).toString() };
}

function permissionEvent(requestId: number, edits: unknown[] = []): unknown {
    return {
        PermissionRequested: {
            task_id: 1,
            request_id: requestId,
            action: 'write-file',
            detail: 'Write src/main.rs — /tmp/p/src/main.rs',
            edits
        }
    };
}

describe('AgentSessionServiceImpl — permissão é decisão, não aviso', () => {
    it('mostra o pedido pendente, com o id que responde', async () => {
        const { service, engine, rootUri } = fixture();
        engine.events = [permissionEvent(7)];

        const snapshot = await service.poll(rootUri);

        assert.strictEqual(snapshot.pending.length, 1);
        assert.strictEqual(snapshot.pending[0].requestId, 7);
        assert.strictEqual(snapshot.pending[0].action, 'write-file');
        assert.ok(snapshot.pending[0].detail.includes('Write src/main.rs'));
    });

    it('leva o diff proposto até o card, com o corte marcado', async () => {
        const { service, engine, rootUri } = fixture();
        engine.events = [
            permissionEvent(7, [
                {
                    path: 'src/main.rs',
                    old_text: 'antes',
                    new_text: 'depois',
                    truncated: true
                }
            ])
        ];

        const snapshot = await service.poll(rootUri);

        const edits = snapshot.pending[0].edits;
        assert.strictEqual(edits.length, 1);
        assert.strictEqual(edits[0].path, 'src/main.rs');
        assert.strictEqual(edits[0].oldText, 'antes');
        assert.strictEqual(edits[0].newText, 'depois');
        assert.strictEqual(edits[0].truncated, true);
    });

    // `old_text: null` means the agent did not report the previous content.
    // Turning it into '' would render as "the file was empty" — a different and
    // false claim about what is being approved.
    it('conteúdo anterior não informado vira undefined, nunca string vazia', async () => {
        const { service, engine, rootUri } = fixture();
        engine.events = [
            permissionEvent(7, [{ path: 'novo.txt', old_text: null, new_text: 'oi', truncated: false }])
        ];

        const snapshot = await service.poll(rootUri);

        assert.strictEqual(snapshot.pending[0].edits[0].oldText, undefined);
    });

    it('pedido sem diff (um comando) chega com lista vazia, não inventada', async () => {
        const { service, engine, rootUri } = fixture();
        engine.events = [permissionEvent(7)];

        const snapshot = await service.poll(rootUri);

        assert.deepStrictEqual(snapshot.pending[0].edits, []);
    });

    it('não duplica o mesmo pedido se o evento chegar duas vezes', async () => {
        const { service, engine, rootUri } = fixture();
        engine.events = [permissionEvent(7), permissionEvent(7)];

        await service.poll(rootUri);
        const snapshot = await service.poll(rootUri);

        assert.strictEqual(snapshot.pending.length, 1);
    });

    it('aprovar encaminha a decisão e tira o card da tela', async () => {
        const { service, engine, rootUri } = fixture();
        engine.events = [permissionEvent(7)];
        await service.poll(rootUri);

        const snapshot = await service.respondPermission(rootUri, 7, true);

        assert.deepStrictEqual(engine.answered, [
            {
                agent: 'claude',
                sessionId: 'sess-1',
                requestId: 7,
                allow: true,
                denyEndsTurn: true
            }
        ]);
        assert.strictEqual(snapshot.pending.length, 0);
    });

    it('negar sem encerrar o turno propaga o escopo escolhido', async () => {
        const { service, engine, rootUri } = fixture();
        engine.events = [permissionEvent(7)];
        await service.poll(rootUri);

        await service.respondPermission(rootUri, 7, false, false);

        assert.strictEqual(engine.answered[0].allow, false);
        assert.strictEqual(engine.answered[0].denyEndsTurn, false);
    });

    it('falha ao responder MANTÉM o pedido pendente — o agente ainda espera', async () => {
        const { service, engine, rootUri } = fixture();
        engine.events = [permissionEvent(7)];
        await service.poll(rootUri);
        engine.failNextAnswer = 'sidecar fora do ar';

        const snapshot = await service.respondPermission(rootUri, 7, true);

        assert.strictEqual(snapshot.pending.length, 1, 'o card não pode sumir sem a decisão chegar');
        assert.ok(snapshot.lastError?.includes('sidecar fora do ar'));
        assert.strictEqual(engine.answered.length, 0);
    });

    it('responder um pedido que não está pendente é recusado, não silencioso', async () => {
        const { service, engine, rootUri } = fixture();

        const snapshot = await service.respondPermission(rootUri, 99, true);

        assert.strictEqual(engine.answered.length, 0);
        assert.ok(snapshot.lastError?.includes('99'));
    });

    // §14 no portão do agente: só Yolo explícito responde sozinho, e responder
    // sozinho tem de deixar rastro. Classificar pedido de agente como protótipo
    // faria até Cautious auto-responder, que é o contrário do que Cautious diz.
    it('yolo responde o pedido sozinho e registra a regra que decidiu', async () => {
        const { service, engine, rootUri } = fixture();
        engine.policyAnswer = {
            mode: 'full_vibes',
            permissions: 'yolo',
            scoped: false,
            class: 'durable',
            effect: 'auto_approve_recorded',
            interruption: 'proceed',
            explain: 'yolo'
        };
        engine.events = [permissionEvent(7)];

        const snapshot = await service.poll(rootUri);

        assert.strictEqual(snapshot.pending.length, 0);
        assert.strictEqual(engine.answered[0]?.allow, true);
        const note = snapshot.events.find(e => e.text.includes('aprovado automaticamente'));
        assert.ok(note, 'decisão que ninguém tomou ainda precisa estar visível');
        assert.ok(note!.text.includes('COMANDO não tem recibo'));
    });

    it('a política é perguntada com a ferramenta e o arquivo do pedido', async () => {
        const { service, engine, rootUri } = fixture();
        engine.events = [
            permissionEvent(7, [{ path: 'src/main.rs', old_text: 'a', new_text: 'b', truncated: false }])
        ];

        await service.poll(rootUri);

        assert.deepStrictEqual(engine.policyAsked, [{ resource: 'src/main.rs', tool: 'write-file' }]);
    });

    it('política padrão (balanced) NÃO responde sozinha: o card fica de pé', async () => {
        const { service, engine, rootUri } = fixture();
        engine.events = [permissionEvent(7)];

        const snapshot = await service.poll(rootUri);

        assert.strictEqual(snapshot.pending.length, 1);
        assert.strictEqual(engine.answered.length, 0);
    });

    it('política indisponível deixa o pedido pendente, nunca aprovado', async () => {
        const { service, engine, rootUri } = fixture();
        engine.policyAnswer = new Error('sidecar fora do ar');
        engine.events = [permissionEvent(7)];

        const snapshot = await service.poll(rootUri);

        assert.strictEqual(snapshot.pending.length, 1);
        assert.strictEqual(engine.answered.length, 0);
        assert.ok(snapshot.events.some(e => e.text.includes('política de efeito indisponível')));
    });

    it('turno que termina leva os pedidos sem resposta, e diz que não respondido é negado', async () => {
        const { service, engine, rootUri } = fixture();
        engine.events = [
            permissionEvent(7),
            { Ended: { task_id: 1, outcome: 'TimedOut' } }
        ];

        const snapshot = await service.poll(rootUri);

        assert.strictEqual(snapshot.pending.length, 0);
        const note = snapshot.events.find(e => e.text.includes('não respondido conta como negado'));
        assert.ok(note, 'o usuário precisa ver por que o card sumiu sozinho');
    });
});
