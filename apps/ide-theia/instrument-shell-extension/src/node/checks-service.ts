// DETERMINISTIC CHECKS (§4) — implementation.
//
// Deliberately thin. Every judgement lives in `crates/ide-harness`, and every
// observed fact is gathered by the sidecar (`engine-sidecar/src/harness.rs`).
// This layer only resolves the workspace root and carries the owner identity,
// because the pending-effect count is owner-scoped and comes from the same
// broker the governed-write path uses.
//
// It does no caching. A report is a statement about NOW; serving a stored one
// after a file changed would be the panel claiming knowledge it no longer has.

import { injectable, inject } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { EngineService, HarnessRun } from 'engine-extension';
import { ChecksService } from '../common/checks-protocol';

/** Same owner the governed-write path uses, so `pending_effects` counts the
 *  effects this shell actually proposed rather than a foreign scope. */
const OWNER = 'owner:instrument-ide';

@injectable()
export class ChecksServiceImpl implements ChecksService {

    @inject(EngineService) protected readonly engine!: EngineService;

    async run(rootUri: string, runTools = false): Promise<HarnessRun> {
        const root = FileUri.fsPath(new URI(rootUri));
        return this.engine.harnessRun(root, OWNER, runTools);
    }
}
