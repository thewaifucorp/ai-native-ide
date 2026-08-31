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
- **Project Navigator:** Overview, Anotações, Status, Build, Resources, Evidence e histórico; não é apenas uma árvore de arquivos.
- **Work Surface:** conversa, anotações, intenção, spec, editor, Markdown, terminal, diff, mapa e preview em superfícies reais e editáveis.
- **Context Dock:** agente ativo, escopo, decisões, permissões e findings relacionados ao trabalho atual; permite inspecionar o contexto efetivamente enviado ao agente.
- **Activity Strip:** sequência causal de intenção, ação, efeito, observação, verificação e reconciliação, em linguagem do projeto.

O Home do projeto deve responder em segundos: o que estamos construindo, qual o estado atual, o que mudou, o que está bloqueado e qual decisão precisa de mim.

O Activity Strip é uma projeção local, concisa e causal dos eventos pertinentes ao
projeto: identifica ação/agente, recursos afetados, resultado, evidência e, quando
for aplicável, consumo. Ele pode consumir eventos do Bastion Core, mas não replica
telemetria organizacional, gestão de workforce, SLAs, governança ou a Control Tower.

Durante exploração, Anotações ocupa a Work Surface quando preview ainda não é a
superfície relevante. Construção usa preview/arquivos/diff; entendimento usa o mapa;
conferência usa Status/Evidência. Isso muda a superfície visível, não fragmenta o
projeto em produtos ou modos incompatíveis.

### Profundidade progressiva

- **Essential:** objetivo, resultado, decisão e próximo passo.
- **Detailed:** specs, diff, findings, causalidade e configuração relevante.
- **Raw:** arquivos, código, terminal, logs, payloads e evidência original.

É uma única IDE. Profundidade muda apresentação, não capacidade nem formato do projeto. Usuários podem personalizar layout e salvar perfis.

### Baseline técnico da mesma IDE

Editor, arquivos, busca, terminal, Source Control, extensões, debugger e checks são
superfícies reais do v1, não uma segunda “IDE para dev” nem profundidade opcional a
ser construída depois. A pessoa não técnica não precisa abri-las para construir; a
pessoa técnica chega nelas progressivamente, no mesmo projeto e com o mesmo estado.

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

### Features, tasks e verificações

Intenção e SoTs dão o contexto do produto; a estrutura de execução só aparece para
trabalho de construção concreto:

```text
Feature (resultado de produto, quando houver)
  └─ Task (mudança ou trabalho concreto)
       └─ Subtask (somente se a decomposição ajudar)
```

Não há Epic/Story obrigatório. Uma mudança pequena pode ser uma Task direta; uma
Feature pode ter uma só Task ou muitas; Task e Subtask não possuem quantidade mínima.
Uma Task pode apoiar mais de uma Feature, mas cada evidência declara qual critério ela
suporta.

Todo item possui objetivo, revisão, relações e estado. Features sempre possuem
critérios observáveis; Tasks possuem verificações adequadas ao seu impacto; Subtasks
podem ter somente conclusão observável ou herdar a prova da Task. Critérios de Feature
tratam resultado/fluxo/integridade; critérios de Task tratam a mudança focal; Subtasks
tratam passos menores. Teste unitário é apenas uma evidência possível, não o sentido de
Task.

O agente pode propor um plano de verificação antes de executar, usando intenção,
SoTs, Guidances, AAG, impacto, conexões e políticas. A pessoa pode aceitar, editar,
recusar ou adiar os candidatos. O agente não pode reduzir, substituir ou reescrever
silenciosamente critérios depois de falhar: alterar o contrato cria nova revisão e
preserva a prova anterior como pertencente à revisão antiga.

O estado de uma Feature é calculado, nunca declarado pelo agente: `não iniciado`,
`em andamento`, `implementado, não verificado`, `parcialmente verificado`,
`verificado`, `bloqueado` ou `evidência desatualizada`. Diff, texto do agente,
screenshot ou preview aberto são evidências de escopo limitado; não tornam uma Feature
verificada sem evidência atual ligada a todos os seus critérios. Mudança relevante em
artefato, SoT, conexão ou critério invalida a prova afetada.

**Status** é a superfície central desses resultados. Overview mantém apenas o resumo
compacto e as pendências reais; Tasks mostram a fila de trabalho, mas concluir uma Task
não promove automaticamente sua Feature. Evidência detalhada abre somente em resposta
a “como sabemos disso?”.

### Exploração, anotações e reconciliação

Conversa serve para pensar e não vira automaticamente Guidance, SoT, Feature ou Task.
Ideias, perguntas, alternativas e sínteses relevantes podem ser preservadas em
**Anotações** editáveis, organizadas por tema e vinculadas às mensagens, referências,
decisões, SoTs, Features e arquivos que lhes deram origem. Uma anotação automática é
um rascunho com provenance, não uma verdade silenciosa.

Uma anotação distingue proposta, decisão confirmada, pergunta aberta, alternativa e
item substituído. A ação **Conciliar e reconciliar** compara anotações escolhidas — ou
todas as do projeto — com Guidances, SoTs e Features: aponta convergências,
duplicatas, conflitos e candidatos de promoção. A pessoa escolhe promover para SoT,
criar/atualizar Guidance, criar Feature/Task, marcar como substituído, manter opções
abertas ou corrigir a síntese. Nenhuma reconciliação mescla, descarta ou promove estado
sem escolha explícita.

### Intenção guiada e ajuda contextual

O campo de intenção não é um chat vazio nem autocomplete de frases. O **composer de
intenção** propõe, inline e de forma editável, ambiguidades, decisões ausentes,
requisitos esquecidos, contradições com o projeto e consequências relevantes antes de
virarem instrução para agente. Ele gera candidates de anotação/spec/critério, nunca
uma decisão silenciosa.

**Ajuda contextual** é distinta de Guidance: explica à pessoa, no momento em que um
conceito, risco ou escolha aparece, o que está em jogo e quais opções existem. Ela
não instrui agentes, não bloqueia por padrão e pode ter providers externos no futuro
(incluindo Exia), mas o v1 possui experiência local e neutra.

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

### Inspeção do contexto do agente

Antes ou depois de uma execução, a pessoa pode verificar o contexto efetivamente
entregue ao agente: prompt compilado, SoTs, Guidances, referências, arquivos,
decisões, policies e limites, sempre com versão, origem e escopo. A inspeção também
explica itens candidatos que foram excluídos. Seu propósito é verificável: distinguir
uma ação fundamentada no projeto de uma inferência inventada pelo agente; não é uma
superfície de telemetria ou observabilidade organizacional.

O Context Compiler constrói um pacote mínimo por execução, nunca despeja projeto,
mapa, transcript, Features, Tasks, Anotações, evidência ou capabilities inteiros por
default. Ele parte de objetivo atual, recursos no escopo, Guidances/SoTs aplicáveis,
critérios, referências explicitamente vinculadas, vizinhança estrutural limitada e
policies. Itens restantes ficam acessíveis por handles e capabilities de retrieval
governadas, com `unknown` explícito quando não puderem ser obtidos.

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
Theia application shell
       │ contratos/RPC tipados
Engine sidecar Rust/Bastion
       │ fronteira privilegiada mínima
IDE Core
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

`apps/ide-theia/` é o shell oficial e ativo do produto. Ele fala com o engine sidecar
Rust/Bastion por contratos tipados, preservando uma fronteira privilegiada única para
filesystem, processos, effects e providers. `apps/desktop/` Tauri é protótipo histórico
e fonte de evidência/crates; não recebe features nesta milestone. Empacotamento desktop
do shell Theia é decisão futura separada: não cria um segundo produto nem autoriza
portar a fila ativa para Tauri.

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
- Source Control fornece stage, commit e branch reais; extensões podem ser buscadas,
  instaladas e geridas pelo provider de extensões ativo.
- Debugger usa sessão real/DAP, breakpoints e configurações de launch/attach; não é
  um ícone decorativo nem um log apresentado como depuração.
- Checks expõem resumo acessível e saída raw/commands para quem precisa investigar.
- Preview roda isolado, possui lifecycle e health state e correlaciona erros com atividade/efeitos causais.
- Mudanças externas entram no mesmo fluxo de observação e reconciliação.

### Materiais do projeto

**Referências** são materiais de entrada externos — anexos, imagens, links,
documentos, áudio, texto ou repositórios — preservados com proveniência e vinculáveis
a uma SoT, decisão, atividade ou recurso. **Assets** são materiais que pertencem ao
produto e são editados/versionados no workspace, como imagens, ícones, fontes e
documentos publicados. A distinção impede que inspiração externa se torne
silenciosamente estado autoritativo do produto.

### Agentes

Adapters possuem capability negotiation: autenticação, sessão, resume, cancelamento, ferramentas, custos, efeitos e limites. ACP é preferencial quando maduro; CLI/PTTY e APIs diretas permanecem caminhos honestos. Não se uniformiza uma capacidade inexistente.

O estado durável pertence à IDE. Trocar agente não perde projeto, intenção, decisões, findings ou evidências.

`bastion-agent-runtime` é o contrato base para agentes externos. Sua `PolicyCoverage` é renderizada honestamente pela IDE: visibilidade de ferramentas, approvals, egress, budget e sandbox podem ser completos, parciais, desconhecidos ou controlados pelo harness externo.

#### Project Agents

A IDE possui um substrato próprio de **Project Agents**: agentes que constroem e evoluem o software do projeto aberto. O usuário pode defini-los livremente sobre os contratos do Bastion Core e ligá-los a Codex, Claude, ACP, um modelo direto ou outro runtime compatível. Uma definição declara papel, instruções, adapter preferido, capabilities requeridas e escopo de recursos; ela não é uma sessão nem uma credencial.

Uma execução de time materializa roster, sessões, mailbox, tarefas, handoffs, blockers e escopos de escrita. Definições e manifestos do time são artefatos locais/versionáveis do projeto; sessões vivas, segredos, processos, snapshots e logs operacionais pertencem ao estado local da IDE. Todo contexto visível ao modelo, efeito e mensagem entre agentes deve poder ser reconstruído a partir do ledger do projeto.

Times locais de subagentes são baseline v1: um agente pode criar subagentes e
dividir trabalho dentro do projeto, inclusive em paralelo quando o runtime permitir,
sempre com broker, escopos de escrita, orçamento e handoffs visíveis. Isso não inclui
agentes persistentes de operação, filas/retries de produção, workforce cross-project
ou Digital Workers organizacionais.

Project Agents não são Digital Workers do Katsui Agent Dojo. O Dojo hospeda deployments Bastion persistentes conectados à Company Brain/Ontology, opera Solution Packs e workers prontos e executa trabalho/outcomes de negócio. A IDE pode conectar ou promover para o Dojo, mas não converte o seu project runtime em um clone dele.

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

O mapa da aplicação é derivado da análise observável do projeto — AAG, workspace,
serviços, conexões, execução e evidências — desde a importação e após mudanças. Task
concluída somente liga intenção/trabalho aos artefatos observados; nunca preenche ou
altera o mapa por declaração.

Todo finding inclui identidade, versão do evaluator, camada, escopo, afirmação, evidência/provenance, confiança, severidade, remediação, enforcement e estado de revisão.

### Harness providers

O Harness nativo é o provider padrão de workflow, critérios e status verificável; ele
não é o único fluxo possível. Um projeto pode ativar outro **Harness Provider**, como
um adapter GSD, sem deixar de ser projeto da IDE.

O Core não é substituível: broker de efeitos, confinamento, credenciais, snapshots,
rollback, receipts/evidência bruta, artefatos do projeto e registro de providers
continuam do host. O provider recebe capabilities governadas e não executa
filesystem/rede/processos diretamente nem transforma sua própria declaração em prova.

Cada provider declara versão/compatibilidade, artefatos lidos/escritos, modelo de
trabalho/status, UI/comandos, verificadores, evidências emitidas, cobertura,
limitações, degradação e migração. Os slots `workflow`, `hierarquia de trabalho` e
`status principal` são exclusivos por projeto; checks, packs de domínio,
visualizações e importadores são componíveis quando declaram origem e escopo.

Ativar outro provider suspende o Harness padrão somente nos slots assumidos, preserva
artefatos e histórico do provider anterior e mostra a troca explicitamente. O status
de um provider externo permanece atribuído a ele; a IDE não o apresenta como prova
universal sem evidência compatível. Marketplace e publicação de plugins são posteriores
ao v1; o contrato, sandbox e ativação por projeto pertencem ao v1.

## Configuração

Fluxo: detectar → aplicar default reversível → revelar no momento relevante → permitir aprofundar → salvar por projeto/perfil.

### Analisar projeto existente

Ao abrir/importar um projeto existente, a IDE oferece **Analisar projeto**. A análise
local/AAG detecta recursos, stack, linguagens, package manager, comandos de execução
e checks, Git, configurações, serviços, arquivos de instrução, integrações e relações
estruturais disponíveis. Ela gera apenas candidatos revisáveis: importação/classificação
de `AGENTS.md`, `CLAUDE.md`, steering e equivalentes como Guidance com escopo/lifecycle;
SoTs ou configurações de preview/checks inferidos; e lacunas marcadas como `unknown`.
Nada é ativado como Guidance, SoT ou configuração autoritativa sem revisão da pessoa.

Defaults: Hybrid, Essential adaptativo, balanced permissions, layers 0/1, checkpoints automáticos, AAG local quando disponível, respostas concisas e nenhuma inferência paga em idle. Toda capability da IDE recebe um provider/configuração padrão reversível: editor, arquivos, terminal, Git, preview, checks, grafo, SoTs, broker, economia local e extensões funcionam ou degradam honestamente sem uma tela inicial de setup.

Agentes são a única exceção. A IDE detecta adapters instalados e oferece sugestões, mas não ativa, cria ou autentica um agente por conta própria: o usuário escolhe/conecta o primeiro runtime porque essa decisão determina identidade, credencial, custo, capabilities e fronteira de confiança.

Primeiro uso deve pedir no máximo: intenção; escolher/conectar o primeiro agente; confirmar o primeiro efeito externo irreversível.

## IDE × Katsui

A IDE é um host de capabilities e providers. Cada ferramenta declara o provider ativo, sua cobertura e degradações, aceita alternativas neutras quando existirem e mostra uma rota contextual para a solução Katsui correspondente. A conexão Katsui não é um plugin genérico de onboarding: ela aparece no lugar em que a capability é usada.

A IDE gratuita possui o necessário para construir e evoluir software localmente: projeto semântico, ferramentas de workspace, Project Agents, SoTs e grafo locais, efeitos governados, evidência e providers configuráveis. Katsui é o teto premium: Company Brain/Ontology, Agent Dojo/Digital Workers, Kekkai Shield, Iai Gate, Mugen, Judge e Control Tower oferecem produtos e profundidades que a IDE não deve replicar como substitutos locais.

O compartilhamento de artefatos do projeto permanece portátil: Git cobre colaboração
de código; compartilhar preview/revisão externa é uma capability da IDE a definir sem
pressupor colaboração em tempo real ou uma Control Tower local.

Cada estágio de segurança possui um único provider semântico autoritativo. O broker mantém invariantes locais não negociáveis — confinamento, execução privilegiada, snapshot e identidade — mas não empilha classificadores concorrentes sobre o mesmo input. Um framework externo, NeMo ou MCP só entra como Policy/Egress Provider se o host puder invocá-lo no chokepoint privilegiado, obter um veredito versionado e declarar cobertura, transformação, retenção e modo de falha. Um gateway composto que também imponha guardrails, memória ou decisões concorrentes não entra na rota governada.

O perfil local de economia é deliberadamente pequeno e opt-in: RTK compacta output de tools/CLI e Caveman solicita saída concisa; ambos preservam o bruto recuperável e nunca alteram prompts de sistema, schemas de tools, policies, critérios de aceite ou evidências. Iai Gate permanece o provider para routing, cache, compressão contextual e economia de inferência.

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
