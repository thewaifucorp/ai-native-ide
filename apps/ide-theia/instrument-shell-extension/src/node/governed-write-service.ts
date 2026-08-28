// Backend service for the GOVERNED WRITE loop.
//
// It performs a governed write over the REAL workspace filesystem, and — as of
// M4 — the governance is REAL: every write crosses `ide-domain`'s
// `WorkspaceEffectBroker` (Rust: capability registry + SqliteApprovalGate +
// snapshot store) via the engine sidecar. This Node service is now only a thin
// adapter that maps the frontend's propose/approve/rollback UX onto the broker's
// propose → approve → propose-executes → rollback lifecycle, and computes the
// diff preview shown on the dock card.
//
//   proposeWrite  → read the current bytes (confined, for the diff preview only),
//                   compute the diff via the REAL Rust `ide-diff` sidecar, then
//                   QUEUE the effect in the real broker (`brokerPropose`). The
//                   broker writes nothing on this first call.
//   approve       → grant the broker's SqliteApprovalGate (`brokerApprove`) and
//                   re-send the identical effect (`brokerPropose`), which the
//                   broker now EXECUTES — writing the file and snapshotting it.
//   rollback      → `brokerRollback`, restoring the broker's own snapshot.
//
// ── HONEST BOUNDARY ────────────────────────────────────────────────────────
// The awaiting-approval gate, the write, and the snapshot/restore all live in
// Rust now (ide-domain). The Node side neither writes workspace files nor keeps
// snapshots; it only reads the pre-image to render the diff. Path confinement is
// enforced authoritatively by the Rust broker (`resolve_workspace_path`); the
// `confine()` here guards only the local pre-image read.
// ────────────────────────────────────────────────────────────────────────────

import { injectable, inject } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { FileUri } from '@theia/core/lib/common/file-uri';
import * as fs from 'fs';
import * as path from 'path';
import { BrokerActivity, EngineService, Hunk } from 'engine-extension';
import { WriteSourceLedger } from './write-source-ledger';
import {
    EffectPolicy,
    GovernedWriteService,
    RuntimeStateNotice,
    WriteProposal,
    DiffLinePreview
} from '../common/governed-protocol';

/** Fixed owner identity for effects proposed through the instrument shell. */
const OWNER = 'owner:instrument-ide';

/**
 * Per-process prefix for effect ids.
 *
 * ── WHY THIS EXISTS (a real governance bug this fixes) ────────────────────
 * The broker's approval gate persists in `<root>/.instrument/effects.sqlite3`,
 * and a grant is matched by (owner, effect id, path, content). This service used
 * to number effects `w1, w2, …` from a counter that RESTARTED at 1 on every
 * backend boot. So an approval granted in one session and left unconsumed — the
 * user approves, the confirming propose never happens, the IDE is closed — stayed
 * valid, and the NEXT session's first proposal reused `w1`. Same id, same file,
 * same bytes: the gate matched and the broker EXECUTED the write on the first
 * propose, with nobody deciding.
 *
 * Reproduced against the real sidecar: propose `w1` + approve, restart the
 * sidecar, propose `w1` again with the same content -> `{written: true}` and the
 * file changed on disk. Also observed in the running app.
 *
 * A process-unique prefix makes an effect id unrepeatable across sessions, so a
 * stale grant can never match a future proposal. `verifyQueued` below is the
 * belt-and-braces check: if a queueing propose ever comes back executed anyway,
 * we do not paper over it.
 */
const EFFECT_PREFIX = `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

interface StoredRecord {
    proposal: WriteProposal;
    /** Absolute fs path of the workspace root — the broker's scope key. */
    rootFsPath: string;
    /** Path relative to the root, as the broker expects it. */
    relPath: string;
    /** The bytes `approve` re-sends so the broker executes the write. */
    proposed: string;
}

/** Cap on diff lines shipped to the dock decision card. */
const PREVIEW_CAP = 14;

/*
 * ── HISTÓRIA, PARA NÃO VOLTAR ─────────────────────────────────────────────
 * `broker_approve` já aprovou "o efeito pendente mais antigo" do escopo em vez
 * do efeito decidido. Com duas decisões abertas, clicar "Permitir" na proposta
 * B autorizava a proposta A, e B continuava aguardando. Observado como
 * `broker did not execute approved effect … (got {awaiting_approval: true})`.
 *
 * Duas guardas viviam aqui por causa disso: recusar propostas empilhadas, e
 * drenar autorizações antigas até a decisão cair no efeito certo. As duas
 * saíram quando o sidecar passou a aprovar POR EFFECT ID
 * (`ide-domain::WorkspaceEffectBroker::approve_effect`), que é a correção na
 * origem. O teste que fixa isso vive em
 * `crates/ide-domain/tests/workspace_effects.rs`
 * (`approving_the_second_proposal_does_not_authorize_the_first`).
 */

@injectable()
export class GovernedWriteServiceImpl implements GovernedWriteService {

    // The Rust sidecar host: `ide-diff` (diff/merge) AND the real
    // `ide-domain` WorkspaceEffectBroker (governed writes). engine-extension's
    // backend module binds it into the same Inversify container.
    @inject(EngineService) protected readonly engine!: EngineService;

    // The observer subtracts the IDE's own writes; a governed write is the most
    // clearly "ours" there is, so it says so the moment it lands.
    @inject(WriteSourceLedger) protected readonly ledger!: WriteSourceLedger;

    protected readonly records = new Map<string, StoredRecord>();
    protected seq = 1;

    /**
     * Resolve `<root>/<relPath>` for the local pre-image READ only, rejecting
     * anything that escapes the root — lexically and via symlinks. The broker
     * re-confines authoritatively before any write.
     */
    protected confine(rootFsPath: string, relPath: string): string {
        const root = fs.realpathSync(path.resolve(rootFsPath));
        const absPath = path.resolve(root, relPath);
        const rel = path.relative(root, absPath);
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error(`path '${relPath}' escapes the workspace root`);
        }
        // Walk up to the nearest ancestor that EXISTS. A write that creates a
        // file — and, with it, the directory it lives in — still has to be
        // confined, and `dirname` alone throws ENOENT for a nested new path
        // instead of checking anything.
        let probe = fs.existsSync(absPath) ? absPath : path.dirname(absPath);
        while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
            probe = path.dirname(probe);
        }
        const real = fs.realpathSync(probe);
        const realRel = path.relative(root, real);
        if (realRel !== '' && (realRel.startsWith('..') || path.isAbsolute(realRel))) {
            throw new Error(`path '${relPath}' escapes the workspace root via symlink`);
        }
        if (fs.existsSync(absPath) && fs.lstatSync(absPath).isSymbolicLink()) {
            throw new Error(`refusing to read through a symlink: ${relPath}`);
        }
        return absPath;
    }

    async proposeWrite(rootUri: string, relPath: string, newContent: string): Promise<WriteProposal> {
        const rootFsPath = FileUri.fsPath(new URI(rootUri));

        const absPath = this.confine(rootFsPath, relPath);
        if (fs.existsSync(absPath) && !fs.statSync(absPath).isFile()) {
            throw new Error(`not a workspace file: ${relPath}`);
        }
        // A file that does not exist yet has an EMPTY pre-image, and the diff is
        // all-added — which is exactly what a creation is. Refusing new files
        // here would push §5's adoptions (guidance, references) outside the
        // broker, and the point of routing them through it is that project
        // content only ever appears as a reviewed diff.
        const creating = !fs.existsSync(absPath);
        const original = creating ? '' : fs.readFileSync(absPath, 'utf8');

        // Real diff via the Rust ide-diff engine — same round trip as the demo.
        const hunks = await this.engine.diff(original, newContent);

        // Process-unique, monotonic id: never reused by a later session.
        let id = `${EFFECT_PREFIX}-${this.seq++}`;

        // QUEUE the effect in the REAL Rust broker. It writes nothing yet — it
        // records the proposal and returns awaiting_approval.
        let queued = await this.engine.brokerPropose(rootFsPath, OWNER, id, relPath, newContent);

        // ── DEFENSE IN DEPTH ───────────────────────────────────────────────
        // With process-unique ids this must not happen. If it ever does, an
        // effect got executed without a decision, so: revert it through the
        // broker's own snapshot, re-propose under a fresh id, and report what
        // actually happened — including the case where the revert fails and the
        // bytes are still on disk. Never report `awaiting` for a write that ran.
        let warning: string | undefined;
        if (queued.written === true) {
            this.ledger.note(rootFsPath, relPath, 'governed', `efeito ${id} executado por autorização pendente`);
            let reverted = false;
            try {
                const rollback = await this.engine.brokerRollback(rootFsPath, OWNER, id);
                reverted = rollback.rolledback === true;
            } catch {
                reverted = false;
            }
            const onDisk = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';
            if (!reverted && onDisk === newContent) {
                // The write stands and the broker could not undo it. Hand back an
                // APPROVED proposal so the dock offers a rollback, and say so.
                const applied = this.summarize(hunks, id, relPath, 'approved');
                applied.warning =
                    'Esta escrita foi executada sem aprovação (autorização pendente de uma ' +
                    'sessão anterior) e o rollback do broker falhou. Os bytes estão no disco.';
                this.records.set(id, { proposal: applied, rootFsPath, relPath, proposed: newContent });
                return applied;
            }
            warning = reverted
                ? 'Uma autorização pendente de uma sessão anterior executou esta escrita ' +
                  'sozinha. Ela foi revertida pelo snapshot do broker e a proposta foi ' +
                  'refeita — nada ficou aplicado sem você decidir.'
                : 'Uma autorização pendente de uma sessão anterior disparou esta escrita, ' +
                  'mas o arquivo no disco não contém a mudança. A proposta foi refeita.';
            id = `${EFFECT_PREFIX}-${this.seq++}`;
            queued = await this.engine.brokerPropose(rootFsPath, OWNER, id, relPath, newContent);
        }

        if (queued.awaiting_approval !== true) {
            throw new Error(
                `broker did not queue effect ${id} for approval (got ${JSON.stringify(queued)})`
            );
        }

        const proposal = this.summarize(hunks, id, relPath, 'awaiting');
        proposal.creating = creating;
        proposal.warning = warning;
        this.records.set(id, { proposal, rootFsPath, relPath, proposed: newContent });

        // ── §14: the MODE decides whether this stops here ──────────────────
        // The engine answers with the project's mode and the permission that
        // actually applies to this path, for the class this write belongs to.
        const policy = await this.policyFor(rootFsPath, relPath);
        proposal.policy = policy;
        if (policy?.decision === 'auto_approve_recorded') {
            // Yolo does NOT skip the broker: the effect was proposed above, and
            // approving it here still snapshots, still writes through the broker
            // and still leaves a rollback. What changed is only that nobody was
            // asked.
            const applied = await this.execute(id, true);
            applied.policy = { ...policy, autoApproved: true };
            return applied;
        }
        return proposal;
    }

    /**
     * Which effect class a write belongs to, decided by WHERE it lands.
     *
     * `ide-modes` has always had two classes and nothing produced the throwaway
     * one, so `prototype` was a branch no call could reach. The line already
     * drawn everywhere else in this repo is the honest producer: `.instrument/`
     * is IDE runtime state for the project (checks, previews, the agent's
     * worktree) — it is not reviewed as a diff and it is not the project's
     * content. A write there is throwaway by construction, so it does not stop
     * to ask in any mode; it is still proposed, snapshotted and recorded, and it
     * is still reversible.
     *
     * Everything else is the project itself: durable, and it follows the mode.
     */
    protected classOf(relPath: string): 'durable' | 'prototype' {
        const first = relPath.split(/[\\/]/).filter(Boolean)[0];
        return first === '.instrument' ? 'prototype' : 'durable';
    }

    /**
     * Asks `ide-modes` (through the sidecar) what this effect requires.
     *
     * A failure here is NOT a reason to auto-approve: `undefined` leaves the
     * proposal awaiting a decision, which is the side that cannot lose data. The
     * card reports the missing answer rather than implying a rule was applied.
     */
    protected async policyFor(
        rootFsPath: string,
        relPath: string
    ): Promise<EffectPolicy | undefined> {
        try {
            const decision = await this.engine.policyDecide(rootFsPath, this.classOf(relPath), {
                resource: relPath
            });
            return {
                mode: decision.mode,
                permissions: decision.permissions,
                scoped: decision.scoped,
                decision: decision.effect,
                interruption: decision.interruption,
                explain: decision.explain
            };
        } catch (err) {
            console.warn(
                `[governed] política de efeito indisponível (${err instanceof Error ? err.message : String(err)}) — ` +
                    'a proposta fica aguardando decisão'
            );
            return undefined;
        }
    }

    /** Build the wire-level proposal from the real diff. */
    protected summarize(
        hunks: Hunk[],
        id: string,
        relPath: string,
        state: WriteProposal['state']
    ): WriteProposal {
        let added = 0;
        let removed = 0;
        const preview: DiffLinePreview[] = [];
        for (const hunk of hunks) {
            for (const line of hunk.lines) {
                if (line.tag === 'added') {
                    added++;
                } else if (line.tag === 'removed') {
                    removed++;
                }
                if (preview.length < PREVIEW_CAP) {
                    preview.push({ tag: line.tag, text: line.text });
                }
            }
        }
        return {
            id,
            relPath,
            addedLines: added,
            removedLines: removed,
            hunkCount: hunks.length,
            state,
            preview
        };
    }

    async approve(id: string): Promise<WriteProposal> {
        return this.execute(id);
    }

    /**
     * Grants and executes one queued effect through the broker.
     *
     * Shared by the person clicking "Permitir" and by an auto-approving policy,
     * ON PURPOSE: there is exactly one way a write reaches disk, so a mode can
     * change who decides without ever changing what governs. The ledger note says
     * which of the two it was.
     */
    protected async execute(id: string, auto = false): Promise<WriteProposal> {
        const rec = this.require(id);
        // Grant THIS effect, then re-send the identical write: the broker executes
        // it and snapshots the pre-image. No draining and no ordering assumption —
        // the grant names the effect, so other pending decisions are untouched.
        await this.engine.brokerApprove(rec.rootFsPath, OWNER, id);
        // The broker confines by canonicalizing the PARENT, and it never creates
        // directories — deliberately. So a creation inside a directory that does
        // not exist yet needs the directory made here, at approval time and not
        // at proposal time: a proposal that is denied must leave no trace in the
        // project. Rollback still removes the created file (the broker snapshots
        // "did not exist"); the now-empty directory stays, and that is why this
        // happens only after a decision.
        if (rec.proposal.creating === true) {
            fs.mkdirSync(path.dirname(path.join(rec.rootFsPath, rec.relPath)), { recursive: true });
        }
        const written = await this.engine.brokerPropose(
            rec.rootFsPath,
            OWNER,
            id,
            rec.relPath,
            rec.proposed
        );
        if (written.written !== true) {
            // Never report `approved` for a write that did not run.
            throw new Error(
                `broker did not execute approved effect ${id} (got ${JSON.stringify(written)})`
            );
        }
        this.ledger.note(
            rec.rootFsPath,
            rec.relPath,
            'governed',
            auto ? `efeito ${id} aprovado pela política do modo` : `efeito ${id} aprovado`
        );
        rec.proposal.state = 'approved';
        return rec.proposal;
    }

    /** Proposals still awaiting a decision (or awaiting a rollback) for this
     *  project, newest first — including the ones an agent created over MCP. */
    async pending(rootUri: string): Promise<WriteProposal[]> {
        const rootFsPath = FileUri.fsPath(new URI(rootUri));
        return [...this.records.values()]
            .filter(r => r.rootFsPath === rootFsPath && r.proposal.state !== 'rolledback')
            .map(r => r.proposal)
            .reverse();
    }

    /**
     * The broker's audit trail for THIS project — no reinterpretation, and no
     * foreign scope.
     *
     * The broker is already keyed by (owner, root), so this should be
     * project-local by construction. The filter is the guard that says so out
     * loud (§6): Activity shows Bastion effects of the open project, never a
     * fleet-wide feed. If an entry ever arrives with a path outside the root, it
     * is dropped and COUNTED — a silently mixed-in event would make the trail
     * unusable as evidence about this project.
     */
    async activity(rootUri: string): Promise<BrokerActivity[]> {
        const rootFsPath = FileUri.fsPath(new URI(rootUri));
        const result = await this.engine.brokerActivity(rootFsPath, OWNER);
        const root = path.resolve(rootFsPath);
        const local = result.activity.filter(entry => {
            if (!entry.path) {
                // An entry with no path is scope-neutral (the broker keyed it to
                // this project); keeping it is not a scope leak.
                return true;
            }
            // ── DEFEITO QUE A JORNADA DO §12 ACHOU ──────────────────────────
            // O broker emite `proposed` com o caminho RELATIVO que recebeu
            // (`a.md`) e `snapshot_created`/`executed` com o absoluto. Este
            // filtro resolvia os dois contra o cwd do BACKEND, então todo evento
            // relativo caía fora da raiz e era descartado como "de outro
            // projeto" — a trilha mostrava a execução e escondia a proposta que
            // a originou, silenciosamente, num contador de console.
            //
            // Um caminho relativo é, por construção, relativo à raiz do efeito.
            const resolved = path.isAbsolute(entry.path)
                ? path.resolve(entry.path)
                : path.resolve(root, entry.path);
            return resolved === root || resolved.startsWith(`${root}${path.sep}`);
        });
        const foreign = result.activity.length - local.length;
        if (foreign > 0) {
            // Never swallowed: the count reaches the log, and the ledger note
            // keeps it attributable.
            console.warn(
                `[governed] ${foreign} evento(s) do broker fora de ${rootFsPath} foram ` +
                    'descartados da trilha do projeto'
            );
        }
        return local;
    }

    async rollback(id: string): Promise<WriteProposal> {
        const rec = this.require(id);
        await this.engine.brokerRollback(rec.rootFsPath, OWNER, id);
        this.ledger.note(rec.rootFsPath, rec.relPath, 'governed', `efeito ${id} revertido`);
        rec.proposal.state = 'rolledback';
        return rec.proposal;
    }

    async runtimeState(rootUri: string): Promise<RuntimeStateNotice> {
        const root = FileUri.fsPath(new URI(rootUri));
        const dir = '.instrument';
        const abs = path.join(root, dir);
        const exists = fs.existsSync(abs);
        const gitRepo = fs.existsSync(path.join(root, '.git'));

        // O que existe lá dentro, dito em português: "banco sqlite" não explica
        // nada a quem só quer saber por que o repositório dela mudou.
        const known: [string, string][] = [
            ['effects.sqlite3', 'o registro de efeitos do broker (o que foi proposto, aprovado, revertido)'],
            ['baseline', 'a linha de base dos arquivos, usada para ver mudança feita fora do IDE'],
            ['config.json', 'a configuração deste projeto (modo, permissões, camadas)'],
            ['preview.json', 'a declaração do preview deste projeto'],
            ['preview.log', 'a saída crua do último preview']
        ];
        const contents = exists
            ? known.filter(([name]) => fs.existsSync(path.join(abs, name))).map(([, what]) => what)
            : [];

        return { dir, exists, gitRepo, ignored: this.ignoresRuntimeDir(root, dir), contents };
    }

    /**
     * Lê as regras de `.gitignore` da raiz — só as que cobrem este diretório.
     *
     * Não chama `git check-ignore`: um projeto pode não ter git instalado, e o
     * aviso não pode depender disso. A leitura é conservadora de propósito: se
     * houver dúvida, o aviso aparece. Um aviso a mais custa um clique; um aviso
     * de menos deixa a pessoa com o repositório sujo sem saber por quê.
     */
    protected ignoresRuntimeDir(root: string, dir: string): boolean {
        const file = path.join(root, '.gitignore');
        if (!fs.existsSync(file)) {
            return false;
        }
        let text: string;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch {
            return false;
        }
        return text
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('#'))
            .some(line => {
                const bare = line.replace(/^\//, '').replace(/\/$/, '');
                return bare === dir || bare === `${dir}/**` || bare === '*';
            });
    }

    async proposeIgnoreRuntimeState(rootUri: string): Promise<WriteProposal> {
        const root = FileUri.fsPath(new URI(rootUri));
        const notice = await this.runtimeState(rootUri);
        if (notice.ignored) {
            throw new Error('`.instrument/` já está ignorado neste projeto');
        }
        const file = path.join(root, '.gitignore');
        const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        const linha = `${notice.dir}/`;
        const comentario = '# Estado de runtime do IDE (broker, baseline, config deste projeto).';
        const prefixo = current.length === 0 || current.endsWith('\n') ? '' : '\n';
        const proposto = `${current}${prefixo}${comentario}\n${linha}\n`;
        return this.proposeWrite(rootUri, '.gitignore', proposto);
    }

    protected require(id: string): StoredRecord {
        const stored = this.records.get(id);
        if (!stored) {
            throw new Error(`unknown write proposal: ${id}`);
        }
        return stored;
    }
}
