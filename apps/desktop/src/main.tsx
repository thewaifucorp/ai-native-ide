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
  type BenchmarkPreviewStatus,
  type HostCall,
  type PreviewFailureReport,
  type SemanticProjectRecord,
  type StartedAgentSession,
  type TerminalRunStatus,
  type WorkspaceResource,
} from "./host-client";
import { TerminalSurface } from "./terminal-surface";
import "./styles.css";

const starterIntent =
  "Quero criar um leilão simples de posições para divulgar ferramentas.";
const navItems = ["Overview", "Build", "Resources", "Evidence"] as const;

type AgentTranscriptEntry = {
  role: "user" | "agent" | "system";
  text: string;
};

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
  const [intent, setIntent] = useState(starterIntent);
  const [mode, setMode] = useState<BuildMode>("hybrid");
  const [depth, setDepth] = useState<Depth>("essential");
  const [section, setSection] = useState<(typeof navItems)[number]>("Overview");
  const [activeSignal, setActiveSignal] = useState<IntentSignal | null>(null);
  const [project, setProject] = useState<SemanticProjectRecord | null>(null);
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
  const [rawDocument, setRawDocument] = useState(
    `# intent.md\n\n${starterIntent}\n\nmode: hybrid\nactive-scope: local resource\npreview: not-run\n`,
  );
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
    // The initial project is an opaque stable ID. On a desktop restart the
    // native host restores its persisted resources and watchers without asking
    // the user to re-import the directory.
    void hostClient.openSemanticProject("new-product").then((result) => {
      if (result.state !== "available" || !result.value) return;
      setProject(result.value.project);
      setResource(result.value.resources[0] ?? null);
    });
  }, []);
  useEffect(() => {
    if (!resource) return;
    void hostClient.agentCapabilityCard("claude").then(setAgentCapability);
  }, [resource]);
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
        setHostActivity((current) =>
          [describeAgentEvent(event), ...current].slice(0, 4),
        );
      });
    }, 500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [agentSession]);
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
  async function createProject() {
    const result = await hostClient.createSemanticProject({
      projectId: "new-product",
      title: "Novo produto",
      intent,
    });
    setProjectCall(result);
    if (result.state === "available") {
      setProject(result.value);
      setSection("Build");
    }
  }
  async function attachWorkspace() {
    if (!project) return;
    const result = await hostClient.attachWorkspaceFromPicker(
      project.id,
      `${project.id}-local`,
    );
    if (result.state === "available" && result.value) setResource(result.value);
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
      "benchmark-plan-v1",
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
  async function proposeBenchmarkPlan() {
    if (!project || !resource) return;
    const result = await hostClient.proposeWorkspaceWrite(project.id, {
      resourceId: resource.id,
      effectId: "benchmark-plan-v1",
      relativePath: "benchmark.intent.md",
      content: `# Benchmark intent\n\n${intent}\n\nMode: ${mode}\n`,
    });
    if (result.state !== "available") {
      setEffectState("failed");
      return;
    }
    setEffectState(result.value.written ? "written" : "awaiting");
  }
  async function approveBenchmarkPlan() {
    if (!project || !resource) return;
    const approved = await hostClient.approveNextWorkspaceWrite(
      project.id,
      resource.id,
    );
    if (approved.state !== "available") {
      setEffectState("failed");
      return;
    }
    await proposeBenchmarkPlan();
  }
  async function rollbackBenchmarkPlan() {
    if (!project || !resource) return;
    const result = await hostClient.rollbackWorkspaceWrite(
      project.id,
      resource.id,
      "benchmark-plan-v1",
    );
    if (result.state === "available") {
      setEffectState("idle");
      setPreview(null);
      setPreviewFailure(null);
    } else {
      setEffectState("failed");
    }
  }
  async function startAgentSession() {
    if (!project || !resource) return;
    const result = await hostClient.startReadOnlyAgentSession(
      "claude",
      project.id,
      resource.id,
    );
    setAgentCall(result);
    if (result.state === "available") {
      setAgentSession(result.value);
      setAgentTranscript([
        {
          role: "system",
          text: "Sessão conectada. O agente recebe o workspace anexado e sua intenção; escrita continua fora desta sessão read-only.",
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
    const prompt = `Intenção atual do projeto:\n${intent}\n\nPedido do usuário:\n${agentPrompt}`;
    appendAgentTranscript("user", agentPrompt);
    const result = await hostClient.submitAgentTask(
      agentSession.sessionId,
      prompt,
      false,
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
        <button
          className="project-chip project-chip--active"
          aria-label="Projeto ativo: Novo produto"
          type="button"
        >
          NP
        </button>
        <button
          className="project-chip"
          aria-label="Adicionar projeto"
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
          <h1>{project?.title ?? "Novo produto"}</h1>
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
                onClick={() => void createProject()}
                type="button"
              >
                {project ? "Atualizar projeto" : "Começar a construir"}{" "}
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
                  <span>AGENTE</span>
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
                        ? "O plano do benchmark está pausado para sua aprovação explícita."
                        : effectState === "written"
                          ? "O plano foi escrito no recurso anexado e está registrado como efeito da IDE."
                          : "Prepare o plano do benchmark antes de iniciar o preview."
                      : "Anexe um diretório para criar o primeiro artefato do benchmark."}
                </p>
              </div>
              <div>
                {effectState === "awaiting" ? (
                  <button
                    className="primary-action"
                    onClick={() => void approveBenchmarkPlan()}
                    type="button"
                  >
                    Aprovar plano <span>→</span>
                  </button>
                ) : effectState === "written" ? (
                  <button
                    className="outline-action"
                    onClick={() => void rollbackBenchmarkPlan()}
                    type="button"
                  >
                    Reverter plano
                  </button>
                ) : (
                  <button
                    className="outline-action"
                    disabled={!resource}
                    onClick={() => void proposeBenchmarkPlan()}
                    type="button"
                  >
                    Preparar benchmark
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
                            ? "Prepare e aprove o plano do benchmark para criar seu primeiro artefato controlado."
                            : "O benchmark real aparece aqui quando o host iniciar o preview local."}
                  </p>
                  <button
                    className="outline-action"
                    disabled={!project || effectState !== "written"}
                    onClick={() => void startPreview()}
                    type="button"
                  >
                    {project
                      ? "Iniciar benchmark local"
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
                  aria-label="Editor Monaco de intent.md"
                  style={{ background: "#181a17", height: 300, padding: 0 }}
                >
                  <Editor
                    defaultLanguage="markdown"
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
                    Arquivos, terminal, preview e logs entram pela bridge
                    tipada Tauri → Rust. O editor permanece no mesmo estado
                    do projeto; gravar no workspace continua um efeito aprovado.
                  </p>
                  <button className="outline-action" type="button">
                    Ver contrato do host
                  </button>
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
              ? "Claude conectado · somente leitura"
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
            {agentSession ? "Encerrar sessão" : "Conectar Claude"}{" "}
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
