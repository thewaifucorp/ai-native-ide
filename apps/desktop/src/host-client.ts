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
  | "pendingArtifactMeasurement"
  | "passingByConstruction"
  | "measuredPassing"
  | "blocker";

export interface LoopTurn {
  prompt: string;
  response: string;
}
export type StopReason =
  | "budget_reached"
  | "marker_found"
  | "provider_error"
  | "cancelled";
export interface LoopTranscript {
  turns: LoopTurn[];
  stopped: StopReason;
  error: string | null;
}

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

export interface WorkspaceFile {
  relativePath: string;
  sizeBytes: number;
}

export interface WorkspaceFileContents {
  relativePath: string;
  content: string;
}

export interface WorkspaceDiff {
  available: boolean;
  content: string;
}

export type LineTag = "context" | "added" | "removed";
export interface DiffLine {
  tag: LineTag;
  text: string;
}
export interface Hunk {
  id: number;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface OpenedSemanticProject {
  project: SemanticProjectRecord;
  resources: WorkspaceResource[];
}

export type PreviewHealth =
  | "starting"
  | "healthy"
  | "stale"
  | "broken"
  | "reconnecting"
  | "stopped";

export interface BenchmarkPreviewStatus {
  projectId: string;
  url: string;
  /** Live lifecycle state derived from a real loopback probe. */
  health: PreviewHealth;
  detail: string | null;
  changedAtMs: number;
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

/** AAG is a degradable navigation provider; its absence stays an explicit unknown. */
export type AagRelations =
  | { known: { related_symbols: string[] } }
  | { unknown: { reason: string } };

export type GuidanceScope =
  | { kind: "person" }
  | { kind: "project"; project_id: string }
  | { kind: "resource"; resource_id: string }
  | { kind: "path"; path: string }
  | { kind: "task"; session_id: string };

export type GuidanceType =
  | "preference"
  | "convention"
  | "applicable_decision"
  | "rule"
  | "policy";
export type GuidanceApplication =
  | "writing"
  | "code"
  | "design"
  | "tool"
  | "agent"
  | "effect"
  | "general";
export type GuidanceStrength = "suggestion" | "default" | "required" | "blocking";
export type GuidanceState =
  | "candidate"
  | "active"
  | "suspended"
  | "superseded"
  | "archived";
export type GuidanceDuration =
  | { kind: "session" }
  | { kind: "task" }
  | { kind: "until"; date: string }
  | { kind: "permanent" };

export type CaptureDestination =
  | { kind: "use_now" }
  | { kind: "incorporate"; set: string }
  | { kind: "create_stable" }
  | { kind: "record_decision" };

export interface GuidanceDraft {
  name: string;
  text: string;
  guidanceType: GuidanceType;
  scope: GuidanceScope;
  application: GuidanceApplication;
  strength: GuidanceStrength;
  owner: string;
  provenance: string;
}

export interface Guidance {
  id: string;
  name: string;
  guidanceType: GuidanceType;
  scope: GuidanceScope;
  application: GuidanceApplication;
  strength: GuidanceStrength;
  origin: "created" | "imported" | "suggested";
  duration: GuidanceDuration;
  priority: number;
  owner: string;
  provenance: string;
  set: string;
  text: string;
  state: GuidanceState;
  lastUsedMs: number;
}

export interface AppliedGuidance {
  guidance: Guidance;
  reason: string;
}

export type HygieneFinding =
  | { kind: "duplicate"; ids: string[]; name: string }
  | { kind: "point_rule_as_permanent"; id: string; name: string };

export interface ActivityContext {
  projectId?: string | null;
  resourceId?: string | null;
  path?: string | null;
  sessionId?: string | null;
  application?: GuidanceApplication | null;
}

export interface TruthDeclaration {
  id: string;
  subject: string;
  scope: GuidanceScope;
  authorityPath: string;
  precedence: number;
  consumers: string[];
  provenance: string;
}

export type TruthFinding = {
  kind: "authority_conflict";
  ids: string[];
  subject: string;
};

export type CheckState = "passed" | "failed" | "unknown" | "not_run";
export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface HarnessFinding {
  id: string;
  checkId: string;
  layer: number;
  title: string;
  state: CheckState;
  severity: Severity;
  claim: string;
  evidence: string;
  remediation: string | null;
}

export interface HarnessReport {
  findings: HarnessFinding[];
  passed: number;
  failed: number;
  unknown: number;
  notRun: number;
}

export type ConfigBuildMode = "full_vibes" | "hybrid" | "spec";
export type ConfigDepth = "essential" | "detailed" | "raw";
export type ConfigPermissions = "cautious" | "balanced" | "yolo";
export type ValueSource = "default" | "detected" | "user";
export interface Setting<T> {
  value: T;
  source: ValueSource;
}
export interface IdeConfig {
  mode: Setting<ConfigBuildMode>;
  depth: Setting<ConfigDepth>;
  permissions: Setting<ConfigPermissions>;
  harnessLayers: Setting<number[]>;
  automaticCheckpoints: Setting<boolean>;
  idlePaidInference: Setting<boolean>;
  localAag: Setting<boolean>;
}
export interface ConfigPatch {
  mode?: ConfigBuildMode;
  depth?: ConfigDepth;
  permissions?: ConfigPermissions;
  harnessLayers?: number[];
  automaticCheckpoints?: boolean;
  idlePaidInference?: boolean;
}
export type ConfigField =
  | "mode"
  | "depth"
  | "permissions"
  | "harness_layers"
  | "automatic_checkpoints"
  | "idle_paid_inference"
  | "local_aag";

export interface ExportedResource {
  id: string;
  kind: string;
  label: string;
}
export interface ExportManifest {
  projectId: string;
  title: string;
  intent: string;
  version: string;
  resources: ExportedResource[];
  appliedGuidance: string[];
  appliedPacks: string[];
  portabilityNote: string;
}
export interface PublishRecord {
  projectId: string;
  version: string;
  problem: string | null;
  relatedResources: string[];
  note: string;
}
export type ConfirmationDecision = "proceed" | "confirm_first";

export type ReferenceKind = "service" | "environment";
export interface ProjectReference {
  id: string;
  kind: ReferenceKind;
  name: string;
  endpoint: string;
  projects: string[];
}

export type PackCapability =
  | "read_workspace"
  | "run_deterministic_check"
  | "offer_guidance";
export interface PackCheck {
  id: string;
  title: string;
  subject: string;
  criterion: string;
  layer: number;
}
export interface PackGuide {
  id: string;
  title: string;
  text: string;
}
export interface Pack {
  id: string;
  name: string;
  domain: string;
  description: string;
  checks: PackCheck[];
  guides: PackGuide[];
  capabilities: PackCapability[];
  reversible: boolean;
}
export interface ReadinessVerdict {
  packId: string;
  ready: boolean;
  missingChecks: string[];
  failedChecks: string[];
  note: string;
}

export interface ContextSegment {
  origin: string;
  scope: string;
  reason: string;
  text: string;
  verbatim: boolean;
  priority: number;
}
export interface CompiledContext {
  segments: ContextSegment[];
  droppedForBudget: string[];
  usedChars: number;
  budgetChars: number;
}
export interface Authority {
  authorityPath: string;
  precedence: number;
  consumers: string[];
}
export interface EvidenceRef {
  id: string;
  summary: string;
  source: string;
}
export interface Navigation {
  subject: string;
  authorities: Authority[];
  evidence: EvidenceRef[];
}

export type FindingCategory = "ambiguity" | "missing_decision" | "risk";
export type ReviewState = "open" | "accepted" | "dismissed";
export interface SemanticFinding {
  id: string;
  evaluator: string;
  evaluatorVersion: string;
  layer: number;
  category: FindingCategory;
  claim: string;
  evidence: string;
  confidence: number;
  severity: Severity;
  remediation: string;
  reviewState: ReviewState;
}
export interface SemanticReport {
  findings: SemanticFinding[];
  withheldForBudget: number;
  evaluatorsRun: string[];
  contentHash: string;
}

export type EffectClass = "prototype" | "durable";
export type EffectPolicyDecision = "require_approval" | "auto_approve_recorded";
export type InterruptionDecision =
  | "proceed"
  | "proceed_recording_hypothesis"
  | "require_checkpoint"
  | "resolve_contract_first";
export interface PromotionRecord {
  prototypeEffectId: string;
  checkpointEffectId: string;
  reconciled: boolean;
  note: string;
}

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
  phase?: "awaitingApproval" | "written" | "rolledBack";
  effectId?: string;
  activityId?: string | null;
}

interface HostCommandMap {
  host_status: { args: undefined; result: HostStatus };
  host_viability_report: { args: undefined; result: TauriViabilityReport };
  emit_host_probe: { args: undefined; result: void };
  create_semantic_project: {
    args: { input: SemanticProjectInput };
    result: SemanticProjectRecord;
  };
  list_semantic_projects: { args: undefined; result: SemanticProjectRecord[] };
  update_semantic_project_intent: {
    args: { projectId: string; intent: string };
    result: SemanticProjectRecord;
  };
  open_semantic_project: {
    args: { projectId: string };
    result: OpenedSemanticProject | null;
  };
  attach_workspace_from_picker: {
    args: { projectId: string };
    result: WorkspaceResource | null;
  };
  list_workspace_files: {
    args: { projectId: string; resourceId: string };
    result: WorkspaceFile[];
  };
  read_workspace_file: {
    args: { projectId: string; resourceId: string; relativePath: string };
    result: WorkspaceFileContents;
  };
  workspace_diff: {
    args: { projectId: string; resourceId: string };
    result: WorkspaceDiff;
  };
  start_benchmark_preview: {
    args: { projectId: string };
    result: BenchmarkPreviewStatus;
  };
  poll_benchmark_preview: {
    args: undefined;
    result: BenchmarkPreviewStatus | null;
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
  aag_relations: {
    args: { query: string };
    result: AagRelations;
  };
  capture_guidance: {
    args: { draft: GuidanceDraft; destination: CaptureDestination };
    result: Guidance;
  };
  activate_guidance: { args: { id: string }; result: Guidance };
  import_steering: {
    args: { name: string; text: string; scope: GuidanceScope };
    result: Guidance;
  };
  list_guidance: { args: undefined; result: Guidance[] };
  guidance_applied_now: {
    args: { context: ActivityContext };
    result: AppliedGuidance[];
  };
  guidance_hygiene: { args: undefined; result: HygieneFinding[] };
  truth_declare: {
    args: {
      subject: string;
      scope: GuidanceScope;
      authorityPath: string;
      precedence: number;
      provenance: string;
    };
    result: TruthDeclaration;
  };
  truth_list: { args: undefined; result: TruthDeclaration[] };
  truth_add_consumer: { args: { id: string; consumer: string }; result: void };
  truth_consumers: { args: { subject: string }; result: string[] };
  truth_conflicts: { args: undefined; result: TruthFinding[] };
  run_harness_layer0: {
    args: { projectId: string; resourceId: string };
    result: HarnessReport;
  };
  get_config: { args: undefined; result: IdeConfig };
  detect_and_apply_config_defaults: { args: undefined; result: IdeConfig };
  set_config: { args: { patch: ConfigPatch }; result: IdeConfig };
  reset_config_field: { args: { field: ConfigField }; result: IdeConfig };
  explain_config_field: { args: { field: ConfigField }; result: string };
  evaluate_intent: {
    args: { intent: string; maxFindings?: number };
    result: SemanticReport;
  };
  compile_agent_context: {
    args: {
      projectId: string;
      resourceId?: string;
      sessionId?: string;
      budgetChars?: number;
    };
    result: CompiledContext;
  };
  navigate_subject: { args: { subject: string }; result: Navigation };
  list_packs: { args: undefined; result: Pack[] };
  applied_packs: { args: undefined; result: string[] };
  apply_pack: { args: { packId: string }; result: string[] };
  revert_pack: { args: { packId: string }; result: string[] };
  pack_readiness: {
    args: { packId: string; passed: string[]; failed: string[] };
    result: ReadinessVerdict;
  };
  link_reference: {
    args: {
      id: string;
      kind: ReferenceKind;
      name: string;
      endpoint: string;
      projectId: string;
    };
    result: ProjectReference;
  };
  list_project_references: {
    args: { projectId: string };
    result: ProjectReference[];
  };
  unlink_reference: { args: { id: string; projectId: string }; result: void };
  export_project: { args: { projectId: string }; result: ExportManifest };
  publish_project: { args: { projectId: string }; result: PublishRecord };
  republish_project: {
    args: { projectId: string; problem: string; relatedResources: string[] };
    result: PublishRecord;
  };
  publish_history: { args: { projectId: string }; result: PublishRecord[] };
  external_effect_confirmation: {
    args: { irreversible: boolean; alreadyConfirmed: boolean };
    result: ConfirmationDecision;
  };
  mode_interruption_policy: {
    args: { class: EffectClass };
    result: InterruptionDecision;
  };
  promote_prototype: {
    args: {
      prototypeEffectId: string;
      checkpointEffectId: string;
      note: string;
    };
    result: PromotionRecord;
  };
  propose_workspace_write: {
    args: { projectId: string; request: WorkspaceWriteRequest };
    result: WorkspaceEffectResult;
  };
  run_model_loop: {
    args: { prompt: string; maxTurns?: number };
    result: LoopTranscript;
  };
  effect_policy: {
    args: { class: EffectClass };
    result: EffectPolicyDecision;
  };
  apply_workspace_write_yolo: {
    args: { projectId: string; request: WorkspaceWriteRequest };
    result: WorkspaceEffectResult;
  };
  workspace_file_diff: {
    args: {
      projectId: string;
      resourceId: string;
      relativePath: string;
      proposed: string;
    };
    result: Hunk[];
  };
  propose_partial_workspace_write: {
    args: {
      projectId: string;
      request: WorkspaceWriteRequest;
      selectedHunks: number[];
    };
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
  start_agent_session: {
    args: {
      target: AgentTarget;
      projectId: string;
      resourceId: string;
      allowWorkspaceWrites: boolean;
    };
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
  listSemanticProjects(): Promise<HostCall<SemanticProjectRecord[]>>;
  updateSemanticProjectIntent(
    projectId: string,
    intent: string,
  ): Promise<HostCall<SemanticProjectRecord>>;
  openSemanticProject(
    projectId: string,
  ): Promise<HostCall<OpenedSemanticProject | null>>;
  attachWorkspaceFromPicker(
    projectId: string,
  ): Promise<HostCall<WorkspaceResource | null>>;
  listWorkspaceFiles(
    projectId: string,
    resourceId: string,
  ): Promise<HostCall<WorkspaceFile[]>>;
  readWorkspaceFile(
    projectId: string,
    resourceId: string,
    relativePath: string,
  ): Promise<HostCall<WorkspaceFileContents>>;
  workspaceDiff(
    projectId: string,
    resourceId: string,
  ): Promise<HostCall<WorkspaceDiff>>;
  startBenchmarkPreview(
    projectId: string,
  ): Promise<HostCall<BenchmarkPreviewStatus>>;
  pollBenchmarkPreview(): Promise<HostCall<BenchmarkPreviewStatus | null>>;
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
  aagRelations(query: string): Promise<HostCall<AagRelations>>;
  captureGuidance(
    draft: GuidanceDraft,
    destination: CaptureDestination,
  ): Promise<HostCall<Guidance>>;
  activateGuidance(id: string): Promise<HostCall<Guidance>>;
  importSteering(
    name: string,
    text: string,
    scope: GuidanceScope,
  ): Promise<HostCall<Guidance>>;
  listGuidance(): Promise<HostCall<Guidance[]>>;
  guidanceAppliedNow(
    context: ActivityContext,
  ): Promise<HostCall<AppliedGuidance[]>>;
  guidanceHygiene(): Promise<HostCall<HygieneFinding[]>>;
  truthDeclare(
    subject: string,
    scope: GuidanceScope,
    authorityPath: string,
    precedence: number,
    provenance: string,
  ): Promise<HostCall<TruthDeclaration>>;
  truthList(): Promise<HostCall<TruthDeclaration[]>>;
  truthAddConsumer(id: string, consumer: string): Promise<HostCall<void>>;
  truthConsumers(subject: string): Promise<HostCall<string[]>>;
  truthConflicts(): Promise<HostCall<TruthFinding[]>>;
  runHarnessLayer0(
    projectId: string,
    resourceId: string,
  ): Promise<HostCall<HarnessReport>>;
  getConfig(): Promise<HostCall<IdeConfig>>;
  detectAndApplyConfigDefaults(): Promise<HostCall<IdeConfig>>;
  setConfig(patch: ConfigPatch): Promise<HostCall<IdeConfig>>;
  resetConfigField(field: ConfigField): Promise<HostCall<IdeConfig>>;
  explainConfigField(field: ConfigField): Promise<HostCall<string>>;
  evaluateIntent(
    intent: string,
    maxFindings?: number,
  ): Promise<HostCall<SemanticReport>>;
  compileAgentContext(
    projectId: string,
    resourceId?: string,
    sessionId?: string,
    budgetChars?: number,
  ): Promise<HostCall<CompiledContext>>;
  navigateSubject(subject: string): Promise<HostCall<Navigation>>;
  listPacks(): Promise<HostCall<Pack[]>>;
  appliedPacks(): Promise<HostCall<string[]>>;
  applyPack(packId: string): Promise<HostCall<string[]>>;
  revertPack(packId: string): Promise<HostCall<string[]>>;
  packReadiness(
    packId: string,
    passed: string[],
    failed: string[],
  ): Promise<HostCall<ReadinessVerdict>>;
  linkReference(
    id: string,
    kind: ReferenceKind,
    name: string,
    endpoint: string,
    projectId: string,
  ): Promise<HostCall<ProjectReference>>;
  listProjectReferences(
    projectId: string,
  ): Promise<HostCall<ProjectReference[]>>;
  unlinkReference(id: string, projectId: string): Promise<HostCall<void>>;
  exportProject(projectId: string): Promise<HostCall<ExportManifest>>;
  publishProject(projectId: string): Promise<HostCall<PublishRecord>>;
  republishProject(
    projectId: string,
    problem: string,
    relatedResources: string[],
  ): Promise<HostCall<PublishRecord>>;
  publishHistory(projectId: string): Promise<HostCall<PublishRecord[]>>;
  externalEffectConfirmation(
    irreversible: boolean,
    alreadyConfirmed: boolean,
  ): Promise<HostCall<ConfirmationDecision>>;
  modeInterruptionPolicy(
    effectClass: EffectClass,
  ): Promise<HostCall<InterruptionDecision>>;
  promotePrototype(
    prototypeEffectId: string,
    checkpointEffectId: string,
    note: string,
  ): Promise<HostCall<PromotionRecord>>;
  proposeWorkspaceWrite(
    projectId: string,
    request: WorkspaceWriteRequest,
  ): Promise<HostCall<WorkspaceEffectResult>>;
  runModelLoop(
    prompt: string,
    maxTurns?: number,
  ): Promise<HostCall<LoopTranscript>>;
  effectPolicy(
    effectClass: EffectClass,
  ): Promise<HostCall<EffectPolicyDecision>>;
  applyWorkspaceWriteYolo(
    projectId: string,
    request: WorkspaceWriteRequest,
  ): Promise<HostCall<WorkspaceEffectResult>>;
  workspaceFileDiff(
    projectId: string,
    resourceId: string,
    relativePath: string,
    proposed: string,
  ): Promise<HostCall<Hunk[]>>;
  proposePartialWorkspaceWrite(
    projectId: string,
    request: WorkspaceWriteRequest,
    selectedHunks: number[],
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
  startAgentSession(
    target: AgentTarget,
    projectId: string,
    resourceId: string,
    allowWorkspaceWrites: boolean,
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
  // Tauri v2 injects its IPC bridge as `__TAURI_INTERNALS__`. `isTauri` is
  // optional (and absent when the global API is disabled), so using it as the
  // sole check made every installed Windows build behave like a browser preview.
  const runtime = globalThis as typeof globalThis & {
    isTauri?: unknown;
    __TAURI_INTERNALS__?: { invoke?: unknown };
  };
  return (
    runtime.isTauri === true ||
    typeof runtime.__TAURI_INTERNALS__?.invoke === "function"
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
    listSemanticProjects: () => call("list_semantic_projects", undefined),
    updateSemanticProjectIntent: (projectId, intent) =>
      call("update_semantic_project_intent", { projectId, intent }),
    openSemanticProject: (projectId) =>
      call("open_semantic_project", { projectId }),
    attachWorkspaceFromPicker: (projectId) =>
      call("attach_workspace_from_picker", { projectId }),
    listWorkspaceFiles: (projectId, resourceId) =>
      call("list_workspace_files", { projectId, resourceId }),
    readWorkspaceFile: (projectId, resourceId, relativePath) =>
      call("read_workspace_file", { projectId, resourceId, relativePath }),
    workspaceDiff: (projectId, resourceId) =>
      call("workspace_diff", { projectId, resourceId }),
    startBenchmarkPreview: (projectId) =>
      call("start_benchmark_preview", { projectId }),
    pollBenchmarkPreview: () => call("poll_benchmark_preview", undefined),
    stopBenchmarkPreview: () => call("stop_benchmark_preview", undefined),
    stopAndCaptureBenchmarkPreviewFailure: (projectId, resourceId, effectId) =>
      call("stop_and_capture_benchmark_preview_failure", {
        projectId,
        resourceId,
        effectId,
      }),
    reconcileBenchmarkPreviewFailure: (divergenceId, action) =>
      call("reconcile_benchmark_preview_failure", { divergenceId, action }),
    aagRelations: (query) => call("aag_relations", { query }),
    captureGuidance: (draft, destination) =>
      call("capture_guidance", { draft, destination }),
    activateGuidance: (id) => call("activate_guidance", { id }),
    importSteering: (name, text, scope) =>
      call("import_steering", { name, text, scope }),
    listGuidance: () => call("list_guidance", undefined),
    guidanceAppliedNow: (context) =>
      call("guidance_applied_now", { context }),
    guidanceHygiene: () => call("guidance_hygiene", undefined),
    truthDeclare: (subject, scope, authorityPath, precedence, provenance) =>
      call("truth_declare", {
        subject,
        scope,
        authorityPath,
        precedence,
        provenance,
      }),
    truthList: () => call("truth_list", undefined),
    truthAddConsumer: (id, consumer) =>
      call("truth_add_consumer", { id, consumer }),
    truthConsumers: (subject) => call("truth_consumers", { subject }),
    truthConflicts: () => call("truth_conflicts", undefined),
    runHarnessLayer0: (projectId, resourceId) =>
      call("run_harness_layer0", { projectId, resourceId }),
    getConfig: () => call("get_config", undefined),
    detectAndApplyConfigDefaults: () =>
      call("detect_and_apply_config_defaults", undefined),
    setConfig: (patch) => call("set_config", { patch }),
    resetConfigField: (field) => call("reset_config_field", { field }),
    explainConfigField: (field) => call("explain_config_field", { field }),
    evaluateIntent: (intent, maxFindings) =>
      call("evaluate_intent", { intent, maxFindings }),
    compileAgentContext: (projectId, resourceId, sessionId, budgetChars) =>
      call("compile_agent_context", {
        projectId,
        resourceId,
        sessionId,
        budgetChars,
      }),
    navigateSubject: (subject) => call("navigate_subject", { subject }),
    listPacks: () => call("list_packs", undefined),
    appliedPacks: () => call("applied_packs", undefined),
    applyPack: (packId) => call("apply_pack", { packId }),
    revertPack: (packId) => call("revert_pack", { packId }),
    packReadiness: (packId, passed, failed) =>
      call("pack_readiness", { packId, passed, failed }),
    linkReference: (id, kind, name, endpoint, projectId) =>
      call("link_reference", { id, kind, name, endpoint, projectId }),
    listProjectReferences: (projectId) =>
      call("list_project_references", { projectId }),
    unlinkReference: (id, projectId) =>
      call("unlink_reference", { id, projectId }),
    exportProject: (projectId) => call("export_project", { projectId }),
    publishProject: (projectId) => call("publish_project", { projectId }),
    republishProject: (projectId, problem, relatedResources) =>
      call("republish_project", { projectId, problem, relatedResources }),
    publishHistory: (projectId) => call("publish_history", { projectId }),
    externalEffectConfirmation: (irreversible, alreadyConfirmed) =>
      call("external_effect_confirmation", { irreversible, alreadyConfirmed }),
    modeInterruptionPolicy: (effectClass) =>
      call("mode_interruption_policy", { class: effectClass }),
    promotePrototype: (prototypeEffectId, checkpointEffectId, note) =>
      call("promote_prototype", {
        prototypeEffectId,
        checkpointEffectId,
        note,
      }),
    proposeWorkspaceWrite: (projectId, request) =>
      call("propose_workspace_write", { projectId, request }),
    runModelLoop: (prompt, maxTurns) =>
      call("run_model_loop", { prompt, maxTurns }),
    effectPolicy: (effectClass) =>
      call("effect_policy", { class: effectClass }),
    applyWorkspaceWriteYolo: (projectId, request) =>
      call("apply_workspace_write_yolo", { projectId, request }),
    workspaceFileDiff: (projectId, resourceId, relativePath, proposed) =>
      call("workspace_file_diff", {
        projectId,
        resourceId,
        relativePath,
        proposed,
      }),
    proposePartialWorkspaceWrite: (projectId, request, selectedHunks) =>
      call("propose_partial_workspace_write", {
        projectId,
        request,
        selectedHunks,
      }),
    approveNextWorkspaceWrite: (projectId, resourceId) =>
      call("approve_next_workspace_write", { projectId, resourceId }),
    rollbackWorkspaceWrite: (projectId, resourceId, effectId) =>
      call("rollback_workspace_write", { projectId, resourceId, effectId }),
    agentCapabilityCard: (target) => call("agent_capability_card", { target }),
    startAgentSession: (target, projectId, resourceId, allowWorkspaceWrites) =>
      call("start_agent_session", {
        target,
        projectId,
        resourceId,
        allowWorkspaceWrites,
      }),
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
