import { StrictMode, useEffect, useMemo, useState } from "react";
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
  hostClient,
  type BenchmarkPreviewStatus,
  type HostCall,
  type PreviewFailureReport,
  type SemanticProjectRecord,
  type StartedAgentSession,
  type TerminalRunStatus,
  type WorkspaceResource,
} from "./host-client";
import "./styles.css";

const starterIntent =
  "Quero criar um leilão simples de posições para divulgar ferramentas.";
const navItems = ["Overview", "Build", "Resources", "Evidence"] as const;

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
  const [agentPrompt, setAgentPrompt] = useState(
    "Revise a intenção e aponte o próximo risco verificável.",
  );
  const [agentTask, setAgentTask] = useState<HostCall<number> | null>(null);
  const [terminal, setTerminal] = useState<TerminalRunStatus | null>(null);
  const [terminalCall, setTerminalCall] =
    useState<HostCall<TerminalRunStatus> | null>(null);
  const [hostActivity, setHostActivity] = useState<string[]>([]);
  const [reconciliationNote, setReconciliationNote] = useState<string | null>(
    null,
  );
  const signals = useMemo(() => analyzeIntent(intent), [intent]);
  const nextStep = nextStepFor(intent, signals);
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
      })
      .then((stop) => {
        unsubscribe = stop;
      });
    return () => unsubscribe?.();
  }, []);
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
    if (result.state === "available") setAgentSession(result.value);
  }
  async function cancelAgentSession() {
    if (!agentSession) return;
    await hostClient.cancelAgentSession(agentSession.sessionId);
    setAgentSession(null);
  }
  async function submitAgentTask() {
    if (!agentSession) return;
    const result = await hostClient.submitAgentTask(
      agentSession.sessionId,
      agentPrompt,
      false,
    );
    setAgentTask(result);
  }
  async function startWorkspaceInspection() {
    if (!project || !resource) return;
    const result = await hostClient.startWorkspaceInspection(
      project.id,
      resource.id,
    );
    setTerminalCall(result);
    if (result.state === "available") setTerminal(result.value);
  }
  async function cancelWorkspaceInspection() {
    if (!terminal) return;
    await hostClient.cancelWorkspaceInspection(terminal.terminalId);
    setTerminal(null);
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
                <pre>{`intent.md\n\n${intent || "# Intenção ainda não declarada"}\n\nmode: ${mode}\nactive-scope: local resource\npreview: not-run`}</pre>
                <div>
                  <span className="eyebrow">PONTE DO HOST</span>
                  <p>
                    Arquivos, terminal e logs entram aqui pela bridge tipada
                    Tauri → Rust. Nesta fatia, nenhum efeito é simulado como
                    real.
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
            {agentCall?.state === "failed"
              ? `O adapter recusou a sessão: ${agentCall.message}`
              : agentSession
                ? agentSession.policyNote
                : "Conecte um adapter só depois de escolher o recurso. A IDE mantém efeitos de escrita fora do agente."}
          </p>
          <button
            className="text-button"
            disabled={!project || !resource}
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
              <label htmlFor="agent-task">Tarefa do agente</label>
              <textarea
                id="agent-task"
                value={agentPrompt}
                onChange={(event) => setAgentPrompt(event.target.value)}
                rows={2}
              />
              <button
                className="text-button"
                disabled={!agentPrompt.trim()}
                onClick={() => void submitAgentTask()}
                type="button"
              >
                Enviar leitura <span>→</span>
              </button>
              <p>
                {agentTask?.state === "available"
                  ? `Tarefa ${agentTask.value} enviada à sessão; alterações continuam fora do agente.`
                  : agentTask?.state === "failed"
                    ? `A sessão recusou a tarefa: ${agentTask.message}`
                    : ""}
              </p>
            </div>
          )}
        </section>
        <section className="dock-section">
          <span className="dock-label">TERMINAL</span>
          <strong>
            {terminal ? "Inspeção PTY em execução" : "Somente leitura"}
          </strong>
          <p>
            {terminalCall?.state === "failed"
              ? `O host recusou o terminal: ${terminalCall.message}`
              : terminal
                ? terminal.detail
                : "Execute uma inspeção Git limitada ao recurso; comandos livres entram somente com a política de terminal da fase seguinte."}
          </p>
          <button
            className="text-button"
            disabled={!project || !resource}
            onClick={() =>
              void (terminal
                ? cancelWorkspaceInspection()
                : startWorkspaceInspection())
            }
            type="button"
          >
            {terminal ? "Cancelar inspeção" : "Inspecionar recurso"}{" "}
            <span>→</span>
          </button>
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
      </aside>
      <footer className="activity-strip" aria-label="Atividade do projeto">
        <span className="activity-title">ATIVIDADE</span>
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
