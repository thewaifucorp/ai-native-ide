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
import { BrokerActivity, EngineService } from 'engine-extension';
import {
    GovernedWriteService,
    WriteProposal,
    DiffLinePreview
} from '../common/governed-protocol';

/** Fixed owner identity for effects proposed through the instrument shell. */
const OWNER = 'owner:instrument-ide';

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

@injectable()
export class GovernedWriteServiceImpl implements GovernedWriteService {

    // The Rust sidecar host: `ide-diff` (diff/merge) AND the real
    // `ide-domain` WorkspaceEffectBroker (governed writes). engine-extension's
    // backend module binds it into the same Inversify container.
    @inject(EngineService) protected readonly engine!: EngineService;

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

        const id = `w${this.seq++}`;

        // QUEUE the effect in the REAL Rust broker. It writes nothing yet — it
        // records the proposal and returns awaiting_approval.
        const queued = await this.engine.brokerPropose(rootFsPath, OWNER, id, relPath, newContent);
        if (queued.awaiting_approval !== true) {
            throw new Error(
                `broker did not queue effect ${id} for approval (got ${JSON.stringify(queued)})`
            );
        }

        const proposal: WriteProposal = {
            id,
            relPath,
            addedLines: added,
            removedLines: removed,
            hunkCount: hunks.length,
            state: 'awaiting',
            preview
        };
        this.records.set(id, { proposal, rootFsPath, relPath, proposed: newContent });
        return proposal;
    }

    async approve(id: string): Promise<WriteProposal> {
        const rec = this.require(id);
        // Grant the broker's SqliteApprovalGate, then re-send the identical
        // effect: the broker now executes the write and snapshots the pre-image.
        await this.engine.brokerApprove(rec.rootFsPath, OWNER);
        const written = await this.engine.brokerPropose(
            rec.rootFsPath,
            OWNER,
            id,
            rec.relPath,
            rec.proposed
        );
        if (written.written !== true) {
            throw new Error(
                `broker did not execute approved effect ${id} (got ${JSON.stringify(written)})`
            );
        }
        rec.proposal.state = 'approved';
        return rec.proposal;
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
