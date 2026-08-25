// Serves the repo's aag knowledge-graph artifacts (the `.aag/` directory) as
// same-origin static files under `/aag`, so the frontend "Grafo" mode can iframe
// the REAL `.aag/graph.html` (a self-contained interactive graph — inline CSS/JS,
// no CDN) without cross-origin/CSP friction.
//
// The `.aag/` dir is found by walking up from the backend cwd (the Theia app
// root) to the enclosing repository root that actually holds it. If none is
// found, the route simply isn't mounted and the Grafo view shows its empty state.

import { injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import * as express from '@theia/core/shared/express';
import * as fs from 'fs';
import * as path from 'path';

/** Walk up from `start` until a directory containing a readable `.aag` is found. */
function findAagDir(start: string): string | undefined {
    let dir = start;
    // Bounded walk to the filesystem root.
    for (let i = 0; i < 12; i++) {
        const candidate = path.join(dir, '.aag');
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
            return candidate;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return undefined;
}

@injectable()
export class AagStaticContribution implements BackendApplicationContribution {
    configure(app: express.Application): void {
        const aagDir = process.env.AAG_DIR || findAagDir(process.cwd());
        if (!aagDir) {
            console.warn('[aag-static] no .aag directory found; /aag route not mounted');
            return;
        }
        // Read-only static serving of the graph artifacts.
        app.use('/aag', express.static(aagDir, { index: false, dotfiles: 'allow' }));
        console.log(`[aag-static] serving ${aagDir} at /aag`);
    }
}
