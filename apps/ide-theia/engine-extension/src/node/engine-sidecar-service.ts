// Backend service: spawns the Rust `engine-sidecar` binary as a child process
// and proxies EngineService calls to it over line-delimited JSON on stdio.

import { injectable } from '@theia/core/shared/inversify';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { AgentEvent, AgentProbe, BrokerActivity, EngineService, Hunk } from '../common/engine-protocol';

interface PendingRequest {
    resolve(value: unknown): void;
    reject(error: Error): void;
}

/**
 * Default location of the release binary produced by `cargo build --release` in
 * `ide-theia-spike/engine-sidecar/`. Anchored on the backend process cwd, which
 * is the app root when the IDE is launched with `theia start` / `yarn start`
 * (robust regardless of how this module is bundled into `lib/backend`).
 * Override with the ENGINE_SIDECAR_BIN env var to point anywhere else.
 */
const DEFAULT_BIN = path.resolve(
    process.cwd(),
    'engine-sidecar/target/release/engine-sidecar'
);

function resolveBinaryPath(): string {
    return process.env.ENGINE_SIDECAR_BIN || DEFAULT_BIN;
}

@injectable()
export class EngineSidecarService implements EngineService {
    private child: ChildProcessWithoutNullStreams | undefined;
    private reader: readline.Interface | undefined;
    private nextId = 1;
    private readonly pending = new Map<number, PendingRequest>();

    /** Lazily spawns the sidecar, reusing a live process across calls. */
    protected ensureProcess(): ChildProcessWithoutNullStreams {
        if (this.child && this.child.exitCode === null && !this.child.killed) {
            return this.child;
        }
        const bin = resolveBinaryPath();
        if (!fs.existsSync(bin)) {
            throw new Error(
                `Rust engine sidecar binary not found at '${bin}'. Build it with ` +
                `'cargo build --release' in ide-theia-spike/engine-sidecar/ ` +
                `(see engine-sidecar/BUILD.md), or set ENGINE_SIDECAR_BIN.`
            );
        }
        const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        child.on('error', err => this.failAll(err));
        child.on('exit', code => {
            this.failAll(new Error(`engine sidecar exited (code ${code ?? 'unknown'})`));
            this.reader?.close();
            this.reader = undefined;
            this.child = undefined;
        });
        child.stderr.on('data', chunk =>
            console.error(`[engine-sidecar] ${String(chunk).trim()}`)
        );
        const reader = readline.createInterface({ input: child.stdout });
        reader.on('line', line => this.onLine(line));
        this.child = child;
        this.reader = reader;
        return child;
    }

    /** Correlates one response line back to its pending request by id. */
    protected onLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }
        let message: { id?: number; result?: unknown; error?: string };
        try {
            message = JSON.parse(trimmed);
        } catch {
            console.error(`[engine-sidecar] unparseable line: ${trimmed}`);
            return;
        }
        const id = typeof message.id === 'number' ? message.id : undefined;
        if (id === undefined) {
            return;
        }
        const request = this.pending.get(id);
        if (!request) {
            return;
        }
        this.pending.delete(id);
        if (message.error) {
            request.reject(new Error(message.error));
        } else {
            request.resolve(message.result);
        }
    }

    protected failAll(error: Error): void {
        for (const request of this.pending.values()) {
            request.reject(error);
        }
        this.pending.clear();
    }

    /** Writes one request and resolves when its correlated reply arrives. */
    protected call<T>(method: string, params: object): Promise<T> {
        let child: ChildProcessWithoutNullStreams;
        try {
            child = this.ensureProcess();
        } catch (err) {
            return Promise.reject(err instanceof Error ? err : new Error(String(err)));
        }
        const id = this.nextId++;
        const payload = JSON.stringify({ id, method, params }) + '\n';
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
            child.stdin.write(payload, err => {
                if (err) {
                    this.pending.delete(id);
                    reject(err);
                }
            });
        });
    }

    ping(): Promise<{ pong: boolean; engine: string }> {
        return this.call('ping', {});
    }

    async diff(original: string, proposed: string): Promise<Hunk[]> {
        const result = await this.call<{ hunks: Hunk[] }>('diff', { original, proposed });
        return result.hunks;
    }

    async mergeSelected(original: string, proposed: string, selected: number[]): Promise<string> {
        const result = await this.call<{ merged: string }>('merge_selected', {
            original,
            proposed,
            selected
        });
        return result.merged;
    }

    // ── Real governed-write broker (ide-domain WorkspaceEffectBroker) ──────────

    brokerPropose(
        root: string,
        owner: string,
        effectId: string,
        relativePath: string,
        content: string
    ): Promise<{ awaiting_approval?: boolean; written?: boolean; path?: string }> {
        return this.call('broker_propose', {
            root,
            owner,
            effect_id: effectId,
            relative_path: relativePath,
            content
        });
    }

    brokerApprove(root: string, owner: string): Promise<{ approved_id: number }> {
        return this.call('broker_approve', { root, owner });
    }

    brokerRollback(
        root: string,
        owner: string,
        effectId: string
    ): Promise<{ rolledback: boolean }> {
        return this.call('broker_rollback', { root, owner, effect_id: effectId });
    }

    brokerActivity(root: string, owner: string): Promise<{ activity: BrokerActivity[] }> {
        return this.call('broker_activity', { root, owner });
    }

    agentProbe(agent: string): Promise<AgentProbe> {
        return this.call('agent_probe', { agent });
    }

    // ── Real ACP session ──────────────────────────────────────────────────────

    agentStartSession(params: {
        agent: string;
        owner: string;
        workspaceRoot: string;
        homeDir?: string;
        readOnly?: boolean;
        deniedPaths?: string[];
        sandbox?: 'isolated' | 'workspace-net' | 'trusted';
    }): Promise<{ session_id: string }> {
        return this.call('agent_start_session', {
            agent: params.agent,
            owner: params.owner,
            workspace_root: params.workspaceRoot,
            home_dir: params.homeDir,
            read_only: params.readOnly,
            denied_paths: params.deniedPaths,
            sandbox: params.sandbox
        });
    }

    agentSubmitTask(
        agent: string,
        sessionId: string,
        prompt: string,
        expectation?: 'conversation' | 'code-change'
    ): Promise<{ task_id: number }> {
        return this.call('agent_submit_task', {
            agent,
            session_id: sessionId,
            prompt,
            expectation
        });
    }

    agentNextEvent(agent: string, sessionId: string): Promise<{ event: AgentEvent | null }> {
        return this.call('agent_next_event', { agent, session_id: sessionId });
    }

    agentCancel(agent: string, sessionId: string, graceful = true): Promise<{ cancelled: boolean }> {
        return this.call('agent_cancel', { agent, session_id: sessionId, graceful });
    }

    agentRespondPermission(
        agent: string,
        sessionId: string,
        requestId: number,
        allow: boolean,
        denyEndsTurn = true
    ): Promise<{ answered: boolean }> {
        return this.call('agent_respond_permission', {
            agent,
            session_id: sessionId,
            request_id: requestId,
            allow,
            deny_ends_turn: denyEndsTurn
        });
    }
}
