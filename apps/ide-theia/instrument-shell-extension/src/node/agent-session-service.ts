// AGENT SESSION — implementation of the pre-disk path.
//
// See common/agent-session-protocol.ts for why the session runs against a git
// worktree instead of the project itself.

import { injectable, inject } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AgentEvent, EngineService } from 'engine-extension';
import { GovernedWriteService } from '../common/governed-protocol';
import {
    AgentSessionService,
    AgentSessionSnapshot,
    HarvestedChange,
    SessionEventView,
    SessionPhase
} from '../common/agent-session-protocol';

/** Where the agent's worktree lives (IDE runtime state, git-ignored). */
const WORKTREE_DIR = path.join('.instrument', 'agent-worktree');

/** Owner identity for effects harvested out of an agent session. */
const EVENT_CAP = 200;

/** Directories never compared between worktree and project. */
const SKIP = new Set([
    '.git', 'node_modules', '.instrument', 'target', 'lib', 'dist', 'src-gen', '.aag'
]);

const MAX_FILE_BYTES = 512 * 1024;

interface SessionState {
    agent: string;
    phase: SessionPhase;
    sessionId?: string;
    worktree?: string;
    events: SessionEventView[];
    lastError?: string;
    changes: HarvestedChange[];
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
        return this.view(this.state(this.rootPath(rootUri)));
    }

    async start(rootUri: string, agent: string): Promise<AgentSessionSnapshot> {
        const root = this.rootPath(rootUri);
        const state = this.state(root);
        state.agent = agent;
        state.phase = 'starting';
        state.lastError = undefined;
        state.changes = [];

        const worktree = await this.ensureWorktree(root);
        if (typeof worktree !== 'string') {
            state.phase = 'failed';
            state.lastError = worktree.error;
            return this.view(state);
        }
        state.worktree = worktree;

        try {
            // read_only stays false INSIDE THE WORKTREE: the agent must be able to
            // work. The worktree is not the project, so this grants it nothing over
            // the project — every change still has to cross the broker in `harvest`.
            const started = await this.engine.agentStartSession({
                agent,
                owner: 'owner:instrument-ide',
                workspaceRoot: worktree,
                readOnly: false,
                sandbox: 'isolated'
            });
            state.sessionId = started.session_id;
            state.phase = 'idle';
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
        return this.view(state);
    }

    async harvest(rootUri: string): Promise<AgentSessionSnapshot> {
        const root = this.rootPath(rootUri);
        const state = this.state(root);
        if (!state.worktree) {
            throw new Error('nenhuma worktree de agente para colher');
        }
        const changes = this.compare(root, state.worktree);

        // One decision at a time: the broker's approval is positional, so we
        // propose the first change and report the rest as queued behind it.
        let proposedOne = false;
        for (const change of changes) {
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
        if (changes.length === 0) {
            this.push(state, 'colheita', 'nenhuma mudança na worktree');
        }
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
        this.push(state, 'session', 'sessão encerrada');
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
    protected async ensureWorktree(root: string): Promise<string | { error: string }> {
        const target = path.join(root, WORKTREE_DIR);
        if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
            return target;
        }
        fs.mkdirSync(target, { recursive: true });

        if (fs.existsSync(path.join(root, '.git'))) {
            const added = await run('git', ['worktree', 'add', '--detach', target, 'HEAD'], root);
            if (added.code === 0) {
                return target;
            }
            // Fall through to the copy: a failed worktree is not a reason to give
            // the agent the project itself.
        }
        try {
            this.copyProject(root, target);
        } catch (err) {
            return { error: `não foi possível isolar o projeto para o agente: ${this.msg(err)}` };
        }
        return target;
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

    /** Files whose bytes differ between the worktree and the project. */
    protected compare(root: string, worktree: string): HarvestedChange[] {
        const changes: HarvestedChange[] = [];
        const walk = (relDir: string): void => {
            const dir = path.join(worktree, relDir);
            let names: string[];
            try {
                names = fs.readdirSync(dir);
            } catch {
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
                const change = this.compareOne(root, worktree, rel);
                if (change) {
                    changes.push(change);
                }
            }
        };
        walk('');
        return changes.sort((a, b) => a.relPath.localeCompare(b.relPath));
    }

    protected compareOne(root: string, worktree: string, rel: string): HarvestedChange | undefined {
        let mine: string;
        try {
            mine = fs.readFileSync(path.join(worktree, rel), 'utf8');
        } catch {
            return undefined;
        }
        const projectFile = path.join(root, rel);
        let theirs = '';
        if (fs.existsSync(projectFile)) {
            try {
                theirs = fs.readFileSync(projectFile, 'utf8');
            } catch {
                return undefined;
            }
        }
        if (mine === theirs) {
            return undefined;
        }
        // Line counts here are a summary for the list; the authoritative diff is
        // the one the broker computes with the Rust engine when proposing.
        const before = theirs ? theirs.split('\n') : [];
        const after = mine.split('\n');
        return {
            relPath: rel,
            addedLines: after.filter(l => !before.includes(l)).length,
            removedLines: before.filter(l => !after.includes(l)).length,
            proposed: false
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
            case 'PermissionRequested':
                this.push(state, 'permissão', `${payload.action}: ${payload.detail}`);
                break;
            case 'Diff':
                this.push(state, 'diff', `${payload.path} +${payload.added}/-${payload.removed}`);
                break;
            case 'Warning':
                this.push(state, 'aviso', `${payload.code}: ${payload.detail}`);
                break;
            case 'Ended':
                state.phase = 'idle';
                this.push(state, 'fim', JSON.stringify(payload.outcome));
                break;
            case 'Started':
                break;
            default:
                this.push(state, kind.toLowerCase(), JSON.stringify(payload).slice(0, 200));
        }
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
            state = { agent: 'claude', phase: 'none', events: [], changes: [] };
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
            changes: state.changes
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
