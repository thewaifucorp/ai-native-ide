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
    GovernedWriteService,
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
        const probe = fs.existsSync(absPath) ? absPath : path.dirname(absPath);
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
        if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
            throw new Error(`no such workspace file: ${relPath}`);
        }
        const original = fs.readFileSync(absPath, 'utf8');

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
        proposal.warning = warning;
        this.records.set(id, { proposal, rootFsPath, relPath, proposed: newContent });
        return proposal;
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
        const rec = this.require(id);
        // Grant THIS effect, then re-send the identical write: the broker executes
        // it and snapshots the pre-image. No draining and no ordering assumption —
        // the grant names the effect, so other pending decisions are untouched.
        await this.engine.brokerApprove(rec.rootFsPath, OWNER, id);
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
        this.ledger.note(rec.rootFsPath, rec.relPath, 'governed', `efeito ${id} aprovado`);
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

    /** Straight passthrough of the broker's audit trail — no reinterpretation. */
    async activity(rootUri: string): Promise<BrokerActivity[]> {
        const rootFsPath = FileUri.fsPath(new URI(rootUri));
        const result = await this.engine.brokerActivity(rootFsPath, OWNER);
        return result.activity;
    }

    async rollback(id: string): Promise<WriteProposal> {
        const rec = this.require(id);
        await this.engine.brokerRollback(rec.rootFsPath, OWNER, id);
        this.ledger.note(rec.rootFsPath, rec.relPath, 'governed', `efeito ${id} revertido`);
        rec.proposal.state = 'rolledback';
        return rec.proposal;
    }

    protected require(id: string): StoredRecord {
        const stored = this.records.get(id);
        if (!stored) {
            throw new Error(`unknown write proposal: ${id}`);
        }
        return stored;
    }
}
