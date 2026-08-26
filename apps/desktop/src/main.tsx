import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Editor from "@monaco-editor/react";
import { createRoot } from "react-dom/client";
import { analyzeIntent, nextStepFor, type IntentSignal } from "./instrument";
import {
  createGameModeState,
  readArchetypes,
  recordOutcome,
  verifiedProgress,
  type GameModeState,
} from "./game-mode";
import {
  hostClient,
  type AgentCapabilityCard,
  type AgentEvent,
  type AgentTarget,
  type BenchmarkPreviewStatus,
  type ExportManifest,
  type HarnessReport,
  type IdeConfig,
  type PreviewFailureReport,
  type PublishRecord,
  type SemanticProjectRecord,
  type StartedAgentSession,
  type WorkspaceFile,
  type WorkspaceResource,
} from "./host-client";
import "./styles.css";

/* ============================================================
   Tipos locais de UI (o shell "Instrumento").
   ============================================================ */
type WorkView = "home" | "build" | "resources" | "evidence" | "ship";
type Depth = "essential" | "detailed" | "raw";
type ActiveTab = { kind: "view"; view: WorkView } | { kind: "file"; path: string };

interface OpenFile {
  path: string;
  content: string;
  saved: string;
  effectId: string | null;
  awaiting: boolean;
}

type NotchKind = "ed" | "ck" | "dc" | "ev" | "bad";
interface ActivityEvent {
  id: string;
  ts: string;
  kind: string;
  klass: NotchKind;
  text: string;
}

interface ConvMsg {
  id: string;
  role: "user" | "agent" | "sys";
  text: string;
}

const NAV_ITEMS: Array<{ view: WorkView; label: string; icon: string }> = [
  { view: "home", label: "Overview", icon: "overview" },
  { view: "build", label: "Build", icon: "build" },
  { view: "resources", label: "Resources", icon: "resources" },
  { view: "evidence", label: "Evidence", icon: "evidence" },
  { view: "ship", label: "Ship", icon: "ship" },
];

const AGENT_TARGETS: AgentTarget[] = ["claude", "codex", "gemini", "opencode"];

/* ============================================================
   Utilidades puras.
   ============================================================ */
function clock(): string {
  return new Date().toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function projectIdentity(intent: string): string {
  const slug = intent
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
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

function firstSentence(intent: string): string {
  const trimmed = intent.trim();
  if (!trimmed) return "";
  const match = trimmed.split(/(?<=[.!?])\s/, 1)[0];
  return match ?? trimmed;
}

function initials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "··";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function editorLanguage(path: string | null): string {
  if (!path) return "markdown";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".html")) return "html";
  if (path.endsWith(".rs")) return "rust";
  if (path.endsWith(".py")) return "python";
  return "markdown";
}

function describeAgentEvent(event: AgentEvent): string {
  if ("MessageDelta" in event) return event.MessageDelta.text;
  if ("Thinking" in event) return event.Thinking.summary;
  if ("ToolCall" in event) return `Ferramenta: ${event.ToolCall.name}`;
  if ("ToolResult" in event)
    return `Resultado ${event.ToolResult.name}${event.ToolResult.is_error ? " (erro)" : ""}`;
  if ("PermissionRequested" in event)
    return `Permissão externa: ${event.PermissionRequested.action}`;
  if ("Diff" in event)
    return `Diff em ${event.Diff.path} (+${event.Diff.added} −${event.Diff.removed})`;
  if ("Artifact" in event) return `Artefato: ${event.Artifact.path}`;
  if ("Warning" in event) return `Aviso: ${event.Warning.detail}`;
  if ("Ended" in event) return "Sessão do agente terminou.";
  if ("Started" in event) return "Sessão do agente iniciada.";
  return "Evento do agente registrado.";
}

function healthClass(health: BenchmarkPreviewStatus["health"] | null): string {
  if (!health) return "idle";
  if (health === "healthy") return "ok";
  if (health === "starting" || health === "reconnecting") return "run";
  if (health === "broken") return "bad";
  return "idle";
}

/* ============================================================
   Folha de ícones (idêntica ao sketch 001).
   ============================================================ */
function IconSheet() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <symbol id="ic-overview" viewBox="0 0 16 16">
          <rect x="2" y="2" width="5" height="5" rx="1" />
          <rect x="9" y="2" width="5" height="5" rx="1" />
          <rect x="2" y="9" width="5" height="5" rx="1" />
          <rect x="9" y="9" width="5" height="5" rx="1" />
        </symbol>
        <symbol id="ic-build" viewBox="0 0 16 16">
          <path d="M8 1.5 9.5 6.5 14.5 8 9.5 9.5 8 14.5 6.5 9.5 1.5 8 6.5 6.5Z" />
        </symbol>
        <symbol id="ic-resources" viewBox="0 0 16 16">
          <path d="M2 5.5 8 2.5l6 3v5l-6 3-6-3Z" />
          <path d="M2 5.5 8 8.5l6-3M8 8.5v6" />
        </symbol>
        <symbol id="ic-evidence" viewBox="0 0 16 16">
          <path d="M8 1.8 13.5 4v4c0 3.2-2.3 5.4-5.5 6.2C4.8 13.4 2.5 11.2 2.5 8V4Z" />
          <path d="M5.8 8l1.6 1.6L10.6 6.4" />
        </symbol>
        <symbol id="ic-ship" viewBox="0 0 16 16">
          <path d="M4 12 12 4M6 4h6v6" />
        </symbol>
        <symbol id="ic-session" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.5V8l2.5 1.5" />
        </symbol>
        <symbol id="ic-history" viewBox="0 0 16 16">
          <path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9M2.5 8V4.8M2.5 8h3.2" />
        </symbol>
        <symbol id="ic-gear" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" />
        </symbol>
        <symbol id="ic-plus" viewBox="0 0 16 16">
          <path d="M8 3.5v9M3.5 8h9" />
        </symbol>
        <symbol id="ic-refresh" viewBox="0 0 16 16">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 3.5v2.7h-2.7" />
        </symbol>
        <symbol id="ic-more" viewBox="0 0 16 16">
          <circle cx="3.5" cy="8" r=".9" fill="currentColor" stroke="none" />
          <circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none" />
          <circle cx="12.5" cy="8" r=".9" fill="currentColor" stroke="none" />
        </symbol>
        <symbol id="ic-check" viewBox="0 0 16 16">
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
        </symbol>
        <symbol id="ic-dot" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />
        </symbol>
        <symbol id="ic-circle" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="4.5" />
        </symbol>
      </defs>
    </svg>
  );
}

function Icon({ id }: { id: string }) {
  return (
    <svg className="i">
      <use href={`#ic-${id}`} />
    </svg>
  );
}

/* ============================================================
   Aplicação.
   ============================================================ */
function App() {
  // Projeto / recurso
  const [projects, setProjects] = useState<SemanticProjectRecord[]>([]);
  const [project, setProject] = useState<SemanticProjectRecord | null>(null);
  const [resources, setResources] = useState<WorkspaceResource[]>([]);
  const [resource, setResource] = useState<WorkspaceResource | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [intentDraft, setIntentDraft] = useState("");

  // Navegação / abas
  const [active, setActive] = useState<ActiveTab>({ kind: "view", view: "home" });
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [depth, setDepth] = useState<Depth>("detailed");
  const [game, setGame] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Host / ambiente
  const [hostAvailable, setHostAvailable] = useState(false);
  const [config, setConfig] = useState<IdeConfig | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);

  // Preview
  const [preview, setPreview] = useState<BenchmarkPreviewStatus | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [previewFailure, setPreviewFailure] = useState<PreviewFailureReport | null>(null);

  // Agente
  const [agentTarget, setAgentTarget] = useState<AgentTarget>("claude");
  const [agentCapability, setAgentCapability] = useState<AgentCapabilityCard | null>(null);
  const [agentSession, setAgentSession] = useState<StartedAgentSession | null>(null);
  const [allowWrites, setAllowWrites] = useState(false);
  const [conv, setConv] = useState<ConvMsg[]>([]);
  const [composer, setComposer] = useState("");
  const [agentUsage, setAgentUsage] = useState({ input: 0, output: 0 });

  // Governança leve (evidence / ship)
  const [harness, setHarness] = useState<HarnessReport | null>(null);
  const [harnessNote, setHarnessNote] = useState<string | null>(null);
  const [exportManifest, setExportManifest] = useState<ExportManifest | null>(null);
  const [publications, setPublications] = useState<PublishRecord[]>([]);

  // Game Mode ledger (recibos independentes)
  const [gameMode, setGameMode] = useState<GameModeState>(() => createGameModeState());

  const toastTimer = useRef<number | null>(null);
  const intent = project?.intent ?? "";
  const signals = useMemo(() => analyzeIntent(intent || intentDraft), [intent, intentDraft]);
  const nextStep = nextStepFor(intent, signals);

  /* ---- helpers de estado ---- */
  const flash = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  }, []);

  const pushActivity = useCallback(
    (kind: string, klass: NotchKind, text: string) => {
      setActivity((current) =>
        [
          { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: clock(), kind, klass, text },
          ...current,
        ].slice(0, 40),
      );
    },
    [],
  );

  const pushConv = useCallback((role: ConvMsg["role"], text: string) => {
    setConv((current) => {
      const last = current.at(-1);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      if (role === "agent" && last?.role === "agent") {
        return [...current.slice(0, -1), { ...last, text: `${last.text}${text}` }];
      }
      return [...current, { id, role, text }];
    });
  }, []);

  /* ---- carga de arquivos ---- */
  const loadWorkspaceFiles = useCallback(
    async (activeProject: SemanticProjectRecord, activeResource: WorkspaceResource) => {
      const result = await hostClient.listWorkspaceFiles(activeProject.id, activeResource.id);
      if (result.state === "available") setWorkspaceFiles(result.value);
    },
    [],
  );

  const openFile = useCallback(
    async (path: string) => {
      if (!project || !resource) return;
      const existing = openFiles.find((file) => file.path === path);
      if (existing) {
        setActive({ kind: "file", path });
        return;
      }
      const result = await hostClient.readWorkspaceFile(project.id, resource.id, path);
      const content = result.state === "available" ? result.value.content : "";
      setOpenFiles((current) => [
        ...current,
        { path, content, saved: content, effectId: null, awaiting: false },
      ]);
      setActive({ kind: "file", path });
      if (result.state !== "available") {
        flash("O host não leu o arquivo; abrindo buffer vazio.");
      }
    },
    [project, resource, openFiles, flash],
  );

  const closeFile = useCallback(
    (path: string) => {
      setOpenFiles((current) => current.filter((file) => file.path !== path));
      setActive((current) => {
        if (current.kind === "file" && current.path === path) {
          return { kind: "view", view: "build" };
        }
        return current;
      });
    },
    [],
  );

  const editActiveFile = useCallback((path: string, content: string) => {
    setOpenFiles((current) =>
      current.map((file) => (file.path === path ? { ...file, content } : file)),
    );
  }, []);

  /* ---- projetos ---- */
  const openProject = useCallback(
    async (projectId: string) => {
      const result = await hostClient.openSemanticProject(projectId);
      if (result.state !== "available" || !result.value) return;
      setProject(result.value.project);
      setResources(result.value.resources);
      const first = result.value.resources[0] ?? null;
      setResource(first);
      setOpenFiles([]);
      setConv([]);
      setAgentSession(null);
      setPreview(null);
      setPreviewFailure(null);
      setHarness(null);
      setActive({ kind: "view", view: "home" });
      if (first) await loadWorkspaceFiles(result.value.project, first);
      else setWorkspaceFiles([]);
      pushActivity("PROJETO", "ck", `Projeto aberto: ${result.value.project.title}`);
    },
    [loadWorkspaceFiles, pushActivity],
  );

  const createProject = useCallback(async () => {
    const text = intentDraft.trim();
    if (!text) return;
    const result = await hostClient.createSemanticProject({
      projectId: projectIdentity(text),
      title: projectTitle(text),
      intent: text,
    });
    if (result.state !== "available") {
      flash(
        result.state === "unavailable"
          ? "Abra o app desktop para persistir o projeto."
          : `O host recusou o projeto: ${result.message}`,
      );
      return;
    }
    setProjects((current) => [
      result.value,
      ...current.filter((candidate) => candidate.id !== result.value.id),
    ]);
    setProject(result.value);
    setResources([]);
    setResource(null);
    setWorkspaceFiles([]);
    setIntentDraft("");
    setActive({ kind: "view", view: "home" });
    pushActivity("INTENÇÃO", "ck", `Intenção declarada: ${projectTitle(text)}`);
  }, [intentDraft, flash, pushActivity]);

  const startNewProject = useCallback(() => {
    setProject(null);
    setResources([]);
    setResource(null);
    setWorkspaceFiles([]);
    setOpenFiles([]);
    setConv([]);
    setIntentDraft("");
    setActive({ kind: "view", view: "home" });
  }, []);

  const attachWorkspace = useCallback(async () => {
    if (!project) return;
    const result = await hostClient.attachWorkspaceFromPicker(project.id);
    if (result.state !== "available") {
      flash(
        result.state === "unavailable"
          ? "O seletor de diretório só existe no app desktop."
          : `O host recusou anexar: ${result.message}`,
      );
      return;
    }
    if (!result.value) return;
    const attached = result.value;
    setResources((current) => [
      attached,
      ...current.filter((candidate) => candidate.id !== attached.id),
    ]);
    setResource(attached);
    await loadWorkspaceFiles(project, attached);
    pushActivity("EDIÇÃO", "ed", `Diretório anexado: ${attached.canonicalPath}`);
  }, [project, flash, loadWorkspaceFiles, pushActivity]);

  /* ---- gravação de arquivo (propose / approve) ---- */
  const proposeFile = useCallback(
    async (file: OpenFile, effectId: string) => {
      if (!project || !resource) return;
      const result = await hostClient.proposeWorkspaceWrite(project.id, {
        resourceId: resource.id,
        effectId,
        relativePath: file.path,
        content: file.content,
      });
      if (result.state !== "available") {
        flash(
          result.state === "unavailable"
            ? "Efeitos de escrita exigem o app desktop."
            : `O host recusou a escrita: ${result.message}`,
        );
        return;
      }
      if (result.value.written) {
        setOpenFiles((current) =>
          current.map((entry) =>
            entry.path === file.path
              ? { ...entry, saved: entry.content, effectId, awaiting: false }
              : entry,
          ),
        );
        await loadWorkspaceFiles(project, resource);
        pushActivity("CHECKPOINT", "ck", `${file.path} gravado com snapshot reversível.`);
        flash(`${file.path} gravado.`);
      } else {
        setOpenFiles((current) =>
          current.map((entry) =>
            entry.path === file.path ? { ...entry, effectId, awaiting: true } : entry,
          ),
        );
        pushActivity("DECISÃO", "dc", `${file.path} aguarda sua aprovação para gravar.`);
      }
    },
    [project, resource, flash, loadWorkspaceFiles, pushActivity],
  );

  const saveFile = useCallback(
    async (file: OpenFile) => {
      const effectId = `edit-${project?.id ?? "workspace"}-${Date.now()}`;
      await proposeFile(file, effectId);
    },
    [project, proposeFile],
  );

  const approveFile = useCallback(
    async (file: OpenFile) => {
      if (!project || !resource || !file.effectId) return;
      // Approve THIS file's effect by id: with more than one decision open,
      // approving "the next one" authorizes the wrong write.
      const approval = await hostClient.approveWorkspaceWrite(
        project.id,
        resource.id,
        file.effectId,
      );
      if (approval.state !== "available") {
        flash("O host não confirmou a aprovação.");
        return;
      }
      await proposeFile(file, file.effectId);
    },
    [project, resource, flash, proposeFile],
  );

  const createNewFile = useCallback(() => {
    const path = window.prompt("Novo arquivo (caminho relativo):", "src/nota.md");
    if (!path) return;
    const clean = path.trim();
    if (!clean) return;
    setOpenFiles((current) => {
      if (current.some((file) => file.path === clean)) return current;
      return [...current, { path: clean, content: "", saved: "", effectId: null, awaiting: false }];
    });
    setActive({ kind: "file", path: clean });
  }, []);

  /* ---- preview ---- */
  const startPreview = useCallback(async () => {
    if (!project) return;
    const result = await hostClient.startBenchmarkPreview(project.id);
    if (result.state !== "available") {
      setPreviewNote(
        result.state === "unavailable"
          ? "O preview de referência só inicia pelo app desktop; nenhum servidor foi iniciado no preview web."
          : `O host não iniciou o preview: ${result.message}`,
      );
      return;
    }
    setPreview(result.value);
    setPreviewFailure(null);
    setPreviewNote(null);
    pushActivity("EDIÇÃO", "ed", `Preview iniciado em ${result.value.url}`);
  }, [project, pushActivity]);

  const capturePreviewFailure = useCallback(async () => {
    if (!project || !resource) return;
    const result = await hostClient.stopAndCaptureBenchmarkPreviewFailure(
      project.id,
      resource.id,
      `${project.id}-preview`,
    );
    if (result.state === "available" && result.value) {
      setPreview(null);
      setPreviewFailure(result.value);
      pushActivity("EVIDENCE", "ev", result.value.failure.message);
    } else {
      flash("Nenhuma falha de preview foi capturada.");
    }
  }, [project, resource, flash, pushActivity]);

  const reconcilePreview = useCallback(
    async (action: "change_implementation" | "change_intent" | "accept_preview_exception") => {
      if (!previewFailure) return;
      const result = await hostClient.reconcileBenchmarkPreviewFailure(
        previewFailure.divergence.id,
        action,
      );
      if (result.state !== "available") return;
      flash(
        result.value.status === "accepted_scoped_exception"
          ? "Exceção limitada registrada; a evidência continua acessível."
          : "Reconciliação registrada, pendente de nova verificação.",
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
              observedAt: new Date(previewFailure.failure.observedAtMs).toISOString(),
              summary: previewFailure.failure.message,
            },
          ],
        },
        new Date().toISOString(),
      );
      setGameMode(transition.state);
      setPreviewFailure(null);
      pushActivity("DECISÃO", "dc", `Divergência reconciliada (${action}).`);
    },
    [previewFailure, gameMode, flash, pushActivity],
  );

  /* ---- agente ---- */
  const ensureAgentSession = useCallback(async (): Promise<StartedAgentSession | null> => {
    if (agentSession) return agentSession;
    if (!project || !resource) return null;
    const result = await hostClient.startAgentSession(
      agentTarget,
      project.id,
      resource.id,
      allowWrites,
    );
    if (result.state !== "available") {
      pushConv(
        "sys",
        result.state === "unavailable"
          ? "Nenhum host: conecte pelo app desktop para trabalhar com o agente."
          : `O adapter recusou a sessão: ${result.message}`,
      );
      return null;
    }
    setAgentSession(result.value);
    setAgentUsage({ input: 0, output: 0 });
    pushActivity("EDIÇÃO", "ed", `Sessão ${agentTarget} conectada (${result.value.readOnly ? "leitura" : "escrita"}).`);
    return result.value;
  }, [agentSession, project, resource, agentTarget, allowWrites, pushConv, pushActivity]);

  const disconnectAgent = useCallback(async () => {
    if (!agentSession) return;
    await hostClient.cancelAgentSession(agentSession.sessionId);
    setAgentSession(null);
    pushConv("sys", "Sessão do agente encerrada.");
  }, [agentSession, pushConv]);

  const submitComposer = useCallback(async () => {
    const text = composer.trim();
    if (!text) return;
    if (!project) {
      flash("Crie um projeto antes de conversar com o agente.");
      return;
    }
    if (!resource) {
      pushConv("user", text);
      pushConv("sys", "Anexe um diretório para dar contexto ao agente. Nada foi enviado.");
      setComposer("");
      return;
    }
    pushConv("user", text);
    setComposer("");
    const session = await ensureAgentSession();
    if (!session) return;
    const prompt = `Intenção do projeto:\n${intent}\n\nPedido:\n${text}\n\n${
      session.readOnly
        ? "Não altere arquivos; investigue e proponha os próximos passos verificáveis."
        : "Você pode alterar arquivos somente dentro do workspace anexado."
    }`;
    const result = await hostClient.submitAgentTask(session.sessionId, prompt, !session.readOnly);
    if (result.state !== "available") {
      pushConv("sys", `O host recusou a tarefa: ${result.state === "failed" ? result.message : "host indisponível"}.`);
    }
  }, [composer, project, resource, intent, ensureAgentSession, pushConv, flash]);

  /* ---- evidence / ship ---- */
  const runHarness = useCallback(async () => {
    if (!project || !resource) return;
    const result = await hostClient.runHarnessLayer0(project.id, resource.id);
    if (result.state !== "available") {
      setHarnessNote(
        result.state === "unavailable"
          ? "Abra o app desktop para rodar os checks determinísticos."
          : `O host recusou os checks: ${result.message}`,
      );
      setHarness(null);
      return;
    }
    setHarness(result.value);
    setHarnessNote(null);
    pushActivity("EVIDENCE", "ev", `Harness: ${result.value.passed} ok · ${result.value.failed} falhas.`);
    if (result.value.failed === 0 && result.value.passed > 0) {
      const transition = recordOutcome(
        gameMode,
        {
          id: `harness:${project.id}:${Date.now()}`,
          category: "finding-resolved",
          summary: "Checks determinísticos passaram sem falhas.",
          proposedBy: "user:local",
          evidence: [
            {
              id: `harness-run-${Date.now()}`,
              source: "test-run",
              verifiedBy: "host:harness",
              observedAt: new Date().toISOString(),
              summary: `${result.value.passed} checks aprovados.`,
            },
          ],
        },
        new Date().toISOString(),
      );
      setGameMode(transition.state);
    }
  }, [project, resource, gameMode, pushActivity]);

  const exportProject = useCallback(async () => {
    if (!project) return;
    const result = await hostClient.exportProject(project.id);
    if (result.state === "available") {
      setExportManifest(result.value);
      flash(`v${result.value.version} exportada.`);
    } else {
      flash("Export disponível apenas no app desktop.");
    }
  }, [project, flash]);

  const publishProject = useCallback(async () => {
    if (!project) return;
    const result = await hostClient.publishProject(project.id);
    if (result.state !== "available") {
      flash("Publish disponível apenas no app desktop.");
      return;
    }
    const history = await hostClient.publishHistory(project.id);
    if (history.state === "available") setPublications(history.value);
    pushActivity("CHECKPOINT", "ck", `Projeto publicado (v${result.value.version}).`);
  }, [project, flash, pushActivity]);

  /* ============================================================
     Efeitos: carga inicial, subscrição de eventos, polls.
     ============================================================ */
  useEffect(() => {
    void hostClient.status().then((result) => setHostAvailable(result.state === "available"));
    void hostClient.getConfig().then((result) => {
      if (result.state === "available") setConfig(result.value);
    });
    void hostClient.listSemanticProjects().then((result) => {
      if (result.state !== "available") return;
      setProjects(result.value);
      if (result.value[0]) void openProject(result.value[0].id);
    });
  }, [openProject]);

  useEffect(() => {
    document.body.classList.toggle("game", game);
  }, [game]);

  // Subscrição de eventos do host -> atividade + saúde do preview.
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    void hostClient
      .listenHostEvents((event) => {
        if (event.kind === "workspaceEffect") {
          const label =
            event.phase === "awaitingApproval"
              ? "DECISÃO"
              : event.phase === "rolledBack"
                ? "CHECKPOINT"
                : "CHECKPOINT";
          const klass: NotchKind = event.phase === "awaitingApproval" ? "dc" : "ck";
          pushActivity(
            label,
            klass,
            `${event.effectId ?? "efeito"}${event.path ? ` (${event.path})` : ""}`,
          );
          return;
        }
        if (event.extension === "preview" && event.health) {
          pushActivity("EDIÇÃO", "ed", `Preview: ${event.health}`);
          return;
        }
        const detail = event.message ?? event.detail ?? event.line ?? event.health ?? event.kind;
        pushActivity("EDIÇÃO", "ed", `${event.kind}: ${detail}`);
      })
      .then((stop) => {
        unsubscribe = stop;
      });
    return () => unsubscribe?.();
  }, [pushActivity]);

  // Capability card do agente sempre que alvo/recurso mudam.
  useEffect(() => {
    if (!resource) {
      setAgentCapability(null);
      return;
    }
    void hostClient.agentCapabilityCard(agentTarget).then((result) => {
      setAgentCapability(result.state === "available" ? result.value : null);
    });
  }, [agentTarget, resource]);

  // Poll de eventos do agente.
  useEffect(() => {
    if (!agentSession) return;
    let live = true;
    const timer = window.setInterval(() => {
      void hostClient.nextAgentEvent(agentSession.sessionId).then((result) => {
        if (!live || result.state !== "available" || !result.value) return;
        const event = result.value;
        if ("MessageDelta" in event) pushConv("agent", event.MessageDelta.text);
        else pushConv("sys", describeAgentEvent(event));
        if ("Usage" in event) {
          setAgentUsage((current) => ({
            input: current.input + event.Usage.input_tokens,
            output: current.output + event.Usage.output_tokens,
          }));
        }
        if (("Diff" in event || "Artifact" in event) && project && resource) {
          void loadWorkspaceFiles(project, resource);
          pushActivity("EDIÇÃO", "ed", describeAgentEvent(event));
        }
      });
    }, 500);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [agentSession, project, resource, pushConv, pushActivity, loadWorkspaceFiles]);

  // Poll de saúde do preview.
  useEffect(() => {
    if (!preview || preview.health === "stopped") return;
    let live = true;
    const timer = window.setInterval(() => {
      void hostClient.pollBenchmarkPreview().then((result) => {
        if (!live || result.state !== "available" || !result.value) return;
        setPreview((current) => {
          if (current && current.health !== "healthy" && result.value?.health === "healthy") {
            const transition = recordOutcome(
              gameMode,
              {
                id: `preview-healthy:${result.value.projectId}:${result.value.changedAtMs}`,
                category: "feature-validated",
                summary: "Preview ficou saudável após uma mudança.",
                proposedBy: "user:local",
                evidence: [
                  {
                    id: `preview-probe-${result.value.changedAtMs}`,
                    source: "preview-probe",
                    verifiedBy: "host:preview",
                    observedAt: new Date(result.value.changedAtMs).toISOString(),
                    summary: result.value.detail ?? "Loopback probe saudável.",
                  },
                ],
              },
              new Date().toISOString(),
            );
            setGameMode(transition.state);
          }
          return result.value;
        });
      });
    }, 1200);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [preview, gameMode]);

  /* ============================================================
     Derivados para render.
     ============================================================ */
  const currentView: WorkView = active.kind === "view" ? active.view : "build";
  const activeFile =
    active.kind === "file" ? openFiles.find((file) => file.path === active.path) ?? null : null;
  const decisionFile = openFiles.find((file) => file.awaiting) ?? null;
  const dirtyCount = openFiles.filter((file) => file.content !== file.saved).length;
  const modeLabel =
    config?.mode.value === "full_vibes"
      ? "Full vibes"
      : config?.mode.value === "spec"
        ? "Spec"
        : "Hybrid";
  const previewHealthy = preview?.health === "healthy";
  const evidenceCount = (previewFailure ? 1 : 0) + (harness?.failed ?? 0);
  const archetypes = readArchetypes(gameMode);
  const progress = verifiedProgress(gameMode);
  const level = 1 + Math.floor(progress / 3);
  const levelPct = ((progress % 3) / 3) * 100;

  const strip = activity[0];
  const stripText = agentSession
    ? `${agentTarget} · ${conv.at(-1)?.role === "agent" ? "respondendo" : "em sessão"}`
    : strip
      ? `${strip.kind.toLowerCase()} · ${strip.text}`
      : project
        ? "instrumento pronto · sem atividade"
        : "sem projeto aberto";

  /* ============================================================
     Render.
     ============================================================ */
  return (
    <div className="window">
      <IconSheet />

      {/* TITLEBAR */}
      <header className="titlebar">
        <div className="traffic">
          <i />
          <i />
          <i />
        </div>
        <div className="crumb">
          <span className="proj">{project?.title ?? "AI-Native IDE"}</span>
          <span className="sep">·</span>
          <span className="sess">{project ? firstSentence(project.intent) : "instrumento local-first"}</span>
        </div>
        <div className="tb-right">
          <span className="pill">
            <span className={hostAvailable ? "dot" : "dot off"} />
            {modeLabel} · {hostAvailable ? "local" : "web"}
          </span>
          <button
            className="gm-toggle"
            aria-pressed={game}
            onClick={() => setGame((value) => !value)}
            type="button"
          >
            Game mode
            <span className="sw" />
          </button>
        </div>
      </header>

      {/* RAIL */}
      <aside className="rail">
        <div className="logo">/i</div>
        {projects.map((candidate) => {
          const isActive = candidate.id === project?.id;
          return (
            <button
              key={candidate.id}
              className={isActive ? "rail-btn on" : "rail-btn"}
              title={candidate.title}
              onClick={() => void openProject(candidate.id)}
              type="button"
            >
              {initials(candidate.title)}
              {isActive && previewHealthy && <span className="hb ok" />}
              {isActive && agentSession && <span className="hb run" />}
            </button>
          );
        })}
        <button className="rail-btn" title="Novo projeto" onClick={startNewProject} type="button">
          <Icon id="plus" />
        </button>
        <div className="sp" />
        <button className="rail-btn" title="Configurações" type="button">
          <Icon id="gear" />
        </button>
        <div className="avatar">
          MA<span className="lvl-badge">{level}</span>
        </div>
      </aside>

      {/* NAVIGATOR */}
      <nav className="nav">
        <div className="proj-head">
          <div className="name">{project?.title ?? "Sem projeto"}</div>
          <div className="meta">
            {project
              ? `${workspaceFiles.length} recursos · ${previewHealthy ? "preview vivo" : "preview parado"}`
              : "comece pela intenção"}
          </div>
        </div>

        <div className="nav-sec">
          <span className="tag">Produto</span>
          {NAV_ITEMS.map((item) => {
            const count =
              item.view === "resources"
                ? workspaceFiles.length
                : item.view === "build"
                  ? dirtyCount
                  : item.view === "evidence"
                    ? evidenceCount
                    : 0;
            const isOn = active.kind === "view" && active.view === item.view;
            return (
              <button
                key={item.view}
                className={isOn ? "nav-item on" : "nav-item"}
                onClick={() => setActive({ kind: "view", view: item.view })}
                type="button"
              >
                <Icon id={item.icon} />
                {item.label}
                {count > 0 && (
                  <span className={item.view === "evidence" ? "n warn" : "n"}>{count}</span>
                )}
              </button>
            );
          })}
        </div>

        <div className="nav-sec">
          <span className="tag">Recursos ativos</span>
          {resource && (
            <div className="res">
              <b>{resource.canonicalPath.split("/").pop() || resource.canonicalPath}</b>
              <small>
                <span className="st ok" />
                {resource.kind === "repository" ? "repositório" : "diretório"} anexado
              </small>
            </div>
          )}
          {workspaceFiles.slice(0, 6).map((file) => (
            <button
              key={file.relativePath}
              className={
                active.kind === "file" && active.path === file.relativePath ? "res on" : "res"
              }
              onClick={() => void openFile(file.relativePath)}
              type="button"
            >
              <b>{file.relativePath}</b>
              <small>
                <span className="st idle" />
                {file.sizeBytes} bytes
              </small>
            </button>
          ))}
          <div className="res">
            <b>preview local</b>
            <small>
              <span className={`st ${previewHealthy ? "ok" : preview ? "run" : "idle"}`} />
              {preview ? `${preview.url} · ${preview.health}` : "não iniciado"}
            </small>
          </div>
          {!resource && (
            <p className="nav-empty">
              Nenhum diretório anexado. Use “Anexar diretório” em Resources para dar um workspace ao
              agente.
            </p>
          )}
        </div>

        <div className="nav-sec">
          <span className="tag">Sessões</span>
          <button
            className="nav-item"
            onClick={() => setActive({ kind: "view", view: "build" })}
            type="button"
          >
            <Icon id="session" />
            {agentSession ? `${agentTarget} conectado` : "Sessão de build"}
          </button>
          <button className="nav-item" onClick={() => setDrawerOpen(true)} type="button">
            <Icon id="history" />
            Histórico
          </button>
        </div>
      </nav>

      {/* WORK SURFACE */}
      <main className="work">
        <div className="tabs">
          <button
            className={active.kind === "view" && active.view === "home" ? "tab on" : "tab"}
            onClick={() => setActive({ kind: "view", view: "home" })}
            type="button"
          >
            Overview
          </button>
          <button
            className={active.kind === "view" && active.view === "build" ? "tab on" : "tab"}
            onClick={() => setActive({ kind: "view", view: "build" })}
            type="button"
          >
            <span className="mod" />
            Build
          </button>
          {openFiles.map((file) => (
            <button
              key={file.path}
              className={
                active.kind === "file" && active.path === file.path ? "tab file on" : "tab file"
              }
              onClick={() => setActive({ kind: "file", path: file.path })}
              type="button"
            >
              {file.path.split("/").pop()}
              {file.content !== file.saved && <span className="mod" />}
              <span
                className="x"
                role="button"
                aria-label={`Fechar ${file.path}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeFile(file.path);
                }}
              >
                ×
              </span>
            </button>
          ))}
          <button className="tab new" title="Nova aba" onClick={createNewFile} type="button">
            <Icon id="plus" />
          </button>
        </div>

        {/* ---- FILE TAB ---- */}
        {activeFile && (
          <section className="view on editor-pane">
            <div className="editor-host">
              <Editor
                language={editorLanguage(activeFile.path)}
                theme="vs-dark"
                value={activeFile.content}
                onChange={(value) => editActiveFile(activeFile.path, value ?? "")}
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
            <div className="editor-bar">
              <span className="path">{activeFile.path}</span>
              {activeFile.content !== activeFile.saved && <span className="dirty">· não salvo</span>}
              <span className="sp" />
              {activeFile.awaiting ? (
                <button className="btn pri" onClick={() => void approveFile(activeFile)} type="button">
                  Aprovar gravação<span className="kbd">⏎</span>
                </button>
              ) : (
                <button
                  className="btn pri"
                  disabled={!resource || activeFile.content === activeFile.saved}
                  onClick={() => void saveFile(activeFile)}
                  type="button"
                >
                  Salvar
                </button>
              )}
            </div>
          </section>
        )}

        {/* ---- HOME ---- */}
        {!activeFile && currentView === "home" && (
          <section className="view on" id="view-home">
            {!project ? (
              <div className="intent-entry">
                <div className="box">
                  <span className="tag">Intenção</span>
                  <h1>O que você quer colocar no mundo?</h1>
                  <p>
                    Comece pela mudança que você quer causar. A estrutura técnica pode esperar — o
                    instrumento organiza o resto.
                  </p>
                  <textarea
                    className="field"
                    value={intentDraft}
                    onChange={(event) => setIntentDraft(event.target.value)}
                    placeholder="Ex.: quero que aplicações disputem a primeira posição sem ver o lance vencedor…"
                  />
                  <div className="row">
                    <button
                      className="btn pri lg"
                      disabled={!intentDraft.trim()}
                      onClick={() => void createProject()}
                      type="button"
                    >
                      Começar a construir<span className="kbd">⏎</span>
                    </button>
                    <span>
                      {hostAvailable
                        ? "Um projeto semântico será persistido localmente."
                        : "Sem host: abra o app desktop para persistir."}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className="home-main">
                  <div className="h-sec continue">
                    <h1 className="goal">{firstSentence(project.intent) || project.title}</h1>
                    <div className="next">
                      <button
                        className="btn pri lg"
                        onClick={() => setActive({ kind: "view", view: "build" })}
                        type="button"
                      >
                        Retomar a sessão<span className="kbd">⏎</span>
                      </button>
                      <span>próximo: {nextStep}</span>
                    </div>
                  </div>

                  <div className="h-sec">
                    <span className="tag">Agora</span>
                    {activity.length === 0 ? (
                      <div className="calm">
                        Nada em andamento. Descreva uma mudança em Build e o agente começa a trabalhar.
                      </div>
                    ) : (
                      <div className="now-list">
                        {activity.slice(0, 3).map((event) => (
                          <div className="now-row" key={event.id}>
                            <span className={event.klass === "ck" ? "live ok" : "live"} />
                            <span className="who">{event.kind}</span>
                            <span className="what">{event.text}</span>
                            <span className="meta">{event.ts}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {(decisionFile || previewFailure) && (
                    <div className="h-sec">
                      <span className="tag">Precisa de você</span>
                      <div className="need">
                        {decisionFile && (
                          <div className="need-item">
                            <div className="txt">
                              <b>Gravar {decisionFile.path}?</b>
                              <small>
                                O payload exato só é escrito após sua aprovação. Um checkpoint
                                reversível é criado antes.
                              </small>
                            </div>
                            <div className="acts">
                              <button
                                className="btn"
                                onClick={() => setActive({ kind: "file", path: decisionFile.path })}
                                type="button"
                              >
                                Ver o que muda
                              </button>
                              <button
                                className="btn pri"
                                onClick={() => void approveFile(decisionFile)}
                                type="button"
                              >
                                Permitir
                              </button>
                            </div>
                          </div>
                        )}
                        {previewFailure && (
                          <div className="need-item">
                            <div className="txt">
                              <b>{previewFailure.divergence.subject}</b>
                              <small>{previewFailure.failure.message}</small>
                            </div>
                            <div className="acts">
                              <button
                                className="btn"
                                onClick={() => setActive({ kind: "view", view: "evidence" })}
                                type="button"
                              >
                                Entender
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="home-side">
                  <div className="h-sec">
                    <span className="tag">Produto</span>
                    <div className="prod-map">
                      {signals.map((signal: IntentSignal) => (
                        <div className="prod-row" key={signal.id}>
                          <span
                            className={`st ${signal.severity === "important" ? "" : signal.severity === "attention" ? "run" : "ok"}`}
                            style={signal.severity === "important" ? { background: "var(--need)" } : undefined}
                          />
                          <span className="nm">{signal.title}</span>
                          <span className="ds">{signal.kind}</span>
                          <span
                            className={`lb ${signal.severity === "important" ? "warn" : signal.severity === "attention" ? "run" : "ok"}`}
                          >
                            {signal.severity === "important"
                              ? "decidir"
                              : signal.severity === "attention"
                                ? "em aberto"
                                : "ok"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="recent">
                    <span className="tag">Recentes</span>
                    {activity.length === 0 ? (
                      <div className="calm">Sem histórico ainda.</div>
                    ) : (
                      activity.slice(0, 6).map((event) => (
                        <div className="r" key={event.id}>
                          <time>{event.ts}</time>
                          <span>
                            <em>{event.kind}</em> — {event.text}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}
          </section>
        )}

        {/* ---- BUILD ---- */}
        {!activeFile && currentView === "build" && (
          <section className="view on" id="view-build">
            <div className="conv" data-depth={depth}>
              <div className="conv-top">
                <span className="tag">Conversa</span>
                <div className="depth-seg" role="group" aria-label="Profundidade">
                  {(["essential", "detailed", "raw"] as Depth[]).map((value, index) => (
                    <button
                      key={value}
                      className={depth === value ? "on" : ""}
                      onClick={() => setDepth(value)}
                      type="button"
                    >
                      {["A", "B", "C"][index]} ·{" "}
                      {value === "essential" ? "Essencial" : value === "detailed" ? "Detalhado" : "Raw"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="conv-scroll">
                <h2 className="goal">{firstSentence(intent) || "Descreva o que quer construir."}</h2>
                {conv.length === 0 && (
                  <div className="msg agent">
                    <div className="head">
                      <span className="live" />
                      {agentTarget.toUpperCase()} · {resource ? "PRONTO" : "SEM RECURSO"}
                    </div>
                    <div className="body">
                      {resource
                        ? "Peça uma mudança ou pergunte o porquê. A sessão do agente conecta ao enviar."
                        : "Anexe um diretório (aba Resources) para dar contexto ao agente."}
                      {depth !== "essential" && (
                        <div className="steps">
                          <div className="step done">
                            <Icon id="check" />
                            intenção declarada
                          </div>
                          <div className={resource ? "step done" : "step run"}>
                            <Icon id={resource ? "check" : "dot"} />
                            recurso anexado
                          </div>
                          <div className="step">
                            <Icon id="circle" />
                            primeiro efeito verificável
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {conv.map((message) =>
                  message.role === "user" ? (
                    <div className="msg user" key={message.id}>
                      <div className="bubble">{message.text}</div>
                    </div>
                  ) : message.role === "agent" ? (
                    <div className="msg agent" key={message.id}>
                      <div className="head">
                        <span className="live" />
                        {agentTarget.toUpperCase()}
                      </div>
                      <div className="body">{message.text}</div>
                    </div>
                  ) : (
                    <div className="msg sys" key={message.id}>
                      {message.text}
                    </div>
                  ),
                )}
              </div>
              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitComposer();
                }}
              >
                <input
                  value={composer}
                  onChange={(event) => setComposer(event.target.value)}
                  placeholder="Peça uma mudança ou pergunte o porquê…"
                />
                <div className="foot">
                  <span className="hint">
                    <em>⏎</em> envia ao agente
                  </span>
                  <span>
                    {modeLabel} · {resource ? "efeitos locais liberados" : "sem recurso anexado"}
                  </span>
                </div>
              </form>
            </div>

            <div className="preview">
              <div className="pv-bar">
                <button className="i-btn" onClick={() => void startPreview()} type="button" title="Recarregar">
                  <Icon id="refresh" />
                </button>
                <span className="pv-url">{preview?.url ?? "preview não iniciado"}</span>
                <span className={`pv-health ${healthClass(preview?.health ?? null)}`}>
                  {preview ? `● ${preview.health.toUpperCase()}` : previewFailure ? "● BROKEN" : "○ NOT-RUN"}
                </span>
              </div>
              <div className="pv-body">
                {preview ? (
                  <iframe className="pv-frame" src={preview.url} title="Preview do produto" />
                ) : (
                  <div className="pv-empty">
                    <h4>{previewFailure ? "Preview quebrou" : "Sem preview vivo"}</h4>
                    <p>
                      {previewFailure
                        ? previewFailure.failure.message
                        : previewNote ??
                          "Inicie o preview de referência para ver o produto real dentro da IDE."}
                    </p>
                    <button
                      className="btn pri"
                      disabled={!project}
                      onClick={() => void startPreview()}
                      type="button"
                    >
                      Iniciar preview
                    </button>
                  </div>
                )}
              </div>
              {preview && (
                <div className="pv-foot">
                  <span>
                    <b>{preview.health === "healthy" ? "Saudável." : "Instável."}</b>{" "}
                    {preview.detail ?? "Probe de loopback ativo."}
                  </span>
                  <button className="btn" onClick={() => void capturePreviewFailure()} type="button">
                    Verificar falha real
                  </button>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ---- RESOURCES ---- */}
        {!activeFile && currentView === "resources" && (
          <section className="view on panel-view">
            <div className="panel-in">
              <h1>Recursos</h1>
              <p className="lede">
                Diretórios anexados e arquivos do workspace. Clique num arquivo para abri-lo numa aba
                com o editor.
              </p>
              <div className="panel-block">
                <span className="tag">Diretórios anexados</span>
                {resources.length === 0 ? (
                  <div className="row-line">
                    <span className="k">nenhum recurso anexado</span>
                  </div>
                ) : (
                  resources.map((entry) => (
                    <div className="row-line" key={entry.id}>
                      <b>{entry.kind === "repository" ? "repo" : "dir"}</b>
                      <span className="k">{entry.canonicalPath}</span>
                      <span className="sp" />
                      {entry.id === resource?.id ? (
                        <span className="k">ativo</span>
                      ) : (
                        <button className="btn" onClick={() => setResource(entry)} type="button">
                          Selecionar
                        </button>
                      )}
                    </div>
                  ))
                )}
                <div className="inline" style={{ marginTop: 12 }}>
                  <button className="btn pri" disabled={!project} onClick={() => void attachWorkspace()} type="button">
                    Anexar diretório
                  </button>
                </div>
              </div>
              <div className="panel-block">
                <span className="tag">Arquivos ({workspaceFiles.length})</span>
                {workspaceFiles.length === 0 ? (
                  <div className="row-line">
                    <span className="k">anexe um diretório para listar arquivos</span>
                  </div>
                ) : (
                  workspaceFiles.map((file) => (
                    <div className="row-line" key={file.relativePath}>
                      <button className="btn" onClick={() => void openFile(file.relativePath)} type="button">
                        {file.relativePath}
                      </button>
                      <span className="sp" />
                      <span className="k">{file.sizeBytes} bytes</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        )}

        {/* ---- EVIDENCE ---- */}
        {!activeFile && currentView === "evidence" && (
          <section className="view on panel-view">
            <div className="panel-in">
              <h1>Evidência</h1>
              <p className="lede">
                Checks determinísticos e divergências de preview. Nada conta como aprovação sem
                evidência independente.
              </p>
              <div className="panel-block">
                <span className="tag">Harness · camada 0</span>
                {harness ? (
                  <>
                    <div className="row-line">
                      <b>
                        {harness.passed} ok · {harness.failed} falhas · {harness.unknown} unknown
                      </b>
                    </div>
                    {harness.findings.map((finding) => (
                      <div
                        className={`finding-card ${finding.state === "passed" ? "ok" : ""}`}
                        key={finding.id}
                      >
                        <b>{finding.title}</b>
                        <small>
                          {finding.state.toUpperCase()} · {finding.evidence}
                          {finding.remediation ? ` — ${finding.remediation}` : ""}
                        </small>
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="row-line">
                    <span className="k">{harnessNote ?? "checks ainda não rodaram"}</span>
                  </div>
                )}
                <div className="inline" style={{ marginTop: 12 }}>
                  <button
                    className="btn pri"
                    disabled={!project || !resource}
                    onClick={() => void runHarness()}
                    type="button"
                  >
                    Rodar checks determinísticos
                  </button>
                </div>
              </div>
              {previewFailure && (
                <div className="panel-block">
                  <span className="tag">Divergência de preview</span>
                  <div className="finding-card">
                    <b>{previewFailure.divergence.subject}</b>
                    <small>{previewFailure.failure.message}</small>
                  </div>
                  <div className="inline" style={{ marginTop: 10 }}>
                    <button className="btn" onClick={() => void reconcilePreview("change_implementation")} type="button">
                      Mudar implementação
                    </button>
                    <button className="btn" onClick={() => void reconcilePreview("change_intent")} type="button">
                      Mudar intenção
                    </button>
                    <button className="btn" onClick={() => void reconcilePreview("accept_preview_exception")} type="button">
                      Aceitar exceção
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ---- SHIP ---- */}
        {!activeFile && currentView === "ship" && (
          <section className="view on panel-view">
            <div className="panel-in">
              <h1>Ship</h1>
              <p className="lede">
                Exporte ou publique sem lock-in. Republicar preserva o histórico e a proveniência.
              </p>
              <div className="panel-block">
                <span className="tag">Ciclo de vida</span>
                <div className="inline">
                  <button className="btn pri" disabled={!project} onClick={() => void exportProject()} type="button">
                    Exportar
                  </button>
                  <button className="btn" disabled={!project} onClick={() => void publishProject()} type="button">
                    Publicar
                  </button>
                </div>
                {exportManifest && (
                  <div className="finding-card ok" style={{ marginTop: 12 }}>
                    <b>
                      {exportManifest.title} · v{exportManifest.version}
                    </b>
                    <small>{exportManifest.portabilityNote}</small>
                  </div>
                )}
              </div>
              {publications.length > 0 && (
                <div className="panel-block">
                  <span className="tag">Histórico de publicações</span>
                  {publications.map((record) => (
                    <div className="row-line" key={record.version}>
                      <b>v{record.version}</b>
                      <span className="k">{record.problem ?? record.note}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      {/* CONTEXT DOCK */}
      <aside className="dock">
        <span className="tag">Contexto ativo</span>
        <div className="agent-card">
          <div className="agent-top">
            <div className="agent-orb">{agentTarget[0]?.toUpperCase()}</div>
            <div>
              <span className="nm">{agentTarget}</span>
              <small>
                {agentSession
                  ? agentSession.readOnly
                    ? "sessão · somente leitura"
                    : "sessão · escrita externa"
                  : agentCapability
                    ? `CLI · ${agentCapability.health.availability}`
                    : "adapter não sondado"}
              </small>
            </div>
          </div>
          {!agentSession && (
            <div className="agent-targets">
              {AGENT_TARGETS.map((target) => (
                <button
                  key={target}
                  className={agentTarget === target ? "on" : ""}
                  onClick={() => setAgentTarget(target)}
                  type="button"
                >
                  {target}
                </button>
              ))}
            </div>
          )}
          <div className="krow">
            <span>Escopo</span>
            <b>{resource ? "recurso anexado" : "sem recurso"}</b>
          </div>
          <div className="krow">
            <span>Disponibilidade</span>
            <b
              className={
                agentCapability?.health.availability === "Ready"
                  ? "ok"
                  : agentCapability?.health.availability === "Unavailable"
                    ? "bad"
                    : ""
              }
            >
              {agentCapability?.health.availability ?? "desconhecida"}
            </b>
          </div>
          <div className="krow">
            <span>Tokens (sessão)</span>
            <b className="em">
              {agentUsage.input} in · {agentUsage.output} out
            </b>
          </div>
          <div className="meter">
            <i style={{ width: agentSession ? "68%" : "0%" }} />
          </div>
          {!agentSession && (
            <label className="agent-check">
              <input
                type="checkbox"
                checked={allowWrites}
                onChange={(event) => setAllowWrites(event.target.checked)}
              />
              Permitir escrita neste workspace
            </label>
          )}
          <button
            className="btn"
            disabled={
              !project ||
              !resource ||
              (!agentSession && agentCapability?.health.availability === "Unavailable")
            }
            onClick={() => void (agentSession ? disconnectAgent() : ensureAgentSession())}
            type="button"
          >
            {agentSession ? "Encerrar sessão" : `Conectar ${agentTarget}`}
          </button>
          {agentCapability?.health.availability === "Unavailable" && !agentSession && (
            <p style={{ marginTop: 8, fontSize: 11, color: "var(--faint)", lineHeight: 1.5 }}>
              {agentCapability.health.detail ?? "O adapter ACPX não está pronto neste computador."}
            </p>
          )}
        </div>

        {decisionFile ? (
          <div className="decision">
            <div className="st-row">AGUARDANDO VOCÊ</div>
            <h4>Gravar {decisionFile.path}?</h4>
            <p>
              O host escreve o payload exato só depois da sua aprovação. Um checkpoint reversível é
              criado antes — dá para desfazer.
            </p>
            <div className="acts">
              <button
                className="btn"
                onClick={() => setActive({ kind: "file", path: decisionFile.path })}
                type="button"
              >
                Ver o que muda
              </button>
              <button className="btn pri" onClick={() => void approveFile(decisionFile)} type="button">
                Permitir<span className="kbd">⏎</span>
              </button>
            </div>
          </div>
        ) : previewFailure ? (
          <div className="decision">
            <div className="st-row">DIVERGÊNCIA</div>
            <h4>{previewFailure.divergence.subject}</h4>
            <p>{previewFailure.failure.message}</p>
            <div className="acts">
              <button className="btn pri" onClick={() => setActive({ kind: "view", view: "evidence" })} type="button">
                Reconciliar
              </button>
            </div>
          </div>
        ) : (
          <div className="decision resolved">
            <div className="st-row">SEM PENDÊNCIAS</div>
            <h4>Nada aguardando você</h4>
            <p>Cada efeito de escrita aparece aqui antes de tocar o disco.</p>
          </div>
        )}

        <div className="prog">
          <div className="prog-top">
            <div className="prog-lvl">{level}</div>
            <div className="who">
              <b>{archetypes[0]?.archetype ?? "Explorer"}</b>
              <small>nível {level} · leitura descritiva</small>
            </div>
          </div>
          <div className="prog-bar">
            <i style={{ width: `${levelPct}%` }} />
          </div>
          <div className="prog-next">{3 - (progress % 3)} outcomes verificados para o nível {level + 1}</div>
          <div className="prog-earn">
            <span className="tag">Rendeu ({progress})</span>
            {archetypes.length === 0 ? (
              <div className="e">
                <em>0</em>ainda sem outcome verificado
              </div>
            ) : (
              archetypes.map((reading) => (
                <div className="e" key={reading.archetype}>
                  <em>+{reading.outcomeIds.length}</em>
                  {reading.description}
                </div>
              ))
            )}
          </div>
          <div className="prog-never">
            nunca rende: <b>tokens, horas, linhas, prompts</b>
          </div>
        </div>
      </aside>

      {/* TIMELINE DRAWER */}
      <div className={drawerOpen ? "drawer open" : "drawer"}>
        <div className="drawer-in">
          {activity.length === 0 ? (
            <div className="tl-empty">
              Sem eventos ainda. Ações reais (edições, checkpoints, decisões, evidências) aparecem
              aqui em ordem.
            </div>
          ) : (
            activity.map((event) => (
              <div className="tl" key={event.id}>
                <time>{event.ts}</time>
                <span className={`k ${event.klass}`}>{event.kind}</span>
                <span>{event.text}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* PULSE STRIP */}
      <footer
        className="strip"
        title="Clique para abrir a timeline"
        onClick={() => setDrawerOpen((value) => !value)}
      >
        <span className="now">
          <span className="live" />
          <span className="txt">{stripText}</span>
        </span>
        <div className="strand">
          <div className="wire" />
          {activity.slice(0, 5).map((event, index) => (
            <span
              key={event.id}
              className={`notch ${event.klass}`}
              style={{ left: `${12 + index * 13}%` }}
              title={`${event.ts} ${event.kind}`}
            />
          ))}
          <span className="head" />
          <div className="buddy">
            <span className="stage">{agentSession ? "CONSTRUINDO" : "PRONTO"}</span>
            <div className="bod" />
          </div>
        </div>
        <div className="stats">
          <span>{workspaceFiles.length} arquivos</span>
          <span className={previewHealthy ? "ok" : ""}>preview {previewHealthy ? "✓" : "—"}</span>
          <span className={decisionFile ? "warn" : ""}>
            {decisionFile ? "1 decisão" : "0 decisões"}
          </span>
          <span className="lvl-strip">nv {level}</span>
          <span className="open-hint">timeline ▴</span>
        </div>
      </footer>

      {toast && (
        <div className="toast show">
          <span className="st" />
          <span>{toast}</span>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
