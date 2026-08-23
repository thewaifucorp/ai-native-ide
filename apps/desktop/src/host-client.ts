/**
 * Renderer-side boundary for the deliberately small desktop-host command surface.
 *
 * This module never exposes a generic `invoke(command, args)` escape hatch to UI
 * code. A browser preview has no host: calls then report that fact explicitly
 * instead of manufacturing a project, capability card, or effect result.
 */

export type HostCall<T> =
  | { state: "available"; value: T }
  | { state: "unavailable"; reason: string }
  | { state: "failed"; message: string };

export interface HostStatus {
  host: "tauri";
  eventChannel: string;
  rendererPrivileges: string;
  extensions: string[];
}

export type ViabilityGateStatus = "pendingArtifactMeasurement" | "passingByConstruction" | "blocker";

export interface TauriViabilityReport {
  host: "tauri";
  fallback: string;
  gates: Array<{
    id: string;
    assertion: string;
    failureIsStructuralBlocker: boolean;
    status: ViabilityGateStatus;
  }>;
}

export interface SemanticProjectInput {
  projectId: string;
  title: string;
  intent: string;
}

export interface SemanticProjectRecord {
  id: string;
  title: string;
  intent: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface WorkspaceResource {
  id: string;
  kind: "directory" | "repository";
  canonicalPath: string;
  createdAtMs: number;
}

export type AgentTarget = "claude" | "codex" | "gemini" | "opencode";
export type AgentAvailability = "Ready" | "Degraded" | "Unavailable";
export type IdeCoverage = "Enforced" | "DeclaredOnly" | "HarnessOwned" | "Unknown";

export interface AgentCapabilityCard {
  target: AgentTarget;
  descriptor: {
    id: string;
    adapterVersion: string;
    targetVersion: string;
    transport: string;
    supportsResume: boolean;
    supportsSteer: boolean;
    supportsUsageReporting: boolean;
    supportsDiffEvents: boolean;
    supportsPermissionBridge: boolean;
    supportsConcurrentSessions: boolean;
    policy: {
      toolVisibility: IdeCoverage;
      approvals: IdeCoverage;
      egress: IdeCoverage;
      budget: IdeCoverage;
      sandbox: IdeCoverage;
    };
    degradations: string[];
  } | null;
  health: {
    availability: AgentAvailability;
    detectedVersion: string | null;
    detail: string | null;
    degradations: string[];
  };
  authBoundary: string;
}

interface HostCommandMap {
  host_status: { args: undefined; result: HostStatus };
  host_viability_report: { args: undefined; result: TauriViabilityReport };
  emit_host_probe: { args: undefined; result: void };
  create_semantic_project: { args: { input: SemanticProjectInput }; result: SemanticProjectRecord };
  attach_workspace_from_picker: {
    args: { projectId: string; resourceId: string };
    result: WorkspaceResource | null;
  };
  agent_capability_card: { args: { target: AgentTarget }; result: AgentCapabilityCard };
}

type HostCommand = keyof HostCommandMap;
type HostCommandArgs<C extends HostCommand> = HostCommandMap[C]["args"];
type HostCommandResult<C extends HostCommand> = HostCommandMap[C]["result"];

/** The only shape an adapter may use to reach native IPC. */
export interface HostTransport {
  invoke(command: HostCommand, args?: Record<string, unknown>): Promise<unknown>;
}

export interface HostClient {
  status(): Promise<HostCall<HostStatus>>;
  viabilityReport(): Promise<HostCall<TauriViabilityReport>>;
  emitProbe(): Promise<HostCall<void>>;
  createSemanticProject(input: SemanticProjectInput): Promise<HostCall<SemanticProjectRecord>>;
  attachWorkspaceFromPicker(projectId: string, resourceId: string): Promise<HostCall<WorkspaceResource | null>>;
  agentCapabilityCard(target: AgentTarget): Promise<HostCall<AgentCapabilityCard>>;
}

export interface HostClientOptions {
  /** Injected only by tests or another trusted embedding. */
  isNativeHost?: () => boolean;
  /** Lazy so browser/Node tests never load Tauri's WebView API. */
  loadTransport?: () => Promise<HostTransport>;
}

const unavailableReason = "O host Tauri não está disponível nesta sessão; nenhum efeito foi executado.";

function defaultNativeHostCheck(): boolean {
  return (globalThis as typeof globalThis & { isTauri?: unknown }).isTauri === true;
}

async function loadTauriTransport(): Promise<HostTransport> {
  const { invoke } = await import("@tauri-apps/api/core");
  return {
    invoke(command, args) {
      return invoke(command, args);
    },
  };
}

/**
 * Creates the renderer client. Native availability is checked for every call so
 * a web preview cannot retain an optimistic host state after it is detached.
 */
export function createHostClient(options: HostClientOptions = {}): HostClient {
  const isNativeHost = options.isNativeHost ?? defaultNativeHostCheck;
  const transportLoader = options.loadTransport ?? loadTauriTransport;

  async function call<C extends HostCommand>(
    command: C,
    args: HostCommandArgs<C>,
  ): Promise<HostCall<HostCommandResult<C>>> {
    if (!isNativeHost()) return { state: "unavailable", reason: unavailableReason };

    try {
      const transport = await transportLoader();
      const value = await transport.invoke(command, args);
      return { state: "available", value: value as HostCommandResult<C> };
    } catch (error) {
      return {
        state: "failed",
        message: error instanceof Error ? error.message : "O host não respondeu ao comando solicitado.",
      };
    }
  }

  return {
    status: () => call("host_status", undefined),
    viabilityReport: () => call("host_viability_report", undefined),
    emitProbe: () => call("emit_host_probe", undefined),
    createSemanticProject: (input) => call("create_semantic_project", { input }),
    attachWorkspaceFromPicker: (projectId, resourceId) => call("attach_workspace_from_picker", { projectId, resourceId }),
    agentCapabilityCard: (target) => call("agent_capability_card", { target }),
  };
}

export const hostClient = createHostClient();
