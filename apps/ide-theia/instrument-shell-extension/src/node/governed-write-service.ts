// Backend service for the M3 GOVERNED WRITE loop.
//
// It performs a governed write over the REAL workspace filesystem:
//   proposeWrite  → confine path to the workspace root, SNAPSHOT the current
//                   bytes, compute the diff via the EXISTING Rust `ide-diff`
//                   sidecar (reused through the engine-extension EngineService),
//                   and return an awaiting-approval record. It does NOT write.
//   approve       → write the proposed bytes to the real file.
//   rollback      → restore the snapshot bytes.
//
// ── HONEST BOUNDARY ────────────────────────────────────────────────────────
// The governance in THIS service — the awaiting-approval gate and the
// snapshot/restore — is a Node STAND-IN. It proves the end-to-end UX loop on
// real files. The real governance surface, `ide-domain`'s `WorkspaceEffectBroker`
// (Rust: capability tokens + policy gates + audited effect application), is wired
// in M4. The DIFF here is already real (the Rust `ide-diff` engine via the
// sidecar); only the broker/gates are stubbed in Node.
// ────────────────────────────────────────────────────────────────────────────

import { injectable, inject } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { FileUri } from '@theia/core/lib/common/file-uri';
import * as fs from 'fs';
import * as path from 'path';
import { EngineService } from 'engine-extension';
import {
    GovernedWriteService,
    WriteProposal,
    DiffLinePreview
} from '../common/governed-protocol';

interface StoredRecord {
    proposal: WriteProposal;
    absPath: string;
    /** Snapshot of the bytes at propose time — the rollback target. */
    original: string;
    /** The bytes `approve` will write. */
    proposed: string;
}

/** Cap on diff lines shipped to the dock decision card. */
const PREVIEW_CAP = 14;

@injectable()
export class GovernedWriteServiceImpl implements GovernedWriteService {

    // The EXISTING Rust `ide-diff` sidecar, spawned + proxied by engine-extension.
    // Both backend modules share one Inversify container, so this resolves to the
    // same singleton that serves the "Engine: Diff Demo" command.
    @inject(EngineService) protected readonly engine!: EngineService;

    protected readonly records = new Map<string, WriteProposal & { _rec: StoredRecord }>();
    protected seq = 1;

    /** Resolve `<root>/<relPath>` and reject anything that escapes the root. */
    protected confine(rootUri: string, relPath: string): { absPath: string; root: string } {
        const root = path.resolve(FileUri.fsPath(new URI(rootUri)));
        const absPath = path.resolve(root, relPath);
        const rel = path.relative(root, absPath);
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error(`path '${relPath}' escapes the workspace root`);
        }
        return { absPath, root };
    }

    async proposeWrite(rootUri: string, relPath: string, newContent: string): Promise<WriteProposal> {
        const { absPath } = this.confine(rootUri, relPath);
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
        const proposal: WriteProposal = {
            id,
            relPath,
            addedLines: added,
            removedLines: removed,
            hunkCount: hunks.length,
            state: 'awaiting',
            preview
        };
        this.records.set(id, { ...proposal, _rec: { proposal, absPath, original, proposed: newContent } });
        return proposal;
    }

    async approve(id: string): Promise<WriteProposal> {
        const rec = this.require(id);
        fs.writeFileSync(rec.absPath, rec.proposed, 'utf8');
        rec.proposal.state = 'approved';
        return rec.proposal;
    }

    async rollback(id: string): Promise<WriteProposal> {
        const rec = this.require(id);
        fs.writeFileSync(rec.absPath, rec.original, 'utf8');
        rec.proposal.state = 'rolledback';
        return rec.proposal;
    }

    protected require(id: string): StoredRecord {
        const stored = this.records.get(id);
        if (!stored) {
            throw new Error(`unknown write proposal: ${id}`);
        }
        return stored._rec;
    }
}
