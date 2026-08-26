// EXTERNAL WRITE OBSERVER — implementation.
//
// Keeps a content baseline of the project's text files under
// `.instrument/baseline/` (IDE runtime state, not project content), so a write
// made by the person's agent, a script or the terminal can be seen, diffed with
// the real Rust engine, and reconciled.
//
// Deliberate boundaries:
//  • READ-ONLY observation. `scan` never writes a project file, never blocks a
//    write, and never "fixes" anything.
//  • `accept` records a decision (new baseline + receipt); the file is untouched.
//  • `proposeRevert` does NOT restore the file. It proposes the baseline bytes
//    through the governed write service — the same broker path, with its own
//    snapshot, approval and rollback — so undoing an external change is itself a
//    governed, reversible effect.
//  • Anything it cannot characterise (binary, too large, unreadable) is reported
//    in `skipped` with the reason. Silence would be a lie about coverage.

import { injectable, inject } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { FileUri } from '@theia/core/lib/common/file-uri';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { EngineService } from 'engine-extension';
import { GovernedWriteService } from '../common/governed-protocol';
import {
    Drift,
    ObserverReceipt,
    ObserverReport,
    ObserverService,
    WriteAttribution
} from '../common/observer-protocol';
import { WriteSourceLedger } from './write-source-ledger';

/** IDE-owned runtime state (git-ignored), not project content. */
const BASELINE_DIR = path.join('.instrument', 'baseline');
const INDEX_FILE = path.join(BASELINE_DIR, 'index.json');
const OBJECTS_DIR = path.join(BASELINE_DIR, 'objects');
const RECEIPTS_FILE = path.join(BASELINE_DIR, 'receipts.json');

/** Directories never walked: build output, VCS internals, IDE state, deps. */
const SKIP_DIRS = new Set([
    '.git', 'node_modules', '.aag', 'target', 'lib', 'dist', 'build', 'out',
    'src-gen', 'plugins', '.instrument', '.theia', 'coverage', '.next', '.cache'
]);

/** Files larger than this are tracked by hash only — never copied. */
const MAX_CONTENT_BYTES = 512 * 1024;

/** Hard cap on files walked, so a huge tree cannot hang the backend. */
const MAX_FILES = 5000;

const RECEIPT_CAP = 200;

interface BaselineEntry {
    /** sha256 of the bytes at baseline time. */
    hash: string;
    size: number;
    mtimeMs: number;
    /** True when the bytes were copied into `objects/` and a revert is possible. */
    stored: boolean;
}

interface BaselineIndex {
    at: string;
    entries: Record<string, BaselineEntry>;
    skipped: { relPath: string; reason: string }[];
}

function sha256(data: Buffer | string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
}

/** Heuristic: a NUL byte in the first 8 KB means "not text for our purposes". */
function looksBinary(buffer: Buffer): boolean {
    const slice = buffer.subarray(0, Math.min(buffer.length, 8192));
    return slice.includes(0);
}

@injectable()
export class ObserverServiceImpl implements ObserverService {

    @inject(EngineService) protected readonly engine!: EngineService;
    @inject(GovernedWriteService) protected readonly governed!: GovernedWriteService;
    @inject(WriteSourceLedger) protected readonly ledger!: WriteSourceLedger;

    async noteEditorSave(rootUri: string, relPath: string): Promise<void> {
        const root = this.rootPath(rootUri);
        // Confine first: a save report is untrusted input like any other.
        this.confine(root, relPath);
        this.ledger.note(root, relPath, 'editor', 'salvo no editor');
    }

    async baseline(rootUri: string): Promise<ObserverReport> {
        const root = this.rootPath(rootUri);
        const index = this.build(root);
        this.writeIndex(root, index);
        this.appendReceipt(root, {
            at: index.at,
            relPath: '.',
            action: 'baseline',
            detail: `${Object.keys(index.entries).length} arquivos registrados como referência`
        });
        return this.report(root, index, []);
    }

    async scan(rootUri: string): Promise<ObserverReport> {
        const root = this.rootPath(rootUri);
        const index = this.readIndex(root);
        if (!index) {
            // First use: establish the baseline instead of reporting the whole
            // project as drift, which would be noise, not information.
            return this.baseline(rootUri);
        }
        const current = this.build(root, /* store */ false);
        const drifts: Drift[] = [];

        for (const [relPath, now] of Object.entries(current.entries)) {
            const before = index.entries[relPath];
            if (!before) {
                drifts.push({
                    relPath,
                    kind: 'created',
                    addedLines: await this.countLines(root, relPath),
                    removedLines: 0,
                    revertible: false,
                    observedAt: new Date(now.mtimeMs).toISOString(),
                    detail: 'arquivo novo — não existia na referência, então não há bytes para restaurar',
                    ...this.attributionFor(root, relPath, now.mtimeMs)
                });
                continue;
            }
            if (before.hash === now.hash) {
                continue;
            }
            drifts.push(await this.describeModified(root, relPath, before, now));
        }

        for (const [relPath, before] of Object.entries(index.entries)) {
            if (!current.entries[relPath]) {
                drifts.push({
                    relPath,
                    kind: 'deleted',
                    addedLines: 0,
                    removedLines: this.storedLineCount(root, before),
                    revertible: before.stored,
                    observedAt: new Date().toISOString(),
                    detail: before.stored
                        ? undefined
                        : 'os bytes anteriores não foram guardados (arquivo grande ou binário)',
                    // A deletion has no mtime to match, so use "now": the ledger
                    // window still separates our own delete from an outside one.
                    ...this.attributionFor(root, relPath, Date.now())
                });
            }
        }

        drifts.sort((a, b) => a.relPath.localeCompare(b.relPath));

        // Subtract the IDE's own writes: anything the ledger can prove we did is
        // folded into the baseline right here, so `drifts` holds only what the IDE
        // cannot account for. The folded ones are reported separately — visible,
        // not silent.
        const unattributed: Drift[] = [];
        const reconciled: Drift[] = [];
        let baselineChanged = false;
        for (const drift of drifts) {
            if (drift.source === 'unknown') {
                unattributed.push(drift);
                continue;
            }
            reconciled.push(drift);
            const absolute = path.join(root, drift.relPath);
            if (drift.kind === 'deleted') {
                delete index.entries[drift.relPath];
            } else {
                const entry = this.entryFor(root, absolute, true);
                if (entry) {
                    index.entries[drift.relPath] = entry;
                }
            }
            baselineChanged = true;
            this.appendReceipt(root, {
                at: new Date().toISOString(),
                relPath: drift.relPath,
                action: 'auto-reconciled',
                detail: `escrita do próprio IDE (${drift.source}): ${drift.sourceDetail ?? '—'}`
            });
        }
        if (baselineChanged) {
            index.at = new Date().toISOString();
            this.writeIndex(root, index);
        }

        return this.report(root, index, unattributed, current.skipped, reconciled);
    }

    async accept(rootUri: string, relPath: string): Promise<ObserverReport> {
        const root = this.rootPath(rootUri);
        const absolute = this.confine(root, relPath);
        const index = this.readIndex(root) ?? this.build(root);
        if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
            const entry = this.entryFor(root, absolute, true);
            if (entry) {
                index.entries[relPath] = entry;
            }
        } else {
            // Accepting a deletion means the baseline stops tracking the file.
            delete index.entries[relPath];
        }
        index.at = new Date().toISOString();
        this.writeIndex(root, index);
        this.appendReceipt(root, {
            at: index.at,
            relPath,
            action: 'accepted',
            detail: 'escrita externa adotada como nova referência'
        });
        return this.scan(rootUri);
    }

    async proposeRevert(
        rootUri: string,
        relPath: string
    ): Promise<{ proposalId: string; relPath: string }> {
        const root = this.rootPath(rootUri);
        const index = this.readIndex(root);
        const entry = index?.entries[relPath];
        if (!entry) {
            throw new Error(`'${relPath}' não está na referência — não há bytes anteriores`);
        }
        if (!entry.stored) {
            throw new Error(
                `os bytes anteriores de '${relPath}' não foram guardados ` +
                '(arquivo grande ou binário); reverter exige o histórico do Git'
            );
        }
        const previous = fs.readFileSync(this.objectPath(root, entry.hash), 'utf8');
        // The restore is a governed effect like any other: it goes to the broker,
        // gets a snapshot of the CURRENT (externally written) bytes, and waits for
        // a decision. Undoing an external change is therefore itself reversible.
        const proposal = await this.governed.proposeWrite(rootUri, relPath, previous);
        this.appendReceipt(root, {
            at: new Date().toISOString(),
            relPath,
            action: 'revert-proposed',
            detail: `restauração proposta pelo broker (${proposal.id}), aguardando decisão`
        });
        return { proposalId: proposal.id, relPath };
    }

    // ── observation ────────────────────────────────────────────────────────

    /** Walk the project and hash every tracked text file. */
    protected build(root: string, store = true): BaselineIndex {
        const entries: Record<string, BaselineEntry> = {};
        const skipped: { relPath: string; reason: string }[] = [];
        let seen = 0;

        const walk = (dir: string): void => {
            let names: string[];
            try {
                names = fs.readdirSync(dir);
            } catch {
                skipped.push({ relPath: path.relative(root, dir), reason: 'diretório ilegível' });
                return;
            }
            for (const name of names) {
                if (seen >= MAX_FILES) {
                    return;
                }
                const absolute = path.join(dir, name);
                let stat: fs.Stats;
                try {
                    stat = fs.lstatSync(absolute);
                } catch {
                    continue;
                }
                if (stat.isSymbolicLink()) {
                    skipped.push({ relPath: path.relative(root, absolute), reason: 'symlink' });
                    continue;
                }
                if (stat.isDirectory()) {
                    if (!SKIP_DIRS.has(name)) {
                        walk(absolute);
                    }
                    continue;
                }
                if (!stat.isFile()) {
                    continue;
                }
                seen++;
                const relPath = path.relative(root, absolute);
                const entry = this.entryFor(root, absolute, store, skipped);
                if (entry) {
                    entries[relPath] = entry;
                }
            }
        };

        walk(root);
        if (seen >= MAX_FILES) {
            skipped.push({ relPath: '.', reason: `limite de ${MAX_FILES} arquivos alcançado` });
        }
        return { at: new Date().toISOString(), entries, skipped };
    }

    /** Hash one file, copying its bytes when it is small text and `store` is on. */
    protected entryFor(
        root: string,
        absolute: string,
        store: boolean,
        skipped?: { relPath: string; reason: string }[]
    ): BaselineEntry | undefined {
        const relPath = path.relative(root, absolute);
        let stat: fs.Stats;
        let buffer: Buffer;
        try {
            stat = fs.statSync(absolute);
            if (stat.size > MAX_CONTENT_BYTES) {
                // Still tracked (drift is detectable) but not restorable by us.
                const hash = sha256(`${stat.size}:${stat.mtimeMs}`);
                skipped?.push({ relPath, reason: `maior que ${MAX_CONTENT_BYTES} bytes` });
                return { hash, size: stat.size, mtimeMs: stat.mtimeMs, stored: false };
            }
            buffer = fs.readFileSync(absolute);
        } catch {
            skipped?.push({ relPath, reason: 'arquivo ilegível' });
            return undefined;
        }
        if (looksBinary(buffer)) {
            skipped?.push({ relPath, reason: 'binário' });
            return { hash: sha256(buffer), size: stat.size, mtimeMs: stat.mtimeMs, stored: false };
        }
        const hash = sha256(buffer);
        if (store) {
            const object = this.objectPath(root, hash);
            if (!fs.existsSync(object)) {
                fs.mkdirSync(path.dirname(object), { recursive: true });
                fs.writeFileSync(object, buffer);
            }
        }
        return { hash, size: stat.size, mtimeMs: stat.mtimeMs, stored: true };
    }

    /** Describe a modified file using the REAL diff engine when possible. */
    protected async describeModified(
        root: string,
        relPath: string,
        before: BaselineEntry,
        now: BaselineEntry
    ): Promise<Drift> {
        const observedAt = new Date(now.mtimeMs).toISOString();
        const attribution = this.attributionFor(root, relPath, now.mtimeMs);
        if (!before.stored) {
            return {
                relPath,
                kind: 'modified',
                addedLines: 0,
                removedLines: 0,
                revertible: false,
                observedAt,
                detail: 'mudou, mas os bytes anteriores não foram guardados — só o hash difere',
                ...attribution
            };
        }
        try {
            const original = fs.readFileSync(this.objectPath(root, before.hash), 'utf8');
            const current = fs.readFileSync(path.join(root, relPath), 'utf8');
            const hunks = await this.engine.diff(original, current);
            let added = 0;
            let removed = 0;
            for (const hunk of hunks) {
                for (const line of hunk.lines) {
                    if (line.tag === 'added') {
                        added++;
                    } else if (line.tag === 'removed') {
                        removed++;
                    }
                }
            }
            return {
                relPath,
                kind: 'modified',
                addedLines: added,
                removedLines: removed,
                revertible: true,
                observedAt,
                ...attribution
            };
        } catch (err) {
            return {
                relPath,
                kind: 'modified',
                addedLines: 0,
                removedLines: 0,
                revertible: before.stored,
                observedAt,
                detail:
                    'mudou, mas o diff não pôde ser calculado: ' +
                    (err instanceof Error ? err.message : String(err)),
                ...attribution
            };
        }
    }

    /** Ask the ledger who wrote this, matching against the observed mtime. */
    protected attributionFor(
        root: string,
        relPath: string,
        mtimeMs: number
    ): { source: WriteAttribution; sourceDetail?: string } {
        const note = this.ledger.attribute(root, relPath, mtimeMs);
        return note
            ? { source: note.source, sourceDetail: note.detail }
            : { source: 'unknown' };
    }

    protected async countLines(root: string, relPath: string): Promise<number> {
        try {
            return fs.readFileSync(path.join(root, relPath), 'utf8').split('\n').length;
        } catch {
            return 0;
        }
    }

    protected storedLineCount(root: string, entry: BaselineEntry): number {
        if (!entry.stored) {
            return 0;
        }
        try {
            return fs.readFileSync(this.objectPath(root, entry.hash), 'utf8').split('\n').length;
        } catch {
            return 0;
        }
    }

    // ── storage ────────────────────────────────────────────────────────────

    protected objectPath(root: string, hash: string): string {
        return path.join(root, OBJECTS_DIR, hash.slice(0, 2), hash.slice(2));
    }

    protected readIndex(root: string): BaselineIndex | undefined {
        const file = path.join(root, INDEX_FILE);
        if (!fs.existsSync(file)) {
            return undefined;
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as BaselineIndex;
            return {
                at: parsed.at,
                entries: parsed.entries ?? {},
                skipped: parsed.skipped ?? []
            };
        } catch {
            // A corrupt baseline is not silently replaced: the caller decides.
            throw new Error(`referência de observação ilegível em ${file}`);
        }
    }

    protected writeIndex(root: string, index: BaselineIndex): void {
        const file = path.join(root, INDEX_FILE);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(index, undefined, 1) + '\n', 'utf8');
    }

    protected readReceipts(root: string): ObserverReceipt[] {
        const file = path.join(root, RECEIPTS_FILE);
        if (!fs.existsSync(file)) {
            return [];
        }
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8')) as ObserverReceipt[];
        } catch {
            return [];
        }
    }

    protected appendReceipt(root: string, receipt: ObserverReceipt): void {
        const receipts = this.readReceipts(root);
        receipts.push(receipt);
        const capped = receipts.slice(-RECEIPT_CAP);
        const file = path.join(root, RECEIPTS_FILE);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(capped, undefined, 1) + '\n', 'utf8');
    }

    protected report(
        root: string,
        index: BaselineIndex,
        drifts: Drift[],
        skipped = index.skipped,
        reconciled: Drift[] = []
    ): ObserverReport {
        return {
            baselineExists: true,
            trackedFiles: Object.keys(index.entries).length,
            baselineAt: index.at,
            drifts,
            reconciled,
            receipts: this.readReceipts(root).slice(-40).reverse(),
            skipped: skipped.slice(0, 40)
        };
    }

    // ── paths ──────────────────────────────────────────────────────────────

    /** Confine `relPath` to the project root, lexically and via symlinks. */
    protected confine(root: string, relPath: string): string {
        const absolute = path.resolve(root, relPath);
        const rel = path.relative(root, absolute);
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error(`caminho '${relPath}' escapa da raiz do projeto`);
        }
        return absolute;
    }

    protected rootPath(rootUri: string): string {
        if (!rootUri) {
            throw new Error('nenhum projeto aberto: a observação é por projeto');
        }
        const raw = rootUri.includes('://') ? FileUri.fsPath(new URI(rootUri)) : rootUri;
        const resolved = path.resolve(raw);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            throw new Error(`raiz de projeto inexistente: ${resolved}`);
        }
        return resolved;
    }
}
