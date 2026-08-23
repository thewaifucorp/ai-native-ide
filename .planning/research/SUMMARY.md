# Project Research Summary

**Project:** AI-Native IDE
**Domain:** IDE desktop local-first para criação e operação de software orientadas por intenção
**Researched:** 2026-08-22
**Confidence:** MEDIUM

## Executive Summary

Este produto não deve ser construído como chat acoplado a um editor nem como outro gerador de aplicações. A categoria proposta é uma IDE em que projeto, intenção, especificação, implementação e evidência são objetos duráveis, enquanto conversas são apenas sessões temporais. A oportunidade distributiva está em oferecer gratuitamente uma superfície generalista na qual pessoas não técnicas consigam criar e continuar operando software real, sem retirar de pessoas técnicas arquivos, Git, terminal, modelos ou agentes de sua escolha. O diferencial defendível não é geração de código: é o ciclo `intenção guiada → construção observável → evidência → reconciliação`, acumulado em formatos abertos e num ecossistema de harnesses e guias.

A abordagem recomendada é um monólito modular local-first com processos isolados: shell desktop fino, core/daemon independente, projeto semântico acima de repositórios, SQLite mais artefatos editáveis/versionáveis, e adaptadores de capacidade para agentes. ACP, MCP, LSP e PTY ocupam fronteiras diferentes; nenhum deles deve contaminar o modelo de domínio. Um primeiro slice deve provar um produto pequeno por inteiro — por exemplo marketplace, ferramenta interna ou microsaaS — com editor real, preview, um agente nativo e um ACP, intenção estruturada, reconciliação fina e evidência verificável. Paridade ampla com VS Code, marketplace e infraestrutura Katsui ficam depois da validação dessa nova primitiva.

Os riscos centrais são criar uma terceira verdade semântica opaca, vender hipóteses de IA como verificação, prometer controle sobre agentes apenas observáveis, queimar tokens com análise constante e construir uma plataforma de editor antes de provar o produto. A mitigação é provenance em todo estado inferido, separação de fatos determinísticos e julgamentos de modelo, enforcement no effect broker/sandbox em vez do prompt, avaliação com corpus rotulado e instrumentação do funil de distribuição. A pesquisa não escolhe silenciosamente o harness default: essa decisão afeta o domínio, a UX e as garantias do produto e exige discussão fundadora antes de finalizar requisitos e roadmap.

## Key Findings

### Recommended Stack

O stack recomendado é Rust + Tauri 2 + React/TypeScript + Monaco, com SQLite e arquivos normais como planos complementares de persistência. O core precisa ser testável fora da UI e evoluir para um daemon supervisionado antes de sessões longas/background e crash recovery. As versões pesquisadas são snapshots, não faixas automáticas; Tauri/WebView, sandbox cross-platform e ABI de plugins ainda exigem spikes.

**Core technologies:**

- **Rust 1.97.1 + Tokio 1.53.1:** domínio, runtime local, supervisão de processos, protocolos e policy/effect broker.
- **Tauri 2.11.5:** shell e distribuição desktop com IPC estreito; precisa ser comparado com Electron num slice real.
- **React 19.2.8 + TypeScript 7.0.2 + Vite 8.2.2:** workbench de profundidade progressiva e contratos de eventos tipados.
- **Monaco 0.56.0 + LSP 3.18 + Tree-sitter 0.26.12:** edição real, inteligência de linguagem e indexação estrutural. Monaco não equivale a um extension host do VS Code.
- **SQLite/rusqlite:** grafo relacional local, ledger, projeções e FTS; arquivos Markdown/manifests continuam portáteis e humanos.
- **ACP / MCP / PTY / APIs:** ACP para agentes completos, MCP para ferramentas/contexto, PTY para terminal e fallback, APIs para inferência nativa; tudo atrás de contratos internos.
- **Harness packs declarativos primeiro; WASI/Wasmtime depois:** evita dar execução nativa a extensões antes de existir uma fronteira comprovada.

### Expected Features

**Must have (table stakes):**

- Arquivos e Markdown realmente editáveis, busca, Git/diff, terminal, tarefas, logs e preview.
- Loop de agente visível com plano, ações, alterações, testes, resultado, cancelamento e recuperação.
- Full Vibes, Spec e Hybrid sobre o mesmo estado de projeto.
- Conhecimento/instruções persistentes, editáveis, escopados e com provenance.
- Modelos, BYOK/local, agentes externos/CLIs e MCP com capacidades e caminhos de dados expostos honestamente.
- Permissões configuráveis e segredos tratados fora de prompts.
- Onboarding acessível e profundidade progressiva, sem criar um produto amputado para não técnicos.

**Should have (category-defining):**

- Autocomplete de intenção que revela ambiguidades, decisões e riscos, não apenas completa prosa.
- Projeto semântico multi-recurso acima de pastas, repositórios e chats.
- Estado dual intenção/spec ↔ implementação com divergência explícita e reconciliação bidirecional.
- Harness semântico orientado ao produto, com evidência, confiança, severidade, remediação e exceções.
- Continuidade entre sessões e agentes sem fazer do chat a fonte da verdade.
- Conclusão apoiada em evidências e, no futuro, reconciliação com produção.
- Contrato aberto para harnesses/guias e rail ShinAI/Katsui estritamente opcional.

**Defer (v1.x/v2+):**

- Voz, visual editing, agentes paralelos/background e muitos adapters até o loop-base ser confiável.
- Operação completa de produção, cloud sandboxes, colaboração multiplayer e orquestração de portfólio.
- Marketplace assinado de harnesses/agentes, publicidade patrocinada e rail de inferência/capacidade.
- Compatibilidade com extensões VS Code, banco vetorial ou grafo especializado sem demanda comprovada.

### Architecture Approach

O desenho deve separar a camada de experiência, host privilegiado, control plane semântico, integração de agentes e recursos/runtime. Projeto, recurso, artefato, sessão, intenção e evidência recebem identidades estáveis; caminhos e chats não são identidade. Há duas verdades revisáveis — intenção declarada e comportamento executável — enquanto ledger e evidência explicam a relação, sem virar uma terceira autoridade. O sistema normaliza apenas o que observa, negocia capacidades de agentes e coloca garantias reais no broker/sandbox.

**Major components:**

1. **Project/resource/artifact services** — projetos semânticos, recursos compartilháveis e documentos editáveis/versionados.
2. **Session service + activity ledger** — episódios de trabalho, escopo, handoff, custos e eventos auditáveis, sem possuir os artefatos.
3. **Capability registry + agent adapters** — ACP, CLI, PTY, API e local com degradação explícita.
4. **Context assembler + policy/effect/secret brokers** — disclosure, provenance, permissão e execução controlada.
5. **Intent graph + evidence index + reconciler** — intenção tipada, âncoras resilientes, divergências e reconciliação proposta.
6. **Harness pipeline + guide engine** — checks antes/depois do agente e efeitos; fatos, hipóteses e políticas permanecem distintos.
7. **Editor/runtime bridge** — Monaco/LSP, filesystem, Git, PTY, preview e observação de runtime.

### Default Harness: Decision Gate Before Requirements

A pesquisa sustenta a arquitetura do harness, mas não autoriza escolher seu comportamento default sem o fundador. O pipeline viável possui estágios: escopo/provenance; preflight semântico; inspeção de plano; admissão de efeitos; observação; avaliação de resultado; reconciliação. Os modos podem alterar ordem e limiar de interrupção, mas não devem apagar evidência nem mudar a verdade do projeto.

**Hard constraints supported by research:**

- Ser provider/model-agnostic; o core não depende de um juiz/modelo único.
- Separar fatos determinísticos (build, LSP, testes, policies, diff, browser/runtime) de hipóteses probabilísticas.
- Toda finding carrega origem, escopo, evidência, confiança, severidade, remediação e estado de revisão/exceção.
- O modelo pode propor classificação; não pode escolher enforcement. `Inform`, `suggest`, `warn`, `require-confirmation` e `block-by-policy` pertencem à política.
- ACP não é sandbox. Efeitos nativos de agentes opacos podem ser observados depois, mas só são interceptáveis antes quando passam por ferramentas da IDE ou runtime isolado.
- Nenhum `unknown` pode aparecer como `passed`; não prometer ausência de falhas com base em revisão de IA.
- Análise deve ser incremental, cacheada, atribuível e sujeita a budgets; jamais trabalho de inferência billable durante idle sem escolha clara.
- O harness não reescreve intenção ou código silenciosamente e não vira um segundo agente autônomo opaco.

**Viable alternatives/design axes requiring founder discussion:**

1. **Composição default:** somente invariantes universais e determinísticas; camada semântica geral sempre ativa; ou pack inicial por tipo de produto detectado/escolhido.
2. **Ativação:** continuamente incremental; apenas em checkpoints/antes de deploy; sob demanda; ou combinação diferente por classe de evaluator.
3. **Comportamento por modo:** quanto Full Vibes pode prosseguir com avisos; quais decisões Spec Mode deve resolver antes; quando Hybrid promove protótipo descartável a estado durável.
4. **Enforcement:** quais classes apenas informam, quais pedem confirmação e quais podem bloquear por policy mesmo em YOLO; quais garantias são universais versus configuráveis.
5. **Contrato de evidência:** quais provas bastam para `verified`, como representar `assumed`, `unknown`, divergência aceita e exceção com prazo/escopo.
6. **Autoridade da IA:** IA apenas levanta hipóteses; IA pode gerar testes/evidências; ou IA também recomenda enforcement, sempre sujeito a política não-modelo.
7. **Escolha de domínio inicial:** marketplace/microsaaS, ferramenta interna, loja ou chatbot; o primeiro corpus e as invariantes do starter harness dependem disso.
8. **Economia e frequência:** quem paga inferência nativa do harness, quais features funcionam sem inferência paga e como provar que incentivos de monetização não criam warnings artificiais.

**Required outcome of discussion:** um `HARNESS-SPEC` curto com taxonomia de evaluator, schema de finding/evidence, matriz modo × interrupção × enforcement, guarantees/degradations por classe de adapter e benchmark inicial. Requisitos e roadmap podem ser esboçados antes, mas não devem ser congelados sem isso.

### Critical Pitfalls

1. **Confundir observabilidade com controle** — declarar capacidades por adapter e executar efeitos garantidos por broker/sandbox; deixar degradação visível.
2. **Criar terceira verdade opaca** — tratar estado inferido como candidato com provenance/confiança; intenção humana e comportamento executável continuam revisáveis.
3. **Harness fabricar confiança** — combinar oráculos determinísticos e hipóteses; medir precision/recall num corpus defeituoso e nunca mapear desconhecido para aprovado.
4. **Chat continuar sendo o banco** — sessões precisam poder desaparecer sem orfanar projeto, decisões ou arquivos; handoff funciona por snapshot tipado, não transcript inteiro.
5. **Contexto vazar ou ser envenenado** — provenance, separação instrução/dado, scopes explícitos e gate para escrita de memória.
6. **Análise semântica queima tokens e atenção** — invalidação incremental, deduplicação, budgets e scans profundos em checkpoints.
7. **Construir VS Code antes da nova primitiva** — validar cedo `intenção → evidência → reconciliação` numa fixture limitada.
8. **Distribuição gratuita sem loop/economia** — medir instalação → artefato útil → deploy → evolução 30/90 dias e segmentar API, BYOK, assinatura externa, local e sponsored.

## Implications for Roadmap

O roadmap abaixo é uma recomendação estrutural, condicionada ao gate de discussão do harness. Ele mantém a tese de categoria/distribuição no centro e evita transformar os spikes numa longa fase de infraestrutura sem experiência testável.

### Gate 0: Founder Harness Design

**Rationale:** O default define estado, eventos, evidência, permissões, custo e comportamento dos três modos; escolhê-lo depois criaria retrabalho estrutural.
**Delivers:** `HARNESS-SPEC` com alternativas decididas, invariantes, matriz de modos/enforcement e benchmark inicial.
**Addresses:** product-aware harness, semantic completion, modes, model neutrality.
**Avoids:** juiz monolítico de IA, warning firehose, token-burning e falsas garantias.

### Phase 1: Category Experience + Architecture Spikes

**Rationale:** Provar simultaneamente o loop diferenciador e os maiores unknowns técnicos antes de comprometer o shell.
**Delivers:** protótipo de `intenção → construção → evidência → reconciliação` numa aplicação fixture; comparação Tauri/Electron; ACP + CLI; mini projeto multi-repo; isolamento básico.
**Addresses:** intent autocomplete, três modos, agente externo, acesso progressivo a arquivos/preview.
**Avoids:** construir plataforma de editor ou escolher ACP/Tauri/sandbox por documentação apenas.

### Phase 2: Durable Semantic Project Substrate

**Rationale:** Toda superfície posterior depende de identidade estável; implementar chat primeiro recriaria o erro do Antigravity.
**Delivers:** projetos, recursos multi-repo, manifests/artefatos editáveis, SQLite, sessões, scopes, ledger seletivo, file watching e Git observations.
**Addresses:** project-first, shared resources, editable truth, cross-session continuity.
**Avoids:** path como identidade, conversation database, event sourcing universal e vazamento entre projetos.

### Phase 3: Controlled Agent Build Loop

**Rationale:** O sistema precisa produzir software real e observável antes de sofisticar semântica.
**Delivers:** capability contract, fake-agent conformance, um agente de referência, um ACP, context assembler, effect/policy broker, diff/review, terminal, preview, checkpoints e um caminho de deploy/export.
**Addresses:** model/agent neutrality, transparent execution, recovery e app lifecycle.
**Avoids:** universal chat API, ACP como sandbox, permissão universal e preview confundido com produto operável.

### Phase 4: Intent, Guidance and Reconciliation Thin Slice

**Rationale:** Com edições e efeitos observáveis, intenção pode ser ligada a evidência real em vez de guesses.
**Delivers:** schema mínimo de intent nodes, editor/canvas, autocomplete, links revisados, detecção de divergência por alteração direta e reconciliação nos dois sentidos.
**Addresses:** core moat de estado dual e prompting guiado.
**Avoids:** grafo de código como grafo de intenção, docs append-only e auto-rewrite silencioso.

### Phase 5: Evidence-Based Harness v0 + Three Modes

**Rationale:** Implementar o `HARNESS-SPEC` somente quando domínio, efeitos e evidências existem; medir antes de expandir packs.
**Delivers:** pipeline H0–H6, findings/policy contracts, checks determinísticos, um evaluator semântico, corpus rotulado, telemetria de custo/qualidade e UX Full Vibes/Spec/Hybrid sobre o mesmo backend.
**Addresses:** semantic harness, contextual guide, evidence-backed completion e progressive depth.
**Avoids:** AI-only review, perguntas excessivas, ruído, custo invisível e falsa equivalência entre modos.

### Phase 6: First Usable Distribution Slice

**Rationale:** A tese econômica depende de uso continuado, não de uma demo; o produto precisa atravessar criar, publicar, observar, mudar e recuperar.
**Delivers:** uma jornada refinada para o domínio benchmark, onboarding não técnico, preview/deploy portável, readiness view, instrumentação do funil e teste com builders reais.
**Addresses:** first useful artifact, ownership, maintenance e distribuição gratuita.
**Avoids:** otimizar installs/demos sem retenção, stack proprietária permanente e monetização contaminando recomendações.

### Phase 7: Ecosystem and Optional Rails

**Rationale:** Marketplace, mais adapters e monetização precisam de demanda recorrente e contratos estáveis.
**Delivers:** harness/guide SDK e signing, adapters adicionais, packs guiados por uso, fronteira open-core, experimentos opcionais Katsui/inference/sponsorship e depois recursos de produção.
**Addresses:** moat de ecossistema, receita sem assinatura obrigatória e operação contínua.
**Avoids:** marketplace inseguro, lock-in ShinAI, publicidade opaca e token asset sem viabilidade contratual/regulatória.

### Phase Ordering Rationale

- Harness design é um gate conceitual; harness implementation depende do substrate, efeitos e evidência.
- Projeto/recurso vem antes de chat e agentes para impedir que working directory/session IDs definam a arquitetura.
- Um loop real de construção vem antes da automação semântica para que findings tenham observações reproduzíveis.
- Intent schema vem antes de autocomplete/reconciliação; reconciliation vem antes de marketplace de harnesses.
- Distribuição é validada no primeiro slice utilizável; rails e marketplace expandem um loop comprovado, não o substituem.

### Research Flags

Phases likely needing deeper research during planning:

- **Gate 0:** pesquisa de produto/eval para encontrar a matriz de harness adequada aos três modos.
- **Phase 1:** Tauri vs Electron, ACP/ACPX real, sandbox cross-platform e protótipo de reconciliação.
- **Phase 3:** guarantees de efeitos por adapter, autenticação/subscriptions e isolation específico de OS.
- **Phase 5:** corpus, métricas de precision/recall, incremental analysis e UX de interrupção.
- **Phase 7:** licença/open core, marketplace security, provider agreements, settlement, unidade econômica e regulação.

Phases with more standard patterns (research can be narrower):

- **Phase 2:** SQLite, CRUD versionado, file watching e Git são bem documentados; o modelo semântico ainda requer testes de invariantes.
- **Parte da Phase 3:** Monaco/LSP/PTY e diff/review têm padrões maduros, embora a fronteira privilegiada seja específica.
- **Phase 6:** onboarding e telemetria de funil usam padrões conhecidos; os benchmarks do produto são novos.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM | Tecnologias e versões foram verificadas; shell, WebViews, sandbox e plugin ABI precisam de execução real nos três OSes. |
| Features | MEDIUM-HIGH | Table stakes e concorrentes estão bem documentados; diferenciação e prioridade são hipóteses até testes com builders. |
| Architecture | MEDIUM | Limites ACP/MCP, local-first e provenance são fortes; schema de intenção, reconciliação e guarantees ainda são novos. |
| Pitfalls | MEDIUM-HIGH | Security/protocol/editor risks têm fontes primárias e precedentes; riscos de categoria/economia exigem dados próprios. |

**Overall confidence:** MEDIUM

### Gaps to Address

- **Harness default:** realizar discussão fundadora e produzir `HARNESS-SPEC` antes do freeze de requisitos/roadmap.
- **Benchmark inicial:** escolher a primeira classe de aplicação e construir corpus de sucesso/falhas intencionais.
- **Reconciliation quality:** não existe benchmark industrial; criar ground truth revisado por humanos e testar rename/refactor/external edit/exceção.
- **ACP/ACPX reality:** validar Codex, Claude e Gemini, incluindo auth, resume, cancelamento, edits e permissões; documentar o que é apenas observável.
- **Desktop/runtime:** comparar Tauri/Electron e provar isolamento Linux/macOS/Windows antes da escolha irreversível.
- **Distribution:** entrevistar e observar pessoas não técnicas; medir artefato útil, deploy e evolução 30/90 dias, não somente instalação.
- **Economics:** estudar 1% de inferência/capacidade por caminho de uso e restrições contratuais/regulatórias separadamente do core.
- **Open-core boundary:** inventário de licenças, ameaça de fork, portabilidade, marca, marketplace e revisão jurídica.

## Sources

### Primary (HIGH/MEDIUM-HIGH confidence)

- [Agent Client Protocol](https://agentclientprotocol.com/get-started/architecture) e [schema ACP](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json) — sessões, capacidades, permissões e trusted-agent boundary.
- [Model Context Protocol](https://modelcontextprotocol.io/specification/2025-06-18/architecture) — ferramentas, recursos, prompts, consentimento e authorization boundary.
- [VS Code Workspaces](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces), [Profiles](https://code.visualstudio.com/docs/configure/profiles) e [Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust) — baseline de IDE, multi-root e trust.
- [Zed Agents](https://zed.dev/docs/ai/agents), [External Agents](https://zed.dev/docs/ai/external-agents), [Tool Permissions](https://zed.dev/docs/ai/tool-permissions) e [Sandboxing](https://zed.dev/docs/ai/sandboxing) — agentes externos, auth própria, ACP e limites de sandbox.
- [Kiro documentation](https://kiro.dev/docs/) — specs, steering, hooks, modos, permissões, checkpoints e harness.
- [Google Antigravity](https://developers.googleblog.com/en/build-with-google-antigravity-our-new-agentic-development-platform/) — editor/manager, agentes e artefatos.
- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security) e [Tauri Security](https://v2.tauri.app/security/) — isolamento de renderer/host e capabilities.
- [OWASP AI Agent Security](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html) — prompt injection, excessive agency, memory poisoning e denial-of-wallet.
- [OpenRouter FAQ/BYOK/Terms](https://openrouter.ai/docs/faq) — rail de inferência, BYOK e restrições de créditos.

### Secondary (MEDIUM confidence)

- Cursor, Replit, Lovable e Bolt official product documentation — paridade de features, code ownership, preview, knowledge e rollback.
- Microsoft Agent Framework harness documentation — decomposição de harness em contexto, loop, persistência, aprovação, observabilidade e UX.
- Ecossistema de crates/npm e especificações Rust/Tauri/Monaco/Tree-sitter/Wasmtime — adequação e versões pesquisadas.

### Tertiary / Requires Validation

- Categoria e willingness-to-use de pessoas não técnicas, qualidade de semantic autocomplete e formato ideal dos três modos.
- Viabilidade de mercado de capacidade/créditos e margem de 1%.
- Moat e fronteira de licença/open core.

---
*Research completed: 2026-08-22*
*Ready for roadmap: conditional — complete founder harness discussion first*
