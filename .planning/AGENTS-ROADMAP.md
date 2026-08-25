# Roadmap — Modo "Agentes": substrato de times governados (paperclip)

**Data:** 2026-08-25 · **Status:** direção acordada, não iniciado (discussão, sem implementação)

Direção para as funções de agente da IDE. Não é spec de execução — é o mapa de
onde mora, qual é o mecanismo, e em que ordem se constrói.

---

## 1. Enquadramento de IA

Dois eixos:
- **Rail (56px) = inter-projeto** — trocar de projeto, home, loja, identidade.
- **Navigator (240px) = dentro do projeto atual** — padrão-de-IDE E exclusivo, juntos.

Funções exclusivas (SoT, Grafo, **Agentes**) são do projeto → **modos do
navigator**, irmãos de Arquivos/Git/Busca:

```
Arquivos · Busca · Git · Verdade/SoT · Grafo · Agentes · Ferramentas
```

Este doc cobre só **Agentes**.

---

## 2. O que queremos — o mecanismo, não um time pronto

**Não** vamos embutir um harness/time SDLC padrão. Construímos o **mecanismo** e o
usuário (ou um agente) compõe o time. O mecanismo central é o **paperclip**:

> um agente pode **criar outros agentes** e **dividir tasks entre eles**, e todo
> efeito de qualquer um passa pela governança.

Formação de time é **dinâmica** (um agente-líder decompõe e delega), não um roster
fixo. Um manifesto declarativo é opcional — pra semear/persistir um time — mas o
mecanismo permite spawn em runtime.

**Mesmo substrato do Bastion.** O Bastion já tem o SDLC dele (agentes que se
dividem trabalho) sobre `bastion-agent-runtime`/`bastion-core`. O paperclip da IDE
é o **mesmo substrato**, não um paralelo — a IDE expõe/governa localmente o que o
runtime já sabe fazer. Não reimplementar; encaixar.

**Agnóstico.** Formato e mecanismo são **nossos e neutros** — qualquer
modelo/agente/harness via ACP (adapter). **Não** reusamos `.claude/agents` nem
amarramos a Claude/Codex/qualquer vendor. Papel, prompt, tools, permissões e
divisão de tarefa num formato próprio.

---

## 3. Como a indústria resolve (pesquisa 2025-2026) — o que roubamos de padrão

| Framework | O padrão útil | O que falta |
|---|---|---|
| **CrewAI** | manifesto de papéis + processo (sequential/manager) | governança post-hoc; amarrado ao Python |
| **OpenAI Agents SDK** | **gate pré-execução** (`needs_approval` antes do write/shell), handoffs, agents-as-tools | sem config no repo, sem binding de projeto |
| **MetaGPT** | **artefatos tipados** num bus (PRD→design→code), budget `invest($)` | waterfall rígido, YOLO, config só em código |
| **ChatDev** | config declarativa versionada; Human mode + Docker sandbox | waterfall rígido, gate tudo-ou-nada |
| **Claude subagents** | ideia de papéis versionados no repo | vendor-lock Claude, hub-and-spoke, sem peer-chat |
| **AutoGen** | **topologias** (RoundRobin, Selector-manager, Swarm-handoff), spawn dinâmico | zero governança, zero binding |

**Insight que define o moat:** ninguém junta as três metades —
1. formação de time **dinâmica** (paperclip: agente cria agentes),
2. **gate pré-execução** por efeito,
3. **snapshot/rollback + auditoria** por efeito.

O 2 e o 3 já são o `WorkspaceEffectBroker` (M4). Nenhum framework do mercado
governa por-efeito com reversão. Roubamos os *padrões* (spawn dinâmico, handoff,
artefato tipado, gate pré-exec) e construímos em formato **próprio, agnóstico,
governado**.

---

## 4. Design

**Substrato (núcleo):** um agente pode spawnar sub-agentes e repartir tasks; cada
efeito (write/command) vira efeito no broker → Permitir/Reverter + snapshot +
trilha. É o SDLC do Bastion exposto e governado localmente pela IDE. Model/harness-
agnóstico via ACP.

**Formato próprio (agnóstico):** descreve um agente (prompt, tools, model,
permissões) e como um time divide trabalho (decompor → delegar → juntar). Serve
pra semear/persistir; runtime pode spawnar sem manifesto. Nada de `.claude/agents`.

**Orquestração híbrida — LLM-driven E fixa:** quando o time declara um pipeline
fixo, roda fixo (previsível). Quando não, um agente-líder decide em runtime quem
faz o quê e faz handoff (flexível). Os dois coexistem; a escolha é por-time.

**Governança = broker.** Todo efeito de todo agente atravessa o gate. Mais o
YOLO-explícito-com-histórico e policy-por-permissão que já existem (`b5b810e`,
`b3fd360`).

**Superfície (modo Agentes):** mostra o time vivo — agentes ativos, quem spawnou
quem, como dividiram, o que cada um propôs pro teu Permitir. Sessões vêm do
`AcpxAgentFacade` (múltiplas concorrentes + swap/resume/adopt + usage). Handoffs e
efeitos na timeline.

**Base já pronta:** `AcpxAgentFacade` (multi-sessão, swap/resume/adopt), broker
(M4), probe honesto (M5). Falta o spawn/decompose (paperclip) e a superfície.

---

## 5. Fronteira Katsui — capacidades DIFERENTES, não "isto pra org"

Katsui **não** é a versão-org deste mecanismo. É um produto de fronteira com
capacidades próprias e diferentes — não um wrapper de tenancy do time da IDE.
Nunca desenhar como "o time governado, mas pra organização".

O que a IDE faz é camada-local, no seu próprio direito: um substrato de agentes que
se dividem trabalho, governado por efeito, para **um projeto**. O que Katsui faz é
outro tipo de capacidade (não "o mesmo, compartilhado entre pessoas") — a definir
por capacidade específica, não por escopo. Inferência paga roteia pra Katsui como
upsell; a IDE nunca dá Iai Gate de graça. (Constraint cross-cutting — ver memória
`katsui-distinct-frontier-not-org-scope`.)

---

## 6. Roadmap em fases

Continua a numeração do pivô Theia (M4 broker, M5 probe, M6 git feitos).

| Fase | Entrega | Depende | Prova |
|---|---|---|---|
| **A1 — Sessão viva** | Modo Agentes; probe (M5) vira sessão real: `start_session` de 1 agente, status/usage/eventos ao vivo, cancelar. | M5 | agente roda de verdade |
| **A2 — Efeitos governados** | Write/command do agente atravessa o broker → Permitir/Reverter. Deixa de ser YOLO. | A1 + M4 | agente escreve só após Permitir; rollback restaura |
| **A3 — Formato próprio agnóstico** | Manifesto nosso (agente + divisão de trabalho), neutro via ACP. Modo Agentes carrega o time do formato. Sem spawn ainda. | A1 | editar o manifesto muda o time |
| **A4 — Paperclip (spawn + divisão)** | Um agente cria sub-agentes e reparte tasks; mesmo substrato do SDLC do Bastion. Árvore de spawn + divisão no painel. | A2 + A3 | um agente decompõe e delega, tudo governado |
| **A5 — Orquestração híbrida** | Pipeline fixo E líder-LLM em runtime; handoff-graph, paralelo, swap/resume. | A4 | time roda fixo OU decidido em runtime, contexto preservado no swap |
| **A6 — Budget + policy por time** | Cap local por projeto + YOLO-com-histórico e policy por permissão por papel. | A5 | time para no cap; policy por papel respeitada |

**Valor:** A1→A2 já entregam o diferencial (agente governado real). A4 (paperclip)
é o núcleo do mecanismo. Dá pra parar em A2 e já ter algo único.

---

## 7. Perguntas abertas (decidir antes de A3/A4)

1. **Formato do manifesto** — que campos, que sintaxe (nosso, agnóstico). Como
   descreve "divisão de trabalho" sem virar waterfall rígido.
2. **Limite do spawn** — quão fundo o paperclip pode ir (profundidade, nº de
   agentes) e como o broker/budget contém isso.
3. **Reuso do substrato Bastion** — quanto do spawn/divisão já vem do
   `bastion-agent-runtime` vs o que a IDE adiciona por cima.
