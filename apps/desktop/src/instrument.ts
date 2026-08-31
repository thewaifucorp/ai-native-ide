export type BuildMode = "full-vibes" | "hybrid" | "spec";
export type Depth = "essential" | "raw";
export type SignalKind = "ambiguity" | "decision" | "risk" | "concept";

export interface IntentSignal {
  id: string;
  kind: SignalKind;
  title: string;
  detail: string;
  prompt: string;
  severity: "info" | "attention" | "important";
}

export interface ActivityItem {
  id: string;
  label: string;
  detail: string;
  state: "observed" | "current" | "unknown";
}

const baselineSignals: IntentSignal[] = [
  {
    id: "audience",
    kind: "ambiguity",
    title: "Quem usa primeiro?",
    detail: "Definir o primeiro usuário deixa o fluxo e a linguagem mais concretos.",
    prompt: "O primeiro usuário é…",
    severity: "attention",
  },
  {
    id: "success",
    kind: "decision",
    title: "Como sabemos que funcionou?",
    detail: "Escolha um resultado observável antes de pedir uma implementação.",
    prompt: "Vai estar pronto quando…",
    severity: "important",
  },
  {
    id: "data",
    kind: "risk",
    title: "Há dados de clientes ou pagamentos?",
    detail: "Isso muda os cuidados com privacidade, acesso e validação.",
    prompt: "O produto vai guardar…",
    severity: "important",
  },
];

const topicSignals: Array<{ terms: string[]; signal: IntentSignal }> = [
  {
    terms: ["loja", "vender", "checkout", "pedido"],
    signal: {
      id: "commerce",
      kind: "concept",
      title: "Jornada de compra",
      detail: "Vale separar catálogo, pedido e confirmação antes de conectar pagamentos.",
      prompt: "O cliente compra assim…",
      severity: "info",
    },
  },
  {
    terms: ["leilão", "leilao", "lance", "leaderboard"],
    signal: {
      id: "concurrency",
      kind: "risk",
      title: "Lances concorrentes",
      detail: "Duas pessoas podem agir ao mesmo tempo. Precisamos declarar desempate e estado final.",
      prompt: "Quando dois lances chegam juntos…",
      severity: "important",
    },
  },
  {
    terms: ["chatbot", "agente", "vendedor"],
    signal: {
      id: "agent-boundary",
      kind: "decision",
      title: "O que o agente pode fazer?",
      detail: "Defina quais ações ele só sugere e quais pode executar com aprovação.",
      prompt: "O agente pode…",
      severity: "attention",
    },
  },
];

export function analyzeIntent(intent: string): IntentSignal[] {
  const normalized = intent.trim().toLocaleLowerCase("pt-BR");
  if (!normalized) return baselineSignals.slice(0, 2);

  const matches = topicSignals
    .filter(({ terms }) => terms.some((term) => normalized.includes(term)))
    .map(({ signal }) => signal);
  const signals = [...matches, ...baselineSignals.filter((signal) => signal.id !== "audience")];

  return signals.slice(0, 4);
}

export function nextStepFor(intent: string, signals: IntentSignal[]): string {
  if (!intent.trim()) return "Descreva o resultado que você quer colocar no mundo.";
  const decision = signals.find((signal) => signal.kind === "decision" || signal.kind === "ambiguity");
  return decision ? `Resolver: ${decision.title}` : "Transformar a intenção em um primeiro checkpoint.";
}

export const initialActivity: ActivityItem[] = [
  { id: "intent", label: "Intenção", detail: "Ainda não declarada", state: "current" },
  { id: "guide", label: "Orientação", detail: "Aguardando uma decisão", state: "unknown" },
  { id: "build", label: "Construção", detail: "Nenhum efeito proposto", state: "unknown" },
  { id: "preview", label: "Preview", detail: "Placeholder local", state: "unknown" },
];
