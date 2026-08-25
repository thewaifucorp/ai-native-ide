// Backend Theia module for the instrument shell: binds the M3 governed-write
// service and exposes it to the frontend over JSON-RPC on GOVERNED_SERVICE_PATH.
// Same DI + RpcConnectionHandler pattern as engine-extension's backend module.
//
// The EngineService (Rust ide-diff sidecar) that GovernedWriteServiceImpl injects
// is bound by engine-extension's own backend module — both load into the same
// backend Inversify container.

import { ConnectionHandler, RpcConnectionHandler } from '@theia/core';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ContainerModule } from '@theia/core/shared/inversify';
import { GOVERNED_SERVICE_PATH, GovernedWriteService } from '../common/governed-protocol';
import { GovernedWriteServiceImpl } from './governed-write-service';
import { AagStaticContribution } from './aag-static-contribution';

export default new ContainerModule(bind => {
    bind(GovernedWriteServiceImpl).toSelf().inSingletonScope();
    bind(GovernedWriteService).toService(GovernedWriteServiceImpl);

    // Serve the repo's `.aag/` knowledge-graph artifacts at /aag for the Grafo mode.
    bind(AagStaticContribution).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(AagStaticContribution);
    bind(ConnectionHandler)
        .toDynamicValue(
            ctx =>
                new RpcConnectionHandler<object>(GOVERNED_SERVICE_PATH, () =>
                    ctx.container.get<GovernedWriteService>(GovernedWriteService)
                )
        )
        .inSingletonScope();
});
