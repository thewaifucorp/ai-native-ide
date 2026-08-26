// Frontend Theia module for the sketch-001 "Instrumento" layout as a REAL shell.
//
// It rebinds ApplicationShell to a subclass that reshapes createLayout(), binds
// the bespoke region widgets (rail/crumb/pulse are consumed by the shell layout;
// work/dock are placed into real areas by the contribution), and imports the
// ported 001 CSS for its bundling side effect. The 001 navigator "Arquivos" mode
// is now the REAL @theia/navigator file explorer in the native left panel, so no
// bespoke navigator widget is bound here anymore.

import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution } from '@theia/core/lib/common/command';
import { FrontendApplicationContribution, WidgetFactory } from '@theia/core/lib/browser';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import {
    RemoteConnectionProvider,
    ServiceConnectionProvider
} from '@theia/core/lib/browser/messaging/service-connection-provider';
import { InstrumentStore } from './instrument-store';
import { InstrumentShellContribution } from './instrument-shell-contribution';
import { InstrumentApplicationShell } from './instrument-application-shell';
import { InstrumentDataContribution } from './instrument-data-contribution';
import { GOVERNED_SERVICE_PATH, GovernedWriteService } from '../common/governed-protocol';
import { RailWidget } from './widgets/rail-widget';
import { WorkWidget } from './widgets/work-widget';
import { DockWidget } from './widgets/dock-widget';
import { CrumbWidget } from './widgets/crumb-widget';
import { PulseWidget } from './widgets/pulse-widget';
import { NavModesWidget } from './widgets/nav-modes-widget';
import { ProdutoWidget } from './widgets/produto-widget';
import { CapabilitySurfaceWidget } from './widgets/capability-surface-widget';
import { ToolsWidget } from './widgets/tools-widget';
import { CAPABILITY_SERVICE_PATH, CapabilityService } from '../common/capability-protocol';
import { HARNESS_SERVICE_PATH, HarnessService } from '../common/harness-protocol';
import { OBSERVER_SERVICE_PATH, ObserverService } from '../common/observer-protocol';
import { AGENT_SESSION_SERVICE_PATH, AgentSessionService } from '../common/agent-session-protocol';
import { PRODUCT_SERVICE_PATH, ProductService } from '../common/product-protocol';
import { InstrumentCapabilityContribution } from './instrument-capability-contribution';

import '../../src/browser/style/instrument-shell.css';

// One-time layout reset (M2). A returning user may carry a persisted Lumino
// layout from M1 / earlier overlay builds whose geometry predates the reconciled
// instrument grid (hidden activity bar, wrapped left column, pinned widths).
// Bump LAYOUT_VERSION on any structural shell change to drop the stale layout
// BEFORE Theia's ShellLayoutRestorer reads it. Runs at module-load, i.e. well
// before `initializeLayout`. Preferences and other storage are untouched.
const LAYOUT_VERSION = 'm15-projeto-semantico';
try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('iws.layoutVersion') !== LAYOUT_VERSION) {
        Object.keys(localStorage)
            .filter(k => k.includes('layout'))
            .forEach(k => localStorage.removeItem(k));
        localStorage.setItem('iws.layoutVersion', LAYOUT_VERSION);
    }
} catch { /* storage unavailable (private mode / SSR) — nothing to reset */ }

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
    bind(InstrumentStore).toSelf().inSingletonScope();

    bind(RailWidget).toSelf().inSingletonScope();
    bind(WorkWidget).toSelf().inSingletonScope();
    bind(DockWidget).toSelf().inSingletonScope();
    bind(CrumbWidget).toSelf().inSingletonScope();
    bind(PulseWidget).toSelf().inSingletonScope();
    bind(NavModesWidget).toSelf().inSingletonScope();
    bind(ProdutoWidget).toSelf().inSingletonScope();
    bind(CapabilitySurfaceWidget).toSelf().inSingletonScope();
    bind(ToolsWidget).toSelf().inSingletonScope();

    // Widget factories so the two tracked area widgets (Overview in MAIN, dock in
    // RIGHT) are recreated when Theia restores a persisted layout on reload.
    bind(WidgetFactory).toDynamicValue(({ container }) => ({
        id: WorkWidget.ID,
        createWidget: () => container.get(WorkWidget)
    })).inSingletonScope();
    bind(WidgetFactory).toDynamicValue(({ container }) => ({
        id: DockWidget.ID,
        createWidget: () => container.get(DockWidget)
    })).inSingletonScope();
    // Bespoke "Produto" navigator mode lives in the LEFT area; a factory lets Theia
    // recreate it when a persisted layout is restored on reload.
    bind(WidgetFactory).toDynamicValue(({ container }) => ({
        id: ProdutoWidget.ID,
        createWidget: () => container.get(ProdutoWidget)
    })).inSingletonScope();
    // The generic capability surface is a MAIN-area tab; a factory recreates it
    // when a persisted layout is restored on reload.
    bind(WidgetFactory).toDynamicValue(({ container }) => ({
        id: CapabilitySurfaceWidget.ID,
        createWidget: () => container.get(CapabilitySurfaceWidget)
    })).inSingletonScope();
    // "Ferramentas" (capability platform + harness) lives in the LEFT area.
    bind(WidgetFactory).toDynamicValue(({ container }) => ({
        id: ToolsWidget.ID,
        createWidget: () => container.get(ToolsWidget)
    })).inSingletonScope();

    // Reshape the workbench: the 001 four-column instrument is the actual shell.
    bind(InstrumentApplicationShell).toSelf().inSingletonScope();
    rebind(ApplicationShell).toService(InstrumentApplicationShell);

    bind(InstrumentShellContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(InstrumentShellContribution);

    // M3 governed-write loop: a typed JSON-RPC proxy to the backend service, plus
    // the contribution that loads the real workspace model and drives the loop.
    bind(GovernedWriteService)
        .toDynamicValue(ctx => {
            const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
            return provider.createProxy<GovernedWriteService>(GOVERNED_SERVICE_PATH);
        })
        .inSingletonScope();
    bind(InstrumentDataContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(InstrumentDataContribution);
    bind(CommandContribution).toService(InstrumentDataContribution);

    // Capability platform + harness provider: typed JSON-RPC proxies to the
    // backend registries, plus the contribution that drives them and keeps the
    // store as the single truth every widget renders from.
    bind(CapabilityService)
        .toDynamicValue(ctx => {
            const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
            return provider.createProxy<CapabilityService>(CAPABILITY_SERVICE_PATH);
        })
        .inSingletonScope();
    bind(HarnessService)
        .toDynamicValue(ctx => {
            const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
            return provider.createProxy<HarnessService>(HARNESS_SERVICE_PATH);
        })
        .inSingletonScope();
    bind(ObserverService)
        .toDynamicValue(ctx => {
            const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
            return provider.createProxy<ObserverService>(OBSERVER_SERVICE_PATH);
        })
        .inSingletonScope();
    bind(AgentSessionService)
        .toDynamicValue(ctx => {
            const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
            return provider.createProxy<AgentSessionService>(AGENT_SESSION_SERVICE_PATH);
        })
        .inSingletonScope();
    bind(ProductService)
        .toDynamicValue(ctx => {
            const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
            return provider.createProxy<ProductService>(PRODUCT_SERVICE_PATH);
        })
        .inSingletonScope();
    bind(InstrumentCapabilityContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(InstrumentCapabilityContribution);
    bind(CommandContribution).toService(InstrumentCapabilityContribution);
});
