// Backend Theia module: binds the sidecar service and exposes it to the
// frontend over JSON-RPC on ENGINE_SERVICE_PATH.

import { ConnectionHandler, RpcConnectionHandler } from '@theia/core';
import { ContainerModule } from '@theia/core/shared/inversify';
import { ENGINE_SERVICE_PATH, EngineService } from '../common/engine-protocol';
import { EngineSidecarService } from './engine-sidecar-service';

export default new ContainerModule(bind => {
    bind(EngineSidecarService).toSelf().inSingletonScope();
    bind(EngineService).toService(EngineSidecarService);
    bind(ConnectionHandler)
        .toDynamicValue(
            ctx =>
                new RpcConnectionHandler<object>(ENGINE_SERVICE_PATH, () =>
                    ctx.container.get<EngineService>(EngineService)
                )
        )
        .inSingletonScope();
});
