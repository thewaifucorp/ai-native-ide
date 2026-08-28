// AGENT SESSION — implementation of the pre-disk path.
//
// See common/agent-session-protocol.ts for why the session runs against a git
// worktree instead of the project itself.

import { injectable, inject } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AgentEvent, EngineService } from 'engine-extension';
import { GovernedWriteService } from '../common/governed-protocol';
import {
    AgentSessionService,
    AgentSessionSnapshot,
    HarvestedChange,
    PendingPermission,
    PermissionEditView,
    SessionEventView,
    SessionPhase,
    SessionUsage,
    SkippedFile,
    SwapOutcome,
    WorktreeBaseline
} from '../common/agent-session-protocol';

/** Where the agent's worktree lives (IDE runtime state, git-ignored). */
const WORKTREE_DIR = path.join('.instrument', 'agent-worktree');

/** Where the baseline that makes the comparison three-way is recorded. */
const BASELINE_FILE = path.join('.instrument', 'agent-worktree.baseline.json');

/** Owner identity for effects harvested out of an agent session. */
const EVENT_CAP = 200;

/** Directories never compared between worktree and project. */
const SKIP = new Set([
    '.git', 'node_modules', '.instrument', 'target', 'lib', 'dist', 'src-gen', '.aag'
]);

const MAX_FILE_BYTES = 512 * 1024;

/** The baseline as it is stored on disk: content hash per relative path. */
interface BaselineFile {
    at: string;
    commit?: string;
    recovered?: boolean;
    hashes: Record<string, string>;
}

interface SessionState {
    agent: string;
    phase: SessionPhase;
    sessionId?: string;
    worktree?: string;
    events: SessionEventView[];
    lastError?: string;
    changes: HarvestedChange[];
    skipped: SkippedFile[];
    /** What the worktree was made from; absent when there is no worktree. */
    baseline?: WorktreeBaseline;
    /** Permissions the agent is currently blocked on. */
    pending: PendingPermission[];
    /** Spend so far, as the adapter reported it. */
    usage?: SessionUsage;
    /** The last adapter swap and what it cost in context. */
    lastSwap?: SwapOutcome;
}

/** Run a command to completion; never throws. */
function run(
    command: string,
    args: string[],
    cwd: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise(resolve => {
        let child;
        try {
            child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            resolve({ code: null, stdout: '', stderr: String(err) });
            return;
        }
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', c => { stdout += String(c); });
        child.stderr.on('data', c => { stderr += String(c); });
        child.on('error', err => resolve({ code: null, stdout, stderr: err.message }));
        child.on('close', code => resolve({ code, stdout, stderr }));
    });
}

@injectable()
export class AgentSessionServiceImpl implements AgentSessionService {

    @inject(EngineService) protected readonly engine!: EngineService;
    @inject(GovernedWriteService) protected readonly governed!: GovernedWriteService;

    protected readonly states = new Map<string, SessionState>();

    async snapshot(rootUri: string): Promise<AgentSessionSnapshot> {
        const root = this.rootPath(rootUri);
        const state = this.state(root);
        // A worktree left behind by an earlier IDE run is a fact about this
        // project, not about this process: report it before any session starts,
        // so the panel never looks clean over leftovers.
        if (!state.worktree) {
            const target = path.join(root, WORKTREE_DIR);
            if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
                state.worktree = target;
                const stored = this.readBaseline(root);
                state.baseline = stored
                    ? {
                        at: stored.at,
                        commit: stored.commit,
                        files: Object.keys(stored.hashes).length,
                        reused: true,
                        recovered: stored.recovered
                    }
                    : undefined;
            }
        }
        return this.view(state);
    }

    async start(rootUri: string, agent: string): Promise<AgentSessionSnapshot> {
        const root = this.rootPath(rootUri);
        const state = this.state(root);
        state.agent = agent;
        state.phase = 'starting';
        state.lastError = undefined;
        state.changes = [];
        state.skipped = [];
        state.pending = [];

        const worktree = await this.ensureWorktree(root, state);
        if (typeof worktree !== 'string') {
            state.phase = 'failed';
            state.lastError = worktree.error;
            return this.view(state);
        }
        state.worktree = worktree;

        try {
            // read_only stays false INSIDE THE WORKTREE: the agent must be able to
            // work. Isto NÃO é confinamento: o adapter acpx declara
            // `sandbox = None`, então o agente pode escrever fora da worktree por
            // caminho absoluto. A worktree evita o acidente e o `harvest` é o único
            // caminho governado para o projeto; escrita deliberada fora dela cai no
            // observador, como qualquer escrita externa.
            const started = await this.engine.agentStartSession({
                agent,
                owner: 'owner:instrument-ide',
                workspaceRoot: worktree,
                readOnly: false,
                sandbox: 'isolated'
            });
            state.sessionId = started.session_id;
            state.phase = 'idle';
            this.push(
                state,
                'aviso',
                'a worktree evita escrita acidental no projeto, mas não é jaula: o adapter atual ' +
                'não aplica sandbox, então escrita por caminho absoluto é possível e apareceria ' +
                'como escrita externa'
            );
            this.push(state, 'session', `sessão ${started.session_id} aberta em ${path.relative(root, worktree)}`);
        } catch (err) {
            state.phase = 'failed';
            state.lastError = this.msg(err);
            this.push(state, 'erro', state.lastError);
        }
        return this.view(state);
    }

    async submit(rootUri: string, prompt: string, codeChange: boolean): Promise<AgentSessionSnapshot> {
        const root = this.rootPath(rootUri);
        const state = this.state(root);
        if (!state.sessionId) {
            throw new Error('nenhuma sessão aberta');
        }
        this.push(state, 'você', prompt);
        try {
            await this.engine.agentSubmitTask(
                state.agent,
                state.sessionId,
                prompt,
                codeChange ? 'code-change' : 'conversation'
            );
            state.phase = 'working';
        } catch (err) {
            state.lastError = this.msg(err);
            this.push(state, 'erro', state.lastError);
        }
        return this.view(state);
    }

    async poll(rootUri: string): Promise<AgentSessionSnapshot> {
        const root = this.rootPath(rootUri);
        const state = this.state(root);
        if (!state.sessionId) {
            return this.view(state);
        }
        // Drain what is queued; a bounded loop so one poll cannot spin forever.
        for (let i = 0; i < 40; i++) {
            let event: AgentEvent | null;
            try {
                event = (await this.engine.agentNextEvent(state.agent, state.sessionId)).event;
            } catch (err) {
                state.lastError = this.msg(err);
                state.phase = 'failed';
                break;
            }
            if (!event) {
                break;
            }
            this.absorb(state, event);
        }
        await this.applyPolicyToPending(rootUri, root, state);
        await this.readUsage(state);
        return this.view(state);
    }

    /**
     * §10 — what this session has spent, as the ADAPTER reported it.
     *
     * `reported: false` is the load-bearing part: an adapter that does not report
     * usage returns zero, and a zero rendered as spend would read as "cheap" when
     * it means "not measured". The probe's `supportsUsageReporting` is what tells
     * the two apart, so the flag travels with the number.
     */
    protected async readUsage(state: SessionState): Promise<void> {
        if (!state.sessionId) {
            return;
        }
        try {
            const status = (await this.engine.agentSessionStatus(
                state.agent,
                state.sessionId
            )) as { usage?: { inputTokens: number; outputTokens: number } | null };
            const usage = status.usage;
            state.usage = usage
                ? {
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    reported: usage.inputTokens > 0 || usage.outputTokens > 0
                }
                : { inputTokens: 0, outputTokens: 0, reported: false };
        } catch {
            // Um status indisponível não vira custo zero: fica sem número.
            state.usage = undefined;
        }
    }

    async swap(rootUri: string, toAgent: string): Promise<AgentSessionSnapshot> {
        const root = this.rootPath(rootUri);
        const state = this.state(root);
        if (!state.sessionId) {
            state.lastError = 'não há sessão aberta para trocar de adaptador';
            return this.view(state);
        }
        const from = state.agent;
        try {
            // Captura ANTES: o que a troca leva é o que existia neste instante,
            // e capturar depois de mexer na sessão descreveria outra coisa.
            const captured = await this.engine.agentCaptureState(from, state.sessionId);
            const result = from === toAgent
                ? await this.engine.agentResume(toAgent, captured)
                : await this.engine.agentSwap(toAgent, captured);
            state.agent = toAgent;
            state.sessionId = result.session_id;
            state.phase = 'idle';
            state.pending = [];
            state.lastSwap = {
                from,
                to: toAgent,
                resumed: result.resumed,
                preserved: result.preserved,
                dropped: result.dropped,
                at: new Date().toISOString()
            };
            this.push(
                state,
                'adaptador',
                result.resumed
                    ? `sessão reatada em ${toAgent}: conversa e contexto preservados`
                    : `sessão recomeçada em ${toAgent} — ${result.dropped.join('; ')} não são ` +
                      'portáveis entre backends e foram perdidos'
            );
            // O projeto não é tocado por uma troca: ela não escreve nada, e o que
            // o agente já tiver feito continua só na worktree até ser colhido.
            this.push(
                state,
                'adaptador',
                'o projeto não mudou: trocar de adaptador não escreve, e a colheita ' +
                'pelo broker continua sendo o único caminho até ele'
            );
        } catch (err) {
            // Uma troca que falha NÃO deixa o painel achando que trocou.
            state.lastError = this.msg(err);
            this.push(state, 'erro', `troca para ${toAgent} recusada: ${state.lastError}`);
        }
        return this.view(state);
    }

    /**
     * §14 at the agent's gate: the mode decides WHETHER the IDE stops to ask.
     *
     * An agent request is classified `durable` on purpose. The worktree is not a
     * jail — the agent can write outside it by absolute path, and a command it
     * runs has real effects — so treating agent requests as throwaway would make
     * `Cautious` auto-answer everything, which is the opposite of what it means.
     * Only an explicit Yolo (globally or scoped to that tool) answers by itself.
     *
     * Two honesty rules hold here. The auto-answer is recorded as an event naming
     * the rule that produced it, so a decision nobody took is still visible. And
     * a policy that cannot be reached leaves the request PENDING — the agent
     * stays blocked, which is the side that cannot cause an effect.
     */
    protected async applyPolicyToPending(
        rootUri: string,
        root: string,
        state: SessionState
    ): Promise<void> {
        if (state.pending.length === 0) {
            return;
        }
        for (const request of [...state.pending]) {
            // Já avaliado é já avaliado: ver a nota em `PendingPermission`.
            if (request.policyChecked) {
                continue;
            }
            request.policyChecked = true;
            let decision;
            try {
                decision = await this.engine.policyDecide(root, 'durable', {
                    resource: request.edits[0]?.path,
                    tool: request.action
                });
            } catch (err) {
                this.push(
                    state,
                    'permissão',
                    `política de efeito indisponível (${this.msg(err)}) — o pedido continua ` +
                    'esperando você, que é o lado que não causa efeito'
                );
                // Marcado como avaliado de propósito: tentar de novo num poll
                // seguinte auto-aprovaria mais tarde, sem ninguém olhando ESTE
                // pedido. Ele espera a pessoa, e o evento acima diz por quê.
                return;
            }
            if (decision.effect !== 'auto_approve_recorded') {
                continue;
            }
            this.push(
                state,
                'permissão',
                `${request.action}: ${request.detail} — aprovado automaticamente ` +
                `(modo ${decision.mode}, permissões ${decision.permissions}` +
                `${decision.scoped ? ', regra com escopo próprio' : ''}). ` +
                'Escrita colhida ainda passa pelo broker; COMANDO não tem recibo nem rollback'
            );
            await this.respondPermission(rootUri, request.requestId, true);
        }
    }

    async harvest(rootUri: string): Promise<AgentSessionSnapshot> {
        const root = this.rootPath(rootUri);
        const state = this.state(root);
        if (!state.worktree) {
            throw new Error('nenhuma worktree de agente para colher');
        }
        const stored = this.readBaseline(root);
        if (!stored) {
            // No baseline means no way to tell the agent's change from the
            // person's. Refusing beats proposing a revert of their work.
            state.lastError =
                'sem baseline da worktree: não é possível distinguir mudança do agente da sua. ' +
                'Descarte a worktree e abra a sessão de novo.';
            this.push(state, 'colheita', state.lastError);
            return this.view(state);
        }
        const { changes, skipped } = this.compare(root, state.worktree, stored.hashes);

        // One decision at a time: the broker's approval is positional, so we
        // propose the first change and report the rest as queued behind it.
        let proposedOne = false;
        for (const change of changes) {
            if (change.kind === 'delete' || change.conflict) {
                continue;   // reported with its own reason; never proposed
            }
            if (proposedOne) {
                change.detail = 'aguardando a decisão anterior';
                continue;
            }
            try {
                const content = fs.readFileSync(path.join(state.worktree, change.relPath), 'utf8');
                const proposal = await this.governed.proposeWrite(rootUri, change.relPath, content);
                change.proposed = true;
                change.proposalId = proposal.id;
                proposedOne = true;
                this.push(state, 'proposta', `${change.relPath} → broker (${proposal.id})`);
            } catch (err) {
                change.detail = this.msg(err);
            }
        }
        state.changes = changes;
        state.skipped = skipped;
        if (changes.length === 0) {
            this.push(state, 'colheita', 'nenhuma mudança do agente na worktree');
        }
        const blocked = changes.filter(c => c.kind === 'delete' || c.conflict).length;
        if (blocked > 0) {
            this.push(
                state,
                'colheita',
                `${blocked} mudança(s) NÃO passam pelo broker (exclusão ou conflito com o seu ` +
                'trabalho) e ficaram só reportadas'
            );
        }
        if (skipped.length > 0) {
            this.push(state, 'colheita', `${skipped.length} arquivo(s) não comparados — veja o motivo de cada um`);
        }
        return this.view(state);
    }

    async respondPermission(
        rootUri: string,
        requestId: number,
        allow: boolean,
        denyEndsTurn = true
    ): Promise<AgentSessionSnapshot> {
        const root = this.rootPath(rootUri);
        const state = this.state(root);
        if (!state.sessionId) {
            state.lastError = 'não há sessão aberta para responder permissão';
            return this.view(state);
        }
        const index = state.pending.findIndex(p => p.requestId === requestId);
        if (index < 0) {
            // Never report a decision the adapter never received. A stale button
            // click must say so, not look like it worked.
            state.lastError = `pedido de permissão ${requestId} não está pendente`;
            return this.view(state);
        }
        const request = state.pending[index];
        try {
            await this.engine.agentRespondPermission(
                state.agent,
                state.sessionId,
                requestId,
                allow,
                denyEndsTurn
            );
        } catch (err) {
            // The request stays pending: the agent is still blocked on it, so the
            // card must stay on screen.
            state.lastError = this.msg(err);
            return this.view(state);
        }
        state.pending.splice(index, 1);
        const verdict = allow
            ? 'aprovado'
            : denyEndsTurn
                ? 'negado (turno encerrado)'
                : 'negado (só este pedido)';
        this.push(state, 'permissão', `${request.action}: ${request.detail} — ${verdict}`);
        return this.view(state);
    }

    async cancel(rootUri: string): Promise<AgentSessionSnapshot> {
        const root = this.rootPath(rootUri);
        const state = this.state(root);
        if (state.sessionId) {
            try {
                await this.engine.agentCancel(state.agent, state.sessionId, true);
            } catch (err) {
                state.lastError = this.msg(err);
            }
        }
        state.sessionId = undefined;
        state.phase = 'none';
        state.pending = [];
        this.push(
            state,
            'session',
            'sessão encerrada · a worktree fica para inspeção; `Descartar worktree` apaga o que ' +
            'não foi colhido'
        );
        return this.view(state);
    }

    async discard(rootUri: string): Promise<AgentSessionSnapshot> {
        const root = this.rootPath(rootUri);
        const state = this.state(root);
        if (state.sessionId) {
            // Removing the directory under a live session would leave the agent
            // writing into a deleted tree. End it first, and say that happened.
            await this.cancel(rootUri);
        }
        const target = path.join(root, WORKTREE_DIR);
        const unharvested = state.changes.filter(c => !c.proposed).length;
        if (fs.existsSync(path.join(root, '.git'))) {
            // `git worktree remove` also drops the administrative entry; without it
            // git keeps a stale registration and refuses to re-add the same path.
            await run('git', ['worktree', 'remove', '--force', target], root);
        }
        try {
            fs.rmSync(target, { recursive: true, force: true });
            fs.rmSync(path.join(root, BASELINE_FILE), { force: true });
        } catch (err) {
            state.lastError = `não foi possível apagar a worktree: ${this.msg(err)}`;
            this.push(state, 'erro', state.lastError);
            return this.view(state);
        }
        state.worktree = undefined;
        state.baseline = undefined;
        state.changes = [];
        state.skipped = [];
        this.push(
            state,
            'worktree',
            unharvested > 0
                ? `worktree descartada — ${unharvested} mudança(s) que ninguém colheu foram perdidas`
                : 'worktree descartada; a próxima sessão parte do estado atual do projeto'
        );
        return this.view(state);
    }

    // ── worktree ───────────────────────────────────────────────────────────

    /**
     * Prepare the isolated place the agent works in.
     *
     * What the pre-disk guarantee actually needs is an isolated COPY of the
     * project, not git specifically. So: a real `git worktree` when the project is
     * a git repository (cheap, shares the object store, and `git diff` works
     * inside it), and a plain recursive copy otherwise — degraded but honest, and
     * reported as such. Either way the agent never writes in the project.
     */
    protected async ensureWorktree(
        root: string,
        state: SessionState
    ): Promise<string | { error: string }> {
        const target = path.join(root, WORKTREE_DIR);
        if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
            // A leftover worktree is REUSED, not silently trusted: it was made
            // from an older commit, so the agent is looking at the project as of
            // then. Say when, and say from what.
            const existing = this.readBaseline(root);
            if (existing) {
                state.baseline = {
                    at: existing.at,
                    commit: existing.commit,
                    files: Object.keys(existing.hashes).length,
                    reused: true,
                    recovered: existing.recovered
                };
                this.push(
                    state,
                    'worktree',
                    `reusando a worktree de uma sessão anterior, criada em ${existing.at}` +
                    `${existing.commit ? ` (commit ${existing.commit.slice(0, 7)})` : ''} — ` +
                    'o agente vê o projeto daquele momento, não o de agora; ' +
                    '`Descartar worktree` recomeça do estado atual'
                );
            } else {
                // Worktree without a baseline: rebuild one from the project NOW and
                // declare the cost — whatever the agent did before this moment is
                // indistinguishable from what the person did.
                const recovered = await this.recordBaseline(root, target, true);
                state.baseline = {
                    at: recovered.at,
                    commit: recovered.commit,
                    files: Object.keys(recovered.hashes).length,
                    reused: true,
                    recovered: true
                };
                this.push(
                    state,
                    'worktree',
                    'a worktree existia sem baseline: uma baseline foi recuperada agora, então ' +
                    'mudança feita nela ANTES deste momento não é distinguível de mudança sua'
                );
            }
            return target;
        }
        fs.mkdirSync(target, { recursive: true });

        let isolated = false;
        if (fs.existsSync(path.join(root, '.git'))) {
            const added = await run('git', ['worktree', 'add', '--detach', target, 'HEAD'], root);
            isolated = added.code === 0;
            // A failed worktree is not a reason to give the agent the project
            // itself: fall through to the copy.
        }
        if (!isolated) {
            try {
                this.copyProject(root, target);
            } catch (err) {
                return { error: `não foi possível isolar o projeto para o agente: ${this.msg(err)}` };
            }
        }
        const fresh = await this.recordBaseline(root, target, false);
        state.baseline = {
            at: fresh.at,
            commit: fresh.commit,
            files: Object.keys(fresh.hashes).length,
            reused: false
        };
        return target;
    }

    // ── baseline ───────────────────────────────────────────────────────────

    /** Hash every comparable file in `dir`, using the same rules as `compare`. */
    protected hashTree(dir: string): Record<string, string> {
        const hashes: Record<string, string> = {};
        const walk = (relDir: string): void => {
            let names: string[];
            try {
                names = fs.readdirSync(path.join(dir, relDir));
            } catch {
                return;
            }
            for (const name of names) {
                if (SKIP.has(name)) {
                    continue;
                }
                const rel = relDir ? path.join(relDir, name) : name;
                const abs = path.join(dir, rel);
                let stat: fs.Stats;
                try {
                    stat = fs.lstatSync(abs);
                } catch {
                    continue;
                }
                if (stat.isSymbolicLink()) {
                    continue;
                }
                if (stat.isDirectory()) {
                    walk(rel);
                    continue;
                }
                if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
                    continue;
                }
                const hash = this.hashFile(abs);
                if (hash) {
                    hashes[rel] = hash;
                }
            }
        };
        walk('');
        return hashes;
    }

    protected hashFile(abs: string): string | undefined {
        try {
            return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        } catch {
            return undefined;
        }
    }

    /**
     * Record what the worktree started from.
     *
     * Taken from the WORKTREE, not the project: the worktree is what the agent
     * will change, so its own initial bytes are the only honest zero point. When
     * recovering (the worktree already existed), the project is used instead —
     * degraded on purpose, and reported as `recovered`.
     */
    protected async recordBaseline(
        root: string,
        worktree: string,
        recovered: boolean
    ): Promise<BaselineFile> {
        const head = await run('git', ['rev-parse', 'HEAD'], root);
        const baseline: BaselineFile = {
            at: new Date().toISOString(),
            commit: head.code === 0 ? head.stdout.trim() : undefined,
            recovered: recovered || undefined,
            hashes: this.hashTree(recovered ? root : worktree)
        };
        try {
            const file = path.join(root, BASELINE_FILE);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(baseline, undefined, 2), 'utf8');
        } catch { /* unwritable state dir — the in-memory baseline still holds */ }
        return baseline;
    }

    protected readBaseline(root: string): BaselineFile | undefined {
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(root, BASELINE_FILE), 'utf8'));
            if (raw && typeof raw === 'object' && raw.hashes && typeof raw.hashes === 'object') {
                return raw as BaselineFile;
            }
        } catch { /* absent or corrupt — the caller recovers one */ }
        return undefined;
    }

    /** Recursive copy of the project's working files into the agent's directory. */
    protected copyProject(root: string, target: string): void {
        let copied = 0;
        const walk = (rel: string): void => {
            const from = path.join(root, rel);
            for (const name of fs.readdirSync(from)) {
                if (SKIP.has(name)) {
                    continue;
                }
                const childRel = rel ? path.join(rel, name) : name;
                const src = path.join(root, childRel);
                const dst = path.join(target, childRel);
                const stat = fs.lstatSync(src);
                if (stat.isSymbolicLink()) {
                    continue;
                }
                if (stat.isDirectory()) {
                    fs.mkdirSync(dst, { recursive: true });
                    walk(childRel);
                    continue;
                }
                if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
                    continue;
                }
                if (copied >= 2000) {
                    throw new Error('projeto grande demais para cópia isolada (limite de 2000 arquivos)');
                }
                fs.copyFileSync(src, dst);
                copied++;
            }
        };
        walk('');
    }

    /**
     * What the AGENT did, told apart from what the PERSON did.
     *
     * Three sides: the baseline the worktree was made from, the worktree now, and
     * the project now. Only files whose worktree bytes moved away from the
     * baseline are the agent's act; a file the person edited in the project after
     * the baseline is theirs, and proposing it would offer to revert their work.
     * A baseline entry with no worktree file left is a DELETION — the case the old
     * worktree-only walk could not see at all.
     */
    protected compare(
        root: string,
        worktree: string,
        hashes: Record<string, string>
    ): { changes: HarvestedChange[]; skipped: SkippedFile[] } {
        const changes: HarvestedChange[] = [];
        const skipped: SkippedFile[] = [];
        const skippedPaths = new Set<string>();
        const seen = new Set<string>();

        const skip = (rel: string, reason: string): void => {
            skipped.push({ relPath: rel, reason });
            skippedPaths.add(rel);
        };

        const walk = (relDir: string): void => {
            const dir = path.join(worktree, relDir);
            let names: string[];
            try {
                names = fs.readdirSync(dir);
            } catch (err) {
                skip(relDir || '.', `diretório ilegível: ${this.msg(err)}`);
                return;
            }
            for (const name of names) {
                if (SKIP.has(name)) {
                    continue;
                }
                const rel = relDir ? path.join(relDir, name) : name;
                const abs = path.join(worktree, rel);
                let stat: fs.Stats;
                try {
                    stat = fs.lstatSync(abs);
                } catch (err) {
                    skip(rel, `ilegível: ${this.msg(err)}`);
                    continue;
                }
                if (stat.isSymbolicLink()) {
                    skip(rel, 'link simbólico — não comparado nem proposto');
                    continue;
                }
                if (stat.isDirectory()) {
                    walk(rel);
                    continue;
                }
                if (!stat.isFile()) {
                    skip(rel, 'não é arquivo comum');
                    continue;
                }
                if (stat.size > MAX_FILE_BYTES) {
                    skip(rel, `grande demais (${Math.round(stat.size / 1024)} KiB > 512 KiB)`);
                    continue;
                }
                seen.add(rel);
                let buffer: Buffer;
                try {
                    buffer = fs.readFileSync(abs);
                } catch (err) {
                    skip(rel, `ilegível: ${this.msg(err)}`);
                    continue;
                }
                if (buffer.includes(0)) {
                    // Reading bytes as utf8 and proposing the result would corrupt
                    // the file. Say it was not compared instead.
                    skip(rel, 'binário — o broker só propõe texto');
                    continue;
                }
                const change = this.classify(root, rel, buffer.toString('utf8'), hashes[rel]);
                if (change) {
                    changes.push(change);
                }
            }
        };
        walk('');

        // The other direction: what the baseline had and the worktree no longer does.
        for (const rel of Object.keys(hashes)) {
            if (seen.has(rel) || skippedPaths.has(rel)) {
                continue;
            }
            const deletion = this.classifyDeletion(root, rel, hashes[rel]);
            if (deletion) {
                changes.push(deletion);
            }
        }

        return {
            changes: changes.sort((a, b) => a.relPath.localeCompare(b.relPath)),
            skipped: skipped.sort((a, b) => a.relPath.localeCompare(b.relPath))
        };
    }

    /** One worktree file, against its baseline hash and the project's bytes. */
    protected classify(
        root: string,
        rel: string,
        mine: string,
        baseHash: string | undefined
    ): HarvestedChange | undefined {
        const mineHash = createHash('sha256').update(Buffer.from(mine, 'utf8')).digest('hex');
        if (baseHash !== undefined && baseHash === mineHash) {
            return undefined;   // the agent did not touch this file
        }
        const projectFile = path.join(root, rel);
        const projectHash = fs.existsSync(projectFile) ? this.hashFile(projectFile) : undefined;
        if (projectHash === mineHash) {
            return undefined;   // already identical in the project; nothing to propose
        }
        let theirs = '';
        if (projectHash !== undefined) {
            try {
                theirs = fs.readFileSync(projectFile, 'utf8');
            } catch (err) {
                return {
                    relPath: rel,
                    kind: 'modify',
                    addedLines: 0,
                    removedLines: 0,
                    proposed: false,
                    detail: `arquivo do projeto ilegível: ${this.msg(err)}`
                };
            }
        }
        // Line counts here are a summary for the list; the authoritative diff is
        // the one the broker computes with the Rust engine when proposing.
        const before = theirs ? theirs.split('\n') : [];
        const after = mine.split('\n');
        const conflict = baseHash !== undefined && projectHash !== undefined && projectHash !== baseHash;
        return {
            relPath: rel,
            kind: projectHash === undefined ? 'create' : 'modify',
            addedLines: after.filter(l => !before.includes(l)).length,
            removedLines: before.filter(l => !after.includes(l)).length,
            proposed: false,
            conflict: conflict || undefined,
            detail: conflict
                ? 'você também mudou este arquivo depois da baseline — propor sobrescreveria o seu trabalho'
                : undefined
        };
    }

    /**
     * A file the baseline had and the worktree does not.
     *
     * It is reported and NOT proposed: the broker has no delete effect, so there
     * is no snapshot and no rollback for it. Pretending otherwise (proposing an
     * empty file, say) would write a lie into the project.
     */
    protected classifyDeletion(
        root: string,
        rel: string,
        baseHash: string
    ): HarvestedChange | undefined {
        const projectFile = path.join(root, rel);
        if (!fs.existsSync(projectFile)) {
            return undefined;   // already gone from the project; nothing to decide
        }
        const projectHash = this.hashFile(projectFile);
        let lines = 0;
        try {
            lines = fs.readFileSync(projectFile, 'utf8').split('\n').length;
        } catch { /* unreadable — the count stays 0, the deletion is still reported */ }
        const conflict = projectHash !== undefined && projectHash !== baseHash;
        return {
            relPath: rel,
            kind: 'delete',
            addedLines: 0,
            removedLines: lines,
            proposed: false,
            conflict: conflict || undefined,
            detail: conflict
                ? 'o agente apagou este arquivo e você o mudou depois da baseline — ' +
                  'exclusão não passa pelo broker, decida à mão'
                : 'o agente apagou este arquivo na worktree — o broker não tem efeito de ' +
                  'exclusão, então isto NÃO foi proposto: decida à mão'
        };
    }

    // ── state ──────────────────────────────────────────────────────────────

    protected absorb(state: SessionState, event: AgentEvent): void {
        const entries = Object.entries(event as Record<string, Record<string, unknown>>);
        if (entries.length === 0) {
            return;
        }
        const [kind, payload] = entries[0];
        switch (kind) {
            case 'MessageDelta': {
                // Stream deltas into the last agent line instead of one line per token.
                const text = String(payload.text ?? '');
                const last = state.events[state.events.length - 1];
                if (last && last.kind === 'agente') {
                    last.text += text;
                } else {
                    this.push(state, 'agente', text);
                }
                break;
            }
            case 'Thinking':
                this.push(state, 'pensando', String(payload.summary ?? ''));
                break;
            case 'ToolCall':
                this.push(state, 'ferramenta', String(payload.name ?? ''));
                break;
            case 'PermissionRequested': {
                // Not observability: the agent is blocked until this is answered.
                const requestId = Number(payload.request_id ?? 0);
                const action = String(payload.action ?? '');
                const detail = String(payload.detail ?? '');
                if (!state.pending.some(p => p.requestId === requestId)) {
                    state.pending.push({
                        requestId,
                        action,
                        detail,
                        edits: this.editsOf(payload.edits),
                        at: new Date().toISOString()
                    });
                }
                this.push(state, 'permissão', `${action}: ${detail} — aguardando decisão`);
                break;
            }
            case 'Diff':
                this.push(state, 'diff', `${payload.path} +${payload.added}/-${payload.removed}`);
                break;
            case 'Warning':
                this.push(state, 'aviso', `${payload.code}: ${payload.detail}`);
                break;
            case 'Ended':
                state.phase = 'idle';
                // A turn that ended took its unanswered questions with it. Leaving
                // them on screen would offer a button that answers nothing.
                if (state.pending.length > 0) {
                    this.push(
                        state,
                        'permissão',
                        `${state.pending.length} pedido(s) sem resposta caíram com o fim do turno — ` +
                        'não respondido conta como negado'
                    );
                    state.pending = [];
                }
                this.push(state, 'fim', JSON.stringify(payload.outcome));
                break;
            case 'Started':
                break;
            default:
                this.push(state, kind.toLowerCase(), JSON.stringify(payload).slice(0, 200));
        }
    }

    /**
     * Normalizes the adapter's proposed edits for rendering.
     *
     * `old_text: null` (the agent did not report the previous content) becomes
     * `undefined` rather than an empty string: an empty string would render as
     * "this file was empty", which is a different and false claim.
     */
    protected editsOf(raw: unknown): PermissionEditView[] {
        if (!Array.isArray(raw)) {
            return [];
        }
        return raw.map(entry => {
            const e = entry as Record<string, unknown>;
            const oldText = e.old_text;
            return {
                path: String(e.path ?? ''),
                oldText: typeof oldText === 'string' ? oldText : undefined,
                newText: String(e.new_text ?? ''),
                truncated: e.truncated === true
            };
        });
    }

    protected push(state: SessionState, kind: string, text: string): void {
        state.events.push({ at: new Date().toISOString(), kind, text });
        if (state.events.length > EVENT_CAP) {
            state.events.splice(0, state.events.length - EVENT_CAP);
        }
    }

    protected state(root: string): SessionState {
        let state = this.states.get(root);
        if (!state) {
            state = { agent: 'claude', phase: 'none', events: [], changes: [], skipped: [], pending: [] };
            this.states.set(root, state);
        }
        return state;
    }

    protected view(state: SessionState): AgentSessionSnapshot {
        return {
            agent: state.agent,
            phase: state.phase,
            sessionId: state.sessionId,
            worktree: state.worktree,
            events: state.events.slice(-60),
            lastError: state.lastError,
            changes: state.changes,
            skipped: state.skipped,
            baseline: state.baseline,
            pending: state.pending,
            usage: state.usage,
            lastSwap: state.lastSwap
        };
    }

    protected msg(err: unknown): string {
        return err instanceof Error ? err.message : String(err);
    }

    protected rootPath(rootUri: string): string {
        if (!rootUri) {
            throw new Error('nenhum projeto aberto');
        }
        const raw = rootUri.includes('://') ? FileUri.fsPath(new URI(rootUri)) : rootUri;
        const resolved = path.resolve(raw);
        if (!fs.existsSync(resolved)) {
            throw new Error(`raiz de projeto inexistente: ${resolved}`);
        }
        return resolved;
    }
}
