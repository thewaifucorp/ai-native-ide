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

function fixture(): Fixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-'));
    return {
        service: new AnalysisServiceImpl(),
        root,
        rootUri: FileUri.create(root).toString()
    };
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
