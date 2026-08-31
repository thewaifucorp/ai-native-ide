// WRITE SOURCE LEDGER — who wrote this file?
//
// The observer can see that a file changed, but "changed outside the IDE" is only
// useful if the IDE first subtracts the writes it DID perform. Without that, the
// person saving a file in Monaco shows up as an external write and the whole
// surface cries wolf until nobody reads it.
//
// So every write the IDE knows about is noted here the moment it happens, with a
// timestamp: the editor saving, the broker executing an approved effect, an MCP
// tool call, the harness writing its own artifacts. At scan time the observer asks
// this ledger who wrote a given path.
//
// ── HONESTY ───────────────────────────────────────────────────────────────
// A note only counts when its timestamp is within `MATCH_WINDOW_MS` of the file's
// modification time — the write that produced THIS mtime is the one we recorded.
// A stale note never gets to claim a later write, and anything unmatched stays
// `unknown` rather than being attributed to a plausible-looking source.

import { injectable } from '@theia/core/shared/inversify';
import * as path from 'path';

/** Who performed a write the IDE knows about. */
export type WriteSource = 'editor' | 'governed' | 'mcp' | 'harness';

/** How close a note has to be to the file's mtime to claim it. */
export const MATCH_WINDOW_MS = 10_000;

/** Entries kept per project root. */
const LEDGER_CAP = 500;

export interface WriteNote {
    /** Epoch ms when the IDE performed the write. */
    at: number;
    /** Path relative to the project root. */
    relPath: string;
    source: WriteSource;
    /** What exactly did it — tool name, effect id, "salvo no editor". */
    detail: string;
}

@injectable()
export class WriteSourceLedger {

    protected readonly byRoot = new Map<string, WriteNote[]>();

    /** Record a write the IDE just performed. */
    note(rootFsPath: string, relPath: string, source: WriteSource, detail: string): void {
        const key = path.resolve(rootFsPath);
        const notes = this.byRoot.get(key) ?? [];
        notes.push({ at: Date.now(), relPath: this.normalize(relPath), source, detail });
        if (notes.length > LEDGER_CAP) {
            notes.splice(0, notes.length - LEDGER_CAP);
        }
        this.byRoot.set(key, notes);
    }

    /**
     * The write this ledger recorded for `relPath` around `mtimeMs`, if any.
     * Returns the most recent qualifying note, or undefined when the IDE did not
     * perform this write (or cannot prove that it did).
     */
    attribute(rootFsPath: string, relPath: string, mtimeMs: number): WriteNote | undefined {
        const notes = this.byRoot.get(path.resolve(rootFsPath));
        if (!notes) {
            return undefined;
        }
        const target = this.normalize(relPath);
        let best: WriteNote | undefined;
        for (const note of notes) {
            if (note.relPath !== target) {
                continue;
            }
            if (Math.abs(note.at - mtimeMs) > MATCH_WINDOW_MS) {
                continue;
            }
            if (!best || note.at > best.at) {
                best = note;
            }
        }
        return best;
    }

    /** Notes for a root, newest first — for diagnostics. */
    recent(rootFsPath: string, limit = 20): WriteNote[] {
        const notes = this.byRoot.get(path.resolve(rootFsPath)) ?? [];
        return notes.slice(-limit).reverse();
    }

    /** Same separator shape on both sides of the comparison. */
    protected normalize(relPath: string): string {
        return relPath.split(path.sep).join('/');
    }
}
