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
import { BrokerActivity, EngineService, Hunk, PolicyDecision } from 'engine-extension';

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

    /** Os bytes que o adaptador mandou o broker escrever, por effect id. */
    readonly proposedContent = new Map<string, string>();

    async brokerPropose(
        _root: string,
        _owner: string,
        effectId: string,
        _relativePath?: string,
        content?: string
    ): Promise<ProposeResult> {
        this.calls.push(`propose:${effectId}`);
        if (typeof content === 'string') {
            this.proposedContent.set(effectId, content);
        }
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

    /** What the broker would report as its trail, including a foreign entry. */
    activityRows: BrokerActivity[] = [];

    async brokerActivity(_root: string, _owner: string): Promise<{ activity: BrokerActivity[] }> {
        this.calls.push('activity');
        return { activity: this.activityRows };
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

    /** §14 policy answer. Defaults to the safe side: the project asks. */
    policyAnswer: PolicyDecision | Error = {
        mode: 'hybrid',
        permissions: 'balanced',
        scoped: false,
        class: 'durable',
        effect: 'require_approval',
        interruption: 'require_checkpoint',
        explain: 'Hybrid (permissão do projeto balanced): efeito durável exige sua aprovação'
    };

    async policyDecide(): Promise<PolicyDecision> {
        this.calls.push('policy');
        if (this.policyAnswer instanceof Error) {
            throw this.policyAnswer;
        }
        return this.policyAnswer;
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
        assert.strictEqual(engine.calls.length, 3);
        assert.strictEqual(engine.calls[0], 'diff');
        assert.match(engine.calls[1], /^propose:w[a-z0-9]+-1$/);
        // §14: the mode is CONSULTED on every proposal, even the ones it leaves
        // waiting — that is what puts the rule on the decision card.
        assert.strictEqual(engine.calls[2], 'policy');
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
        assert.deepStrictEqual(kinds, ['diff', 'propose', 'rollback', 'propose', 'policy']);
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

    /** §6: a trilha é dos efeitos DESTE projeto. Um evento com caminho fora da
     *  raiz não pode se misturar — a trilha é evidência sobre este projeto, e
     *  um feed de frota disfarçado de trilha local não serve para nada. */
    it('trilha do broker descarta evento fora da raiz do projeto', async () => {
        const { service, engine, root, rootUri } = fixture();
        engine.activityRows = [
            { kind: 'executed', effect_id: 'e1', path: path.join(root, 'alvo.md') },
            { kind: 'executed', effect_id: 'e2', path: '/outro/projeto/alvo.md' },
            { kind: 'proposed', effect_id: 'e3' }
        ];

        const trail = await service.activity(rootUri);

        assert.deepStrictEqual(
            trail.map(t => t.effect_id),
            ['e1', 'e3'],
            'evento sem caminho é neutro de escopo; o de outro projeto sai'
        );
    });

    /// O broker emite `proposed` com caminho RELATIVO e `executed` com absoluto.
    /// Resolver o relativo contra o cwd do backend descartava toda proposta da
    /// trilha — a execução aparecia e a proposta que a originou, não.
    it('evento com caminho relativo é do projeto, não de outro lugar', async () => {
        const { service, engine, root, rootUri } = fixture();
        engine.activityRows = [
            { kind: 'proposed', effect_id: 'e1', path: 'alvo.md' },
            { kind: 'executed', effect_id: 'e1', path: path.join(root, 'alvo.md') },
            { kind: 'executed', effect_id: 'e2', path: '/outro/projeto/alvo.md' }
        ];

        const trail = await service.activity(rootUri);

        assert.deepStrictEqual(
            trail.map(t => `${t.kind}:${t.effect_id}`),
            ['proposed:e1', 'executed:e1'],
            'a proposta relativa fica; a execução de outro projeto sai'
        );
    });

    /// §14 — TROCAR DE MODO NÃO DECIDE O QUE JÁ ESTAVA ESPERANDO.
    ///
    /// A política é consultada no PROPOSE, e o que ela respondeu fica gravado na
    /// proposta. Se trocar para `full_vibes`/`yolo` valesse retroativamente, uma
    /// escrita que a pessoa deixou parada para pensar seria aplicada sem ela
    /// pedir nada — o efeito aconteceria por causa de uma configuração mudada
    /// depois, não por causa de uma decisão. A regra nova vale para o efeito
    /// SEGUINTE, e é isso que este teste separa.
    it('modo novo não aprova retroativamente proposta que já aguardava', async () => {
        const { service, engine, rootUri, file } = fixture();

        // Projeto cauteloso: a escrita para para a pessoa decidir.
        const parada = await service.proposeWrite(rootUri, 'alvo.md', 'antes\ndepois\n');
        assert.strictEqual(parada.state, 'awaiting');
        assert.strictEqual(parada.policy?.decision, 'require_approval');

        // Agora o projeto vira yolo — depois da proposta já existir.
        engine.policyAnswer = {
            mode: 'full_vibes',
            permissions: 'yolo',
            scoped: false,
            class: 'durable',
            effect: 'auto_approve_recorded',
            interruption: 'none',
            explain: 'Full vibes (permissão yolo): efeito durável é aplicado e registrado'
        };

        // A proposta parada continua parada, com a regra que a parou.
        const aindaPendentes = await service.pending(rootUri);
        const mesma = aindaPendentes.find(p => p.id === parada.id);
        assert.ok(mesma, 'a proposta não pode desaparecer por troca de modo');
        assert.strictEqual(mesma!.state, 'awaiting', 'trocar de modo não decide o que esperava');
        assert.strictEqual(
            mesma!.policy?.decision,
            'require_approval',
            'a proposta carrega a regra do momento em que foi proposta, não a de agora'
        );
        assert.strictEqual(
            fs.readFileSync(file, 'utf8'),
            'antes\n',
            'nada pode ter sido escrito no arquivo real'
        );

        // E a regra nova vale para o efeito SEGUINTE, que é o ponto de trocar.
        const nova = await service.proposeWrite(rootUri, 'alvo.md', 'antes\noutra\n');
        assert.strictEqual(nova.state, 'approved', 'o modo novo vale para o próximo efeito');
        assert.strictEqual(nova.policy?.autoApproved, true, 'e o cartão diz que ninguém foi perguntado');
    });

    /// ABRIR UM PROJETO ESCREVE NELE — E ISSO TEM DE SER DITO.
    ///
    /// Aberto um repositório qualquer, o IDE cria `.instrument/` (broker, baseline,
    /// config). Achado abrindo um projeto cru fora do workspace de fixture: o
    /// diretório aparecia no `git status` da pessoa sem ninguém ter avisado. O
    /// aviso só faz sentido quando é repositório Git e o diretório ainda não é
    /// ignorado; e o conserto é uma PROPOSTA, nunca uma escrita direta.
    describe('estado de runtime é declarado, não silencioso', () => {

        it('avisa quando é repo Git e `.instrument/` não está ignorado', async () => {
            const { service, root, rootUri } = fixture();
            fs.mkdirSync(path.join(root, '.git'), { recursive: true });
            fs.mkdirSync(path.join(root, '.instrument'), { recursive: true });
            fs.writeFileSync(path.join(root, '.instrument/config.json'), '{}', 'utf8');

            const notice = await service.runtimeState(rootUri);

            assert.strictEqual(notice.exists, true);
            assert.strictEqual(notice.gitRepo, true);
            assert.strictEqual(notice.ignored, false);
            assert.ok(
                notice.contents.some(item => /configuração deste projeto/.test(item)),
                'o aviso diz o que há lá dentro, em português, não "arquivos"'
            );
        });

        it('não avisa quando o .gitignore já cobre o diretório', async () => {
            const { service, root, rootUri } = fixture();
            fs.mkdirSync(path.join(root, '.git'), { recursive: true });
            fs.mkdirSync(path.join(root, '.instrument'), { recursive: true });
            fs.writeFileSync(path.join(root, '.gitignore'), '# nada\n.instrument/\n', 'utf8');

            const notice = await service.runtimeState(rootUri);

            assert.strictEqual(notice.ignored, true, 'já ignorado não vira aviso repetido');
        });

        it('fora de um repo Git não há nada a ignorar', async () => {
            const { service, root, rootUri } = fixture();
            fs.mkdirSync(path.join(root, '.instrument'), { recursive: true });

            const notice = await service.runtimeState(rootUri);

            assert.strictEqual(notice.gitRepo, false);
        });

        it('ignorar é PROPOSTA: o .gitignore não muda antes da decisão', async () => {
            const { service, engine, root, rootUri } = fixture();
            fs.mkdirSync(path.join(root, '.git'), { recursive: true });
            fs.mkdirSync(path.join(root, '.instrument'), { recursive: true });
            fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n', 'utf8');

            const proposal = await service.proposeIgnoreRuntimeState(rootUri);

            assert.strictEqual(proposal.state, 'awaiting');
            assert.strictEqual(proposal.relPath, '.gitignore');
            assert.strictEqual(
                fs.readFileSync(path.join(root, '.gitignore'), 'utf8'),
                'node_modules/\n',
                'consertar escrita silenciosa com escrita silenciosa seria o mesmo defeito'
            );

            // O que a proposta CONTÉM: acrescenta a regra sem apagar o que a
            // pessoa já tinha. (Quem escreve os bytes é o broker; aqui ele é um
            // dublê, então a prova é sobre o diff proposto, não sobre o disco —
            // a escrita real está provada na jornada do §12.)
            // Os bytes que foram ao broker: a regra nova entra e o que a pessoa
            // já tinha continua. (Quem escreve é o broker; aqui ele é dublê, e a
            // escrita real está provada na jornada do §12.)
            const bytes = engine.proposedContent.get(proposal.id);
            assert.ok(bytes, 'o adaptador tem de mandar os bytes ao broker');
            assert.ok(bytes!.startsWith('node_modules/\n'), 'o que a pessoa já tinha continua');
            assert.ok(bytes!.includes('\n.instrument/\n'), 'e a regra nova entra');
        });

        it('recusa propor de novo quando já está ignorado', async () => {
            const { service, root, rootUri } = fixture();
            fs.mkdirSync(path.join(root, '.git'), { recursive: true });
            fs.writeFileSync(path.join(root, '.gitignore'), '.instrument/\n', 'utf8');

            await assert.rejects(
                () => service.proposeIgnoreRuntimeState(rootUri),
                /já está ignorado/
            );
        });
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

// §14 — o modo decide QUANDO o IDE pergunta. Nunca decide se o efeito é
// governado: mesmo sem pergunta, o efeito é proposto, tem snapshot e tem
// rollback. Um Yolo que pulasse o broker apagaria a trilha inteira, que é
// exatamente o que os modos existem para não fazer.
describe('GovernedWriteServiceImpl — §14: o modo decide quando perguntar', () => {

    it('a política viaja na proposta, para o card poder dizer quem decidiu', async () => {
        const { service, rootUri } = fixture();

        const proposal = await service.proposeWrite(rootUri, 'alvo.md', 'antes\ndepois\n');

        assert.strictEqual(proposal.policy?.mode, 'hybrid');
        assert.strictEqual(proposal.policy?.permissions, 'balanced');
        assert.strictEqual(proposal.policy?.decision, 'require_approval');
        assert.notStrictEqual(proposal.policy?.autoApproved, true);
    });

    it('yolo aplica sem perguntar — e ainda assim passa pelo broker', async () => {
        const { service, engine, rootUri } = fixture();
        engine.policyAnswer = {
            mode: 'full_vibes',
            permissions: 'yolo',
            scoped: false,
            class: 'durable',
            effect: 'auto_approve_recorded',
            interruption: 'proceed_recording_hypothesis',
            explain: 'aprovado sem perguntar — snapshot e recibo continuam'
        };

        const proposal = await service.proposeWrite(rootUri, 'alvo.md', 'antes\ndepois\n');

        assert.strictEqual(proposal.state, 'approved');
        assert.strictEqual(proposal.policy?.autoApproved, true);
        // A ordem prova o que importa: PROPOSTO ao broker antes de qualquer
        // aprovação, aprovado por effect id, e executado pelo mesmo caminho da
        // pessoa. Nada de escrita direta.
        const order = engine.calls.filter(c => c !== 'diff' && c !== 'policy');
        assert.strictEqual(order.length, 3);
        assert.match(order[0], /^propose:/);
        assert.match(order[1], /^approve:/);
        assert.match(order[2], /^propose:/);
        assert.strictEqual(order[0], order[2], 'o mesmo efeito é reenviado, não outro');
    });

    it('escrita auto-aprovada continua reversível pelo snapshot do broker', async () => {
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
        const proposal = await service.proposeWrite(rootUri, 'alvo.md', 'x\n');

        const reverted = await service.rollback(proposal.id);

        assert.strictEqual(reverted.state, 'rolledback');
        assert.ok(engine.calls.some(c => c === `rollback:${proposal.id}`));
    });

    // Falha da política não pode virar permissão: sem resposta, a proposta espera.
    it('política indisponível deixa a proposta aguardando, não auto-aprova', async () => {
        const { service, engine, rootUri } = fixture();
        engine.policyAnswer = new Error('sidecar fora do ar');

        const proposal = await service.proposeWrite(rootUri, 'alvo.md', 'x\n');

        assert.strictEqual(proposal.state, 'awaiting');
        assert.strictEqual(proposal.policy, undefined);
        assert.ok(!engine.calls.some(c => c.startsWith('approve:')));
    });

    // A classe throwaway existia no motor e nenhuma chamada a produzia. Quem
    // produz é o destino: `.instrument/` é estado de runtime do IDE, não conteúdo
    // do projeto — mesma linha que §4/§5/§13 já desenham.
    it('escrita em .instrument/ é protótipo; conteúdo do projeto é durável', async () => {
        const { service, engine, rootUri } = fixture();
        const classes: string[] = [];
        (engine as unknown as { policyDecide: unknown }).policyDecide = async (
            _root: string,
            effectClass: string
        ) => {
            classes.push(effectClass);
            return { ...(engine.policyAnswer as PolicyDecision), class: effectClass };
        };

        await service.proposeWrite(rootUri, '.instrument/checks.json', '{}\n');
        await service.proposeWrite(rootUri, 'alvo.md', 'x\n');

        assert.deepStrictEqual(classes, ['prototype', 'durable']);
    });

    it('regra com escopo próprio chega ao card como escopada', async () => {
        const { service, engine, rootUri } = fixture();
        engine.policyAnswer = {
            mode: 'hybrid',
            permissions: 'yolo',
            scoped: true,
            class: 'durable',
            effect: 'auto_approve_recorded',
            interruption: 'require_checkpoint',
            explain: 'regra escopada'
        };

        const proposal = await service.proposeWrite(rootUri, 'alvo.md', 'x\n');

        assert.strictEqual(proposal.policy?.scoped, true);
    });
});
