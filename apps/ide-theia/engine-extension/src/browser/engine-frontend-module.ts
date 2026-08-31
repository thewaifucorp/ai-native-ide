// Frontend Theia module: binds a typed JSON-RPC proxy to the backend
// EngineService and registers the "Engine: Diff Demo" command.

import { CommandContribution } from '@theia/core';
import { ContainerModule } from '@theia/core/shared/inversify';
import {
    RemoteConnectionProvider,
    ServiceConnectionProvider
} from '@theia/core/lib/browser/messaging/service-connection-provider';
import { ENGINE_SERVICE_PATH, EngineService } from '../common/engine-protocol';
import { EngineCommandContribution } from './engine-command-contribution';

export default new ContainerModule(bind => {
    bind(EngineService)
        .toDynamicValue(ctx => {
            const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
            return provider.createProxy<EngineService>(ENGINE_SERVICE_PATH);
        })
        .inSingletonScope();
    bind(CommandContribution).to(EngineCommandContribution).inSingletonScope();
});
