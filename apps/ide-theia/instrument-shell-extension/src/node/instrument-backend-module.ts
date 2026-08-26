// Backend Theia module for the instrument shell:
//
//  • the M3/M4 governed-write service (real Rust broker behind every write);
//  • the CAPABILITY REGISTRY (generic chassis + its hosted definitions) and the
//    same-origin route that serves a capability's generated artifacts;
//  • the HARNESS PROVIDER registry (versioned manifests, exclusive slots,
//    composable extensions, migration, and no path around the broker).
//
// The EngineService (Rust sidecar: ide-diff, broker, agent probe) that these
// services inject is bound by engine-extension's own backend module — both load
// into the same backend Inversify container.

import { ConnectionHandler, RpcConnectionHandler } from '@theia/core';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ContainerModule } from '@theia/core/shared/inversify';
import { GOVERNED_SERVICE_PATH, GovernedWriteService } from '../common/governed-protocol';
import { CAPABILITY_SERVICE_PATH, CapabilityService } from '../common/capability-protocol';
import { HARNESS_SERVICE_PATH, HarnessService } from '../common/harness-protocol';
import { GovernedWriteServiceImpl } from './governed-write-service';
import { CapabilityRegistryService } from './capability-registry-service';
import { CapabilitySiteContribution } from './capability-site-contribution';
import { HarnessRegistryService } from './harness-registry-service';

export default new ContainerModule(bind => {
    bind(GovernedWriteServiceImpl).toSelf().inSingletonScope();
    bind(GovernedWriteService).toService(GovernedWriteServiceImpl);

    bind(CapabilityRegistryService).toSelf().inSingletonScope();
    bind(CapabilityService).toService(CapabilityRegistryService);

    bind(HarnessRegistryService).toSelf().inSingletonScope();
    bind(HarnessService).toService(HarnessRegistryService);

    // Same-origin, per-project, allow-listed serving of capability artifacts
    // (today: `<root>/.aag/graph.html` for the Grafo capability).
    bind(CapabilitySiteContribution).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(CapabilitySiteContribution);

    bind(ConnectionHandler)
        .toDynamicValue(
            ctx =>
                new RpcConnectionHandler<object>(GOVERNED_SERVICE_PATH, () =>
                    ctx.container.get<GovernedWriteService>(GovernedWriteService)
                )
        )
        .inSingletonScope();
    bind(ConnectionHandler)
        .toDynamicValue(
            ctx =>
                new RpcConnectionHandler<object>(CAPABILITY_SERVICE_PATH, () =>
                    ctx.container.get<CapabilityService>(CapabilityService)
                )
        )
        .inSingletonScope();
    bind(ConnectionHandler)
        .toDynamicValue(
            ctx =>
                new RpcConnectionHandler<object>(HARNESS_SERVICE_PATH, () =>
                    ctx.container.get<HarnessService>(HarnessService)
                )
        )
        .inSingletonScope();
});
