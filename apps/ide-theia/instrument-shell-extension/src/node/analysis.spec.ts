// Tests for §5 — analisar projeto e materiais.
//
// The invariant every case below defends is the same one: an assertion the IDE
// makes about a project must be checkable without trusting the IDE. So each
// candidate carries the file, the line when there is one, and text actually read
// from disk. There is no "inferred" or "probable" path through this code — if
// the evidence is not there, the candidate is not emitted.
//
// Two of these are about what must NOT appear: a value from a `.env` (that is
// where the credential is) and a script that starts a server (a check that never
// terminates is worse than no check).

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { AnalysisServiceImpl } from './analysis-service';

interface Fixture {
    service: AnalysisServiceImpl;
    root: string;
    rootUri: string;
}

/** Propostas que o broker teria recebido, para conferir o REGIME de escrita:
 *  `.instrument/` é gravado direto (estado de runtime do IDE) e `.product/` só
 *  atravessa o broker. Trocar os dois transformaria configuração do IDE em
 *  mudança de código para revisar, ou pior, o contrário. */
interface RecordedProposal {
    relPath: string;
    content: string;
}

/** What the sidecar's library import would have received. */
interface RecordedImport {
    name: string;
    text: string;
    provenance?: string;
}

function fixture(): Fixture & { proposals: RecordedProposal[]; imports: RecordedImport[] } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-'));
    const service = new AnalysisServiceImpl();
    const proposals: RecordedProposal[] = [];
    const imports: RecordedImport[] = [];
    // Duplo do sidecar: registra a importação e devolve o que o motor devolveria
    // — estado `candidate`, que é a garantia que o §13 move para o lifecycle.
    (service as unknown as { engine: unknown }).engine = {
        libraryImport: async (_root: string, name: string, text: string, provenance?: string) => {
            imports.push({ name, text, provenance });
            return { id: `guidance-${imports.length}`, state: 'candidate', name, text };
        }
    };
    // Duplo do broker: registra a proposta sem escrever nada, que é exatamente o
    // que o broker real faz na primeira chamada.
    (service as unknown as { governed: unknown }).governed = {
        proposeWrite: async (_rootUri: string, relPath: string, content: string) => {
            proposals.push({ relPath, content });
            return {
                id: `proposta-${proposals.length}`,
                relPath,
                state: 'awaiting',
                addedLines: 0,
                removedLines: 0,
                hunkCount: 1
            };
        }
    };
    return { service, root, rootUri: FileUri.create(root).toString(), proposals, imports };
}

function write(root: string, rel: string, body: string): void {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
}

describe('AnalysisServiceImpl — candidato só existe com evidência', () => {
    it('projeto vazio não produz afirmação nenhuma', async () => {
        const { service, rootUri } = fixture();

        const analysis = await service.analyze(rootUri);

        assert.deepStrictEqual(analysis.stack, []);
        assert.deepStrictEqual(analysis.commands, []);
        assert.deepStrictEqual(analysis.services, []);
        assert.deepStrictEqual(analysis.integrations, []);
        assert.strictEqual(analysis.git.isRepo, false);
    });

    it('cada tecnologia aponta o manifesto que a sustenta', async () => {
        const { service, root, rootUri } = fixture();
        write(root, 'Cargo.toml', '[package]\nname = "x"\n');

        const analysis = await service.analyze(rootUri);

        const rust = analysis.stack.find(s => s.id === 'rust');
        assert.ok(rust, 'Rust detectado');
        assert.strictEqual(rust!.provenance[0].path, 'Cargo.toml');
        assert.strictEqual(rust!.provenance[0].excerpt, '[package]');
    });

    it('comando de script carrega o corpo real, com a linha', async () => {
        const { service, root, rootUri } = fixture();
        write(
            root,
            'package.json',
            JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc -b' } }, null, 2)
        );

        const analysis = await service.analyze(rootUri);

        const test = analysis.commands.find(c => c.slug === 'test');
        assert.ok(test);
        assert.strictEqual(test!.command, 'npm run test');
        assert.strictEqual(test!.provenance.path, 'package.json');
        // O corpo é a evidência: mostra o que `npm run test` vai executar.
        assert.ok(test!.provenance.excerpt.includes('vitest run'), test!.provenance.excerpt);
        assert.ok(typeof test!.provenance.line === 'number');
    });

    /// `start` descreve o projeto, mas os checks não o executam. A marca existe
    /// para a tela não oferecer uma adoção que o serviço vai recusar.
    it('marca quais papéis os checks realmente executam', async () => {
        const { service, root, rootUri } = fixture();
        write(root, 'package.json', JSON.stringify({ scripts: { start: 'node .', test: 'vitest' } }));

        const analysis = await service.analyze(rootUri);

        assert.strictEqual(analysis.commands.find(c => c.slug === 'start')!.runnableByChecks, false);
        assert.strictEqual(analysis.commands.find(c => c.slug === 'test')!.runnableByChecks, true);
    });

    /// Evidência que não sustenta a afirmação é pior que nenhuma: ocupa o lugar
    /// dela. A primeira linha de um package.json é `{`.
    it('não usa pontuação estrutural como evidência', async () => {
        const { service, root, rootUri } = fixture();
        write(root, 'package.json', '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n');

        const analysis = await service.analyze(rootUri);

        const node = analysis.stack.find(s => s.id === 'node')!;
        assert.notStrictEqual(node.provenance[0].excerpt, '{');
        assert.ok(node.provenance[0].excerpt.includes('name'), node.provenance[0].excerpt);
    });

    /// Um script que sobe servidor não é um check: ele nunca termina, e o §4
    /// esperaria por ele até o watchdog.
    it('script de servidor não vira candidato de comando', async () => {
        const { service, root, rootUri } = fixture();
        write(root, 'package.json', JSON.stringify({ scripts: { dev: 'vite', serve: 'http-server' } }));

        const analysis = await service.analyze(rootUri);

        assert.deepStrictEqual(analysis.commands, []);
    });

    it('marca o que já está declarado, para adotar não parecer novidade', async () => {
        const { service, root, rootUri } = fixture();
        write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
        write(root, '.instrument/checks.json', JSON.stringify({ test: { command: 'outro' } }));

        const analysis = await service.analyze(rootUri);

        assert.strictEqual(analysis.commands.find(c => c.slug === 'test')!.alreadyDeclared, true);
    });

    it('lê branch e remoto do próprio .git, sem rodar processo', async () => {
        const { service, root, rootUri } = fixture();
        write(root, '.git/HEAD', 'ref: refs/heads/feat/algo\n');
        write(
            root,
            '.git/config',
            '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@example.com:org/repo.git\n'
        );

        const analysis = await service.analyze(rootUri);

        assert.strictEqual(analysis.git.isRepo, true);
        assert.strictEqual(analysis.git.branch, 'feat/algo');
        assert.deepStrictEqual(analysis.git.remotes, [
            { name: 'origin', url: 'git@example.com:org/repo.git' }
        ]);
        assert.ok(analysis.git.provenance.some(p => p.path === '.git/config'));
    });

    it('serviço de compose aponta a linha da chave', async () => {
        const { service, root, rootUri } = fixture();
        write(root, 'docker-compose.yml', 'version: "3"\nservices:\n  db:\n    image: postgres\n  cache:\n    image: redis\n');

        const analysis = await service.analyze(rootUri);

        assert.deepStrictEqual(analysis.services.map(s => s.id).sort(), ['cache', 'db']);
        const db = analysis.services.find(s => s.id === 'db')!;
        assert.strictEqual(db.kind, 'container');
        assert.strictEqual(db.provenance.line, 3);
    });

    /// O valor de uma variável de ambiente é exatamente onde a credencial mora.
    /// A análise nomeia a variável e NUNCA lê o valor para a evidência.
    it('variável de ambiente entra pelo nome, nunca pelo valor', async () => {
        const { service, root, rootUri } = fixture();
        write(root, '.env', 'DATABASE_URL=postgres://user:senha-secreta@host/db\n');

        const analysis = await service.analyze(rootUri);

        const service0 = analysis.services.find(s => s.id === 'DATABASE_URL');
        assert.ok(service0, 'a variável foi vista');
        assert.strictEqual(service0!.kind, 'database');
        assert.ok(
            !service0!.provenance.excerpt.includes('senha-secreta'),
            `evidência vazou o valor: ${service0!.provenance.excerpt}`
        );
    });

    it('integrações vêm de declaração, com o arquivo que as declara', async () => {
        const { service, root, rootUri } = fixture();
        write(root, '.github/workflows/ci.yml', 'name: CI\non: push\n');
        write(root, '.mcp.json', JSON.stringify({ mcpServers: { docs: { command: 'x' } } }));
        write(root, 'Dockerfile', 'FROM node:22\n');

        const analysis = await service.analyze(rootUri);

        const kinds = analysis.integrations.map(i => i.kind).sort();
        assert.deepStrictEqual(kinds, ['ci', 'container', 'mcp']);
        assert.ok(analysis.integrations.every(i => i.provenance.excerpt.length > 0));
    });

    it('adotar escreve só os slugs pedidos e preserva o resto', async () => {
        const { service, root, rootUri } = fixture();
        write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc -b' } }));
        write(root, '.instrument/checks.json', JSON.stringify({ typecheck: { command: 'escrito à mão' } }));

        await service.adoptCommands(rootUri, ['test']);

        const written = JSON.parse(fs.readFileSync(path.join(root, '.instrument/checks.json'), 'utf8'));
        assert.deepStrictEqual(written.test, { command: 'npm run test' });
        assert.deepStrictEqual(
            written.typecheck,
            { command: 'escrito à mão' },
            'adoção não pode apagar o que alguém escreveu'
        );
        assert.strictEqual(written.build, undefined, 'só o slug pedido foi adotado');
    });

    /// `start` e `lint` não são executados pelo §4; adotá-los escreveria uma
    /// chave que o motor ignora, e a tela mostraria uma adoção sem efeito.
    it('adotar um slug que o motor não executa não escreve nada', async () => {
        const { service, root, rootUri } = fixture();
        write(root, 'package.json', JSON.stringify({ scripts: { start: 'node .' } }));

        await service.adoptCommands(rootUri, ['start']);

        const written = JSON.parse(fs.readFileSync(path.join(root, '.instrument/checks.json'), 'utf8'));
        assert.deepStrictEqual(written, {});
    });

    it('adotar devolve a análise já refletindo a adoção', async () => {
        const { service, root, rootUri } = fixture();
        write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));

        const after = await service.adoptCommands(rootUri, ['test']);

        assert.strictEqual(after.commands.find(c => c.slug === 'test')!.alreadyDeclared, true);
    });

    it('diz quais diretórios não abriu, para a cobertura ser honesta', async () => {
        const { service, root, rootUri } = fixture();
        fs.mkdirSync(path.join(root, 'node_modules'));

        const analysis = await service.analyze(rootUri);

        assert.ok(analysis.skipped.includes('node_modules'));
    });
});

describe('AnalysisServiceImpl — instruções, guidance, configuração, referências, relações', () => {
    it('arquivo de instrução é detectado por nome, com o que foi lido dele', async () => {
        const { service, root, rootUri } = fixture();
        write(root, 'AGENTS.md', '# Como trabalhar aqui\n\nNunca rode migração em produção.\n');

        const analysis = await service.analyze(rootUri);

        assert.strictEqual(analysis.instructions.length, 1);
        const found = analysis.instructions[0];
        assert.strictEqual(found.kind, 'agent');
        assert.strictEqual(found.provenance.path, 'AGENTS.md');
        assert.deepStrictEqual(found.headings, ['Como trabalhar aqui']);
        assert.ok(found.bytes > 0, 'tamanho lido é medido, não afirmado');
    });

    it('guidance sai sempre como sugestão — força é decisão humana', async () => {
        const { service, root, rootUri } = fixture();
        write(
            root,
            'AGENTS.md',
            '# Desempate\n\nO lance precisa exceder estritamente o atual.\n' +
                '\n# Sem conteúdo\n'
        );

        const analysis = await service.analyze(rootUri);

        assert.strictEqual(analysis.guidance.length, 1, 'seção sem texto não vira orientação');
        const guidance = analysis.guidance[0];
        assert.strictEqual(guidance.strength, 'suggestion');
        assert.strictEqual(guidance.title, 'Desempate');
        assert.strictEqual(guidance.text, 'O lance precisa exceder estritamente o atual.');
        assert.strictEqual(guidance.provenance.path, 'AGENTS.md');
        assert.strictEqual(guidance.provenance.line, 1);
        assert.ok(
            guidance.target.startsWith('.guidance/'),
            `o destino é a biblioteca do §13: ${guidance.target}`
        );
    });

    /** §13 corrigiu o destino: a guidance detectada entra na Guidance Library
     *  como CANDIDATA, não em `.product/guidance/` pelo broker. O que barra uma
     *  regra vinda de detector é o lifecycle do motor, não um diff. */
    it('adotar guidance importa para a biblioteca como candidata, sem broker', async () => {
        const { service, root, rootUri, proposals, imports } = fixture();
        write(root, 'AGENTS.md', '# Desempate\n\nExceder estritamente.\n');
        const analysis = await service.analyze(rootUri);

        const result = await service.importGuidance(rootUri, analysis.guidance[0].id);

        assert.strictEqual(result.state, 'candidate', 'importada não dirige agente');
        assert.strictEqual(proposals.length, 0, 'a biblioteca não passa pelo broker');
        assert.strictEqual(imports.length, 1);
        assert.strictEqual(imports[0].name, 'Desempate');
        assert.strictEqual(
            imports[0].provenance,
            'AGENTS.md:1',
            'a procedência detectada viaja com a importação'
        );
    });

    it('config de preview traz a porta quando existe linha para apontar', async () => {
        const { service, root, rootUri } = fixture();
        write(root, 'package.json', '{\n  "scripts": {\n    "start": "node src/server.ts"\n  }\n}\n');
        write(root, 'src/server.ts', 'const PORT = Number(process.env.PORT ?? 8787);\n');

        const analysis = await service.analyze(rootUri);

        const config = analysis.config.find(c => c.id === 'config:preview');
        assert.ok(config, 'candidato de preview emitido');
        assert.strictEqual(config!.target, '.instrument/preview.json');
        assert.strictEqual(config!.proposed.url, 'http://127.0.0.1:8787/');
        assert.strictEqual(config!.gap, undefined);
        assert.ok(
            config!.provenance.some(p => p.path === 'src/server.ts' && p.line === 1),
            'a porta aponta a linha que a declara'
        );
    });

    it('sem porta literal, a config sai com o buraco declarado', async () => {
        const { service, root, rootUri } = fixture();
        write(root, 'package.json', '{\n  "scripts": {\n    "start": "node src/main.ts"\n  }\n}\n');
        write(root, 'src/main.ts', 'console.log("sem servidor");\n');

        const analysis = await service.analyze(rootUri);

        const config = analysis.config[0];
        assert.strictEqual(config.proposed.url, undefined, 'url inventada seria palpite');
        assert.ok(config.gap!.includes('nunca vai poder afirmar'), config.gap ?? 'sem gap');
    });

    it('adotar config grava direto em .instrument/, preservando o que já estava lá', async () => {
        const { service, root, rootUri, proposals } = fixture();
        write(root, 'package.json', '{\n  "scripts": {\n    "start": "node src/server.ts"\n  }\n}\n');
        write(root, 'src/server.ts', 'server.listen(9000);\n');
        write(root, '.instrument/preview.json', '{\n  "readyTimeoutMs": 3000\n}\n');

        const after = await service.adoptConfig(rootUri, 'config:preview');

        const written = JSON.parse(
            fs.readFileSync(path.join(root, '.instrument/preview.json'), 'utf8')
        ) as Record<string, unknown>;
        assert.strictEqual(written.command, 'npm run start');
        assert.strictEqual(written.url, 'http://127.0.0.1:9000/');
        assert.strictEqual(written.readyTimeoutMs, 3000, 'o que estava à mão sobrevive');
        assert.strictEqual(proposals.length, 0, '.instrument/ não vai ao broker');
        assert.strictEqual(after.config[0].alreadyDeclared, true);
    });

    it('URL citada é referência sem cópia local, e diz que não baixou', async () => {
        const { service, root, rootUri } = fixture();
        write(root, 'README.md', 'Regras em https://exemplo.test/spec e nada mais.\n');

        const analysis = await service.analyze(rootUri);

        assert.strictEqual(analysis.references.length, 1);
        const reference = analysis.references[0];
        assert.strictEqual(reference.kind, 'url');
        assert.strictEqual(reference.presentInWorkspace, false);
        assert.ok(reference.assetNote!.includes('não baixada'), reference.assetNote ?? 'sem nota');
        assert.strictEqual(reference.provenance.line, 1);
    });

    it('link para arquivo que existe é asset já versionado; link quebrado não é referência', async () => {
        const { service, root, rootUri } = fixture();
        write(root, 'docs/intent.md', 'conteúdo\n');
        write(
            root,
            'README.md',
            'Ver [intenção](docs/intent.md) e [fantasma](docs/nao-existe.md).\n'
        );

        const analysis = await service.analyze(rootUri);

        const files = analysis.references.filter(r => r.kind === 'file');
        assert.strictEqual(files.length, 1, 'link quebrado não vira linha morta');
        assert.strictEqual(files[0].target, 'docs/intent.md');
        assert.strictEqual(files[0].presentInWorkspace, true);
    });

    it('registrar referência atravessa o broker e leva a procedência', async () => {
        const { service, root, rootUri, proposals } = fixture();
        write(root, 'README.md', 'Spec em https://exemplo.test/spec\n');
        const analysis = await service.analyze(rootUri);

        const result = await service.registerReference(rootUri, analysis.references[0].id);

        assert.strictEqual(proposals.length, 1);
        assert.ok(result.relPath.startsWith('.product/references/'));
        const body = JSON.parse(proposals[0].content) as {
            asset: string | null;
            provenance: { path: string };
        };
        assert.strictEqual(body.asset, null, 'URL não tem asset local');
        assert.strictEqual(body.provenance.path, 'README.md');
    });

    it('relação só existe quando o documento cita literalmente o material', async () => {
        const { service, root, rootUri } = fixture();
        write(root, 'package.json', '{\n  "scripts": {\n    "test": "node --test"\n  }\n}\n');
        write(root, 'src/auction.ts', 'export const rank = () => [];\n');
        write(
            root,
            'docs/intent.md',
            'O ranking vive em src/auction.ts e roda com npm run test.\n' +
                'Este parágrafo fala de leilão sem citar arquivo nenhum.\n'
        );

        const analysis = await service.analyze(rootUri);

        const kinds = analysis.relations.map(r => `${r.kind}:${r.to}`);
        assert.ok(kinds.includes('menciona-arquivo:file:src/auction.ts'), kinds.join(', '));
        assert.ok(kinds.includes('menciona-comando:command:test'), kinds.join(', '));
        assert.ok(
            analysis.relations.every(r => r.provenance.excerpt.length > 0),
            'relação sem trecho lido não sustenta nada'
        );
        assert.ok(
            !analysis.relations.some(r => r.provenance.line === 2),
            'parágrafo sem citação literal não gera relação'
        );
    });

    it('adotar configuração fora de .instrument/ é recusado', async () => {
        const { service, root, rootUri } = fixture();
        write(root, 'package.json', '{\n  "scripts": {\n    "start": "node src/server.ts"\n  }\n}\n');
        const analysis = await service.analyze(rootUri);
        // Um candidato adulterado é a única forma de chegar aqui, e é justamente
        // contra isso que a guarda existe.
        const tampered = { ...analysis.config[0], target: 'src/auction.ts' };
        (service as unknown as { analyze: unknown }).analyze = async () => ({
            ...analysis,
            config: [tampered]
        });

        await assert.rejects(
            () => service.adoptConfig(rootUri, 'config:preview'),
            /não é estado de runtime do IDE/
        );
    });
});
