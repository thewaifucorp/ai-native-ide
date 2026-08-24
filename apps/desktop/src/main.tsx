import { StrictMode, useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import { createRoot } from "react-dom/client";
import {
  analyzeIntent,
  initialActivity,
  nextStepFor,
  type BuildMode,
  type Depth,
  type IntentSignal,
} from "./instrument";
import {
  createGameModeState,
  readArchetypes,
  recordOutcome,
  setGameModeEnabled,
  verifiedProgress,
  type GameModeState,
} from "./game-mode";
import {
  hostClient,
  type AgentCapabilityCard,
  type AgentEvent,
  type AgentTarget,
  type BenchmarkPreviewStatus,
  type HostCall,
  type PreviewFailureReport,
  type SemanticProjectRecord,
  type StartedAgentSession,
  type TerminalRunStatus,
  type WorkspaceFile,
  type WorkspaceResource,
} from "./host-client";
import { TerminalSurface } from "./terminal-surface";
import "./styles.css";

const navItems = ["Overview", "Build", "Resources", "Evidence"] as const;

type AgentTranscriptEntry = {
  role: "user" | "agent" | "system";
  text: string;
};

function projectIdentity(intent: string): string {
  const slug = intent
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  let hash = 5381;
  for (const character of intent) hash = (hash * 33) ^ character.charCodeAt(0);
  return `project-${slug || "workspace"}-${(hash >>> 0).toString(36)}`;
}

function projectTitle(intent: string): string {
  return intent.trim().split(/[.!?\n]/, 1)[0]?.slice(0, 64) || "Projeto sem título";
}

function SignalCard({
  signal,
  onUse,
}: {
  signal: IntentSignal;
  onUse: (signal: IntentSignal) => void;
}) {
  return (
    <article className={`signal signal--${signal.severity}`}>
      <div className="signal__meta">
        <span>{signal.kind}</span>
        <span className="signal__dot" />
      </div>
      <h3>{signal.title}</h3>
      <p>{signal.detail}</p>
      <button
        className="text-button"
        onClick={() => onUse(signal)}
        type="button"
      >
        Usar como orientação <span>→</span>
      </button>
    </article>
  );
}

function describeAgentEvent(event: AgentEvent): string {
  if ("MessageDelta" in event) return `Agente: ${event.MessageDelta.text}`;
  if ("Thinking" in event) return `Agente: ${event.Thinking.summary}`;
  if ("ToolCall" in event) return `Agente pediu ${event.ToolCall.name}`;
  if ("ToolResult" in event)
    return `Agente recebeu ${event.ToolResult.name}${event.ToolResult.is_error ? " com erro" : ""}`;
  if ("PermissionRequested" in event)
    return `Permissão externa: ${event.PermissionRequested.action}`;
  if ("Diff" in event) return `Diff externo: ${event.Diff.path}`;
  if ("Artifact" in event) return `Artefato do agente: ${event.Artifact.path}`;
  if ("Warning" in event) return `Agente: ${event.Warning.detail}`;
  if ("Ended" in event) return "Sessão do agente terminou";
  if ("Started" in event) return "Sessão do agente iniciada";
  return "Uso do agente foi registrado fora da pontuação";
}

function App() {
  const [intent, setIntent] = useState("");
  const [mode, setMode] = useState<BuildMode>("hybrid");
  const [depth, setDepth] = useState<Depth>("essential");
  const [section, setSection] = useState<(typeof navItems)[number]>("Overview");
  const [activeSignal, setActiveSignal] = useState<IntentSignal | null>(null);
  const [project, setProject] = useState<SemanticProjectRecord | null>(null);
  const [projects, setProjects] = useState<SemanticProjectRecord[]>([]);
  const [projectCall, setProjectCall] =
    useState<HostCall<SemanticProjectRecord> | null>(null);
  const [resource, setResource] = useState<WorkspaceResource | null>(null);
  const [preview, setPreview] = useState<BenchmarkPreviewStatus | null>(null);
  const [previewCall, setPreviewCall] =
    useState<HostCall<BenchmarkPreviewStatus> | null>(null);
  const [previewFailure, setPreviewFailure] =
    useState<PreviewFailureReport | null>(null);
  const [effectState, setEffectState] = useState<
    "idle" | "awaiting" | "written" | "failed"
  >("idle");
  const [agentSession, setAgentSession] = useState<StartedAgentSession | null>(
    null,
  );
  const [agentCall, setAgentCall] =
    useState<HostCall<StartedAgentSession> | null>(null);
  const [agentCapability, setAgentCapability] =
    useState<HostCall<AgentCapabilityCard> | null>(null);
  const [agentTarget, setAgentTarget] = useState<AgentTarget>("claude");
  const [allowAgentWorkspaceWrites, setAllowAgentWorkspaceWrites] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState(
    "Revise a intenção e aponte o próximo risco verificável.",
  );
  const [agentTask, setAgentTask] = useState<HostCall<number> | null>(null);
  const [agentTranscript, setAgentTranscript] = useState<AgentTranscriptEntry[]>([]);
  const [terminal, setTerminal] = useState<TerminalRunStatus | null>(null);
  const [terminalCall, setTerminalCall] =
    useState<HostCall<TerminalRunStatus> | null>(null);
  const [terminalOutput, setTerminalOutput] = useState<string[]>([]);
  const [hostActivity, setHostActivity] = useState<string[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [rawDocument, setRawDocument] = useState("");
  const [newFilePath, setNewFilePath] = useState("");
  const [fileEffectId, setFileEffectId] = useState<string | null>(null);
  const [reconciliationNote, setReconciliationNote] = useState<string | null>(
    null,
  );
  const [gameMode, setGameMode] = useState<GameModeState>(() =>
    createGameModeState(),
  );
  const signals = useMemo(() => analyzeIntent(intent), [intent]);
  const nextStep = nextStepFor(intent, signals);
  function appendAgentTranscript(role: AgentTranscriptEntry["role"], text: string) {
    setAgentTranscript((current) => {
      const last = current.at(-1);
      if (role === "agent" && last?.role === "agent") {
        return [...current.slice(0, -1), { role, text: `${last.text}${text}` }];
      }
      return [...current, { role, text }];
    });
  }
  async function openWorkspaceFile(
    activeProject: SemanticProjectRecord,
    activeResource: WorkspaceResource,
    relativePath: string,
  ) {
    const result = await hostClient.readWorkspaceFile(
      activeProject.id,
      activeResource.id,
      relativePath,
    );
    if (result.state !== "available") return;
    setSelectedFile(result.value.relativePath);
    setRawDocument(result.value.content);
  }
  async function loadWorkspaceFiles(
    activeProject: SemanticProjectRecord,
    activeResource: WorkspaceResource,
  ) {
    const result = await hostClient.listWorkspaceFiles(
      activeProject.id,
      activeResource.id,
    );
    if (result.state !== "available") return;
    setWorkspaceFiles(result.value);
    const initial = result.value.find(
      (file) => file.relativePath === "project.intent.md",
    ) ?? result.value[0];
    if (initial) await openWorkspaceFile(activeProject, activeResource, initial.relativePath);
    else {
      setSelectedFile(null);
      setRawDocument("");
    }
  }
  useEffect(() => {
    void hostClient.listSemanticProjects().then((result) => {
      if (result.state !== "available") return;
      setProjects(result.value);
      if (result.value[0]) void openProject(result.value[0].id);
    });
  }, []);
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    void hostClient
      .listenHostEvents((event) => {
        const detail =
          event.line ??
          event.message ??
          event.detail ??
          event.health ??
          event.kind;
        setHostActivity((current) =>
          [`${event.kind}: ${detail}`, ...current].slice(0, 4),
        );
        if (event.extension !== "pty") return;
        const terminalLine = event.line;
        if (event.kind === "processOutput" && terminalLine !== undefined) {
          setTerminalOutput((current) =>
            [...current, terminalLine.slice(0, 16 * 1024)].slice(-500),
          );
        }
        if (event.kind === "processExited") {
          setTerminalOutput((current) => [
            ...current,
            `\n[processo encerrado: ${event.exitCode ?? "sem código"}]`,
          ]);
        }
      })
      .then((stop) => {
        unsubscribe = stop;
      });
    return () => unsubscribe?.();
  }, []);
  useEffect(() => {
    if (!resource) return;
    void hostClient.agentCapabilityCard(agentTarget).then(setAgentCapability);
  }, [agentTarget, resource]);
  useEffect(() => {
    if (!agentSession) return;
    let active = true;
    const timer = window.setInterval(() => {
      void hostClient.nextAgentEvent(agentSession.sessionId).then((result) => {
        if (!active || result.state !== "available") return;
        const event = result.value;
        if (!event) return;
        if ("MessageDelta" in event) {
          appendAgentTranscript("agent", event.MessageDelta.text);
        } else {
          appendAgentTranscript("system", describeAgentEvent(event));
        }
        if (("Diff" in event || "Artifact" in event) && project && resource) {
          void loadWorkspaceFiles(project, resource);
        }
        setHostActivity((current) =>
          [describeAgentEvent(event), ...current].slice(0, 4),
        );
      });
    }, 500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [agentSession, project, resource]);
  useEffect(() => {
    if (!terminal || terminal.state !== "running") return;
    let active = true;
    const timer = window.setInterval(() => {
      void hostClient.pollWorkspaceTerminal(terminal.terminalId).then((result) => {
        if (!active || result.state !== "available") return;
        if (result.value.state === "stopped") setTerminal(result.value);
      });
    }, 250);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [terminal]);
  function useSignal(signal: IntentSignal) {
    setActiveSignal(signal);
    setSection("Build");
  }
  async function openProject(projectId: string) {
    const result = await hostClient.openSemanticProject(projectId);
    if (result.state !== "available" || !result.value) return;
    setProject(result.value.project);
    const restoredResource = result.value.resources[0] ?? null;
    setResource(restoredResource);
    setIntent(result.value.project.intent);
    setAgentSession(null);
    setAgentTranscript([]);
    setSection("Overview");
    if (restoredResource) await loadWorkspaceFiles(result.value.project, restoredResource);
  }
  function startNewProject() {
    setProject(null);
    setResource(null);
    setIntent("");
    setAgentSession(null);
    setAgentTranscript([]);
    setWorkspaceFiles([]);
    setSelectedFile(null);
    setRawDocument("");
    setSection("Overview");
  }
  async function createProject() {
    const projectId = projectIdentity(intent);
    const result = await hostClient.createSemanticProject({
      projectId,
      title: projectTitle(intent),
      intent,
    });
    setProjectCall(result);
    if (result.state === "available") {
      setProject(result.value);
      setProjects((current) => [
        result.value,
        ...current.filter((candidate) => candidate.id !== result.value.id),
      ]);
      setSection("Build");
    }
  }
  async function attachWorkspace() {
    if (!project) return;
    const result = await hostClient.attachWorkspaceFromPicker(
      project.id,
      `${project.id}-local`,
    );
    if (result.state === "available" && result.value) {
      setResource(result.value);
      await loadWorkspaceFiles(project, result.value);
    }
  }
  async function startPreview() {
    if (!project) return;
    const result = await hostClient.startBenchmarkPreview(project.id);
    setPreviewCall(result);
    if (result.state === "available") {
      setPreview(result.value);
      setPreviewFailure(null);
    }
  }
  async function capturePreviewFailure() {
    if (!project || !resource) return;
    const result = await hostClient.stopAndCaptureBenchmarkPreviewFailure(
      project.id,
      resource.id,
      `${project.id}-intent`,
    );
    if (result.state === "available") {
      setPreview(null);
      setPreviewFailure(result.value);
    }
  }
  async function reconcilePreview(
    action:
      "change_implementation" | "change_intent" | "accept_preview_exception",
  ) {
    if (!previewFailure) return;
    const result = await hostClient.reconcileBenchmarkPreviewFailure(
      previewFailure.divergence.id,
      action,
    );
    if (result.state === "available") {
      setReconciliationNote(
        result.value.status === "accepted_scoped_exception"
          ? "Exceção limitada registrada; a evidência continua acessível."
          : "Reconciliação registrada e pendente de nova verificação independente.",
      );
      const transition = recordOutcome(
        gameMode,
        {
          id: `reconciliation:${previewFailure.divergence.id}`,
          category: "divergence-reconciled",
          summary: "Divergência de preview recebeu uma decisão explícita.",
          proposedBy: "user:local",
          evidence: [
            {
              id: previewFailure.failure.evidenceId,
              source: "reconciliation-engine",
              verifiedBy: "host:reconciliation",
              observedAt: new Date(
                previewFailure.failure.observedAtMs,
              ).toISOString(),
              summary: previewFailure.failure.message,
            },
          ],
        },
        new Date().toISOString(),
      );
      setGameMode(transition.state);
    }
  }
  async function proposeProjectIntent() {
    if (!project || !resource) return;
    const result = await hostClient.proposeWorkspaceWrite(project.id, {
      resourceId: resource.id,
      effectId: `${project.id}-intent`,
      relativePath: "project.intent.md",
      content: `# Intenção do projeto\n\n${intent}\n\nModo: ${mode}\n`,
    });
    if (result.state !== "available") {
      setEffectState("failed");
      return;
    }
    setEffectState(result.value.written ? "written" : "awaiting");
    if (result.value.written) {
      const updated = await hostClient.updateSemanticProjectIntent(project.id, intent);
      if (updated.state === "available") {
        setProject(updated.value);
        setProjects((current) => [
          updated.value,
          ...current.filter((candidate) => candidate.id !== updated.value.id),
        ]);
      }
      await loadWorkspaceFiles(project, resource);
    }
  }
  async function approveProjectIntent() {
    if (!project || !resource) return;
    const approved = await hostClient.approveNextWorkspaceWrite(
      project.id,
      resource.id,
    );
    if (approved.state !== "available") {
      setEffectState("failed");
      return;
    }
    await proposeProjectIntent();
  }
  async function rollbackProjectIntent() {
    if (!project || !resource) return;
    const result = await hostClient.rollbackWorkspaceWrite(
      project.id,
      resource.id,
      `${project.id}-intent`,
    );
    if (result.state === "available") {
      setEffectState("idle");
      setPreview(null);
      setPreviewFailure(null);
    } else {
      setEffectState("failed");
    }
  }
  async function proposeSelectedFile(effectId: string) {
    if (!project || !resource || !selectedFile) return;
    const result = await hostClient.proposeWorkspaceWrite(project.id, {
      resourceId: resource.id,
      effectId,
      relativePath: selectedFile,
      content: rawDocument,
    });
    if (result.state !== "available") {
      setEffectState("failed");
      return;
    }
    setEffectState(result.value.written ? "written" : "awaiting");
    if (result.value.written) {
      setFileEffectId(null);
      await loadWorkspaceFiles(project, resource);
    }
  }
  async function saveWorkspaceFile() {
    const effectId = `edit-${project?.id ?? "workspace"}-${Date.now()}`;
    setFileEffectId(effectId);
    await proposeSelectedFile(effectId);
  }
  function beginNewWorkspaceFile() {
    const path = newFilePath.trim();
    if (!path) return;
    setSelectedFile(path);
    setRawDocument("");
    setNewFilePath("");
  }
  async function approveWorkspaceFile() {
    if (!project || !resource || !fileEffectId) return;
    const approval = await hostClient.approveNextWorkspaceWrite(project.id, resource.id);
    if (approval.state !== "available") {
      setEffectState("failed");
      return;
    }
    await proposeSelectedFile(fileEffectId);
  }
  async function startAgentSession() {
    if (!project || !resource) return;
    const result = await hostClient.startAgentSession(
      agentTarget,
      project.id,
      resource.id,
      allowAgentWorkspaceWrites,
    );
    setAgentCall(result);
    if (result.state === "available") {
      setAgentSession(result.value);
      setAgentTranscript([
        {
          role: "system",
          text: allowAgentWorkspaceWrites
            ? "Sessão conectada com escrita no workspace explicitamente habilitada. As permissões do adapter externo são exibidas no Context Dock."
            : "Sessão conectada em leitura. O agente recebe o workspace anexado e sua intenção; escrita continua fora desta sessão.",
        },
      ]);
    }
  }
  async function cancelAgentSession() {
    if (!agentSession) return;
    await hostClient.cancelAgentSession(agentSession.sessionId);
    setAgentSession(null);
  }
  async function submitAgentTask() {
    if (!agentSession) return;
    const prompt = `Intenção atual do projeto:\n${intent}\n\nPedido do usuário:\n${agentPrompt}\n\n${agentSession.readOnly ? "Não altere arquivos; explique, investigue e proponha os próximos passos." : "Você pode alterar arquivos somente dentro do workspace anexado para executar este pedido."}`;
    appendAgentTranscript("user", agentPrompt);
    const result = await hostClient.submitAgentTask(
      agentSession.sessionId,
      prompt,
      !agentSession.readOnly,
    );
    setAgentTask(result);
    if (result.state === "failed") {
      appendAgentTranscript("system", `O host recusou a tarefa: ${result.message}`);
    }
  }
  async function startWorkspaceTerminal() {
    if (!project || !resource) return;
    const result = await hostClient.startWorkspaceTerminal(
      project.id,
      resource.id,
    );
    setTerminalCall(result);
    if (result.state === "available") {
      setTerminalOutput([]);
      setTerminal(result.value);
      void hostClient.resizeWorkspaceTerminal(result.value.terminalId, 24, 120);
    }
  }
  async function cancelWorkspaceInspection() {
    if (!terminal) return;
    await hostClient.cancelWorkspaceInspection(terminal.terminalId);
    setTerminal({
      ...terminal,
      state: "stopped",
      detail: "A sessão foi encerrada e a saída bruta permanece disponível acima.",
    });
  }
  async function submitTerminalInput(input: string) {
    if (!terminal) return;
    const result = await hostClient.writeWorkspaceTerminal(
      terminal.terminalId,
      input,
    );
    if (result.state === "failed") {
      setTerminalOutput((current) => [
        ...current,
        `[host recusou entrada: ${result.message}]`,
      ]);
    }
  }

  return (
    <div className="app-shell">
      <aside className="project-rail" aria-label="Projetos">
        <div className="brand-mark" aria-label="AI Native IDE">
          AI
        </div>
        <div className="rail-divider" />
        {projects.map((candidate) => (
          <button
            key={candidate.id}
            className={
              candidate.id === project?.id
                ? "project-chip project-chip--active"
                : "project-chip"
            }
            aria-label={`Abrir projeto: ${candidate.title}`}
            onClick={() => void openProject(candidate.id)}
            type="button"
          >
            {candidate.title.slice(0, 2).toUpperCase()}
          </button>
        ))}
        <button
          className="project-chip"
          aria-label="Adicionar projeto"
          onClick={startNewProject}
          type="button"
        >
          +
        </button>
        <div className="rail-bottom">
          <button
            className="quiet-icon"
            aria-label="Configurações"
            type="button"
          >
            ◌
          </button>
        </div>
      </aside>
      <aside className="navigator" aria-label="Navegador do projeto">
        <header className="project-heading">
          <span className="eyebrow">PROJETO</span>
          <h1>{project?.title ?? "Sem projeto"}</h1>
          <button
            className="scope-button"
            disabled={!project}
            onClick={() => void attachWorkspace()}
            type="button"
          >
            {resource
              ? `${resource.kind === "repository" ? "repo" : "diretório"} anexado`
              : project
                ? "Anexar diretório"
                : "Crie o projeto primeiro"}{" "}
            <span>⌄</span>
          </button>
        </header>
        <nav>
          {navItems.map((item) => (
            <button
              key={item}
              className={
                section === item ? "nav-item nav-item--active" : "nav-item"
              }
              onClick={() => setSection(item)}
              type="button"
            >
              <span>
                {item === "Overview"
                  ? "◎"
                  : item === "Build"
                    ? "↗"
                    : item === "Resources"
                      ? "□"
                      : "◇"}
              </span>
              {item}
            </button>
          ))}
        </nav>
        <section className="navigator-note">
          <span className="eyebrow">MODO</span>
          <div className="mode-group" aria-label="Modo de construção">
            {(["full-vibes", "hybrid", "spec"] as BuildMode[]).map((item) => (
              <button
                className={
                  mode === item
                    ? "mode-button mode-button--active"
                    : "mode-button"
                }
                key={item}
                onClick={() => setMode(item)}
                type="button"
              >
                {item === "full-vibes"
                  ? "Vibes"
                  : item === "hybrid"
                    ? "Hybrid"
                    : "Spec"}
              </button>
            ))}
          </div>
          <p>
            {mode === "hybrid"
              ? "Experimente agora. Promova com um checkpoint."
              : mode === "spec"
                ? "Resolva contratos antes do efeito durável."
                : "Avance, registre hipóteses e ajuste depois."}
          </p>
        </section>
      </aside>
      <main className="work-surface">
        <header className="surface-bar">
          <div>
            <span className="eyebrow">
              {section.toUpperCase()} / {depth.toUpperCase()}
            </span>
            <span className="connection">
              <i />{" "}
              {project
                ? "Projeto local persistido · sem agente conectado"
                : "Local-first · sem agente conectado"}
            </span>
          </div>
          <div className="depth-switch" aria-label="Profundidade da interface">
            <button
              className={
                depth === "essential"
                  ? "depth-button depth-button--active"
                  : "depth-button"
              }
              onClick={() => setDepth("essential")}
              type="button"
            >
              Essential
            </button>
            <button
              className={
                depth === "raw"
                  ? "depth-button depth-button--active"
                  : "depth-button"
              }
              onClick={() => setDepth("raw")}
              type="button"
            >
              Raw
            </button>
          </div>
        </header>
        <div className="surface-scroll">
          <section className="intent-hero" aria-labelledby="intent-heading">
            <div className="section-label">
              <span>01</span>
              <span>INTENÇÃO</span>
            </div>
            <h2 id="intent-heading">O que você quer colocar no mundo?</h2>
            <p className="lede">
              Comece pela mudança que você quer causar. A estrutura técnica pode
              esperar.
            </p>
            <label className="intent-input-label" htmlFor="intent">
              Intenção do projeto
            </label>
            <textarea
              id="intent"
              value={intent}
              onChange={(event) => setIntent(event.target.value)}
              placeholder="Ex.: quero criar uma ferramenta para…"
              rows={3}
            />
            <div className="intent-footer">
              <span>
                {projectCall?.state === "failed"
                  ? `O host recusou o projeto: ${projectCall.message}`
                  : projectCall?.state === "unavailable"
                    ? "Abra o app desktop para persistir o projeto; nenhum projeto foi criado neste preview web."
                    : project
                      ? "Projeto persistido localmente; a intenção ainda não foi enviada a nenhum modelo."
                      : intent.trim().length
                        ? "Intenção local, ainda não enviada a nenhum modelo."
                        : "Escreva livremente; vamos ajudar a tornar isso construível."}
              </span>
              <button
                className="primary-action"
                disabled={Boolean(project)}
                onClick={() => void createProject()}
                type="button"
              >
                {project ? "Projeto aberto" : "Começar a construir"}{" "}
                <span>→</span>
              </button>
            </div>
          </section>
          <section
            className="guidance-section"
            aria-labelledby="guidance-heading"
          >
            <div className="section-label">
              <span>02</span>
              <span>ORIENTAÇÃO INCREMENTAL</span>
            </div>
            <div className="section-title-row">
              <div>
                <h2 id="guidance-heading">
                  Antes do código, poucas decisões que importam.
                </h2>
                <p>
                  Não é um formulário. São pontos que reduzem retrabalho
                  enquanto você constrói.
                </p>
              </div>
              <span className="signal-count">{signals.length} sinais</span>
            </div>
            <div className="signal-grid">
              {signals.map((signal) => (
                <SignalCard key={signal.id} signal={signal} onUse={useSignal} />
              ))}
            </div>
          </section>
          <section className="build-section" aria-labelledby="build-heading">
            <div className="section-label">
              <span>03</span>
              <span>CONSTRUÇÃO</span>
            </div>
            <h2 id="build-heading">
              Um próximo passo, não uma parede de configuração.
            </h2>
            {agentSession && (
              <section className="agent-workspace" aria-label="Trabalho com o agente">
                <div className="section-label">
              <span>{agentTarget.toUpperCase()}</span>
                  <span>SESSÃO REAL</span>
                </div>
                <pre aria-live="polite">
                  {agentTranscript.length
                    ? agentTranscript
                        .map((entry) => `[${entry.role}] ${entry.text}`)
                        .join("\n\n")
                    : "Aguardando resposta do agente…"}
                </pre>
                <label className="intent-input-label" htmlFor="agent-task">
                  Próxima instrução
                </label>
                <textarea
                  id="agent-task"
                  value={agentPrompt}
                  onChange={(event) => setAgentPrompt(event.target.value)}
                  rows={3}
                />
                <button
                  className="primary-action"
                  disabled={!agentPrompt.trim()}
                  onClick={() => void submitAgentTask()}
                  type="button"
                >
                  Enviar ao agente <span>→</span>
                </button>
              </section>
            )}
            <div className="next-step">
              <div>
                <span className="eyebrow">PRÓXIMA DECISÃO</span>
                <strong>{activeSignal?.title ?? nextStep}</strong>
                <p>
                  {activeSignal
                    ? activeSignal.prompt
                    : resource
                      ? effectState === "awaiting"
                        ? "A intenção será gravada no workspace após sua aprovação explícita."
                        : effectState === "written"
                          ? "A intenção está gravada no recurso anexado e registrada como efeito da IDE."
                          : "Salve a intenção no workspace antes de pedir uma implementação ao agente."
                      : "Anexe um diretório para criar o primeiro artefato do projeto."}
                </p>
              </div>
              <div>
                {effectState === "awaiting" ? (
                  <button
                    className="primary-action"
                    onClick={() => void approveProjectIntent()}
                    type="button"
                  >
                    Aprovar escrita <span>→</span>
                  </button>
                ) : effectState === "written" ? (
                  <button
                    className="outline-action"
                    onClick={() => void rollbackProjectIntent()}
                    type="button"
                  >
                    Reverter intenção
                  </button>
                ) : (
                  <button
                    className="outline-action"
                    disabled={!resource}
                    onClick={() => void proposeProjectIntent()}
                    type="button"
                  >
                    Salvar intenção
                  </button>
                )}
              </div>
            </div>
            <div className="preview-placeholder">
              <div className="preview-top">
                <span>PREVIEW</span>
                <span
                  className={
                    preview
                      ? "status-healthy"
                      : previewFailure
                        ? "status-unknown"
                        : "status-unknown"
                  }
                >
                  {preview
                    ? "● HEALTHY"
                    : previewFailure
                      ? "● BROKEN"
                      : "○ NOT-RUN"}
                </span>
              </div>
              {preview ? (
                <>
                  <iframe
                    className="benchmark-preview"
                    src={preview.url}
                    title="Preview do leilão de posições"
                  />
                  <button
                    className="text-button"
                    onClick={() => void capturePreviewFailure()}
                    type="button"
                  >
                    Verificar falha real <span>→</span>
                  </button>
                </>
              ) : (
                <div className="preview-body">
                  <div className="preview-skeleton preview-skeleton--title" />
                  <div className="preview-skeleton" />
                  <div className="preview-skeleton preview-skeleton--short" />
                  <p>
                    {previewFailure
                      ? `${previewFailure.failure.message} Artefato: ${previewFailure.failure.causalLinks.filePaths.join(", ")}. Divergência registrada: ${previewFailure.divergence.id}.`
                      : previewCall?.state === "failed"
                        ? `O host não iniciou o preview: ${previewCall.message}`
                        : previewCall?.state === "unavailable"
                          ? "O preview só inicia pelo app desktop; nenhum servidor foi iniciado nesta página web."
                          : effectState !== "written"
                            ? "Salve a intenção aprovada antes de iniciar um preview do template de benchmark."
                            : "O preview do template de benchmark permanece disponível como referência técnica; o agente trabalha no seu recurso anexado."}
                  </p>
                  <button
                    className="outline-action"
                    disabled={!project || effectState !== "written"}
                    onClick={() => void startPreview()}
                    type="button"
                  >
                    {project
                      ? "Iniciar preview de referência"
                      : "Crie o projeto primeiro"}
                  </button>
                </div>
              )}
            </div>
          </section>
          {previewFailure && (
            <section
              className="raw-surface"
              aria-label="Reconciliação do preview"
            >
              <div className="section-label">
                <span>04</span>
                <span>RECONCILIAÇÃO</span>
              </div>
              <h2>O que deve mudar?</h2>
              <p>
                {reconciliationNote ??
                  "A falha permanece vinculada ao efeito, atividade e artefato. Escolha a próxima decisão."}
              </p>
              <button
                className="text-button"
                onClick={() => void reconcilePreview("change_implementation")}
                type="button"
              >
                Mudar implementação
              </button>
              <button
                className="text-button"
                onClick={() => void reconcilePreview("change_intent")}
                type="button"
              >
                Mudar intenção
              </button>
              <button
                className="text-button"
                onClick={() =>
                  void reconcilePreview("accept_preview_exception")
                }
                type="button"
              >
                Aceitar exceção limitada
              </button>
            </section>
          )}
          {depth === "raw" && (
            <section className="raw-surface" aria-labelledby="raw-heading">
              <div className="section-label">
                <span>RAW</span>
                <span>MESMO PROJETO, OUTRA PROFUNDIDADE</span>
              </div>
              <h2 id="raw-heading">
                Artefatos acessíveis, sem trocar de contexto.
              </h2>
              <div className="raw-grid">
                <div
                  className="monaco-editor"
                  aria-label="Editor Monaco do arquivo selecionado"
                  style={{ background: "#181a17", height: 300, padding: 0 }}
                >
                  <Editor
                    language={
                      selectedFile?.endsWith(".json")
                        ? "json"
                        : selectedFile?.endsWith(".ts") || selectedFile?.endsWith(".tsx")
                          ? "typescript"
                          : selectedFile?.endsWith(".css")
                            ? "css"
                            : "markdown"
                    }
                    theme="vs-dark"
                    value={rawDocument}
                    onChange={(value) => setRawDocument(value ?? "")}
                    options={{
                      automaticLayout: true,
                      fontFamily: "DM Mono",
                      fontSize: 12,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      wordWrap: "on",
                    }}
                  />
                </div>
                <div>
                  <span className="eyebrow">PONTE DO HOST</span>
                  <p>
                    {selectedFile
                      ? `Editando ${selectedFile}. Salvar passa pelo effect broker do host.`
                      : "Selecione um arquivo do recurso anexado para editar."}
                  </p>
                  <div className="file-list" aria-label="Arquivos do workspace">
                    {workspaceFiles.map((file) => (
                      <button
                        className={file.relativePath === selectedFile ? "text-button file-button--active" : "text-button"}
                        key={file.relativePath}
                        onClick={() => project && resource && void openWorkspaceFile(project, resource, file.relativePath)}
                        type="button"
                      >
                        {file.relativePath}
                      </button>
                    ))}
                  </div>
                  <label className="intent-input-label" htmlFor="new-file-path">
                    Novo arquivo relativo
                  </label>
                  <div className="new-file-row">
                    <input
                      id="new-file-path"
                      onChange={(event) => setNewFilePath(event.target.value)}
                      placeholder="src/app.ts"
                      value={newFilePath}
                    />
                    <button className="outline-action" onClick={beginNewWorkspaceFile} type="button">
                      Criar
                    </button>
                  </div>
                  {effectState === "awaiting" && fileEffectId ? (
                    <button className="primary-action" onClick={() => void approveWorkspaceFile()} type="button">
                      Aprovar edição →
                    </button>
                  ) : (
                    <button className="outline-action" disabled={!selectedFile} onClick={() => void saveWorkspaceFile()} type="button">
                      Salvar edição
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>
      </main>
      <aside className="context-dock" aria-label="Contexto atual">
        <header>
          <span className="eyebrow">CONTEXTO ATUAL</span>
          <button
            className="quiet-icon"
            aria-label="Fixar contexto"
            type="button"
          >
            ⌁
          </button>
        </header>
        <section className="dock-section">
          <span className="dock-label">AGENTE</span>
          <strong>
            {agentSession
              ? `${agentTarget} conectado · ${agentSession.readOnly ? "somente leitura" : "escrita externa habilitada"}`
              : "Não conectado"}
          </strong>
          <p>
            {agentCapability?.state === "available"
              ? agentCapability.value.health.availability === "Unavailable"
                ? (agentCapability.value.health.detail ??
                  "O adapter ACPX não está pronto neste computador.")
                : agentCapability.value.descriptor?.degradations.join(" ") ||
                  "O adapter declarou todas as limitações disponíveis."
              : agentCall?.state === "failed"
                ? `O adapter recusou a sessão: ${agentCall.message}`
                : agentSession
                  ? agentSession.policyNote
                  : "Conecte um adapter só depois de escolher o recurso. A IDE mantém efeitos de escrita fora do agente."}
          </p>
          {!agentSession && (
            <>
              <div className="mode-group" aria-label="Adapter de agente">
                {(["claude", "codex", "gemini", "opencode"] as AgentTarget[]).map(
                  (target) => (
                    <button
                      key={target}
                      className={
                        agentTarget === target
                          ? "mode-button mode-button--active"
                          : "mode-button"
                      }
                      onClick={() => setAgentTarget(target)}
                      type="button"
                    >
                      {target}
                    </button>
                  ),
                )}
              </div>
              <label>
                <input
                  checked={allowAgentWorkspaceWrites}
                  onChange={(event) => setAllowAgentWorkspaceWrites(event.target.checked)}
                  type="checkbox"
                />{" "}
                Permitir escrita neste workspace
              </label>
            </>
          )}
          <button
            className="text-button"
            disabled={
              !project ||
              !resource ||
              (!agentSession &&
                agentCapability?.state === "available" &&
                agentCapability.value.health.availability === "Unavailable")
            }
            onClick={() =>
              void (agentSession ? cancelAgentSession() : startAgentSession())
            }
            type="button"
          >
            {agentSession ? "Encerrar sessão" : `Conectar ${agentTarget}`}{" "}
            <span>→</span>
          </button>
          {agentSession && (
            <div className="guidance-empty">
              <p>
                {agentTask?.state === "available"
                  ? `Tarefa ${agentTask.value} enviada. O transcript aparece na superfície de trabalho.`
                  : "A superfície de trabalho mantém a conversa e a saída do agente."}
              </p>
            </div>
          )}
        </section>
        <section className="dock-section">
          <span className="dock-label">TERMINAL</span>
          <strong>
            {terminal?.state === "running" ? "PTY em execução" : "Terminal do workspace"}
          </strong>
          <p>
            {terminalCall?.state === "failed"
              ? `O host recusou o terminal: ${terminalCall.message}`
              : terminal
                ? terminal.detail
                : "O host abre o shell no recurso anexado; a UI não escolhe executável nem caminho."}
          </p>
          <button
            className="text-button"
            disabled={!project || !resource}
            onClick={() =>
              void (terminal
                ? terminal.state === "running"
                  ? cancelWorkspaceInspection()
                  : startWorkspaceTerminal()
                : startWorkspaceTerminal())
            }
            type="button"
          >
            {terminal?.state === "running" ? "Encerrar terminal" : "Abrir terminal"}{" "}
            <span>→</span>
          </button>
          {terminal && (
            <TerminalSurface
              lines={terminalOutput}
              onCancel={() => void cancelWorkspaceInspection()}
              onSubmit={(input) => void submitTerminalInput(input)}
              running={terminal.state === "running"}
            />
          )}
        </section>
        <section className="dock-section">
          <span className="dock-label">ESCOPO</span>
          <strong>Projeto inteiro</strong>
          <p>
            {resource
              ? `${resource.kind === "repository" ? "Repositório" : "Diretório"} anexado · escopo ativo`
              : "Anexe um diretório para habilitar terminal, agente e efeitos."}
          </p>
        </section>
        <section className="dock-section">
          <span className="dock-label">APLICADO AGORA</span>
          <div className="guidance-empty">
            <span>◌</span>
            <p>
              Nenhuma guidance ativa ainda. Uma decisão que você salvar
              aparecerá aqui com origem e escopo.
            </p>
          </div>
        </section>
        <section className="dock-section dock-section--bottom">
          <span className="dock-label">EFFECTS</span>
          <strong>
            {effectState === "awaiting"
              ? "1 aguardando aprovação"
              : effectState === "written"
                ? "1 efeito aplicado"
                : effectState === "failed"
                  ? "Efeito recusado pelo host"
                  : "0 propostos"}
          </strong>
          <p>
            {effectState === "awaiting"
              ? "O payload exato só será escrito após a aprovação."
              : effectState === "written"
                ? "Snapshot e revisão causal foram registrados pelo host."
                : "Nenhum efeito é autorizado por esta interface."}
          </p>
        </section>
        <section className="dock-section">
          <span className="dock-label">GAME MODE</span>
          <strong>
            {gameMode.enabled
              ? `${verifiedProgress(gameMode)} outcomes verificados`
              : "Oculto; receipts continuam ativos"}
          </strong>
          <p>
            {readArchetypes(gameMode).length
              ? readArchetypes(gameMode)
                  .map((reading) => reading.archetype)
                  .join(" · ")
              : "Progresso só aparece após uma evidência independente."}
          </p>
          <button
            className="text-button"
            onClick={() =>
              setGameMode((current) =>
                setGameModeEnabled(current, !current.enabled),
              )
            }
            type="button"
          >
            {gameMode.enabled ? "Ocultar Game Mode" : "Mostrar Game Mode"}{" "}
            <span>→</span>
          </button>
        </section>
      </aside>
      <footer className="activity-strip" aria-label="Atividade do projeto">
        <span className="activity-title">
          ATIVIDADE
          {gameMode.enabled
            ? ` · ${verifiedProgress(gameMode)} VERIFICADOS`
            : ""}
        </span>
        {initialActivity.map((item, index) => (
          <div
            className={`activity-item activity-item--${item.state}`}
            key={item.id}
          >
            <span className="activity-index">0{index + 1}</span>
            <div>
              <strong>{item.label}</strong>
              <small>
                {item.id === "intent" && intent.trim()
                  ? "Descrição em edição"
                  : item.detail}
              </small>
            </div>
          </div>
        ))}
        {hostActivity.map((entry, index) => (
          <div className="activity-item activity-item--active" key={entry}>
            <span className="activity-index">H{index + 1}</span>
            <div>
              <strong>Host</strong>
              <small>{entry}</small>
            </div>
          </div>
        ))}
        <button className="activity-all" type="button">
          Ver história <span>→</span>
        </button>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
