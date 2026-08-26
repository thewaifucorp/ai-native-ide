// AGENT-FACING SURFACE — an MCP server over the IDE's own services.
//
// Why this exists: everything this extension built (the capability registry, the
// harness provider contract, the governed-write broker) was reachable only from
// the bespoke UI. An IDE for agent-first work whose guarantees need a mouse is
// half a tool: the agent writes files behind the IDE's back, and the governance,
// the receipts and the slot model apply to nobody.
//
// So the same services the widgets use are exposed as MCP tools over
// `POST /mcp` on the Theia backend. An external agent (Claude Code, codex via
// ACP, anything that speaks MCP) can:
//
//   • see what capabilities this project has and generate the missing ones;
//   • propose a write and have it stop at the approval gate like any other —
//     an agent CANNOT write through here without a human approving;
//   • read the broker's raw trail;
//   • see and reconcile writes made OUTSIDE the IDE — including its own, if it
//     used its own file tools instead of these;
//   • register a harness provider, take/free slots, migrate versions, and
//     create work-item artifacts.
//
// Transport is deliberately minimal and dependency-free: JSON-RPC 2.0 over a
// single POST, which is the subset of Streamable HTTP that a stateless tool
// server needs (`initialize`, `tools/list`, `tools/call`). No SSE stream is
// advertised, so no client waits on one.
//
// ── ACCESS ────────────────────────────────────────────────────────────────
// Loopback only, plus a bearer token written at boot to
// `~/.instrument-ide/mcp-token` (mode 0600). An agent reads that file and sends
// `Authorization: Bearer <token>`. The token gates a surface that can propose
// writes and register providers, so it is not optional.

import { injectable, inject } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import * as express from '@theia/core/shared/express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CapabilityService } from '../common/capability-protocol';
import { GovernedWriteService } from '../common/governed-protocol';
import { HarnessManifest, HarnessService } from '../common/harness-protocol';
import { ObserverService } from '../common/observer-protocol';

/** MCP protocol revision this server implements the tool subset of. */
const PROTOCOL_VERSION = '2025-06-18';

const SERVER_INFO = { name: 'instrument-ide', version: '0.1.0' };

/** Where the bearer token is written for local agents to read. */
const TOKEN_DIR = path.join(os.homedir(), '.instrument-ide');
const TOKEN_FILE = path.join(TOKEN_DIR, 'mcp-token');

interface JsonRpcRequest {
    jsonrpc?: string;
    id?: unknown;
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> } & Record<string, unknown>;
}

interface ToolDef {
    name: string;
    description: string;
    inputSchema: object;
    run(args: Record<string, unknown>): Promise<unknown>;
}

/** Required string argument. */
function str(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`argumento '${key}' é obrigatório (string)`);
    }
    return value;
}

function strArray(args: Record<string, unknown>, key: string): string[] {
    const value = args[key];
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
        throw new Error(`argumento '${key}' é obrigatório (array de string)`);
    }
    return value as string[];
}

function manifestArg(args: Record<string, unknown>, key: string): HarnessManifest {
    const value = args[key];
    if (!value || typeof value !== 'object') {
        throw new Error(`argumento '${key}' é obrigatório (objeto de manifesto)`);
    }
    return value as HarnessManifest;
}

const ROOT_PROP = {
    root: {
        type: 'string',
        description: 'Raiz do projeto: caminho absoluto ou file:// URI.'
    }
};

@injectable()
export class McpContribution implements BackendApplicationContribution {

    @inject(CapabilityService) protected readonly capabilities!: CapabilityService;
    @inject(GovernedWriteService) protected readonly governed!: GovernedWriteService;
    @inject(HarnessService) protected readonly harness!: HarnessService;
    @inject(ObserverService) protected readonly observer!: ObserverService;

    protected token = '';

    configure(app: express.Application): void {
        this.token = this.ensureToken();

        // Unauthenticated discovery: says only WHERE the token lives, never what
        // it is, so an agent can bootstrap itself without a human pasting secrets.
        app.get('/mcp', (_req, res) => {
            res.json({
                server: SERVER_INFO,
                protocolVersion: PROTOCOL_VERSION,
                transport: 'jsonrpc-over-post',
                endpoint: '/mcp',
                auth: {
                    scheme: 'Bearer',
                    tokenFile: TOKEN_FILE,
                    header: 'Authorization: Bearer <conteúdo do arquivo>'
                },
                tools: this.tools().map(t => t.name)
            });
        });

        app.post('/mcp', express.json({ limit: '8mb' }), (req, res) => {
            if (!this.isLoopback(req)) {
                res.status(403).json(this.error(null, -32001, 'somente loopback'));
                return;
            }
            if (!this.isAuthorized(req)) {
                res.status(401).json(
                    this.error(null, -32002, `token ausente ou inválido (leia ${TOKEN_FILE})`)
                );
                return;
            }
            this.handle(req.body as JsonRpcRequest)
                .then(result => {
                    if (result === undefined) {
                        res.status(202).end();     // notification: nothing to answer
                    } else {
                        res.json(result);
                    }
                })
                .catch(err => res.json(this.error(
                    (req.body as JsonRpcRequest)?.id ?? null,
                    -32603,
                    err instanceof Error ? err.message : String(err)
                )));
        });

        console.log(`[mcp] agent surface on POST /mcp · token em ${TOKEN_FILE}`);
    }

    // ── transport ──────────────────────────────────────────────────────────

    protected async handle(request: JsonRpcRequest): Promise<object | undefined> {
        const { id, method } = request;
        if (!method) {
            return this.error(id ?? null, -32600, 'requisição sem `method`');
        }
        if (method.startsWith('notifications/')) {
            return undefined;
        }
        switch (method) {
            case 'initialize':
                return this.ok(id, {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: SERVER_INFO,
                    instructions:
                        'Ferramentas do IDE Instrument sobre um projeto aberto. Escritas em ' +
                        'arquivos do projeto passam pelo broker e param aguardando aprovação ' +
                        'humana; nada aqui grava sem aprovação.'
                });
            case 'ping':
                return this.ok(id, {});
            case 'tools/list':
                return this.ok(id, {
                    tools: this.tools().map(t => ({
                        name: t.name,
                        description: t.description,
                        inputSchema: t.inputSchema
                    }))
                });
            case 'tools/call': {
                const name = request.params?.name;
                const tool = this.tools().find(t => t.name === name);
                if (!tool) {
                    return this.error(id ?? null, -32602, `ferramenta desconhecida: ${name}`);
                }
                const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
                try {
                    const value = await tool.run(args);
                    return this.ok(id, {
                        content: [{ type: 'text', text: JSON.stringify(value, undefined, 2) }]
                    });
                } catch (err) {
                    // Tool failures are results, not transport errors — the agent
                    // needs the reason to decide what to do next.
                    return this.ok(id, {
                        isError: true,
                        content: [{
                            type: 'text',
                            text: err instanceof Error ? err.message : String(err)
                        }]
                    });
                }
            }
            default:
                return this.error(id ?? null, -32601, `método não suportado: ${method}`);
        }
    }

    protected ok(id: unknown, result: object): object {
        return { jsonrpc: '2.0', id: id ?? null, result };
    }

    protected error(id: unknown, code: number, message: string): object {
        return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
    }

    // ── access control ─────────────────────────────────────────────────────

    protected ensureToken(): string {
        try {
            fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
            if (fs.existsSync(TOKEN_FILE)) {
                const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
                if (existing.length >= 32) {
                    return existing;
                }
            }
            const token = crypto.randomBytes(32).toString('hex');
            fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
            return token;
        } catch (err) {
            // No token file means no agent surface — fail closed, and say why.
            console.error(
                '[mcp] não foi possível preparar o token; a superfície ficará fechada: ' +
                (err instanceof Error ? err.message : String(err))
            );
            return '';
        }
    }

    protected isAuthorized(req: express.Request): boolean {
        if (!this.token) {
            return false;
        }
        const header = req.header('authorization') || '';
        const bearer = header.toLowerCase().startsWith('bearer ')
            ? header.slice(7).trim()
            : (req.header('x-instrument-token') || '').trim();
        if (bearer.length !== this.token.length) {
            return false;
        }
        return crypto.timingSafeEqual(Buffer.from(bearer), Buffer.from(this.token));
    }

    protected isLoopback(req: express.Request): boolean {
        const address = (req.socket.remoteAddress || '').replace('::ffff:', '');
        return address === '127.0.0.1' || address === '::1' || address === '';
    }

    // ── tools: the same services the UI uses ───────────────────────────────

    protected tools(): ToolDef[] {
        return [
            {
                name: 'capability_list',
                description:
                    'Estado detectado de cada capability do projeto (grafo, agentes, governança): ' +
                    'status honesto, detalhe com a evidência, providers e degradações declaradas.',
                inputSchema: { type: 'object', properties: { ...ROOT_PROP }, required: ['root'] },
                run: async a => this.capabilities.list(str(a, 'root'))
            },
            {
                name: 'capability_install',
                description:
                    'Executa a ação real de instalação/geração de uma capability (ex: indexar o ' +
                    'grafo aag) e devolve o estado re-detectado. Recusa se a precondição não valer.',
                inputSchema: {
                    type: 'object',
                    properties: { ...ROOT_PROP, id: { type: 'string', description: 'Id da capability.' } },
                    required: ['root', 'id']
                },
                run: async a => this.capabilities.install(str(a, 'root'), str(a, 'id'))
            },
            {
                name: 'governed_propose',
                description:
                    'Propõe a escrita completa de um arquivo do projeto. NÃO grava: o efeito para ' +
                    'no gate de aprovação do broker, com diff calculado pelo engine Rust. Use isto ' +
                    'em vez de escrever o arquivo direto — é o que dá snapshot, rollback e recibo.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...ROOT_PROP,
                        relPath: { type: 'string', description: 'Caminho relativo à raiz do projeto.' },
                        content: { type: 'string', description: 'Conteúdo COMPLETO proposto para o arquivo.' }
                    },
                    required: ['root', 'relPath', 'content']
                },
                run: async a => this.governed.proposeWrite(
                    str(a, 'root'), str(a, 'relPath'), str(a, 'content')
                )
            },
            {
                name: 'governed_approve',
                description:
                    'Aplica uma proposta já aprovada por uma pessoa. Um agente só deve chamar isto ' +
                    'quando a aprovação humana existir — o gate do broker é quem decide.',
                inputSchema: {
                    type: 'object',
                    properties: { id: { type: 'string', description: 'Id da proposta.' } },
                    required: ['id']
                },
                run: async a => this.governed.approve(str(a, 'id'))
            },
            {
                name: 'governed_rollback',
                description: 'Restaura o snapshot tirado antes de uma escrita aplicada.',
                inputSchema: {
                    type: 'object',
                    properties: { id: { type: 'string', description: 'Id da proposta.' } },
                    required: ['id']
                },
                run: async a => this.governed.rollback(str(a, 'id'))
            },
            {
                name: 'governed_trail',
                description:
                    'Trilha crua do broker para o projeto: proposto, aguardando aprovação, ' +
                    'snapshot, executado e revertido. É a evidência de o que realmente aconteceu.',
                inputSchema: { type: 'object', properties: { ...ROOT_PROP }, required: ['root'] },
                run: async a => this.governed.activity(str(a, 'root'))
            },
            {
                name: 'external_scan',
                description:
                    'Escritas feitas FORA do IDE (agente, script, terminal) comparadas com a ' +
                    'referência do projeto: caminho, tipo, linhas +/- pelo engine real e se dá ' +
                    'para reverter. Cria a referência na primeira chamada.',
                inputSchema: { type: 'object', properties: { ...ROOT_PROP }, required: ['root'] },
                run: async a => this.observer.scan(str(a, 'root'))
            },
            {
                name: 'external_baseline',
                description:
                    'Refaz a referência do projeto inteiro: tudo que está no disco agora passa a ' +
                    'ser o ponto de comparação.',
                inputSchema: { type: 'object', properties: { ...ROOT_PROP }, required: ['root'] },
                run: async a => this.observer.baseline(str(a, 'root'))
            },
            {
                name: 'external_accept',
                description:
                    'Adota os bytes atuais de um arquivo como nova referência. Não altera o ' +
                    'arquivo; só registra a decisão.',
                inputSchema: {
                    type: 'object',
                    properties: { ...ROOT_PROP, relPath: { type: 'string' } },
                    required: ['root', 'relPath']
                },
                run: async a => this.observer.accept(str(a, 'root'), str(a, 'relPath'))
            },
            {
                name: 'external_propose_revert',
                description:
                    'Propõe restaurar os bytes anteriores de um arquivo pelo broker. Não grava: ' +
                    'volta como proposta aguardando decisão, com snapshot e rollback próprios.',
                inputSchema: {
                    type: 'object',
                    properties: { ...ROOT_PROP, relPath: { type: 'string' } },
                    required: ['root', 'relPath']
                },
                run: async a => this.observer.proposeRevert(str(a, 'root'), str(a, 'relPath'))
            },
            {
                name: 'harness_snapshot',
                description:
                    'Providers de harness descobertos no projeto (manifestos em ' +
                    '.harness/providers/*.json), donos dos slots exclusivos, extensões ' +
                    'compostas, artefatos de trabalho e recibos.',
                inputSchema: { type: 'object', properties: { ...ROOT_PROP }, required: ['root'] },
                run: async a => this.harness.snapshot(str(a, 'root'))
            },
            {
                name: 'harness_register',
                description:
                    'Grava um manifesto de provider como artefato do projeto. Escrever o mesmo JSON ' +
                    'em .harness/providers/<id>.json tem efeito idêntico.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...ROOT_PROP,
                        manifest: { type: 'object', description: 'Manifesto versionado do provider.' }
                    },
                    required: ['root', 'manifest']
                },
                run: async a => this.harness.register(str(a, 'root'), manifestArg(a, 'manifest'))
            },
            {
                name: 'harness_activate',
                description:
                    'Provider assume os slots exclusivos que reivindica. Recusa com conflito ' +
                    'nomeado se outro provider já detém algum deles.',
                inputSchema: {
                    type: 'object',
                    properties: { ...ROOT_PROP, providerId: { type: 'string' } },
                    required: ['root', 'providerId']
                },
                run: async a => this.harness.activate(str(a, 'root'), str(a, 'providerId'))
            },
            {
                name: 'harness_suspend',
                description: 'Libera os slots do provider preservando os artefatos dele.',
                inputSchema: {
                    type: 'object',
                    properties: { ...ROOT_PROP, providerId: { type: 'string' } },
                    required: ['root', 'providerId']
                },
                run: async a => this.harness.suspend(str(a, 'root'), str(a, 'providerId'))
            },
            {
                name: 'harness_migrate',
                description:
                    'Troca o manifesto do provider por uma nova versão preservando os artefatos ' +
                    '(movendo-os se o diretório declarado mudar).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...ROOT_PROP,
                        providerId: { type: 'string' },
                        manifest: { type: 'object', description: 'Manifesto da nova versão.' }
                    },
                    required: ['root', 'providerId', 'manifest']
                },
                run: async a => this.harness.migrate(
                    str(a, 'root'), str(a, 'providerId'), manifestArg(a, 'manifest')
                )
            },
            {
                name: 'harness_add_items',
                description:
                    'Cria artefatos de trabalho (um arquivo por título) no diretório que o ' +
                    'manifesto do provider declara.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...ROOT_PROP,
                        providerId: { type: 'string' },
                        items: { type: 'array', items: { type: 'string' }, description: 'Títulos.' }
                    },
                    required: ['root', 'providerId', 'items']
                },
                run: async a => this.harness.addItems(
                    str(a, 'root'), str(a, 'providerId'), strArray(a, 'items')
                )
            },
            {
                name: 'harness_provider_effect',
                description:
                    'Propõe uma escrita em nome de um provider ativo. Volta sempre aguardando ' +
                    'aprovação: um provider propõe, nunca grava.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        ...ROOT_PROP,
                        providerId: { type: 'string' },
                        relPath: { type: 'string' },
                        content: { type: 'string' }
                    },
                    required: ['root', 'providerId', 'relPath', 'content']
                },
                run: async a => this.harness.providerEffect(
                    str(a, 'root'), str(a, 'providerId'), str(a, 'relPath'), str(a, 'content')
                )
            }
        ];
    }
}
