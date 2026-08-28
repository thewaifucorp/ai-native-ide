// The capability DEFINITIONS the registry hosts.
//
// Each definition is data + two functions (`detect`, optional `install`). The
// registry (capability-registry-service.ts) knows nothing about graphs, agents
// or brokers — which is exactly what makes "Grafo" not hard-coded: it is one
// entry in this array, and the second/third entries go through the same chassis,
// the same UI and the same honesty rules.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EngineService } from 'engine-extension';
import { CapabilityProvider, CapabilityState, CapabilityStatus } from '../common/capability-protocol';

/** What a definition is given when it detects or installs. */
export interface CapabilityContext {
    /** Absolute fs path of the project root being evaluated. */
    rootFsPath: string;
    /** The Rust sidecar host (ide-diff / broker / agent probe). */
    engine: EngineService;
}

/** The evidence-derived part of a state a definition is allowed to produce. */
export interface DetectedCapability {
    status: CapabilityStatus;
    detail: string;
    detectedVersion?: string;
    installable?: boolean;
    surfaceUrl?: string;
    degradations?: string[];
    /** Per-detection provider availability, merged over the declared providers. */
    providerAvailability?: Record<string, { available: boolean; active?: boolean; detail?: string }>;
}

/** One hosted capability. `install` is optional: not everything is installable. */
export interface CapabilityDefinition {
    id: string;
    label: string;
    summary: string;
    /** Declared providers. Availability is decided per detection, not here. */
    providers: Omit<CapabilityProvider, 'available' | 'active'>[];
    /** Label of the real install/generate action, when the definition has one. */
    installLabel?: string;
    detect(ctx: CapabilityContext): Promise<DetectedCapability>;
    install?(ctx: CapabilityContext): Promise<void>;
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Run a command to completion, capturing output. Never throws on exit code. */
export function run(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs = 120_000
): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string }> {
    return new Promise(resolve => {
        let child;
        try {
            child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            resolve({ code: null, stdout: '', stderr: '', spawnError: String(err) });
            return;
        }
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.stdout.on('data', c => { stdout += String(c); });
        child.stderr.on('data', c => { stderr += String(c); });
        child.on('error', err => {
            clearTimeout(timer);
            resolve({ code: null, stdout, stderr, spawnError: err.message });
        });
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

/** First line of a `--version` style output, trimmed. */
function firstLine(text: string): string | undefined {
    const line = text.split('\n').map(l => l.trim()).find(l => l.length > 0);
    return line || undefined;
}

// ── 1. GRAFO — the aag knowledge graph of THIS project ─────────────────────
//
// Detection is two independent facts, reported separately, never conflated:
//   (a) is the `aag` indexer callable at all?         → else `tool-missing`
//   (b) does `<root>/.aag/graph.html` exist for THIS  → else `not-installed`
//       project root?                                    (installable: generate)
// Only both facts true produce `ready` + an embeddable surface.

/** Relative path of the artifact the aag indexer emits. */
export const GRAPH_ARTIFACT = path.join('.aag', 'graph.html');

const GRAFO: CapabilityDefinition = {
    id: 'grafo',
    label: 'Grafo (aag)',
    summary: 'Grafo de conhecimento do código deste projeto: símbolos, chamadas e raio de impacto.',
    installLabel: 'Gerar AAG',
    providers: [
        {
            id: 'aag-local',
            label: 'aag local',
            kind: 'local',
            detail: 'Indexador aag executado na máquina, sobre o repositório aberto.'
        }
    ],
    async detect(ctx): Promise<DetectedCapability> {
        const version = await run('aag', ['--version'], ctx.rootFsPath, 15_000);
        const toolOk = version.code === 0 || !!firstLine(version.stdout);
        if (!toolOk) {
            return {
                status: 'tool-missing',
                detail:
                    'O indexador `aag` não está no PATH deste backend. ' +
                    'Instale-o na máquina para que o IDE possa gerar o grafo.',
                installable: false,
                providerAvailability: {
                    'aag-local': { available: false, detail: 'binário `aag` ausente no PATH' }
                }
            };
        }
        const detectedVersion = firstLine(version.stdout) || firstLine(version.stderr);
        const artifact = path.join(ctx.rootFsPath, GRAPH_ARTIFACT);
        if (!fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) {
            return {
                status: 'not-installed',
                detail:
                    `Nenhum grafo indexado para este projeto (${GRAPH_ARTIFACT} não existe). ` +
                    'O indexador está disponível: gere o grafo para abrir.',
                detectedVersion,
                installable: true,
                providerAvailability: { 'aag-local': { available: true, active: true } }
            };
        }
        const stat = fs.statSync(artifact);
        return {
            status: 'ready',
            detail:
                `Grafo indexado neste projeto · ${Math.round(stat.size / 1024)} KB · ` +
                `atualizado em ${stat.mtime.toISOString().slice(0, 19).replace('T', ' ')}.`,
            detectedVersion,
            installable: true,
            surfaceUrl: 'graph',
            providerAvailability: { 'aag-local': { available: true, active: true } },
            degradations: [
                'O grafo reflete o último índice gravado — não é recalculado a cada edição pelo IDE.'
            ]
        };
    },
    async install(ctx): Promise<void> {
        // Real work: index this project and write the site artifacts.
        // `--no-install` keeps aag from touching the user's agent configuration
        // (MCP entries, hooks, skill packs) — the IDE only asks for the index.
        const result = await run('aag', ['bigbang', '--no-install', '.'], ctx.rootFsPath, 600_000);
        if (result.spawnError) {
            throw new Error(`falha ao executar o indexador aag: ${result.spawnError}`);
        }
        if (result.code !== 0) {
            const reason = firstLine(result.stderr) || firstLine(result.stdout) || `código ${result.code}`;
            throw new Error(`o indexador aag falhou: ${reason}`);
        }
        const artifact = path.join(ctx.rootFsPath, GRAPH_ARTIFACT);
        if (!fs.existsSync(artifact)) {
            throw new Error(
                `o indexador aag terminou sem erro, mas ${GRAPH_ARTIFACT} não foi escrito`
            );
        }
    }
};

// ── 2. AGENTES — the real ide-agent adapter probe ──────────────────────────
//
// Second capability, deliberately of a DIFFERENT shape: no artifact on disk, no
// install action, a live probe instead — and a declared Katsui provider. It goes
// through the same registry, the same state model and the same UI as Grafo.

const AGENTES: CapabilityDefinition = {
    id: 'agentes',
    label: 'Agentes (adaptador ACP)',
    summary: 'Adaptador de agente de codificação: descritor, saúde e o que o IDE não governa.',
    providers: [
        {
            id: 'acpx-local',
            label: 'acpx local',
            kind: 'local',
            detail: 'Agente executado na máquina através do adaptador ACP do sidecar.'
        },
        {
            id: 'katsui-fleet',
            label: 'Katsui (frota governada)',
            kind: 'katsui',
            detail:
                'Provider declarado. Requer endpoint e credencial Katsui; ' +
                'o IDE não implementa a frota localmente.'
        }
    ],
    async detect(ctx): Promise<DetectedCapability> {
        let probe;
        try {
            probe = await ctx.engine.agentProbe('codex');
        } catch (err) {
            return {
                status: 'unknown',
                detail:
                    'Não foi possível sondar o adaptador (sidecar indisponível): ' +
                    (err instanceof Error ? err.message : String(err)),
                installable: false,
                providerAvailability: {
                    'acpx-local': { available: false, detail: 'sondagem falhou' },
                    'katsui-fleet': { available: false, detail: 'não conectado' }
                }
            };
        }
        const status: CapabilityStatus =
            probe.availability === 'ready'
                ? 'ready'
                : probe.availability === 'degraded'
                    ? 'degraded'
                    : 'unavailable';
        const facts = [
            probe.transport ? `transporte ${probe.transport}` : undefined,
            probe.adapterVersion ? `adaptador ${probe.adapterVersion}` : undefined,
            probe.supportsResume ? 'resume' : undefined,
            probe.supportsSteer ? 'steer' : undefined
        ].filter(Boolean).join(' · ');
        return {
            status,
            detail: probe.detail || facts || `adaptador ${probe.agent}: ${probe.availability}`,
            detectedVersion: probe.detectedVersion,
            installable: false,
            degradations: probe.degradations,
            providerAvailability: {
                'acpx-local': {
                    available: probe.available,
                    active: probe.available,
                    detail: probe.available ? undefined : probe.detail || 'adaptador indisponível'
                },
                'katsui-fleet': {
                    available: false,
                    detail: 'não conectado — falta endpoint/credencial Katsui'
                }
            }
        };
    }
};

// ── 3. GOVERNANÇA — the real Rust broker behind every write ────────────────
//
// Third capability, third shape: a liveness probe of the sidecar that hosts the
// broker. No artifact, no install, no Katsui provider — so the Katsui action is
// visibly absent here while present on Agentes.

const GOVERNANCA: CapabilityDefinition = {
    id: 'governanca',
    label: 'Governança (broker)',
    summary: 'Broker de efeitos: aprovação, snapshot, rollback e trilha de recibos das escritas.',
    providers: [
        {
            id: 'sidecar-local',
            label: 'sidecar Rust local',
            kind: 'local',
            detail: 'ide-domain WorkspaceEffectBroker hospedado no sidecar do IDE.'
        }
    ],
    async detect(ctx): Promise<DetectedCapability> {
        try {
            const pong = await ctx.engine.ping();
            if (!pong.pong) {
                return {
                    status: 'unavailable',
                    detail: 'o sidecar respondeu, mas não confirmou o ping',
                    installable: false,
                    providerAvailability: { 'sidecar-local': { available: false } }
                };
            }
            const activity = await ctx.engine.brokerActivity(ctx.rootFsPath, 'owner:instrument-ide');
            return {
                status: 'ready',
                detail:
                    `Broker ativo (${pong.engine}) · ` +
                    `${activity.activity.length} eventos na trilha deste projeto.`,
                installable: false,
                providerAvailability: { 'sidecar-local': { available: true, active: true } }
            };
        } catch (err) {
            return {
                status: 'unavailable',
                detail:
                    'Sidecar do broker indisponível: ' +
                    (err instanceof Error ? err.message : String(err)),
                installable: false,
                providerAvailability: {
                    'sidecar-local': {
                        available: false,
                        detail: 'sidecar não compilado ou não respondendo'
                    }
                }
            };
        }
    }
};

/** Everything the registry hosts. Order is the display order. */

/**
 * §1 — inteligência de Rust como CAPABILITY, não como suposição.
 *
 * A extensão `rust-lang.rust-analyzer` foi tentada e medida: o vsix do open-vsx
 * não traz o binário do servidor e a ativação falha neste host de plugins mesmo
 * com o binário no lugar. Então quem fala LSP é o nosso cliente
 * (`rust-lsp-service.ts`), e o que esta capability responde é a pergunta que
 * sobra: **este ambiente tem o servidor?**
 *
 * A busca é portátil de propósito — PATH, `rustup which`, `CARGO_HOME/bin`, com
 * o nome `.exe` no Windows. Nenhum caminho de máquina específica aparece: o que
 * existe aqui é a convenção de cada sistema, e o estado é dito com a origem
 * ("via rustup", "via PATH") para que duas máquinas diferentes produzam uma
 * diferença explicável em vez de mistério.
 */
const RUST_LSP: CapabilityDefinition = {
    id: 'rust-lsp',
    label: 'Rust (rust-analyzer)',
    summary:
        'Erro de compilação na linha, tipo no hover, ir para a definição e completar em '
        + 'arquivos Rust deste projeto.',
    installLabel: 'Instalar via rustup',
    providers: [
        {
            id: 'rust-analyzer-local',
            label: 'rust-analyzer local',
            kind: 'local',
            detail:
                'Servidor de linguagem executado na máquina, falado por um cliente LSP do '
                + 'próprio IDE (a extensão do VS Code não ativa neste host).'
        }
    ],
    async detect(ctx): Promise<DetectedCapability> {
        const servidor = await findRustAnalyzer(ctx.rootFsPath);
        if (!servidor.path) {
            const rustup = await run('rustup', ['--version'], ctx.rootFsPath, 15_000);
            const temRustup = rustup.code === 0;
            return {
                status: 'tool-missing',
                detail: servidor.shim
                    ? `Existe um atalho em ${servidor.shim}, mas ele não é um servidor: chamá-lo `
                      + 'não devolve versão. É o shim do rustup sem o componente instalado'
                      + (temRustup ? ' — instalar resolve.' : ', e não há rustup para instalar.')
                    : temRustup
                    ? 'O `rust-analyzer` não está instalado. O rustup deste ambiente pode '
                      + 'instalá-lo como componente.'
                    : 'O `rust-analyzer` não está instalado e não há `rustup` para instalá-lo. '
                      + 'Instale o rustup (https://rustup.rs) ou ponha o binário no PATH.',
                installable: temRustup,
                providerAvailability: {
                    'rust-analyzer-local': {
                        available: false,
                        detail: 'binário `rust-analyzer` não encontrado no PATH, no rustup nem em CARGO_HOME/bin'
                    }
                }
            };
        }
        const temCargo = fs.existsSync(path.join(ctx.rootFsPath, 'Cargo.toml'));
        return {
            status: 'ready',
            detail:
                `${servidor.version ?? 'rust-analyzer'} — encontrado via ${servidor.source} `
                + `(${servidor.path}). `
                + (temCargo
                    ? 'Este projeto tem Cargo.toml, então a análise cobre o workspace.'
                    : 'Este projeto NÃO tem Cargo.toml na raiz: o servidor sobe, mas analisa '
                      + 'apenas arquivos soltos.'),
            detectedVersion: servidor.version,
            installable: false,
            // O campo existente para "isto NÃO é coberto": a ausência é dita, não
            // insinuada como pronta.
            degradations: [
                'renomear, ações de código e formatação não estão ligados nesta versão'
            ],
            providerAvailability: {
                'rust-analyzer-local': { available: true, active: true }
            }
        };
    },
    async install(ctx): Promise<void> {
        const result = await run(
            'rustup',
            ['component', 'add', 'rust-analyzer'],
            ctx.rootFsPath,
            300_000
        );
        if (result.code !== 0) {
            throw new Error(
                '`rustup component add rust-analyzer` falhou: '
                + (firstLine(result.stderr) || firstLine(result.stdout) || 'sem saída')
            );
        }
    }
};

/** Busca portátil do servidor — a mesma ordem que o cliente LSP usa. */
async function findRustAnalyzer(
    cwd: string
): Promise<{ path?: string; version?: string; source: string; shim?: string }> {
    const nome = process.platform === 'win32' ? 'rust-analyzer.exe' : 'rust-analyzer';
    const candidatos: [string, string | undefined][] = [];

    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (dir) {
            candidatos.push(['PATH', path.join(dir, nome)]);
        }
    }
    const viaRustup = await run('rustup', ['which', 'rust-analyzer'], cwd, 20_000);
    if (viaRustup.code === 0) {
        candidatos.push(['rustup', firstLine(viaRustup.stdout)]);
    }
    const cargoHome = process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo');
    candidatos.push(['CARGO_HOME/bin', path.join(cargoHome, 'bin', nome)]);

    // Existir não basta: o shim do rustup existe sem o componente e responde
    // `error: Unknown binary 'rust-analyzer'` com código 0. Só conta quem se
    // apresenta pelo nome — ver a nota longa em `rust-lsp-service.ts`.
    let shimQuebrado: string | undefined;
    for (const [source, candidato] of candidatos) {
        if (!candidato || !fs.existsSync(candidato)) {
            continue;
        }
        const versao = await run(candidato, ['--version'], cwd, 20_000);
        const primeira = firstLine(versao.stdout);
        if (primeira && /^rust-analyzer\b/i.test(primeira)) {
            return { path: candidato, version: primeira, source };
        }
        shimQuebrado = candidato;
    }
    return shimQuebrado
        ? { source: 'shim sem componente', shim: shimQuebrado }
        : { source: 'não encontrado' };
}

export const CAPABILITY_DEFINITIONS: CapabilityDefinition[] = [
    GRAFO,
    AGENTES,
    GOVERNANCA,
    RUST_LSP
];

/** Merge a definition + its detection into the wire-level state. */
export function composeState(
    definition: CapabilityDefinition,
    detected: DetectedCapability,
    surfaceUrlResolver: (token: string) => string,
    detectedAt: string
): CapabilityState {
    const providers: CapabilityProvider[] = definition.providers.map(p => {
        const live = detected.providerAvailability?.[p.id];
        return {
            ...p,
            available: live?.available ?? false,
            active: live?.active ?? false,
            detail: live?.detail ?? p.detail
        };
    });
    const installable = (detected.installable ?? false) && !!definition.install;
    return {
        id: definition.id,
        label: definition.label,
        summary: definition.summary,
        status: detected.status,
        detail: detected.detail,
        detectedVersion: detected.detectedVersion,
        installable,
        installLabel: installable ? definition.installLabel : undefined,
        surface: detected.surfaceUrl
            ? { kind: 'iframe', url: surfaceUrlResolver(detected.surfaceUrl) }
            : { kind: 'none' },
        providers,
        degradations: detected.degradations ?? [],
        detectedAt
    };
}
