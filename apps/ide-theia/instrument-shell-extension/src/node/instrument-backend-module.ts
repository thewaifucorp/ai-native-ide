// Backend Theia module for the instrument shell:
//
//  • the M3/M4 governed-write service (real Rust broker behind every write);
//  • the CAPABILITY REGISTRY (generic chassis + its hosted definitions) and the
//    same-origin route that serves a capability's generated artifacts;
//  • the HARNESS PROVIDER registry (manifest/work artifacts discovered from the
//    project, exclusive slots, composable extensions, migration, no bypass);
//  • the MCP surface that exposes all of the above to an external agent.
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
import { OBSERVER_SERVICE_PATH, ObserverService } from '../common/observer-protocol';
import { CHECKS_SERVICE_PATH, ChecksService } from '../common/checks-protocol';
import { ChecksServiceImpl } from './checks-service';
import { ObserverServiceImpl } from './observer-service';
import { WriteSourceLedger } from './write-source-ledger';
import { AGENT_SESSION_SERVICE_PATH, AgentSessionService } from '../common/agent-session-protocol';
import { AgentSessionServiceImpl } from './agent-session-service';
import { PRODUCT_SERVICE_PATH, ProductService } from '../common/product-protocol';
import { ProductServiceImpl } from './product-service';
import { McpContribution } from './mcp-contribution';

export default new ContainerModule(bind => {
    // Shared by every service that writes: the observer subtracts these from
    // what it reports as an external write.
    bind(WriteSourceLedger).toSelf().inSingletonScope();

    bind(GovernedWriteServiceImpl).toSelf().inSingletonScope();
    bind(GovernedWriteService).toService(GovernedWriteServiceImpl);

    bind(CapabilityRegistryService).toSelf().inSingletonScope();
    bind(CapabilityService).toService(CapabilityRegistryService);

    bind(HarnessRegistryService).toSelf().inSingletonScope();
    bind(HarnessService).toService(HarnessRegistryService);

    // Observation of writes the IDE did not perform (the person's own agent, a
    // script, the terminal) — WORK-05.
    bind(ObserverServiceImpl).toSelf().inSingletonScope();
    bind(ObserverService).toService(ObserverServiceImpl);

    // The hosted ACP session: the agent works in a git worktree and every change
    // it makes crosses the broker before reaching the project.
    bind(AgentSessionServiceImpl).toSelf().inSingletonScope();
    bind(AgentSessionService).toService(AgentSessionServiceImpl);

    // Projeto semântico: recursos, autoridades, consumidores e divergências
    // calculadas a partir dos artefatos em `.product/`.
    bind(ProductServiceImpl).toSelf().inSingletonScope();
    bind(ProductService).toService(ProductServiceImpl);

    // Same-origin, per-project, allow-listed serving of capability artifacts
    // (today: `<root>/.aag/graph.html` for the Grafo capability).
    bind(CapabilitySiteContribution).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(CapabilitySiteContribution);

    // Agent-facing MCP surface over the SAME services the UI drives, so an
    // external agent gets the IDE's guarantees instead of writing behind them.
    bind(McpContribution).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(McpContribution);

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
    bind(ConnectionHandler)
        .toDynamicValue(
            ctx =>
                new RpcConnectionHandler<object>(OBSERVER_SERVICE_PATH, () =>
                    ctx.container.get<ObserverService>(ObserverService)
                )
        )
        .inSingletonScope();
    bind(ChecksService).to(ChecksServiceImpl).inSingletonScope();
    bind(ConnectionHandler)
        .toDynamicValue(
            ctx =>
                new RpcConnectionHandler<object>(CHECKS_SERVICE_PATH, () =>
                    ctx.container.get<ChecksService>(ChecksService)
                )
        )
        .inSingletonScope();
    bind(ConnectionHandler)
        .toDynamicValue(
            ctx =>
                new RpcConnectionHandler<object>(AGENT_SESSION_SERVICE_PATH, () =>
                    ctx.container.get<AgentSessionService>(AgentSessionService)
                )
        )
        .inSingletonScope();
    bind(ConnectionHandler)
        .toDynamicValue(
            ctx =>
                new RpcConnectionHandler<object>(PRODUCT_SERVICE_PATH, () =>
                    ctx.container.get<ProductService>(ProductService)
                )
        )
        .inSingletonScope();
});
