// Serves a capability's own generated artifacts as SAME-ORIGIN static files, so
// a capability surface (today: the aag graph) can be embedded in an iframe with
// no cross-origin/CSP friction.
//
// It replaces the earlier fixed `/aag` mount, which walked up from the backend
// cwd and therefore always served the IDE repository's own graph — regardless of
// which project the user had open. This route is per-project:
//
//   GET /capability/<capabilityId>/site/<file>?root=<absolute project root>
//
// Guard rails:
//  • `root` must be a root the CapabilityRegistryService has actually detected
//    for (its allow-list) — an arbitrary path cannot be read through this route.
//  • `<file>` is a single path segment from a per-capability allow-list of
//    extensions inside the capability's own artifact directory. No traversal.
//  • Read-only: no method other than GET is handled.

import { injectable, inject } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import * as express from '@theia/core/shared/express';
import * as fs from 'fs';
import * as path from 'path';
import { CapabilityRegistryService, CAPABILITY_SITE_PREFIX } from './capability-registry-service';

/** Where each capability writes the artifacts this route may serve. */
const SITE_DIR: Record<string, string> = {
    grafo: '.aag'
};

const ALLOWED_EXT = new Set(['.html', '.json', '.css', '.js', '.svg', '.graphml', '.txt', '.md']);

@injectable()
export class CapabilitySiteContribution implements BackendApplicationContribution {

    @inject(CapabilityRegistryService) protected readonly registry!: CapabilityRegistryService;

    configure(app: express.Application): void {
        app.get(`${CAPABILITY_SITE_PREFIX}/:capability/site/:file`, (req, res) => {
            const capability = String(req.params.capability);
            const file = String(req.params.file);
            const root = typeof req.query.root === 'string' ? req.query.root : '';

            const siteDir = SITE_DIR[capability];
            if (!siteDir) {
                res.status(404).send('capability sem artefatos servíveis');
                return;
            }
            if (!root || !this.registry.isKnownRoot(root)) {
                // Not detected for → not served. Prevents this route from being a
                // general-purpose file reader.
                res.status(403).send('raiz de projeto não reconhecida pelo registry');
                return;
            }
            if (file.includes('/') || file.includes('\\') || file.includes('..')) {
                res.status(400).send('nome de arquivo inválido');
                return;
            }
            if (!ALLOWED_EXT.has(path.extname(file).toLowerCase())) {
                res.status(415).send('extensão não servível');
                return;
            }
            const absolute = path.join(path.resolve(root), siteDir, file);
            if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
                res.status(404).send('artefato ainda não gerado');
                return;
            }
            // The artifact is regenerated in place; never let a proxy cache it.
            res.setHeader('Cache-Control', 'no-store');
            res.sendFile(absolute);
        });
        console.log(`[capability-site] serving ${CAPABILITY_SITE_PREFIX}/:capability/site/:file`);
    }
}
