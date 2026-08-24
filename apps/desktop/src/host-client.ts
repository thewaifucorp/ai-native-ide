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

export type ViabilityGateStatus =
  "pendingArtifactMeasurement" | "passingByConstruction" | "blocker";

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

export interface OpenedSemanticProject {
  project: SemanticProjectRecord;
  resources: WorkspaceResource[];
}

export interface BenchmarkPreviewStatus {
  projectId: string;
  url: string;
  state: "healthy" | "stopped";
}

export interface PreviewFailure {
  id: string;
  previewId: string;
  evidenceId: string;
  message: string;
  causalLinks: {
    effectIds: string[];
    activityIds: string[];
    filePaths: string[];
  };
  observedAtMs: number;
}

export interface PreviewFailureReport {
  failure: PreviewFailure;
  divergence: {
    id: string;
    intentId: string;
    observationId: string;
    subject: string;
    evidenceIds: string[];
  };
}

export type PreviewReconciliationAction =
  "change_implementation" | "change_intent" | "accept_preview_exception";

export interface WorkspaceWriteRequest {
  resourceId: string;
  effectId: string;
  relativePath: string;
  content: string;
}

export interface WorkspaceEffectResult {
  awaitingApproval?: boolean;
  written?: boolean;
  path?: string;
}

export type AgentTarget = "claude" | "codex" | "gemini" | "opencode";
export type AgentAvailability = "Ready" | "Degraded" | "Unavailable";
export type IdeCoverage =
  "Enforced" | "DeclaredOnly" | "HarnessOwned" | "Unknown";

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

export interface StartedAgentSession {
  sessionId: string;
  readOnly: boolean;
  policyNote: string;
}

/** Opaque structured output from the externally owned ACPX session. */
export type AgentEvent =
  | { Started: { session_id: string } }
  | { MessageDelta: { task_id: number; text: string } }
  | { Thinking: { task_id: number; summary: string } }
  | { ToolCall: { task_id: number; name: string } }
  | { ToolResult: { task_id: number; name: string; is_error: boolean } }
  | { PermissionRequested: { task_id: number; action: string; detail: string } }
  | { Diff: { task_id: number; path: string; added: number; removed: number } }
  | { Artifact: { task_id: number; kind: string; path: string } }
  | { Usage: { task_id: number; input_tokens: number; output_tokens: number } }
  | { Warning: { task_id: number; code: string; detail: string } }
  | { Ended: { task_id: number; outcome: unknown } };

export interface TerminalRunStatus {
  terminalId: string;
  state: "running" | "stopped";
  detail: string;
}

/** Host observations are read-only events; they carry no capability to invoke code. */
export interface HostEventPayload {
  kind: string;
  message?: string;
  health?: string;
  line?: string;
  detail?: string;
  path?: string;
  exitCode?: number | null;
  extension?: "agentSubprocess" | "preview" | "pty" | "filesystemWatch";
  stream?: "stdout" | "stderr" | "pty";
}

interface HostCommandMap {
  host_status: { args: undefined; result: HostStatus };
  host_viability_report: { args: undefined; result: TauriViabilityReport };
  emit_host_probe: { args: undefined; result: void };
  create_semantic_project: {
    args: { input: SemanticProjectInput };
    result: SemanticProjectRecord;
  };
  open_semantic_project: {
    args: { projectId: string };
    result: OpenedSemanticProject | null;
  };
  attach_workspace_from_picker: {
    args: { projectId: string; resourceId: string };
    result: WorkspaceResource | null;
  };
  start_benchmark_preview: {
    args: { projectId: string };
    result: BenchmarkPreviewStatus;
  };
  stop_benchmark_preview: {
    args: undefined;
    result: BenchmarkPreviewStatus | null;
  };
  stop_and_capture_benchmark_preview_failure: {
    args: { projectId: string; resourceId: string; effectId: string };
    result: PreviewFailureReport | null;
  };
  reconcile_benchmark_preview_failure: {
    args: { divergenceId: string; action: PreviewReconciliationAction };
    result: {
      divergenceId: string;
      status: "pending_verification" | "accepted_scoped_exception";
    };
  };
  propose_workspace_write: {
    args: { projectId: string; request: WorkspaceWriteRequest };
    result: WorkspaceEffectResult;
  };
  approve_next_workspace_write: {
    args: { projectId: string; resourceId: string };
    result: number;
  };
  rollback_workspace_write: {
    args: { projectId: string; resourceId: string; effectId: string };
    result: void;
  };
  agent_capability_card: {
    args: { target: AgentTarget };
    result: AgentCapabilityCard;
  };
  start_read_only_agent_session: {
    args: { target: AgentTarget; projectId: string; resourceId: string };
    result: StartedAgentSession;
  };
  submit_agent_task: {
    args: {
      request: { sessionId: string; prompt: string; codeChange: boolean };
    };
    result: number;
  };
  next_agent_event: { args: { sessionId: string }; result: AgentEvent | null };
  cancel_agent_session: { args: { sessionId: string }; result: void };
  start_workspace_inspection: {
    args: { projectId: string; resourceId: string };
    result: TerminalRunStatus;
  };
  start_workspace_terminal: {
    args: { projectId: string; resourceId: string };
    result: TerminalRunStatus;
  };
  write_workspace_terminal: {
    args: { terminalId: string; input: string };
    result: void;
  };
  resize_workspace_terminal: {
    args: { terminalId: string; rows: number; columns: number };
    result: void;
  };
  poll_workspace_terminal: {
    args: { terminalId: string };
    result: TerminalRunStatus;
  };
  cancel_workspace_inspection: { args: { terminalId: string }; result: void };
}

type HostCommand = keyof HostCommandMap;
type HostCommandArgs<C extends HostCommand> = HostCommandMap[C]["args"];
type HostCommandResult<C extends HostCommand> = HostCommandMap[C]["result"];

/** The only shape an adapter may use to reach native IPC. */
export interface HostTransport {
  invoke(
    command: HostCommand,
    args?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface HostClient {
  status(): Promise<HostCall<HostStatus>>;
  viabilityReport(): Promise<HostCall<TauriViabilityReport>>;
  emitProbe(): Promise<HostCall<void>>;
  createSemanticProject(
    input: SemanticProjectInput,
  ): Promise<HostCall<SemanticProjectRecord>>;
  openSemanticProject(
    projectId: string,
  ): Promise<HostCall<OpenedSemanticProject | null>>;
  attachWorkspaceFromPicker(
    projectId: string,
    resourceId: string,
  ): Promise<HostCall<WorkspaceResource | null>>;
  startBenchmarkPreview(
    projectId: string,
  ): Promise<HostCall<BenchmarkPreviewStatus>>;
  stopBenchmarkPreview(): Promise<HostCall<BenchmarkPreviewStatus | null>>;
  stopAndCaptureBenchmarkPreviewFailure(
    projectId: string,
    resourceId: string,
    effectId: string,
  ): Promise<HostCall<PreviewFailureReport | null>>;
  reconcileBenchmarkPreviewFailure(
    divergenceId: string,
    action: PreviewReconciliationAction,
  ): Promise<
    HostCall<{
      divergenceId: string;
      status: "pending_verification" | "accepted_scoped_exception";
    }>
  >;
  proposeWorkspaceWrite(
    projectId: string,
    request: WorkspaceWriteRequest,
  ): Promise<HostCall<WorkspaceEffectResult>>;
  approveNextWorkspaceWrite(
    projectId: string,
    resourceId: string,
  ): Promise<HostCall<number>>;
  rollbackWorkspaceWrite(
    projectId: string,
    resourceId: string,
    effectId: string,
  ): Promise<HostCall<void>>;
  agentCapabilityCard(
    target: AgentTarget,
  ): Promise<HostCall<AgentCapabilityCard>>;
  startReadOnlyAgentSession(
    target: AgentTarget,
    projectId: string,
    resourceId: string,
  ): Promise<HostCall<StartedAgentSession>>;
  submitAgentTask(
    sessionId: string,
    prompt: string,
    codeChange: boolean,
  ): Promise<HostCall<number>>;
  nextAgentEvent(sessionId: string): Promise<HostCall<AgentEvent | null>>;
  cancelAgentSession(sessionId: string): Promise<HostCall<void>>;
  startWorkspaceInspection(
    projectId: string,
    resourceId: string,
  ): Promise<HostCall<TerminalRunStatus>>;
  startWorkspaceTerminal(
    projectId: string,
    resourceId: string,
  ): Promise<HostCall<TerminalRunStatus>>;
  writeWorkspaceTerminal(
    terminalId: string,
    input: string,
  ): Promise<HostCall<void>>;
  resizeWorkspaceTerminal(
    terminalId: string,
    rows: number,
    columns: number,
  ): Promise<HostCall<void>>;
  pollWorkspaceTerminal(
    terminalId: string,
  ): Promise<HostCall<TerminalRunStatus>>;
  cancelWorkspaceInspection(terminalId: string): Promise<HostCall<void>>;
  listenHostEvents(
    listener: (event: HostEventPayload) => void,
  ): Promise<(() => void) | null>;
}

export interface HostClientOptions {
  /** Injected only by tests or another trusted embedding. */
  isNativeHost?: () => boolean;
  /** Lazy so browser/Node tests never load Tauri's WebView API. */
  loadTransport?: () => Promise<HostTransport>;
}

const unavailableReason =
  "O host Tauri não está disponível nesta sessão; nenhum efeito foi executado.";

function defaultNativeHostCheck(): boolean {
  return (
    (globalThis as typeof globalThis & { isTauri?: unknown }).isTauri === true
  );
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
    if (!isNativeHost())
      return { state: "unavailable", reason: unavailableReason };

    try {
      const transport = await transportLoader();
      const value = await transport.invoke(command, args);
      return { state: "available", value: value as HostCommandResult<C> };
    } catch (error) {
      return {
        state: "failed",
        message:
          error instanceof Error
            ? error.message
            : "O host não respondeu ao comando solicitado.",
      };
    }
  }

  return {
    status: () => call("host_status", undefined),
    viabilityReport: () => call("host_viability_report", undefined),
    emitProbe: () => call("emit_host_probe", undefined),
    createSemanticProject: (input) =>
      call("create_semantic_project", { input }),
    openSemanticProject: (projectId) =>
      call("open_semantic_project", { projectId }),
    attachWorkspaceFromPicker: (projectId, resourceId) =>
      call("attach_workspace_from_picker", { projectId, resourceId }),
    startBenchmarkPreview: (projectId) =>
      call("start_benchmark_preview", { projectId }),
    stopBenchmarkPreview: () => call("stop_benchmark_preview", undefined),
    stopAndCaptureBenchmarkPreviewFailure: (projectId, resourceId, effectId) =>
      call("stop_and_capture_benchmark_preview_failure", {
        projectId,
        resourceId,
        effectId,
      }),
    reconcileBenchmarkPreviewFailure: (divergenceId, action) =>
      call("reconcile_benchmark_preview_failure", { divergenceId, action }),
    proposeWorkspaceWrite: (projectId, request) =>
      call("propose_workspace_write", { projectId, request }),
    approveNextWorkspaceWrite: (projectId, resourceId) =>
      call("approve_next_workspace_write", { projectId, resourceId }),
    rollbackWorkspaceWrite: (projectId, resourceId, effectId) =>
      call("rollback_workspace_write", { projectId, resourceId, effectId }),
    agentCapabilityCard: (target) => call("agent_capability_card", { target }),
    startReadOnlyAgentSession: (target, projectId, resourceId) =>
      call("start_read_only_agent_session", { target, projectId, resourceId }),
    submitAgentTask: (sessionId, prompt, codeChange) =>
      call("submit_agent_task", { request: { sessionId, prompt, codeChange } }),
    nextAgentEvent: (sessionId) => call("next_agent_event", { sessionId }),
    cancelAgentSession: (sessionId) =>
      call("cancel_agent_session", { sessionId }),
    startWorkspaceInspection: (projectId, resourceId) =>
      call("start_workspace_inspection", { projectId, resourceId }),
    startWorkspaceTerminal: (projectId, resourceId) =>
      call("start_workspace_terminal", { projectId, resourceId }),
    writeWorkspaceTerminal: (terminalId, input) =>
      call("write_workspace_terminal", { terminalId, input }),
    resizeWorkspaceTerminal: (terminalId, rows, columns) =>
      call("resize_workspace_terminal", { terminalId, rows, columns }),
    pollWorkspaceTerminal: (terminalId) =>
      call("poll_workspace_terminal", { terminalId }),
    cancelWorkspaceInspection: (terminalId) =>
      call("cancel_workspace_inspection", { terminalId }),
    async listenHostEvents(listener) {
      if (!isNativeHost()) return null;
      const { listen } = await import("@tauri-apps/api/event");
      return listen<HostEventPayload>("ide://host-event", (event) =>
        listener(event.payload),
      );
    },
  };
}

export const hostClient = createHostClient();
