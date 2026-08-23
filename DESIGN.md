# AI-Native IDE — Design

Este documento é a fonte canônica de **como** o produto funciona. Decisões novas devem ser incorporadas aqui; não devem ficar apenas em chats ou comentários de código.

## Princípios

1. **Projeto acima de repo e conversa.** Projeto é uma unidade semântica durável composta por recursos; sessão é apenas um episódio temporal.
2. **Intenção e implementação são reais.** Specs são legíveis por humanos; código/comportamento é executável. Divergência deve ser observada e reconciliada.
3. **Abstração reversível.** Usuários podem descer de intenção para spec, arquivo, código, terminal e evidência bruta.
4. **Modelo e agente agnósticos.** Integrações preservam capacidades reais e declaram o que não conseguem fazer.
5. **Evidência antes de confiança.** IA produz hipóteses; verificação exige observação independente e escopada.
6. **Zero-config útil.** Defaults permitem começar; decisões aparecem just-in-time e sempre podem ser revistas.
7. **Local-first e gratuito.** Recursos essenciais funcionam localmente. Serviços pagos e ShinAI são providers opcionais.

## Experiência

### Anatomia permanente

- **Project Rail:** alternância entre projetos duráveis.
- **Project Navigator:** Overview, Build, Resources, Evidence e histórico; não é apenas uma árvore de arquivos.
- **Work Surface:** intenção, spec, editor, Markdown, terminal, diff e preview em superfícies reais e editáveis.
- **Context Dock:** agente ativo, escopo, decisões, permissões e findings relacionados ao trabalho atual.
- **Activity Strip:** sequência causal de intenção, ação, efeito, observação, verificação e reconciliação.

O Home do projeto deve responder em segundos: o que estamos construindo, qual o estado atual, o que mudou, o que está bloqueado e qual decisão precisa de mim.

### Profundidade progressiva

- **Essential:** objetivo, resultado, decisão e próximo passo.
- **Detailed:** specs, diff, findings, causalidade e configuração relevante.
- **Raw:** arquivos, código, terminal, logs, payloads e evidência original.

É uma única IDE. Profundidade muda apresentação, não capacidade nem formato do projeto. Usuários podem personalizar layout e salvar perfis.

### Modos de construção

- **Full Vibes:** avança rápido, registra hipóteses e adia findings não bloqueantes.
- **Spec Mode:** resolve decisões e contratos antes de efeitos duráveis.
- **Hybrid (default):** cria protótipo para provocar decisões e exige checkpoint/reconciliação ao promovê-lo.

Modo não altera verdade, evidência ou compatibilidade dos artefatos.

### Linguagem visual

Direção **Instrument**: grafite/preto/branco, Geologica para interface, DM Mono para dados/código e cor apenas com significado semântico. Preview pode ser claro dentro do shell escuro. A UI deve parecer instrumento de construção, não chat, dashboard corporativo ou videogame.

### Game Mode

Opcional e cosmético. Nunca concede capacidade, permissão ou qualidade de modelo. Progresso nasce somente de outcomes verificados — requisito satisfeito, finding resolvido sem regressão, feature validada, divergência reconciliada, publicação concluída — nunca tokens, prompts, linhas, cliques ou tempo de tela.

Archetypes descritivos e combináveis: Explorer, Architect, Finisher, Guardian e Operator. Toda leitura deve mostrar evidência e poder ser ocultada/corrigida.

## Modelo de domínio

```text
Project
  ├─ Resources (repos, dirs, docs, services, environments)
  ├─ Intent + Specs
  ├─ Truth declarations + Decisions
  ├─ Sessions
  ├─ Activities + Effects
  ├─ Findings + Evidence
  └─ Configuration + Policies
```

Recursos têm identidade estável independente do caminho e podem participar de vários projetos. Sessões referenciam escopo; não contêm nem possuem recursos.

### Estado de verdade

- `declared`: intenção, contrato ou decisão humana.
- `observed`: fato extraído de arquivos, execução ou ambiente.
- `inferred`: hipótese produzida por análise.
- `verified`: afirmação sustentada por evidência e verificador especificados.
- `unknown` / `not-run`: ausência explícita de conhecimento, nunca sucesso.

O **Local Truth Registry** registra fonte, tipo de autoridade, escopo, precedência, consumidores e provenance. Fontes continuam arquivos humanos, editáveis e versionáveis. Conflito de autoridade vira finding, não merge silencioso.

## Guidance — steering organizado

Guidance é a camada persistente que define **como agir, escrever e construir daqui para frente**. Ela cumpre o papel dos steering files sem permitir que instruções pontuais se acumulem como regras permanentes e indistinguíveis.

Guidance não é memória histórica:

```text
Guidance = como trabalhar daqui para frente
Decision = o que foi decidido e por quê
Memory   = fato aprendido ou evento passado
Truth    = qual fonte possui autoridade sobre um assunto
```

### Modelo

Toda orientação possui:

- identidade e nome legível;
- tipo: preferência, convenção, decisão aplicável, regra ou policy;
- escopo: pessoa, projeto, recurso/caminho ou tarefa/sessão;
- aplicação: escrita, código, design, ferramenta, agente ou efeito;
- força: sugestão, default, obrigatória ou bloqueante;
- origem: criada, importada ou sugerida;
- duração: sessão, tarefa, até uma data ou permanente;
- prioridade e regra de conflito;
- proprietário e provenance;
- último uso e estado: candidate, ativa, suspensa, substituída ou arquivada.

Uma orientação não pode tornar-se persistente sem escopo e duração compreensíveis.

### Organização física

Poucos conjuntos estáveis substituem um arquivo por instrução:

```text
.guidance/
  personal.md
  project.md
  language.md
  development.md
  design.md
  policies.md
  temporary.md
  registry.json
```

Markdown é a superfície humana, local, editável e versionável. O registry preserva identidade, metadados, relações e lifecycle. Orientações relacionadas são incorporadas ao conjunto existente; um arquivo novo exige um domínio estável real, como `checkout.md`, nunca uma tarefa pontual.

### Captura e candidates

Ao surgir uma instrução, a IDE oferece quatro destinos:

1. usar somente nesta tarefa;
2. incorporar a um conjunto existente;
3. criar uma orientação estável;
4. registrar como decisão histórica, sem continuar instruindo agentes.

Correções repetidas podem gerar candidates explicáveis — por exemplo, sugerir uma preferência de voz após várias revisões semelhantes — mas nunca são ativadas silenciosamente.

### Compilação

Agentes não recebem todos os arquivos. O Context Compiler seleciona deterministicamente as orientações aplicáveis à pessoa, projeto, recurso, atividade e efeito atuais. Policies e regras obrigatórias precedem preferências; instrução mais específica pode especializar a geral dentro das regras explícitas de conflito.

O Context Dock mostra **Applied now**: texto exato, origem, escopo e motivo de inclusão de cada orientação. Retrieval probabilístico não é responsável por lembrar regras aplicáveis.

### Hygiene

A IDE detecta e propõe, sem reescrever silenciosamente:

- merge de duplicatas e orientações sobrepostas;
- resolução de conflitos;
- expiração de campanhas/tarefas encerradas;
- arquivamento de orientações nunca mais aplicadas;
- divisão de conjuntos grandes demais;
- correção de regra pontual salva como permanente.

Formatos como steering files do Kiro, `AGENTS.md`, `CLAUDE.md` e equivalentes podem ser importados por adapters. A importação classifica e pede escopo/lifecycle; não despeja todos os arquivos no contexto nem replica seu modelo desorganizado.

## Arquitetura

### Forma geral

```text
React/TypeScript UI
       │ contratos tipados
Desktop Host Tauri
       │ fronteira privilegiada mínima
IDE Host/Core
       ├─ domínios da IDE
       │    ├─ project/resources/truth
       │    ├─ Guidance + intent/specs
       │    ├─ PTY/workspace/preview
       │    └─ activity/evidence/reconciliation
       └─ componentes do bastion-core
            ├─ runtime + typed capabilities
            ├─ approvals + egress + privacy
            ├─ governed memory + SQLite
            ├─ providers + MCP
            └─ Codex/ACP agent runtimes
```

Tauri é o host oficial porque incorpora diretamente o runtime e os crates Rust do Bastion, preservando uma fronteira privilegiada única. A UI permanece shell-neutral. Um spike valida Monaco, PTY, preview, subprocessos, eventos, performance e empacotamento; Electron existe somente como fallback se surgir blocker estrutural documentado, não como segundo host implementado preventivamente.

### Bastion Core como substrato

A IDE é um **embedding host** do `bastion-core`, assim como `bastion-agent` é outro host com um produto diferente. O Core fornece mecanismos reutilizáveis; a IDE conserva identidade, configuração, policies de produto, estado de domínio e UX.

Componentes iniciais:

- `bastion-types`: vocabulário compartilhado, privacy, approvals e referências seguras;
- `bastion-runtime`: loop nativo, capabilities, gates, sessões, hooks e observabilidade;
- `bastion-memory`: beliefs governados e backend SQLite;
- `bastion-agent-runtime`: contratos e adapters Codex/ACP;
- `bastion-providers`: chamadas nativas a modelos;
- `bastion-mcp`: composição de ferramentas e serviços;
- posteriormente, extension protocol/WASM e partes seletivas de cognition.

`bastion-agent` é referência de composição e testes, não dependência de produto. A IDE não herda Life OS, canais pessoais, personas, Cabinet, companion, daemon, configuração ou interfaces do agente.

Reuso nunca reduz os contratos da IDE. Se um mecanismo do Core for insuficiente, a ordem é:

1. confirmar que o requisito pertence realmente à IDE;
2. estender o contrato reutilizável no `bastion-core` quando beneficiar outros hosts;
3. implementar adapter específico no host quando for comportamento exclusivo da IDE;
4. declarar degradação somente quando ela for inerente ao backend externo, nunca para mascarar trabalho ausente.

Dependências são pinadas e validadas por conformance tests. Atualizações do Core não entram automaticamente.

### Desenvolvimento Rust com retenção no CI

A máquina principal possui espaço insuficiente para reter múltiplos builds Rust/Tauri. Compilação local é permitida quando útil; a restrição é acumular seus artefatos. O GitHub preserva builds e validações completas:

```text
editar localmente
→ compilar/testar localmente quando útil
→ testar o resultado
→ limpar artifacts locais do projeto
→ GitHub executa e preserva testes + build + pacote
→ baixar somente o artifact que precisa ser testado
→ substituir instalação local atual
```

Regras:

- GitHub sempre executa Rust completo (`cargo test`, Clippy, Tauri build e pacote) como validação reproduzível e retenção oficial;
- localmente, qualquer build/test necessário pode ser executado, inclusive o workspace completo quando couber;
- depois do uso, binários, `target/`, bundles e staging gerados pelo projeto são removidos pela rotina segura de limpeza;
- somente um build instalado da IDE e um diretório de artefatos temporários podem existir localmente;
- instalação de um novo build é atômica e substitui o anterior, preservando configuração/dados do usuário fora do bundle;
- histórico de artifacts, releases e checks pertence ao GitHub;
- `target/`, binários, bundles baixados e caches do projeto possuem limites, inspeção e comando de limpeza conhecido;
- caches globais de source/registry não são apagados a cada build; são medidos e limpos separadamente apenas quando ultrapassarem orçamento;
- limpeza automática atua apenas em caminhos canônicos do projeto previamente resolvidos e nunca em `$HOME`, raiz do workspace ou cache Cargo global de forma recursiva;
- antes de baixar ou iniciar compilação grande, executar preflight de espaço disponível;
- falha de CI nunca deve substituir a instalação local funcional.

Para evitar acumulação, o canal de desenvolvimento pode reutilizar uma identidade de instalação (`dev`) enquanto Git SHA, provenance e resultado dos checks aparecem dentro da aplicação. Releases versionadas começam somente quando um build estiver bom o suficiente para registro público.

### Fronteira privilegiada

A UI nunca ganha filesystem/process/network irrestritos. Comandos tipados validam projeto, recurso, caminho, capability e policy. Toda operação retorna DTOs explícitos e eventos observáveis.

Um efeito controlável percorre uma única rota:

```text
ProposedEffect → deterministic policy → optional checkpoint
→ snapshot → privileged execution → observation → verification/rollback
```

A aprovação é ligada ao efeito exato; alteração ou replay exige nova avaliação. YOLO muda policy explicitamente, mas não apaga histórico.

O chokepoint base é `CapabilityRegistry::invoke`. A IDE implementa capabilities de filesystem, PTY, processos, Git, preview, instalação, rede e publicação; o Context Dock implementa a experiência de approval e o Activity Strip consome observações. Snapshots, diffs, rollback e causalidade do workspace continuam responsabilidades da IDE.

O egress do Core deve evoluir de exceções baseadas em nome de provider para destinos/capabilities tipados quando necessário. Modelos locais, AAG, memupalace, previews e subprocessos não podem depender de uma comparação especial com o nome `ollama`.

### Editor, terminal e preview

- Monaco é o candidato inicial para edição de código/Markdown.
- PTY é real, supervisionado e suporta spawn, input, resize, output, cancel, exit e cleanup.
- Preview roda isolado, possui lifecycle e health state e correlaciona erros com atividade/efeitos causais.
- Mudanças externas entram no mesmo fluxo de observação e reconciliação.

### Agentes

Adapters possuem capability negotiation: autenticação, sessão, resume, cancelamento, ferramentas, custos, efeitos e limites. ACP é preferencial quando maduro; CLI/PTTY e APIs diretas permanecem caminhos honestos. Não se uniformiza uma capacidade inexistente.

O estado durável pertence à IDE. Trocar agente não perde projeto, intenção, decisões, findings ou evidências.

`bastion-agent-runtime` é o contrato base para agentes externos. Sua `PolicyCoverage` é renderizada honestamente pela IDE: visibilidade de ferramentas, approvals, egress, budget e sandbox podem ser completos, parciais, desconhecidos ou controlados pelo harness externo.

### Memória do runtime

A IDE usa `bastion-memory` e seu SQLite como camada local governada: ownership, provenance, validade temporal, confiança, privacy, correção e revogação. Memória recuperada é contexto, nunca autoridade.

Guidance, Decisions, Truth e Evidence permanecem domínios separados da IDE. `memupalace` pode acrescentar armazenamento/retrieval avançado; ele não substitui o ledger governado nem se torna obrigatório. Outros adapters só serão adicionados quando oferecerem capacidade não atendida, em vez de duplicar integrações por catálogo.

## Harness

### Quatro camadas

1. **Invariantes universais:** build, testes, segredos, dependências, policy, diff, efeitos e estados; determinísticos sempre que possível.
2. **Semântica geral:** ambiguidades, decisões ausentes, contradições, riscos e divergências; incremental, cacheada e budgetada.
3. **Packs de domínio:** checks, guias e critérios declarativos para e-commerce, pagamentos, leilão, chatbot etc.
4. **Deep evaluations:** scans/testes caros em checkpoint, promoção ou publicação.

### Cinco subsistemas inseparáveis

- Local Truth Registry.
- Lifecycle Hook Bus.
- Knowledge/Evidence Graph provider.
- Context Compiler.
- Semantic Evaluators + Reconciler.

AAG é o primeiro provider estrutural externo e degradável. Ele observa o que existe; não decide intenção ou autoridade. Sem AAG, a IDE continua funcionando e marca relações indisponíveis como `unknown`.

Todo finding inclui identidade, versão do evaluator, camada, escopo, afirmação, evidência/provenance, confiança, severidade, remediação, enforcement e estado de revisão.

## Configuração

Fluxo: detectar → aplicar default reversível → revelar no momento relevante → permitir aprofundar → salvar por projeto/perfil.

Defaults: Hybrid, Essential adaptativo, balanced permissions, layers 0/1, checkpoints automáticos, AAG local quando disponível, respostas concisas e nenhuma inferência paga em idle.

Primeiro uso deve pedir no máximo: intenção; aceitar/trocar agente; confirmar primeiro efeito externo irreversível.

## IDE × Katsui

A IDE gratuita possui tudo que uma pessoa precisa para possuir e evoluir um projeto local: projetos, arquivos, Local Truth Registry, AAG local, hooks, reconciliação, checks, adapters e effect broker básicos.

Katsui ou outro provider organizacional possui ingestão de Slack/Teams/Notion/Drive/CRM/ERP, Company Brain, ontologia, retrieval/rerank, registries organizacionais, propagação cross-project, governança, tenancy e operação compartilhada. Integração é canal de distribuição opcional, não dependência.

## Segurança e honestidade

- A UI não autoriza seus próprios efeitos.
- Agente não escolhe enforcement nem declara a própria saída verificada.
- Policies, requisitos, comandos destrutivos, valores financeiros e evidência governante não são comprimidos sem referência verbatim.
- Packs/plugins não recebem execução nativa irrestrita.
- Toda degradação é mostrada antes de depender da capacidade.
- A IDE afirma somente o que a evidência escopada permite.

## Critérios transversais de aceitação

- Pessoa não técnica encontra objetivo, resultado e decisão pendente em até dez segundos.
- Pessoa técnica chega a código, terminal e evidência raw em até duas ações.
- Interface funciona sem cor, animação ou Game Mode.
- Projeto sobrevive a sessões, troca de agente e mudanças externas.
- Nenhum caminho essencial exige Katsui, cloud ShinAI ou assinatura.
