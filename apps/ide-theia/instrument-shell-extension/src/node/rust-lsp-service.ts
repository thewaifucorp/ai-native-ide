// Cliente LSP do `rust-analyzer`, falado direto pelo backend.
//
// A justificativa de existir está em `../common/rust-lsp-protocol.ts`: a
// extensão do VS Code não ativa neste host de plugins, medido, então o cliente é
// nosso. Aqui vive o mínimo honesto de LSP — enquadramento `Content-Length`,
// `initialize`/`initialized`, `didOpen`/`didChange` e escuta de
// `publishDiagnostics` — mais a busca portátil do binário.

import { injectable } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    RustCompletion,
    RustDiagnostic,
    RustHover,
    RustLocation,
    RustLspProbe,
    RustLspService,
    RustLspStatus,
    RustPosition
} from '../common/rust-lsp-protocol';

/** Severidade do LSP (1..4) no vocabulário que o editor usa. */
const SEVERITY = ['error', 'warning', 'information', 'hint'];

/**
 * `CompletionItemKind` do LSP (1..25) em palavra de gente.
 *
 * O número cru vazaria para a tela como "kind 3", que não diz nada a ninguém.
 */
const COMPLETION_KIND = [
    'text', 'method', 'function', 'constructor', 'field', 'variable', 'class',
    'interface', 'module', 'property', 'unit', 'value', 'enum', 'keyword',
    'snippet', 'color', 'file', 'reference', 'folder', 'enum-member',
    'constant', 'struct', 'event', 'operator', 'type-parameter'
];

/** Quanto se espera por uma resposta antes de desistir e dizer que desistiu. */
const REQUEST_TIMEOUT_MS = 15_000;

interface Server {
    child: ChildProcessWithoutNullStreams;
    /** Buffer de bytes ainda não enquadrados. */
    buffer: Buffer;
    /** Diagnósticos por caminho absoluto, como o servidor os publicou. */
    diagnostics: Map<string, RustDiagnostic[]>;
    open: Set<string>;
    ready: boolean;
    problem?: string;
    nextId: number;
    /**
     * Pedidos esperando resposta, por id.
     *
     * Sem isto, hover e definição não existem: o LSP responde de forma assíncrona
     * e a única coisa que liga pergunta a resposta é o id. Cada entrada tem
     * prazo — um servidor que nunca responde não pode deixar a tela girando para
     * sempre.
     */
    pending: Map<number, (result: unknown, error?: string) => void>;
}

@injectable()
export class RustLspServiceImpl implements RustLspService {

    protected readonly servers = new Map<string, Server>();

    // ── busca do binário ──────────────────────────────────────────────────

    /**
     * Procura o `rust-analyzer` em lugares padrão, em qualquer máquina.
     *
     * A ordem é a que uma pessoa esperaria: primeiro o que ela colocou no PATH,
     * depois o que o rustup gerencia, depois o diretório do cargo. Nenhum
     * caminho de usuário específico aparece aqui — o que existe é a convenção de
     * cada sistema.
     */
    async probe(): Promise<RustLspProbe> {
        const rustup = this.which('rustup');
        const rustupAvailable = !!rustup;

        const candidatos: [string, string | undefined][] = [
            ['path', this.which('rust-analyzer')],
            ['rustup', rustup ? this.rustupWhich(rustup) : undefined],
            ['cargo-home', this.cargoHomeBinary()]
        ];
        // Arquivo existir NÃO é ferramenta funcionar.
        //
        // O rustup instala um SHIM em `~/.cargo/bin/rust-analyzer` mesmo quando o
        // componente não está instalado. O arquivo está lá, executável, e ao ser
        // chamado responde `error: Unknown binary 'rust-analyzer' in official
        // toolchain`. A primeira versão disto aceitou a existência do arquivo
        // como prova, e o resultado foi um servidor que morria na hora com a
        // capability jurando estar pronta — o pior dos dois mundos.
        //
        // Então a prova é o binário se apresentar: sem versão, não conta.
        let shimQuebrado: string | undefined;
        for (const [source, candidato] of candidatos) {
            if (!candidato || !fs.existsSync(candidato)) {
                continue;
            }
            const version = this.version(candidato);
            if (version) {
                return {
                    path: candidato,
                    version,
                    source,
                    rustupAvailable,
                    detail: `${version} — encontrado em ${candidato} (via ${source})`
                };
            }
            shimQuebrado = candidato;
        }
        if (shimQuebrado) {
            return {
                source: 'shim sem componente',
                rustupAvailable,
                detail:
                    `existe um atalho em ${shimQuebrado}, mas ele não é um servidor: chamá-lo não `
                    + 'devolve versão. É o shim do rustup sem o componente instalado — '
                    + (rustupAvailable
                        ? 'instale o componente `rust-analyzer`.'
                        : 'instale o rustup e o componente.')
            };
        }
        return {
            source: 'não encontrado',
            rustupAvailable,
            detail: rustupAvailable
                ? 'rust-analyzer não está instalado; o rustup desta máquina pode instalá-lo'
                : 'rust-analyzer não está instalado e não há rustup para instalá-lo — '
                  + 'instale o rustup (https://rustup.rs) ou ponha o binário no PATH'
        };
    }

    async install(): Promise<RustLspProbe> {
        const rustup = this.which('rustup');
        if (!rustup) {
            throw new Error(
                'sem rustup nesta máquina: instalar o componente exige rustup, ou ponha o '
                + 'binário do rust-analyzer no PATH'
            );
        }
        const result = spawnSync(rustup, ['component', 'add', 'rust-analyzer'], {
            encoding: 'utf8',
            timeout: 300_000
        });
        if (result.status !== 0) {
            const saida = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
            throw new Error(
                `\`rustup component add rust-analyzer\` falhou${saida ? `: ${saida.slice(0, 300)}` : ''}`
            );
        }
        return this.probe();
    }

    protected which(binario: string): string | undefined {
        // `which`/`where` dependem de shell e de sistema; resolver na mão sobre
        // PATH é o que funciona igual nos dois e não depende de shell nenhum.
        const nomes = process.platform === 'win32'
            ? [`${binario}.exe`, `${binario}.cmd`, `${binario}.bat`]
            : [binario];
        for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
            if (!dir) {
                continue;
            }
            for (const nome of nomes) {
                const alvo = path.join(dir, nome);
                if (fs.existsSync(alvo)) {
                    return alvo;
                }
            }
        }
        return undefined;
    }

    protected rustupWhich(rustup: string): string | undefined {
        const result = spawnSync(rustup, ['which', 'rust-analyzer'], {
            encoding: 'utf8',
            timeout: 20_000
        });
        const saida = (result.stdout ?? '').trim();
        return result.status === 0 && saida.length > 0 ? saida : undefined;
    }

    protected cargoHomeBinary(): string | undefined {
        const home = process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo');
        const nome = process.platform === 'win32' ? 'rust-analyzer.exe' : 'rust-analyzer';
        const alvo = path.join(home, 'bin', nome);
        return fs.existsSync(alvo) ? alvo : undefined;
    }

    protected version(binario: string): string | undefined {
        const result = spawnSync(binario, ['--version'], { encoding: 'utf8', timeout: 20_000 });
        const saida = `${result.stdout ?? ''}`.trim();
        // O shim do rustup responde no stdout com `error: Unknown binary …` e
        // ainda sai com código 0, então nem o código nem a presença de texto
        // servem: o que serve é a saída começar com o nome da ferramenta.
        const primeira = saida.split('\n')[0] ?? '';
        return /^rust-analyzer\b/i.test(primeira) ? primeira : undefined;
    }

    // ── ciclo do servidor ─────────────────────────────────────────────────

    async open(rootUri: string, fileUri: string, text: string): Promise<RustLspStatus> {
        const root = FileUri.fsPath(new URI(rootUri));
        const server = await this.ensure(root);
        if (!server) {
            return this.status(root);
        }
        const fsPath = FileUri.fsPath(new URI(fileUri));
        if (!server.open.has(fsPath)) {
            server.open.add(fsPath);
            this.notify(server, 'textDocument/didOpen', {
                textDocument: {
                    uri: this.toUri(fsPath),
                    languageId: 'rust',
                    version: 1,
                    text
                }
            });
        }
        return this.status(root);
    }

    async change(rootUri: string, fileUri: string, text: string): Promise<void> {
        const root = FileUri.fsPath(new URI(rootUri));
        const server = this.servers.get(root);
        const fsPath = FileUri.fsPath(new URI(fileUri));
        if (!server || !server.open.has(fsPath)) {
            return;
        }
        this.notify(server, 'textDocument/didChange', {
            textDocument: { uri: this.toUri(fsPath), version: Date.now() },
            contentChanges: [{ text }]
        });
    }

    async diagnostics(rootUri: string): Promise<RustDiagnostic[]> {
        const root = FileUri.fsPath(new URI(rootUri));
        const server = this.servers.get(root);
        if (!server) {
            return [];
        }
        return [...server.diagnostics.values()].flat();
    }

    async hover(
        rootUri: string,
        fileUri: string,
        at: RustPosition
    ): Promise<RustHover | undefined> {
        const server = await this.serverFor(rootUri, fileUri);
        if (!server) {
            return undefined;
        }
        const raw = await this.request<Record<string, unknown> | null>(
            server,
            'textDocument/hover',
            this.textDocumentPosition(fileUri, at)
        ).catch(() => null);
        const markdown = this.hoverText(raw);
        return markdown.length > 0 ? { markdown } : undefined;
    }

    /**
     * `hover.contents` tem três formas legais no LSP (string, marcado, lista).
     *
     * Tratar só uma delas daria hover vazio dependendo do servidor — e "vazio"
     * seria lido como "não há nada aqui", que é diferente de "eu não soube ler".
     */
    protected hoverText(raw: Record<string, unknown> | null): string {
        const contents = raw?.contents as unknown;
        if (!contents) {
            return '';
        }
        const umBloco = (bloco: unknown): string => {
            if (typeof bloco === 'string') {
                return bloco;
            }
            const objeto = bloco as { value?: unknown; language?: unknown };
            if (typeof objeto?.value === 'string') {
                return typeof objeto.language === 'string' && objeto.language.length > 0
                    ? `\`\`\`${objeto.language}\n${objeto.value}\n\`\`\``
                    : objeto.value;
            }
            return '';
        };
        const texto = Array.isArray(contents)
            ? contents.map(umBloco).filter(Boolean).join('\n\n')
            : umBloco(contents);
        return texto.trim();
    }

    async definition(
        rootUri: string,
        fileUri: string,
        at: RustPosition
    ): Promise<RustLocation[]> {
        const server = await this.serverFor(rootUri, fileUri);
        if (!server) {
            return [];
        }
        const raw = await this.request<unknown>(
            server,
            'textDocument/definition',
            this.textDocumentPosition(fileUri, at)
        ).catch(() => undefined);
        // A resposta pode ser um Location, uma lista, ou LocationLink — as três
        // são válidas, e ignorar duas daria "sem definição" onde há uma.
        const lista = Array.isArray(raw) ? raw : raw ? [raw] : [];
        return lista
            .map(item => {
                const alvo = item as {
                    uri?: string;
                    targetUri?: string;
                    range?: { start?: { line?: number; character?: number } };
                    targetSelectionRange?: { start?: { line?: number; character?: number } };
                };
                const uri = alvo.uri ?? alvo.targetUri;
                const start = (alvo.range ?? alvo.targetSelectionRange)?.start;
                if (!uri) {
                    return undefined;
                }
                return {
                    fsPath: this.fromUri(uri),
                    line: (start?.line ?? 0) + 1,
                    column: (start?.character ?? 0) + 1
                };
            })
            .filter((x): x is RustLocation => !!x);
    }

    async completion(
        rootUri: string,
        fileUri: string,
        at: RustPosition
    ): Promise<RustCompletion[]> {
        const server = await this.serverFor(rootUri, fileUri);
        if (!server) {
            return [];
        }
        const raw = await this.request<unknown>(
            server,
            'textDocument/completion',
            this.textDocumentPosition(fileUri, at)
        ).catch(() => undefined);
        const itens = Array.isArray(raw)
            ? raw
            : ((raw as { items?: unknown[] } | undefined)?.items ?? []);
        // Corte deliberado: uma lista de milhares atravessando o RPC trava a
        // digitação. O editor filtra o que mostra; o que importa é chegar rápido.
        return itens.slice(0, 200).map(item => {
            const c = item as {
                label?: unknown;
                kind?: unknown;
                detail?: unknown;
                insertText?: unknown;
            };
            return {
                label: String(c.label ?? ''),
                kind: COMPLETION_KIND[Number(c.kind ?? 1) - 1] ?? 'text',
                detail: typeof c.detail === 'string' ? c.detail : undefined,
                insertText: typeof c.insertText === 'string' ? c.insertText : undefined
            };
        }).filter(c => c.label.length > 0);
    }

    /** O servidor do projeto, com o arquivo garantidamente aberto nele. */
    protected async serverFor(rootUri: string, fileUri: string): Promise<Server | undefined> {
        const root = FileUri.fsPath(new URI(rootUri));
        const server = this.servers.get(root);
        if (!server || !server.ready) {
            return undefined;
        }
        const fsPath = FileUri.fsPath(new URI(fileUri));
        // Pedir sobre arquivo que o servidor não conhece devolve vazio sem erro,
        // o que pareceria "não há definição". Abrir primeiro evita a confusão.
        if (!server.open.has(fsPath)) {
            try {
                await this.open(rootUri, fileUri, fs.readFileSync(fsPath, 'utf8'));
            } catch {
                return undefined;
            }
        }
        return server;
    }

    protected textDocumentPosition(fileUri: string, at: RustPosition): object {
        const fsPath = FileUri.fsPath(new URI(fileUri));
        return {
            textDocument: { uri: this.toUri(fsPath) },
            // A pessoa lê linha 1; o LSP conta de 0.
            position: { line: Math.max(0, at.line - 1), character: Math.max(0, at.column - 1) }
        };
    }

    async stop(rootUri: string): Promise<RustLspStatus> {
        const root = FileUri.fsPath(new URI(rootUri));
        const server = this.servers.get(root);
        if (server) {
            // `shutdown`/`exit` é o pedido educado; matar é o que garante que
            // parou. Sem o segundo, "parei" viraria promessa — o mesmo defeito
            // que o preview já teve.
            this.notify(server, 'exit', undefined);
            server.child.kill();
            this.servers.delete(root);
        }
        return this.status(root);
    }

    protected async ensure(root: string): Promise<Server | undefined> {
        const existente = this.servers.get(root);
        if (existente && existente.child.exitCode === null && !existente.child.killed) {
            return existente;
        }
        const probe = await this.probe();
        if (!probe.path) {
            return undefined;
        }
        const child = spawn(probe.path, [], {
            cwd: root,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, RA_LOG: process.env.RA_LOG ?? 'error' }
        });
        const server: Server = {
            child,
            buffer: Buffer.alloc(0),
            diagnostics: new Map(),
            open: new Set(),
            ready: false,
            nextId: 1,
            pending: new Map()
        };
        this.servers.set(root, server);

        child.stdout.on('data', chunk => this.receive(server, chunk));
        child.on('error', error => {
            server.problem = `o servidor não pôde ser iniciado: ${error.message}`;
        });
        child.on('exit', code => {
            server.ready = false;
            if (code !== 0 && code !== null) {
                server.problem = `o servidor terminou com código ${code}`;
            }
            if (this.servers.get(root) === server) {
                this.servers.delete(root);
            }
        });
        // Stderr do rust-analyzer é log, não falha: guardamos a última linha
        // para o painel poder dizer algo verdadeiro se nada funcionar.
        child.stderr.on('data', chunk => {
            const linha = String(chunk).trim().split('\n').pop();
            if (linha && /error|panic/i.test(linha)) {
                server.problem = linha.slice(0, 300);
            }
        });

        this.lastProbe = probe;
        try {
            await this.request(server, 'initialize', {
                processId: process.pid,
                rootUri: this.toUri(root),
                capabilities: {
                    textDocument: {
                        publishDiagnostics: { relatedInformation: false },
                        synchronization: { didSave: true, dynamicRegistration: false },
                        hover: { contentFormat: ['markdown', 'plaintext'] },
                        definition: { linkSupport: false },
                        completion: { completionItem: { snippetSupport: false } }
                    },
                    workspace: { workspaceFolders: true }
                },
                workspaceFolders: [{ uri: this.toUri(root), name: path.basename(root) }]
            });
            server.ready = true;
            this.notify(server, 'initialized', {});
        } catch (error) {
            server.problem = `initialize falhou: ${(error as Error).message}`;
        }
        return server;
    }

    protected status(root: string): RustLspStatus {
        const server = this.servers.get(root);
        return {
            running: !!server,
            ready: server?.ready ?? false,
            problem: server?.problem,
            openFiles: server?.open.size ?? 0,
            probe: this.lastProbe ?? {
                source: 'não consultado',
                rustupAvailable: false,
                detail: 'a busca do servidor ainda não foi feita nesta sessão'
            }
        };
    }

    protected lastProbe?: RustLspProbe;

    // ── enquadramento LSP ─────────────────────────────────────────────────

    protected send(server: Server, payload: object): void {
        const corpo = Buffer.from(JSON.stringify(payload), 'utf8');
        server.child.stdin.write(`Content-Length: ${corpo.length}\r\n\r\n`);
        server.child.stdin.write(corpo);
    }

    /** Manda um pedido e espera a resposta correlacionada por id. */
    protected request<T>(server: Server, method: string, params: unknown): Promise<T> {
        const id = server.nextId++;
        return new Promise<T>((resolve, reject) => {
            const prazo = setTimeout(() => {
                server.pending.delete(id);
                reject(new Error(`${method} não respondeu em ${REQUEST_TIMEOUT_MS} ms`));
            }, REQUEST_TIMEOUT_MS);
            server.pending.set(id, (result, error) => {
                clearTimeout(prazo);
                server.pending.delete(id);
                if (error) {
                    reject(new Error(error));
                } else {
                    resolve(result as T);
                }
            });
            this.send(server, { jsonrpc: '2.0', id, method, params });
        });
    }

    protected notify(server: Server, method: string, params: unknown): void {
        this.send(server, { jsonrpc: '2.0', method, params });
    }

    /**
     * Desmonta o fluxo de bytes em mensagens.
     *
     * O cabeçalho é `Content-Length` em bytes, não em caracteres: medir com
     * `String.length` corrompe qualquer mensagem com acento — e mensagem de erro
     * do rustc tem acento, aspa tipográfica e seta. Por isso tudo aqui é Buffer.
     */
    protected receive(server: Server, chunk: Buffer): void {
        server.buffer = Buffer.concat([server.buffer, chunk]);
        for (;;) {
            const fim = server.buffer.indexOf('\r\n\r\n');
            if (fim < 0) {
                return;
            }
            const cabecalho = server.buffer.subarray(0, fim).toString('ascii');
            const medida = /content-length:\s*(\d+)/i.exec(cabecalho);
            if (!medida) {
                // Cabeçalho sem tamanho não é recuperável: descarta até aqui em
                // vez de travar o fluxo para sempre.
                server.buffer = server.buffer.subarray(fim + 4);
                continue;
            }
            const tamanho = Number(medida[1]);
            const inicio = fim + 4;
            if (server.buffer.length < inicio + tamanho) {
                return; // mensagem ainda incompleta
            }
            const corpo = server.buffer.subarray(inicio, inicio + tamanho).toString('utf8');
            server.buffer = server.buffer.subarray(inicio + tamanho);
            try {
                this.handle(server, JSON.parse(corpo));
            } catch {
                // Uma mensagem ilegível não pode derrubar o cliente inteiro.
            }
        }
    }

    protected handle(server: Server, message: Record<string, unknown>): void {
        const method = message.method as string | undefined;
        if (method === undefined && message.id !== undefined) {
            // Resposta a um pedido nosso. Quem esperava está em `pending`.
            const aguardando = server.pending.get(Number(message.id));
            if (aguardando) {
                const erro = message.error as { message?: string } | undefined;
                aguardando(message.result, erro?.message);
            }
            return;
        }
        if (method === 'textDocument/publishDiagnostics') {
            const params = message.params as {
                uri?: string;
                diagnostics?: Record<string, unknown>[];
            };
            const uri = params?.uri;
            if (!uri) {
                return;
            }
            const fsPath = this.fromUri(uri);
            const lista = (params.diagnostics ?? []).map(d => this.toDiagnostic(fsPath, d));
            if (lista.length === 0) {
                server.diagnostics.delete(fsPath);
            } else {
                server.diagnostics.set(fsPath, lista);
            }
            return;
        }
        if (method !== undefined && message.id !== undefined) {
            // Pedido do servidor para o cliente (registro dinâmico, progresso,
            // configuração). Responder vazio é honesto: não implementamos, e
            // deixar sem resposta travaria o servidor esperando.
            this.send(server, { jsonrpc: '2.0', id: message.id, result: null });
        }
    }

    protected toDiagnostic(fsPath: string, raw: Record<string, unknown>): RustDiagnostic {
        const range = (raw.range ?? {}) as {
            start?: { line?: number; character?: number };
            end?: { line?: number; character?: number };
        };
        const severidade = Number(raw.severity ?? 1);
        return {
            fsPath,
            // LSP conta de 0; a pessoa lê de 1.
            line: (range.start?.line ?? 0) + 1,
            column: (range.start?.character ?? 0) + 1,
            endLine: (range.end?.line ?? range.start?.line ?? 0) + 1,
            endColumn: (range.end?.character ?? range.start?.character ?? 0) + 1,
            severity: SEVERITY[severidade - 1] ?? 'error',
            message: String(raw.message ?? '').slice(0, 2000),
            source: raw.source ? String(raw.source) : undefined
        };
    }

    protected toUri(fsPath: string): string {
        return FileUri.create(fsPath).toString();
    }

    protected fromUri(uri: string): string {
        try {
            return FileUri.fsPath(new URI(uri));
        } catch {
            return uri;
        }
    }
}
