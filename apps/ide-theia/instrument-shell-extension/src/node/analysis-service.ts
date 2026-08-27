// ANALISAR PROJETO E MATERIAIS (§5) — implementação.
//
// Toda função aqui obedece à mesma regra: só emite um candidato quando pode
// apontar o arquivo, e quando possível a linha, que sustenta a afirmação. Se a
// evidência não existe, o candidato não sai — não há caminho no código que
// produza uma afirmação sem procedência.
//
// Nada aqui grava, exceto `adoptCommands`, que é o ato explícito de adoção.

import { injectable, inject } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { FileUri } from '@theia/core/lib/common/file-uri';
import * as fs from 'fs';
import * as path from 'path';
import {
    AnalysisService,
    CommandCandidate,
    ConfigCandidate,
    GitFacts,
    GuidanceCandidate,
    InstructionCandidate,
    IntegrationCandidate,
    ProjectAnalysis,
    Provenance,
    ReferenceCandidate,
    RelationCandidate,
    ServiceCandidate,
    StackCandidate
} from '../common/analysis-protocol';
import { GovernedWriteService } from '../common/governed-protocol';
import { EngineService } from 'engine-extension';

/** Diretórios nunca abertos, e reportados como não abertos. */
const SKIP_DIRS = [
    '.git',
    'node_modules',
    'target',
    'dist',
    'lib',
    'src-gen',
    '.instrument',
    '.aag',
    'out',
    'build'
];

/**
 * Papéis que os checks do §4 realmente executam.
 *
 * Fonte única: o serviço marca cada candidato, a tela lê a marca, e a adoção
 * usa a mesma lista. Duplicar isto na UI faria a tela oferecer adoção que o
 * serviço recusa.
 */
const RUNNABLE_SLUGS: CommandCandidate['slug'][] = ['build', 'test', 'typecheck'];

/** Comprimento máximo de um trecho de evidência. */
const MAX_EXCERPT = 200;

/**
 * Arquivos de instrução detectados por NOME.
 *
 * Nome é a convenção pública dessas ferramentas: `AGENTS.md` é AGENTS.md em
 * qualquer repo. Detectar "arquivo que parece instrução" por conteúdo seria
 * adivinhação, e o §5 não emite afirmação que não dá para conferir.
 */
const INSTRUCTION_FILES: [string, InstructionCandidate['kind'], string][] = [
    ['AGENTS.md', 'agent', 'Instruções para agentes (AGENTS.md)'],
    ['CLAUDE.md', 'agent', 'Instruções para o Claude (CLAUDE.md)'],
    ['GEMINI.md', 'agent', 'Instruções para o Gemini (GEMINI.md)'],
    ['.cursorrules', 'agent', 'Regras do Cursor'],
    ['.windsurfrules', 'agent', 'Regras do Windsurf'],
    ['.github/copilot-instructions.md', 'agent', 'Instruções do Copilot'],
    ['CONTRIBUTING.md', 'contribution', 'Como contribuir'],
    ['.editorconfig', 'editor', 'Convenções de editor']
];

/** Diretórios varridos por documentos, além da raiz. */
const DOC_DIRS = ['docs', 'doc', '.product'];

/** Teto de arquivos de texto lidos na varredura de documentos e relações. */
const MAX_DOC_FILES = 60;

/** Teto por lista de candidatos. Todo corte é reportado em `limits`. */
const MAX_CANDIDATES = 20;

/**
 * Papel de cada script conhecido no vocabulário do §4.
 *
 * Só nomes inequívocos. `dev` e `serve` ficam de fora de propósito: um script
 * que sobe servidor não é um check, e classificá-lo como `start` levaria o §4 a
 * rodar algo que não termina.
 */
const SCRIPT_ROLES: Record<string, CommandCandidate['slug']> = {
    build: 'build',
    test: 'test',
    typecheck: 'typecheck',
    tsc: 'typecheck',
    'type-check': 'typecheck',
    lint: 'lint',
    start: 'start'
};

@injectable()
export class AnalysisServiceImpl implements AnalysisService {

    @inject(GovernedWriteService) protected readonly governed!: GovernedWriteService;
    @inject(EngineService) protected readonly engine!: EngineService;

    async analyze(rootUri: string): Promise<ProjectAnalysis> {
        const root = this.rootPath(rootUri);
        const declared = this.declaredSlugs(root);
        const limits: string[] = [];

        const commands = this.commandCandidates(root).map(candidate => ({
            ...candidate,
            alreadyDeclared: declared.has(candidate.slug),
            runnableByChecks: RUNNABLE_SLUGS.includes(candidate.slug)
        }));
        const services = this.serviceCandidates(root);
        const instructions = this.instructionCandidates(root);
        const docs = this.docFiles(root, limits);

        return {
            stack: this.stackCandidates(root),
            commands,
            git: this.gitFacts(root),
            services,
            integrations: this.integrationCandidates(root),
            instructions,
            guidance: this.guidanceCandidates(root, instructions, limits),
            config: this.configCandidates(root, commands),
            references: this.referenceCandidates(root, docs, limits),
            relations: this.relationCandidates(root, docs, commands, services, limits),
            skipped: SKIP_DIRS.filter(d => fs.existsSync(path.join(root, d))),
            limits
        };
    }

    async adoptCommands(rootUri: string, slugs: string[]): Promise<ProjectAnalysis> {
        const root = this.rootPath(rootUri);
        const analysis = await this.analyze(rootUri);
        const wanted = new Set(slugs);

        const file = path.join(root, '.instrument', 'checks.json');
        // Preserva o que já estava lá: adoção substitui os slugs pedidos, nunca
        // apaga um comando que alguém escreveu à mão.
        let current: Record<string, unknown> = {};
        try {
            current = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            current = {};
        }

        for (const candidate of analysis.commands) {
            if (!wanted.has(candidate.slug) || !RUNNABLE_SLUGS.includes(candidate.slug)) {
                continue;
            }
            current[candidate.slug] = candidate.cwd
                ? { command: candidate.command, cwd: candidate.cwd }
                : { command: candidate.command };
        }

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, 'utf8');

        // Reanalisa para que `alreadyDeclared` reflita o que acabou de acontecer.
        return this.analyze(rootUri);
    }

    async adoptConfig(rootUri: string, id: string): Promise<ProjectAnalysis> {
        const root = this.rootPath(rootUri);
        const analysis = await this.analyze(rootUri);
        const candidate = analysis.config.find(c => c.id === id);
        if (!candidate) {
            throw new Error(`configuração desconhecida: ${id}`);
        }
        // O destino é sempre dentro de `.instrument/`: estado de runtime do IDE.
        // Qualquer outro caminho é conteúdo do projeto e teria de ir ao broker.
        if (!candidate.target.startsWith('.instrument/')) {
            throw new Error(
                `${candidate.target} não é estado de runtime do IDE — escrita recusada aqui`
            );
        }
        const file = path.join(root, candidate.target);
        let current: Record<string, unknown> = {};
        try {
            current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        } catch {
            current = {};
        }
        // Preserva o que já estava escrito à mão: adoção acrescenta as chaves
        // propostas, e só elas.
        const merged = { ...current, ...candidate.proposed };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
        return this.analyze(rootUri);
    }

    async importGuidance(
        rootUri: string,
        id: string
    ): Promise<{ guidanceId: string; state: string }> {
        const analysis = await this.analyze(rootUri);
        const candidate = analysis.guidance.find(g => g.id === id);
        if (!candidate) {
            throw new Error(`guidance desconhecida: ${id}`);
        }
        // Vai para a Guidance Library do §13 como CANDIDATA. A procedência
        // detectada (arquivo e linha) viaja com ela e substitui a genérica que o
        // motor escreveria — é ela que deixa a orientação conferível.
        const imported = await this.engine.libraryImport(
            this.rootPath(rootUri),
            candidate.title,
            candidate.text,
            `${candidate.provenance.path}${
                typeof candidate.provenance.line === 'number' ? `:${candidate.provenance.line}` : ''
            }`,
            'projeto'
        );
        return { guidanceId: imported.id, state: imported.state };
    }

    async registerReference(
        rootUri: string,
        id: string
    ): Promise<{ proposalId: string; relPath: string }> {
        const analysis = await this.analyze(rootUri);
        const candidate = analysis.references.find(r => r.id === id);
        if (!candidate) {
            throw new Error(`referência desconhecida: ${id}`);
        }
        const relPath = `.product/references/${this.slug(candidate.id)}.json`;
        const body = {
            id: candidate.id,
            kind: candidate.kind,
            target: candidate.target,
            label: candidate.label,
            provenance: candidate.provenance,
            // Para arquivo do projeto, o asset JÁ está versionado aqui e o
            // registro aponta para ele. Para URL, não há cópia local, e o
            // registro diz isso em vez de fingir que baixou.
            asset: candidate.presentInWorkspace ? candidate.target : null,
            assetNote: candidate.assetNote ?? null
        };
        const proposal = await this.governed.proposeWrite(
            rootUri,
            relPath,
            `${JSON.stringify(body, null, 2)}\n`
        );
        return { proposalId: proposal.id, relPath: proposal.relPath };
    }

    // ── instruções ────────────────────────────────────────────────────────

    /** Arquivos de instrução presentes, com o que foi realmente lido deles. */
    protected instructionCandidates(root: string): InstructionCandidate[] {
        const out: InstructionCandidate[] = [];
        for (const [rel, kind, label] of INSTRUCTION_FILES) {
            const abs = path.join(root, rel);
            const raw = this.readOr(abs);
            if (raw === undefined) {
                continue;
            }
            out.push({
                id: `instruction:${rel}`,
                label,
                kind,
                bytes: Buffer.byteLength(raw, 'utf8'),
                headings: this.headings(raw),
                provenance: {
                    path: rel,
                    excerpt: this.firstMeaningfulLine(abs) ?? rel
                }
            });
        }
        return out;
    }

    /** Títulos markdown, na ordem do arquivo. */
    protected headings(raw: string): string[] {
        return raw
            .split('\n')
            .filter(line => /^#{1,6}\s+\S/.test(line))
            .map(line => this.clip(line.replace(/^#+\s*/, '').trim()));
    }

    // ── guidance ──────────────────────────────────────────────────────────

    /**
     * Candidatos de orientação, um por seção de arquivo de instrução.
     *
     * A seção é a unidade porque foi quem escreveu que a delimitou: o título é o
     * título dela, e o texto é a primeira linha de conteúdo, verbatim. Arquivo
     * sem título nenhum rende UM candidato, o próprio arquivo.
     *
     * `strength` nunca sai de `suggestion` — ver o contrato.
     */
    protected guidanceCandidates(
        root: string,
        instructions: InstructionCandidate[],
        limits: string[]
    ): GuidanceCandidate[] {
        const out: GuidanceCandidate[] = [];
        // Nomes que a biblioteca já tem, para não oferecer importar duas vezes a
        // mesma orientação. Lido do registry real — se ele não existe ainda, o
        // conjunto é vazio, que é a verdade.
        const existingNames = this.libraryNames(root);
        for (const instruction of instructions) {
            const raw = this.readOr(path.join(root, instruction.provenance.path));
            if (!raw) {
                continue;
            }
            const lines = raw.split('\n');
            const sections: { title: string; line: number; text: string }[] = [];
            lines.forEach((line, index) => {
                if (!/^#{1,6}\s+\S/.test(line)) {
                    return;
                }
                const body = lines
                    .slice(index + 1)
                    .find(l => l.trim().length > 0 && !/^#{1,6}\s/.test(l));
                if (!body) {
                    // Seção sem conteúdo não vira orientação: não há texto para
                    // sustentar nada.
                    return;
                }
                sections.push({
                    title: line.replace(/^#+\s*/, '').trim(),
                    line: index + 1,
                    text: body.trim()
                });
            });

            if (sections.length === 0) {
                const first = this.firstMeaningfulLine(path.join(root, instruction.provenance.path));
                if (first) {
                    sections.push({ title: instruction.label, line: 1, text: first });
                }
            }

            for (const section of sections) {
                const id = `guidance:${instruction.provenance.path}#${this.slug(section.title)}`;
                out.push({
                    id,
                    title: this.clip(section.title),
                    strength: 'suggestion',
                    text: this.clip(section.text),
                    provenance: {
                        path: instruction.provenance.path,
                        line: section.line,
                        excerpt: this.clip(section.text)
                    },
                    // A biblioteca do §13 é o destino; `alreadyDeclared` lê o
                    // registry dela, não um arquivo inventado aqui.
                    target: '.guidance/ (biblioteca do projeto)',
                    alreadyDeclared: existingNames.has(section.title.trim())
                });
            }
        }
        if (out.length > MAX_CANDIDATES) {
            limits.push(
                `guidance: ${out.length} seções encontradas, ${MAX_CANDIDATES} mostradas`
            );
            return out.slice(0, MAX_CANDIDATES);
        }
        return out;
    }

    // ── configuração ──────────────────────────────────────────────────────

    /**
     * Configuração do IDE que o projeto já tem como declarar.
     *
     * Hoje: o preview do §4. Comandos de check têm caminho próprio de adoção
     * (`adoptCommands`), e duplicá-los aqui daria dois botões que escrevem o
     * mesmo arquivo com regras diferentes.
     *
     * A url de saúde só entra quando existe uma porta literal em código para
     * apontar. Sem isso o candidato sai COM buraco declarado — e o §4 já diz que
     * preview sem url nunca passa de "iniciando", então a tela não promete saúde
     * que ninguém pode medir.
     */
    protected configCandidates(root: string, commands: CommandCandidate[]): ConfigCandidate[] {
        const start = commands.find(c => c.slug === 'start');
        if (!start) {
            return [];
        }
        const provenance: Provenance[] = [start.provenance];
        const port = this.detectPort(root);
        if (port) {
            provenance.push(port.provenance);
        }
        const proposed: Record<string, unknown> = { command: start.command };
        if (start.cwd) {
            proposed.cwd = start.cwd;
        }
        if (port) {
            proposed.url = `http://127.0.0.1:${port.port}/`;
        }
        const declaredRaw = this.readOr(path.join(root, '.instrument', 'preview.json'));
        return [
            {
                id: 'config:preview',
                target: '.instrument/preview.json',
                label: 'Preview do projeto (§4)',
                proposed,
                provenance,
                alreadyDeclared: declaredRaw !== undefined,
                gap: port
                    ? undefined
                    : 'sem porta literal em código para montar a url de saúde — o preview vai ' +
                      'poder subir, mas nunca vai poder afirmar que está saudável'
            }
        ];
    }

    /** Uma porta literal, com a linha que a declara. */
    protected detectPort(root: string): { port: number; provenance: Provenance } | undefined {
        for (const rel of this.sourceFiles(root)) {
            const raw = this.readOr(path.join(root, rel));
            if (!raw) {
                continue;
            }
            const lines = raw.split('\n');
            for (let index = 0; index < lines.length; index += 1) {
                const line = lines[index];
                const match =
                    line.match(/PORT\s*(?:\?\?|\|\|)\s*(\d{2,5})/) ??
                    line.match(/listen\(\s*(\d{2,5})/);
                if (match) {
                    return {
                        port: Number(match[1]),
                        provenance: { path: rel, line: index + 1, excerpt: this.clip(line.trim()) }
                    };
                }
            }
        }
        return undefined;
    }

    // ── referências e relações ────────────────────────────────────────────

    /**
     * Documentos lidos para referências e relações: markdown e texto na raiz e
     * nos diretórios de documentação. Limitado, e o limite é reportado.
     */
    protected docFiles(root: string, limits: string[]): string[] {
        const found: string[] = [];
        const consider = (dir: string): void => {
            for (const name of this.safeReaddir(dir)) {
                const abs = path.join(dir, name);
                let stat: fs.Stats;
                try {
                    stat = fs.statSync(abs);
                } catch {
                    continue;
                }
                if (stat.isDirectory()) {
                    continue;
                }
                if (!/\.(md|markdown|txt|json)$/i.test(name)) {
                    continue;
                }
                if (found.length >= MAX_DOC_FILES) {
                    limits.push(`documentos: leitura parada em ${MAX_DOC_FILES} arquivos`);
                    return;
                }
                found.push(path.relative(root, abs));
            }
        };
        consider(root);
        for (const dir of DOC_DIRS) {
            const abs = path.join(root, dir);
            if (fs.existsSync(abs)) {
                consider(abs);
                for (const name of this.safeReaddir(abs)) {
                    const nested = path.join(abs, name);
                    try {
                        if (fs.statSync(nested).isDirectory()) {
                            consider(nested);
                        }
                    } catch {
                        /* ignorado: já contado como não lido */
                    }
                }
            }
        }
        return found;
    }

    /** Arquivos de código considerados na detecção de porta. */
    protected sourceFiles(root: string): string[] {
        const out: string[] = [];
        const walk = (dir: string, depth: number): void => {
            if (depth > 2 || out.length >= MAX_DOC_FILES) {
                return;
            }
            for (const name of this.safeReaddir(dir)) {
                if (SKIP_DIRS.includes(name)) {
                    continue;
                }
                const abs = path.join(dir, name);
                try {
                    if (fs.statSync(abs).isDirectory()) {
                        walk(abs, depth + 1);
                    } else if (/\.(ts|tsx|js|mjs|cjs|py|rs|go)$/.test(name)) {
                        out.push(path.relative(root, abs));
                    }
                } catch {
                    /* ignorado */
                }
            }
        };
        walk(root, 0);
        return out;
    }

    /**
     * Referências citadas pelos documentos do projeto.
     *
     * URL: registrada como referência, NÃO baixada — este serviço não tem rede, e
     * um asset local inventado a partir de um link seria conteúdo que ninguém
     * buscou. Caminho relativo: só entra quando o arquivo EXISTE, e aí já é um
     * asset versionado no workspace.
     */
    protected referenceCandidates(
        root: string,
        docs: string[],
        limits: string[]
    ): ReferenceCandidate[] {
        const out: ReferenceCandidate[] = [];
        const seen = new Set<string>();

        for (const rel of docs) {
            const raw = this.readOr(path.join(root, rel));
            if (!raw) {
                continue;
            }
            const lines = raw.split('\n');
            lines.forEach((line, index) => {
                const urls = line.match(/https?:\/\/[^\s)\]"'<>]+/g) ?? [];
                for (const url of urls) {
                    if (seen.has(url)) {
                        continue;
                    }
                    seen.add(url);
                    out.push({
                        id: `ref:${url}`,
                        kind: 'url',
                        target: url,
                        label: url.replace(/^https?:\/\//, ''),
                        provenance: { path: rel, line: index + 1, excerpt: this.clip(line.trim()) },
                        presentInWorkspace: false,
                        assetNote:
                            'URL externa: não baixada. A análise não tem rede, e registrar uma ' +
                            'cópia local sem buscá-la seria afirmar conteúdo inexistente.',
                        alreadyRegistered: this.referenceRegistered(root, `ref:${url}`)
                    });
                }

                const links = line.match(/\]\(([^)\s]+)\)/g) ?? [];
                for (const link of links) {
                    const target = link.slice(2, -1);
                    if (/^https?:/.test(target) || target.startsWith('#')) {
                        continue;
                    }
                    const resolved = path
                        .normalize(path.join(path.dirname(rel), target.split('#')[0]))
                        .replace(/\\/g, '/');
                    if (seen.has(resolved) || resolved.startsWith('..')) {
                        continue;
                    }
                    if (!fs.existsSync(path.join(root, resolved))) {
                        // Link quebrado não é referência: não há material para
                        // apontar. Fica de fora em vez de virar linha morta.
                        continue;
                    }
                    seen.add(resolved);
                    out.push({
                        id: `ref:${resolved}`,
                        kind: 'file',
                        target: resolved,
                        label: resolved,
                        provenance: { path: rel, line: index + 1, excerpt: this.clip(line.trim()) },
                        presentInWorkspace: true,
                        alreadyRegistered: this.referenceRegistered(root, `ref:${resolved}`)
                    });
                }
            });
        }

        if (out.length > MAX_CANDIDATES) {
            limits.push(`referências: ${out.length} citadas, ${MAX_CANDIDATES} mostradas`);
            return out.slice(0, MAX_CANDIDATES);
        }
        return out;
    }

    /** Nomes de guidance que a biblioteca do §13 já contém. */
    protected libraryNames(root: string): Set<string> {
        const raw = this.readOr(path.join(root, '.guidance', 'registry.json'));
        if (!raw) {
            return new Set();
        }
        try {
            const parsed = JSON.parse(raw) as { entries?: { name?: string }[] };
            return new Set(
                (parsed.entries ?? [])
                    .map(entry => (entry.name ?? '').trim())
                    .filter(name => name.length > 0)
            );
        } catch {
            return new Set();
        }
    }

    protected referenceRegistered(root: string, id: string): boolean {
        return fs.existsSync(
            path.join(root, '.product', 'references', `${this.slug(id)}.json`)
        );
    }

    /**
     * Relações literais entre materiais.
     *
     * Um documento que cita um caminho existente, um script declarado, ou o nome
     * de uma variável de serviço detectada. Nada de inferência semântica: "este
     * doc PARECE falar do módulo de leilão" é exatamente o tipo de afirmação que
     * o §5 não emite.
     */
    protected relationCandidates(
        root: string,
        docs: string[],
        commands: CommandCandidate[],
        services: ServiceCandidate[],
        limits: string[]
    ): RelationCandidate[] {
        const out: RelationCandidate[] = [];
        const sources = this.sourceFiles(root);

        for (const rel of docs) {
            const raw = this.readOr(path.join(root, rel));
            if (!raw) {
                continue;
            }
            const lines = raw.split('\n');
            lines.forEach((line, index) => {
                const provenance: Provenance = {
                    path: rel,
                    line: index + 1,
                    excerpt: this.clip(line.trim())
                };
                for (const source of sources) {
                    if (line.includes(source)) {
                        out.push({
                            id: `rel:${rel}->${source}:${index + 1}`,
                            from: `doc:${rel}`,
                            to: `file:${source}`,
                            kind: 'menciona-arquivo',
                            provenance
                        });
                    }
                }
                for (const command of commands) {
                    if (line.includes(command.command)) {
                        out.push({
                            id: `rel:${rel}->command:${command.slug}:${index + 1}`,
                            from: `doc:${rel}`,
                            to: `command:${command.slug}`,
                            kind: 'menciona-comando',
                            provenance
                        });
                    }
                }
                for (const service of services) {
                    if (line.includes(service.id)) {
                        out.push({
                            id: `rel:${rel}->service:${service.id}:${index + 1}`,
                            from: `doc:${rel}`,
                            to: `service:${service.id}`,
                            kind: 'menciona-servico',
                            provenance
                        });
                    }
                }
            });
        }

        if (out.length > MAX_CANDIDATES) {
            limits.push(`relações: ${out.length} encontradas, ${MAX_CANDIDATES} mostradas`);
            return out.slice(0, MAX_CANDIDATES);
        }
        return out;
    }

    /** Slug estável para nome de arquivo, derivado do id ou do título. */
    protected slug(text: string): string {
        return (
            text
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 60) || 'sem-nome'
        );
    }

    // ── stack ─────────────────────────────────────────────────────────────

    /** Uma tecnologia por manifesto encontrado. O manifesto É a evidência. */
    protected stackCandidates(root: string): StackCandidate[] {
        const manifests: [string, string, string][] = [
            ['Cargo.toml', 'rust', 'Rust'],
            ['package.json', 'node', 'Node / JavaScript'],
            ['pyproject.toml', 'python', 'Python'],
            ['go.mod', 'go', 'Go'],
            ['pom.xml', 'java', 'Java (Maven)'],
            ['Gemfile', 'ruby', 'Ruby'],
            ['tsconfig.json', 'typescript', 'TypeScript']
        ];
        const found: StackCandidate[] = [];
        for (const [file, id, label] of manifests) {
            const abs = path.join(root, file);
            if (!fs.existsSync(abs)) {
                continue;
            }
            found.push({
                id,
                label,
                provenance: [
                    {
                        path: file,
                        excerpt: this.firstMeaningfulLine(abs) ?? file
                    }
                ]
            });
        }
        return found;
    }

    // ── comandos ──────────────────────────────────────────────────────────

    /**
     * Comandos que o projeto declara para si mesmo.
     *
     * Só de declaração explícita: `scripts` do `package.json`, e a presença de
     * um manifesto Rust (onde `cargo build`/`cargo test` são o contrato da
     * ferramenta, não invenção nossa). Nada é deduzido de nome de diretório.
     */
    protected commandCandidates(
        root: string
    ): Omit<CommandCandidate, 'alreadyDeclared' | 'runnableByChecks'>[] {
        const out: Omit<CommandCandidate, 'alreadyDeclared' | 'runnableByChecks'>[] = [];

        const pkgPath = path.join(root, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const raw = this.readOr(pkgPath);
            let scripts: Record<string, string> = {};
            try {
                scripts = (JSON.parse(raw ?? '{}') as { scripts?: Record<string, string> }).scripts ?? {};
            } catch {
                scripts = {};
            }
            for (const [name, body] of Object.entries(scripts)) {
                const slug = SCRIPT_ROLES[name];
                if (!slug || typeof body !== 'string') {
                    continue;
                }
                out.push({
                    slug,
                    command: `npm run ${name}`,
                    provenance: {
                        path: 'package.json',
                        line: this.lineOf(raw, `"${name}"`),
                        // O corpo do script é a evidência: mostra o que `npm run`
                        // vai de fato executar, em vez de pedir confiança.
                        excerpt: this.clip(`"${name}": "${body}"`)
                    }
                });
            }
        }

        const cargoPath = path.join(root, 'Cargo.toml');
        if (fs.existsSync(cargoPath)) {
            const excerpt = this.firstMeaningfulLine(cargoPath) ?? 'Cargo.toml';
            out.push({
                slug: 'build',
                command: 'cargo build',
                provenance: { path: 'Cargo.toml', excerpt }
            });
            out.push({
                slug: 'test',
                command: 'cargo test',
                provenance: { path: 'Cargo.toml', excerpt }
            });
        }

        return out;
    }

    /** Slugs já presentes em `.instrument/checks.json`. */
    protected declaredSlugs(root: string): Set<string> {
        try {
            const raw = fs.readFileSync(path.join(root, '.instrument', 'checks.json'), 'utf8');
            return new Set(Object.keys(JSON.parse(raw) as Record<string, unknown>));
        } catch {
            return new Set();
        }
    }

    // ── git ───────────────────────────────────────────────────────────────

    /**
     * Fatos de Git lidos do próprio `.git`, sem rodar processo.
     *
     * Ler `HEAD` e `config` é determinístico e não disputa o lock do git do
     * usuário. Um `.git` que existe mas não pode ser lido devolve `isRepo` com
     * o que deu para observar, nunca um branch inventado.
     */
    protected gitFacts(root: string): GitFacts {
        const gitDir = path.join(root, '.git');
        if (!fs.existsSync(gitDir)) {
            return { isRepo: false, remotes: [], provenance: [] };
        }
        const provenance: Provenance[] = [];
        let branch: string | undefined;

        const headPath = path.join(gitDir, 'HEAD');
        const head = this.readOr(headPath);
        if (head) {
            const match = head.match(/ref:\s*refs\/heads\/(.+)/);
            if (match) {
                branch = match[1].trim();
                provenance.push({
                    path: '.git/HEAD',
                    line: 1,
                    excerpt: this.clip(head.trim())
                });
            }
        }

        const remotes: { name: string; url: string }[] = [];
        const configPath = path.join(gitDir, 'config');
        const config = this.readOr(configPath);
        if (config) {
            const lines = config.split('\n');
            let currentRemote: string | undefined;
            lines.forEach((line, index) => {
                const header = line.match(/^\s*\[remote "(.+)"\]/);
                if (header) {
                    currentRemote = header[1];
                    return;
                }
                if (line.match(/^\s*\[/)) {
                    currentRemote = undefined;
                    return;
                }
                const url = line.match(/^\s*url\s*=\s*(.+)$/);
                if (url && currentRemote) {
                    remotes.push({ name: currentRemote, url: url[1].trim() });
                    provenance.push({
                        path: '.git/config',
                        line: index + 1,
                        excerpt: this.clip(line.trim())
                    });
                }
            });
        }

        return { isRepo: true, branch, remotes, provenance };
    }

    // ── serviços ──────────────────────────────────────────────────────────

    /**
     * Serviços que o projeto espera por perto.
     *
     * Container: cada chave sob `services:` num compose. Banco/HTTP: apenas
     * NOMES de variável em `.env*`, nunca o valor — o valor é justamente onde
     * mora a credencial, e mostrá-lo transformaria a análise em vazamento.
     */
    protected serviceCandidates(root: string): ServiceCandidate[] {
        const out: ServiceCandidate[] = [];

        for (const file of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml']) {
            const abs = path.join(root, file);
            const raw = this.readOr(abs);
            if (!raw) {
                continue;
            }
            const lines = raw.split('\n');
            let inServices = false;
            lines.forEach((line, index) => {
                if (/^services:\s*$/.test(line)) {
                    inServices = true;
                    return;
                }
                if (inServices && /^\S/.test(line)) {
                    inServices = false;
                    return;
                }
                const service = inServices ? line.match(/^\s{2}([A-Za-z0-9._-]+):\s*$/) : null;
                if (service) {
                    out.push({
                        id: service[1],
                        label: service[1],
                        kind: 'container',
                        provenance: { path: file, line: index + 1, excerpt: this.clip(line.trim()) }
                    });
                }
            });
        }

        for (const file of this.safeReaddir(root).filter(f => f === '.env' || f.startsWith('.env.'))) {
            const raw = this.readOr(path.join(root, file));
            if (!raw) {
                continue;
            }
            raw.split('\n').forEach((line, index) => {
                const named = line.match(/^\s*([A-Z0-9_]*(?:DATABASE|DB|POSTGRES|MYSQL|REDIS|MONGO)[A-Z0-9_]*)\s*=/);
                const http = line.match(/^\s*([A-Z0-9_]*(?:API_URL|BASE_URL|ENDPOINT)[A-Z0-9_]*)\s*=/);
                const hit = named ?? http;
                if (!hit) {
                    return;
                }
                out.push({
                    id: hit[1],
                    label: hit[1],
                    kind: named ? 'database' : 'http',
                    provenance: {
                        path: file,
                        line: index + 1,
                        // Só o nome da variável. O valor NUNCA é lido para a
                        // evidência: é onde a credencial está.
                        excerpt: `${hit[1]}=<valor não lido>`
                    }
                });
            });
        }

        return out;
    }

    // ── integrações ───────────────────────────────────────────────────────

    protected integrationCandidates(root: string): IntegrationCandidate[] {
        const out: IntegrationCandidate[] = [];

        const workflows = path.join(root, '.github', 'workflows');
        for (const file of this.safeReaddir(workflows).filter(f => /\.ya?ml$/.test(f))) {
            const rel = path.join('.github/workflows', file);
            out.push({
                id: `ci:${file}`,
                label: file,
                kind: 'ci',
                provenance: {
                    path: rel,
                    excerpt: this.firstMeaningfulLine(path.join(workflows, file)) ?? rel
                }
            });
        }

        for (const file of ['.mcp.json', 'mcp.json']) {
            const abs = path.join(root, file);
            const raw = this.readOr(abs);
            if (!raw) {
                continue;
            }
            let servers: Record<string, unknown> = {};
            try {
                servers = (JSON.parse(raw) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {};
            } catch {
                continue;
            }
            for (const name of Object.keys(servers)) {
                out.push({
                    id: `mcp:${name}`,
                    label: name,
                    kind: 'mcp',
                    provenance: { path: file, line: this.lineOf(raw, `"${name}"`), excerpt: this.clip(`"${name}"`) }
                });
            }
        }

        for (const file of ['Dockerfile', 'Containerfile']) {
            const abs = path.join(root, file);
            if (!fs.existsSync(abs)) {
                continue;
            }
            out.push({
                id: `container:${file}`,
                label: file,
                kind: 'container',
                provenance: { path: file, excerpt: this.firstMeaningfulLine(abs) ?? file }
            });
        }

        return out;
    }

    // ── utilidades ────────────────────────────────────────────────────────

    protected rootPath(rootUri: string): string {
        return FileUri.fsPath(new URI(rootUri));
    }

    protected readOr(abs: string): string | undefined {
        try {
            return fs.readFileSync(abs, 'utf8');
        } catch {
            return undefined;
        }
    }

    protected safeReaddir(dir: string): string[] {
        try {
            return fs.readdirSync(dir);
        } catch {
            return [];
        }
    }

    /**
     * Primeira linha que serve como evidência.
     *
     * Pula comentários E pontuação estrutural: a primeira linha de um
     * `package.json` é `{`, que não deixa ninguém conferir coisa alguma. Uma
     * evidência que não sustenta a afirmação é pior que nenhuma, porque ocupa o
     * lugar dela.
     */
    protected firstMeaningfulLine(abs: string): string | undefined {
        const raw = this.readOr(abs);
        if (!raw) {
            return undefined;
        }
        const line = raw
            .split('\n')
            .map(l => l.trim())
            .find(
                l =>
                    l.length > 0 &&
                    !l.startsWith('#') &&
                    !l.startsWith('//') &&
                    !/^[{}[\],]+$/.test(l)
            );
        return line ? this.clip(line) : undefined;
    }

    /** Linha 1-based onde `needle` aparece, quando aparece. */
    protected lineOf(raw: string | undefined, needle: string): number | undefined {
        if (!raw) {
            return undefined;
        }
        const index = raw.split('\n').findIndex(l => l.includes(needle));
        return index >= 0 ? index + 1 : undefined;
    }

    protected clip(text: string): string {
        return text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT)}…` : text;
    }
}
