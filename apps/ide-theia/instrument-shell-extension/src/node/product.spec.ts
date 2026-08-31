// Testes do projeto semântico (§3). O que importa provar: divergência é
// CALCULADA a partir do arquivo real, `unknown` nunca vira conformidade, e
// resolver é sempre uma proposta ao broker — o serviço não conserta nada sozinho.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { ProductServiceImpl } from './product-service';
import {
    GovernedWriteService,
    RuntimeStateNotice,
    WriteProposal
} from '../common/governed-protocol';
import { BrokerActivity } from 'engine-extension';
import { WriteSourceLedger } from './write-source-ledger';
import { SourceOfTruth } from '../common/product-protocol';

class FakeGoverned implements GovernedWriteService {
    readonly proposals: { relPath: string; content: string }[] = [];
    async proposeWrite(_root: string, relPath: string, content: string): Promise<WriteProposal> {
        this.proposals.push({ relPath, content });
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

    async runtimeState(): Promise<RuntimeStateNotice> {
        return { dir: '.instrument', exists: false, gitRepo: false, ignored: true, contents: [] };
    }

    async proposeIgnoreRuntimeState(): Promise<WriteProposal> {
        throw new Error('não usado neste teste');
    }
    async pending(): Promise<WriteProposal[]> { return []; }
}

interface Fixture {
    service: ProductServiceImpl;
    governed: FakeGoverned;
    root: string;
    rootUri: string;
}

/** Projeto de teste com a divergência do desempate já plantada. */
function fixture(): Fixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'src', 'auction.ts'),
        'export function rank(bids) {\n    // desempate\n    return a.createdAt - b.createdAt;\n}\n',
        'utf8'
    );
    fs.writeFileSync(path.join(root, 'docs', 'intent.md'), '# Intenção\n', 'utf8');
    const service = new ProductServiceImpl();
    const governed = new FakeGoverned();
    (service as unknown as { governed: GovernedWriteService }).governed = governed;
    (service as unknown as { ledger: WriteSourceLedger }).ledger = new WriteSourceLedger();
    return { service, governed, root, rootUri: FileUri.create(root).toString() };
}

const TIE_BREAK_SOT: SourceOfTruth = {
    id: 'intent',
    label: 'Intenção do produto',
    kind: 'intent',
    path: 'docs/intent.md',
    authorityOver: ['src'],
    claims: [
        {
            id: 'desempate-nao-por-criacao',
            statement: 'O desempate não pode ser resolvido por ordem de criação.',
            check: { kind: 'absent-in-file', path: 'src/auction.ts', pattern: 'a.createdAt - b.createdAt' }
        }
    ]
};

describe('ProductServiceImpl — modelo semântico vem do disco', () => {

    it('projeto sem artefatos responde `declared: false`, não um modelo inventado', async () => {
        const { service, rootUri } = fixture();
        const model = await service.model(rootUri);
        assert.strictEqual(model.declared, false);
        assert.deepStrictEqual(model.sots, []);
        assert.deepStrictEqual(model.claims, []);
    });

    it('descobre um SoT escrito como arquivo, sem chamada de API', async () => {
        const { service, root, rootUri } = fixture();
        const dir = path.join(root, '.product', 'sot');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'intent.json'), JSON.stringify(TIE_BREAK_SOT), 'utf8');

        const model = await service.model(rootUri);
        assert.strictEqual(model.declared, true);
        assert.strictEqual(model.sots[0].id, 'intent');
        assert.strictEqual(model.sots[0].manifestPath, path.join('.product', 'sot', 'intent.json'));
    });

    it('reporta artefato inválido sem derrubar o resto do modelo', async () => {
        const { service, root, rootUri } = fixture();
        const dir = path.join(root, '.product', 'sot');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'ruim.json'), '{ nao json', 'utf8');
        fs.writeFileSync(path.join(dir, 'intent.json'), JSON.stringify(TIE_BREAK_SOT), 'utf8');

        const model = await service.model(rootUri);
        assert.deepStrictEqual(model.sots.map(s => s.id), ['intent']);
        assert.strictEqual(model.invalid.length, 1);
        assert.match(model.invalid[0].path, /ruim\.json/);
    });

    it('recusa um SoT cuja afirmação não tem check verificável', async () => {
        const { service, rootUri } = fixture();
        await assert.rejects(
            () => service.declareSot(rootUri, {
                ...TIE_BREAK_SOT,
                claims: [{ id: 'x', statement: 'confie em mim', check: undefined as never }]
            }),
            /divergência é calculada/
        );
    });
});

describe('ProductServiceImpl — divergência é calculada', () => {

    async function withSot(f: Fixture, sot = TIE_BREAK_SOT): Promise<void> {
        await f.service.declareSot(f.rootUri, sot);
    }

    it('acha a divergência real, com linha e evidência', async () => {
        const f = fixture();
        await withSot(f);
        const model = await f.service.model(f.rootUri);
        const claim = model.claims[0];
        assert.strictEqual(claim.status, 'divergent');
        assert.strictEqual(claim.line, 3);
        assert.match(claim.evidence, /aparece em src\/auction\.ts:3/);
        assert.deepStrictEqual(claim.affectedResources, ['src']);
    });

    it('deixa de divergir quando a implementação muda de verdade', async () => {
        const f = fixture();
        await withSot(f);
        fs.writeFileSync(
            path.join(f.root, 'src', 'auction.ts'),
            'export function rank(bids) {\n    return a.id.localeCompare(b.id);\n}\n',
            'utf8'
        );
        const model = await f.service.model(f.rootUri);
        assert.strictEqual(model.claims[0].status, 'ok');
        assert.match(model.claims[0].evidence, /não aparece/);
    });

    it('arquivo ausente é `unknown`, nunca `ok`', async () => {
        const f = fixture();
        await withSot(f, {
            ...TIE_BREAK_SOT,
            claims: [{
                ...TIE_BREAK_SOT.claims[0],
                check: { kind: 'absent-in-file', path: 'src/nao-existe.ts', pattern: 'x' }
            }]
        });
        const model = await f.service.model(f.rootUri);
        assert.strictEqual(model.claims[0].status, 'unknown');
        assert.match(model.claims[0].evidence, /não existe/);
    });

    it('caminho fora do projeto é `unknown`, não leitura', async () => {
        const f = fixture();
        await withSot(f, {
            ...TIE_BREAK_SOT,
            claims: [{
                ...TIE_BREAK_SOT.claims[0],
                check: { kind: 'absent-in-file', path: '../fora.txt', pattern: 'x' }
            }]
        });
        const model = await f.service.model(f.rootUri);
        assert.strictEqual(model.claims[0].status, 'unknown');
        assert.match(model.claims[0].evidence, /escapa da raiz/);
    });

    it('exceção registrada aparece como `excepted`, com o motivo, não como ok', async () => {
        const f = fixture();
        await withSot(f, {
            ...TIE_BREAK_SOT,
            claims: [{
                ...TIE_BREAK_SOT.claims[0],
                exception: { reason: 'legado até a migração', at: '2026-08-26T00:00:00.000Z' }
            }]
        });
        const model = await f.service.model(f.rootUri);
        assert.strictEqual(model.claims[0].status, 'excepted');
        assert.match(model.claims[0].evidence, /legado até a migração/);
    });

    it('recurso sem autoridade é lacuna declarada, não erro', async () => {
        const f = fixture();
        await f.service.declareResource(f.rootUri, {
            id: 'src', label: 'src', paths: ['src/auction.ts'], consumers: []
        });
        const model = await f.service.model(f.rootUri);
        assert.deepStrictEqual(model.withoutAuthority, ['src']);
    });
});

describe('ProductServiceImpl — resolver passa pelo broker', () => {

    it('oferece os dois lados: implementação e intenção', async () => {
        const f = fixture();
        await f.service.declareSot(f.rootUri, TIE_BREAK_SOT);
        const options = await f.service.options(f.rootUri, 'intent', 'desempate-nao-por-criacao');
        assert.deepStrictEqual(options.map(o => o.side).sort(), ['implementation', 'intent']);
    });

    it('resolver pela implementação PROPÕE a remoção, sem escrever', async () => {
        const f = fixture();
        await f.service.declareSot(f.rootUri, TIE_BREAK_SOT);
        const before = fs.readFileSync(path.join(f.root, 'src', 'auction.ts'), 'utf8');

        const result = await f.service.resolve(
            f.rootUri, 'intent', 'desempate-nao-por-criacao', 'remove-offending-line'
        );
        assert.strictEqual(result.relPath, 'src/auction.ts');
        assert.strictEqual(f.governed.proposals.length, 1);
        assert.ok(!f.governed.proposals[0].content.includes('a.createdAt - b.createdAt'));
        // O arquivo continua como estava: a decisão é da pessoa, no dock.
        assert.strictEqual(fs.readFileSync(path.join(f.root, 'src', 'auction.ts'), 'utf8'), before);
    });

    it('resolver pela intenção propõe editar o PRÓPRIO SoT, com exceção datada', async () => {
        const f = fixture();
        await f.service.declareSot(f.rootUri, TIE_BREAK_SOT);
        const result = await f.service.resolve(
            f.rootUri, 'intent', 'desempate-nao-por-criacao', 'accept-exception'
        );
        assert.match(result.relPath, /\.product[\\/]sot[\\/]intent\.json/);
        const proposed = JSON.parse(f.governed.proposals[0].content) as SourceOfTruth;
        assert.ok(proposed.claims[0].exception, 'a exceção tem de ir para o artefato');
        assert.ok(proposed.claims[0].exception!.at, 'exceção sem data não é revisável');
        assert.strictEqual(proposed.manifestPath, undefined, 'campo derivado não vai para o disco');
    });

    it('recusa resolver o que não existe', async () => {
        const f = fixture();
        await f.service.declareSot(f.rootUri, TIE_BREAK_SOT);
        await assert.rejects(
            () => f.service.resolve(f.rootUri, 'intent', 'nao-existe', 'accept-exception'),
            /afirmação desconhecida/
        );
        await assert.rejects(
            () => f.service.resolve(f.rootUri, 'intent', 'desempate-nao-por-criacao', 'inventada'),
            /opção de resolução desconhecida/
        );
    });
});

describe('ProductServiceImpl — análise propõe candidatos, não ativa nada', () => {

    it('propõe recurso e SoT a partir do que existe, sem gravar', async () => {
        const f = fixture();
        const candidates = await f.service.candidates(f.rootUri);
        assert.deepStrictEqual(candidates.resources.map(r => r.id), ['src']);
        assert.strictEqual(candidates.sots.length, 1);
        assert.strictEqual(candidates.sots[0].kind, 'intent');
        // Nada foi declarado: candidato não é ativação.
        const model = await f.service.model(f.rootUri);
        assert.strictEqual(model.declared, false);
    });

    /**
     * O botão "Adotar" da view Produto entrega o candidato COMO VEIO da análise.
     * Se o validador recusasse essa forma, o projeto cru continuaria sem saída
     * pela tela — que era exatamente o buraco: o backend sabia adotar e só o
     * agente, pelo MCP, chegava lá.
     */
    it('adota o candidato exatamente como a análise o devolveu', async () => {
        const f = fixture();
        const candidates = await f.service.candidates(f.rootUri);

        const afterSot = await f.service.declareSot(f.rootUri, candidates.sots[0]);
        assert.strictEqual(afterSot.declared, true);
        // Candidato de SoT vem sem `claims`: adotar não pode inventar verificação.
        assert.strictEqual(afterSot.claims.length, 0);

        const afterResource = await f.service.declareResource(f.rootUri, candidates.resources[0]);
        assert.deepStrictEqual(afterResource.resources.map(r => r.id), ['src']);
        // Sem autoridade declarada, e isso aparece como lacuna, não como conformidade.
        assert.deepStrictEqual(afterResource.withoutAuthority, ['src']);
        assert.deepStrictEqual(afterResource.invalid, []);
    });
});
