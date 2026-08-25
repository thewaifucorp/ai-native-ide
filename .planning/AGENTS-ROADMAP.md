# Roadmap — Modo "Agentes": time SDLC governado por projeto

**Data:** 2026-08-25 · **Status:** direção acordada, não iniciado (discussão, sem implementação)

Documento de direção para as funções exclusivas de agente da IDE. Não é spec de
execução — é o mapa que responde "onde isso mora, como é configurado, e em que
ordem construímos".

---

## 1. Enquadramento de IA (information architecture)

Dois eixos de navegação, corrigidos após discussão:

- **Rail (56px) = inter-projeto** — trocar de projeto, home, loja, identidade.
  Coisas ACIMA do projeto atual.
- **Navigator (240px) = dentro do projeto atual** — tudo que é do projeto,
  padrão-de-IDE E exclusivo nosso, lado a lado.

As funções exclusivas (SoT, Grafo, **Agentes**) são **do projeto** → viram
**modos do navigator**, irmãos de Arquivos/Git/Busca — não um cluster separado no
rail. A nav-modes passa a ser:

```
Arquivos · Busca · Git · Verdade/SoT · Grafo · Agentes · Ferramentas
```

Este documento cobre só **Agentes**. SoT e Grafo terão os seus.

---

## 2. O que queremos

Um **time de subagentes / SDLC configurável, versionado no repo, que cuida de um
único projeto** — e cujos efeitos passam **todos pela governança** (aprovar antes
de agir, snapshot reversível, auditoria). O modo Agentes mostra o time vivo: quem
roda, o que cada um propôs, o teu "Permitir".

---

## 3. Como a indústria resolve (pesquisa, 2025-2026)

| Framework | Config do time | Orquestração | Governança de efeito |
|---|---|---|---|
| **CrewAI** | YAML no repo (`agents.yaml`/`tasks.yaml`), role/goal/tools | sequential ou hierarchical (manager delega) | **post-hoc** (guardrail valida a saída, não o ato) |
| **OpenAI Agents SDK** | código Python, sem convenção de arquivo | handoffs (grafo) + agents-as-tools (manager) | **pré-execução real** (`needs_approval` pausa antes do write/shell; ApplyPatch/Shell tools) |
| **MetaGPT** | Python (subclassar Role/Action) | SOP waterfall em message-bus, artefatos tipados (PRD→design→code) | YOLO; só `invest($)` como kill-switch |
| **ChatDev** | **JSON no repo** (ChatChain/Phase/Role) | ChatChain (pipeline de fases) | Human mode + Docker sandbox; tudo-ou-nada |
| **Claude Code subagents** | **Markdown no repo** (`.claude/agents/*.md`), git-versionado, dual-scope | hub-and-spoke (main delega por `description`) | allowlist de tools + `permissionMode` por agente |
| **AutoGen** | Python (serializa pra JSON) | RoundRobin / Selector-manager / Swarm-handoff | nenhuma — você escreve |

### Insight que define nosso moat

Ninguém junta as duas metades:
- **Time declarativo no repo** → CrewAI, ChatDev, Claude subagents têm.
- **Gate de aprovação pré-execução** → só Agents SDK tem (mas sem config no repo).
- **Governança por-efeito com snapshot/rollback + auditoria** → **ninguém tem.**

Nós já temos a peça que falta em todos: o `WorkspaceEffectBroker` (M4) —
capability + approval gate + snapshot + audit. Um time SDLC onde **cada efeito de
cada agente atravessa o broker** é algo que CrewAI/MetaGPT/ChatDev não fazem (rodam
YOLO). Esse é o diferencial, não o "ter agentes".

---

## 4. Design escolhido

**Formato de config (declarativo, no repo):**
- **Papéis** = arquivos `.claude/agents/*.md` (frontmatter `name`/`description`/
  `tools`/`model`/`permissionMode` + corpo = system prompt). Motivo: já é git-
  versionado, dual-scope (projeto vs user, precedência projeto > user), e é o
  formato que o ecossistema do Mario já usa. Zero formato novo pra papel.
- **Time / processo** = um arquivo novo `.instrument/team.yaml` que referencia os
  papéis e declara o SDLC: quais entram, ordem/handoffs, artefatos esperados
  (emprestado de CrewAI role/goal + MetaGPT artefato-tipado).

**Orquestração:** começar **sequential + conductor** (um maestro delega
role→role: architect→coder→reviewer→tester), como CrewAI-hierarchical /
AutoGen-Selector. Grafo de handoff (Swarm) e paralelo vêm depois.

**Governança = nosso broker.** Todo write/command que um agente propõe vira um
efeito no `WorkspaceEffectBroker` → Permitir/Reverter, com snapshot e trilha. Mais
o YOLO-explícito-com-histórico e policy-por-permissão que já existem no repo
(commits `b5b810e`, `b3fd360`).

**Superfície (modo Agentes):** o folder de papéis mapeia 1:1 em cards (nome,
model, tools, status). Sessões vivas vêm do `AcpxAgentFacade` (já suporta
múltiplas sessões concorrentes + swap/resume/adopt + usage). Cada proposta de
agente aparece como decisão governada no dock; handoffs na timeline.

**O que já temos pronto pra isso (base real):**
- `AcpxAgentFacade`: `start_session`, `capture_state`, `resume`, `adopt_state`
  (swap com `SwapReport` honesto), usage por sessão, `supports_concurrent_sessions`.
- `WorkspaceEffectBroker` (M4): o gate pré-execução + snapshot + auditoria.
- Probe honesto (M5): descriptor + health por agente, já no dock.

---

## 5. Fronteira Katsui (intacta)

Isto é **camada-IDE**: execução governada por projeto, local. **Não** é o rail de
inferência pago, **não** são os registries organizacionais nem a medição de custo
central por owner — isso é fronteira Katsui / Iai Gate. Budget aqui (fase A6) é
**limite local por projeto**, não a cobrança org. Inferência paga roteia pra
Katsui como upsell. A IDE nunca dá Iai Gate de graça.

---

## 6. Roadmap em fases

Continua a numeração dos milestones do pivô Theia (M4 broker, M5 probe, M6 git
feitos). O track Agentes:

| Fase | Entrega | Depende de | Prova |
|---|---|---|---|
| **A1 — Sessão viva (single)** | Modo Agentes no navigator; o probe (M5) vira sessão real: `start_session` de 1 agente, status/usage/eventos ao vivo, cancelar. | M5 | agente roda de verdade, não só probe |
| **A2 — Efeitos governados** | O write/command que o agente propõe atravessa o broker (M4) → Permitir/Reverter. Efeito de agente deixa de ser YOLO. | A1 + M4 | agente escreve arquivo real só após teu Permitir; rollback restaura |
| **A3 — Manifesto do time** | Papéis em `.claude/agents/*.md` + `.instrument/team.yaml` (processo). Modo Agentes lista o time do config. Sem orquestração ainda. | A1 | editar o YAML muda o time no painel |
| **A4 — Orquestração (conductor)** | Processo sequential: maestro delega architect→coder→reviewer→tester, artefatos tipados, cada efeito governado (A2). Handoffs no painel + timeline. | A2 + A3 | um pedido roda o pipeline inteiro, tudo aprovado |
| **A5 — Time paralelo + handoff** | Sessões concorrentes, handoff-graph (Swarm), swap/resume (`adopt_state`). Vários agentes vivos, cada um governado. | A4 | 2+ agentes ao vivo, contexto preservado no swap |
| **A6 — Budget + policy por time** | Cap de budget local por projeto (estilo `invest($)`) + YOLO-com-histórico e policy por permissão por papel. Telemetria de uso (display/limite local). | A5 | time para no cap; policy por papel respeitada |

**Ordem de valor:** A1→A2 já entregam o diferencial central (agente governado
rodando de verdade). A3+ é escala (time, orquestração). Dá pra parar em A2 e já
ter algo que ninguém tem.

---

## 7. Perguntas abertas (decidir antes de A3/A4)

1. **Reusar `.claude/agents/` ou namespace próprio** (`.instrument/agents/`)?
   Reusar dá compat com o ecossistema Claude Code; próprio evita acoplamento.
2. **Orquestração declarada (YAML fixo) vs LLM-driven** (maestro decide em runtime,
   estilo Selector/handoff). Fixo = previsível; LLM-driven = flexível.
3. **"Paperclip"**: o time é um preset que o usuário monta na UI, ou só editando
   arquivos? (UI-de-montar-time é produto maior, fase pós-A6.)
