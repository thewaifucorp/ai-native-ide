# Requirements: AI-Native IDE

**Defined:** 2026-08-22  
**Core Value:** Transformar intenção em software real e continuamente controlável, mantendo intenção, especificação e implementação reconciliáveis por humanos e agentes.  
**Project mode:** Vertical MVP

## v1 Requirements

### Semantic Projects

- [ ] **PROJ-01**: Usuário pode criar um projeto semântico a partir de uma intenção ou abrir um produto existente sem precisar escolher previamente uma estrutura técnica.
- [ ] **PROJ-02**: Usuário pode vincular múltiplos repositórios e diretórios a um projeto e visualizar claramente quais recursos estão em escopo.
- [ ] **PROJ-03**: Usuário pode reutilizar o mesmo recurso em mais de um projeto sem duplicar seus arquivos.
- [ ] **PROJ-04**: Usuário pode iniciar sessões sobre o projeto inteiro ou um subconjunto explícito de recursos sem transformar a sessão em dona dos arquivos.
- [ ] **PROJ-05**: Usuário pode fechar, reabrir e continuar um projeto sem depender do transcript de uma sessão anterior.

### Real Workspace

- [ ] **WORK-01**: Usuário pode abrir, criar e editar diretamente arquivos de código, Markdown, configuração e assets do projeto.
- [ ] **WORK-02**: Usuário pode executar e acompanhar comandos num terminal real associado ao projeto.
- [ ] **WORK-03**: Usuário pode inspecionar alterações em diff e aceitar, ajustar ou reverter um checkpoint sem conhecer comandos Git.
- [ ] **WORK-04**: Usuário pode abrir um preview executável do produto e relacionar erros de execução à sessão e aos artefatos relevantes.
- [ ] **WORK-05**: Alterações feitas fora da IDE são detectadas e reconciliadas sem exigir reimportar o projeto.

### Agents and Models

- [ ] **AGNT-01**: Usuário pode conectar pelo menos um agente externo via ACP preservando autenticação, sessão e capacidades próprias.
- [ ] **AGNT-02**: Usuário pode usar pelo menos um loop controlado pela IDE com modelo via API, gateway ou servidor local.
- [ ] **AGNT-03**: Usuário pode iniciar, acompanhar, cancelar e, quando suportado pelo adapter, retomar uma sessão de agente.
- [ ] **AGNT-04**: Usuário pode ver antes do uso quais capacidades, custos, autenticação, efeitos e garantias cada adapter oferece ou não oferece.
- [ ] **AGNT-05**: Usuário pode trocar de agente entre sessões sem perder o estado durável de intenção, decisões, arquivos e findings do projeto.

### Intent and Truth

- [ ] **INTN-01**: Usuário pode expressar informalmente o que quer construir e receber autocomplete que revela ambiguidades, decisões ausentes, riscos e conceitos relevantes.
- [ ] **INTN-02**: Usuário pode revisar e editar diretamente a representação estruturada da intenção e as specs produzidas.
- [ ] **INTN-03**: Usuário pode declarar uma fonte local como autoritativa para assuntos e recursos específicos sem transformá-la em autoridade global.
- [ ] **INTN-04**: Decisões detectadas numa sessão são preservadas como candidates e promovidas, rejeitadas ou mantidas provisórias conforme modo e policy.
- [ ] **INTN-05**: Usuário pode ver quando intenção/spec e comportamento implementado divergem e escolher mudar implementação, mudar intenção ou aceitar exceção escopada.
- [ ] **INTN-06**: Usuário pode identificar consumidores de uma decisão/SoT e receber proposta de sincronização após uma mudança relevante.

### Harness and Evidence

- [ ] **HRNS-01**: Usuário recebe checks universais determinísticos sobre build, testes, segredos, escopo, efeitos e estado do projeto sem exigir inferência paga.
- [ ] **HRNS-02**: Usuário recebe findings semânticos gerais incrementais com afirmação, evidência, confiança, severidade e remediação visíveis.
- [ ] **HRNS-03**: Usuário pode usar um starter pack declarativo para o domínio benchmark, entender o que ele adiciona e desfazer sua ativação.
- [ ] **HRNS-04**: Usuário recebe uma avaliação profunda e uma readiness view antes de promover protótipo ou publicar.
- [ ] **HRNS-05**: Usuário nunca vê hipótese de IA, check não executado ou estado desconhecido apresentado como verificação aprovada.
- [ ] **HRNS-06**: Usuário pode revisar, corrigir, marcar falso positivo ou aceitar temporariamente um finding com justificativa e escopo.
- [ ] **HRNS-07**: Findings equivalentes são deduplicados e apresentados por consequência/momento, sem uma lista constante de warnings repetidos.

### Modes, Policy and Effects

- [ ] **MODE-01**: Usuário pode escolher Full Vibes, Spec Mode ou Hybrid e trocar de modo sem criar projetos incompatíveis ou perder evidência.
- [ ] **MODE-02**: Full Vibes permite avançar com hipóteses e findings não bloqueantes, preservando-os para checkpoint.
- [ ] **MODE-03**: Spec Mode resolve decisões contratuais relevantes antes de efeitos duráveis.
- [ ] **MODE-04**: Hybrid diferencia protótipo descartável de estado durável e exige reconciliação na promoção.
- [ ] **MODE-05**: Usuário pode configurar permissões por projeto/recurso e optar explicitamente por YOLO sem esconder o histórico de efeitos.
- [ ] **MODE-06**: Efeitos brokerados respeitam policy determinística e adapters não controláveis exibem degradação antes do uso.

### Context and Guidance

- [ ] **CTXT-01**: Usuário e agente podem navegar do assunto/requisito para documentos, implementações, consumidores e evidências relevantes usando o graph provider local.
- [ ] **CTXT-02**: O projeto permanece utilizável quando o graph provider está indisponível, expondo structural checks como desconhecidos em vez de bloquear ou fingir sucesso.
- [ ] **CTXT-03**: Usuário pode acessar a saída bruta de ferramentas mesmo quando a IDE usa compressão/deduplicação automática no contexto.
- [ ] **CTXT-04**: Usuário recebe respostas concisas por default e explicações mais profundas quando uma decisão, conceito ou risco exige compreensão.
- [ ] **CTXT-05**: Usuário pode ver e limitar o budget de inferência do harness; nenhuma inferência paga roda em idle por default.
- [ ] **CTXT-06**: Contexto enviado a um agente mostra origem e escopo, preservando verbatim policies, requisitos e evidências que governam a tarefa.

### Configuration Experience

- [ ] **CONF-01**: Usuário consegue iniciar um projeto novo descrevendo a intenção sem completar um wizard de configuração técnica.
- [ ] **CONF-02**: A IDE detecta recursos, Git, AAG, agentes e providers disponíveis e aplica defaults reversíveis com degradação visível.
- [ ] **CONF-03**: Perguntas obrigatórias aparecem somente no momento em que são necessárias e explicam a consequência em linguagem comum.
- [ ] **CONF-04**: Usuário pode alterar configurações por interface simples ou arquivo completo e ambos representam o mesmo estado.
- [ ] **CONF-05**: Defaults iniciais são Hybrid, profundidade progressiva, permissões balanced, camadas 0/1 ativas, checkpoints automáticos e inferência background desligada.

### Build, Publish and Continue

- [ ] **LIFE-01**: Usuário consegue atravessar intenção, construção, preview, evidência e reconciliação num microsaaS benchmark executável.
- [ ] **LIFE-02**: Usuário pode exportar ou publicar o produto sem perder acesso ao código e sem tornar a infraestrutura ShinAI obrigatória.
- [ ] **LIFE-03**: Usuário pode reabrir o produto publicado, observar um problema, alterar implementação/spec e publicar uma nova versão pelo mesmo projeto.
- [ ] **LIFE-04**: Usuário consegue completar o caminho feliz inicial fornecendo apenas intenção, escolhendo/aceitando um agente e confirmando o primeiro efeito externo irreversível.

## v2 Requirements

### Additional Creation Surfaces

- **SURF-01**: Usuário pode usar voz como superfície completa de intenção e controle.
- **SURF-02**: Usuário pode editar visualmente interfaces e reconciliar alterações visuais com código/intento.
- **SURF-03**: Usuário pode executar agentes paralelos e background com supervisão e budgets.

### Ecosystem

- **ECOS-01**: Autor pode publicar packs e adapters assinados num marketplace.
- **ECOS-02**: Usuário pode instalar plugins executáveis em sandbox com capabilities explícitas.
- **ECOS-03**: Usuário pode escolher Katsui Company Brain como Organization Truth Provider.
- **ECOS-04**: Usuário pode escolher Shiori/Iai Gate/Kekkai como providers avançados sem perder alternativas neutras.

### Collaboration and Operations

- **COLL-01**: Várias pessoas podem colaborar em tempo real no mesmo projeto.
- **COLL-02**: Usuário pode visualizar um portfólio e consultar vários projetos simultaneamente.
- **OPER-01**: Usuário pode acompanhar telemetria, incidentes e estado de produção como evidência contínua.
- **OPER-02**: Organização pode governar policies, providers e budgets compartilhados.

### Distribution Economy

- **ECON-01**: Providers podem patrocinar capacidade de forma transparente sem alterar findings ou policy.
- **ECON-02**: A ShinAI pode operar rail/settlement de inferência ou capacidade quando contratual, regulatória e economicamente validado.
- **ECON-03**: Marketplace pode oferecer descoberta patrocinada claramente identificada.

## Out of Scope

| Feature | Reason |
|---|---|
| Paridade completa com VS Code/extensões no v1 | Construiria uma plataforma de editor antes de provar a nova primitiva |
| Esconder código ou documentos de usuários não técnicos | Contradiz controle progressivo e propriedade do produto |
| Chat/conversa como contêiner do projeto | Sessão é temporal; projeto e artefatos precisam sobreviver independentemente |
| Provider/modelo/Katsui obrigatório | Contradiz neutralidade e distribuição |
| Company Brain gratuito embutido | Local Truth Registry é necessário; ingestão, serving e governança organizacionais permanecem produto/provider |
| Slack/Teams/Notion/Drive/CRM/ERP no core v1 | Conectores e ingestão organizacional pertencem a Katsui/Mugen ou providers |
| Marketplace e plugins executáveis antes de contracts locais estáveis | Amplia supply-chain e ABI antes de existir demanda/segurança comprovada |
| Mercado universal de tokens como dependência do v1 | É hipótese econômica posterior, não requisito para validar o produto |
| Garantia genérica de que software está seguro/correto | Evidências são escopadas; desconhecido nunca vira aprovado |
| Inferência paga oculta em background | Cria custo invisível e incentivo desalinhado |
| Banco vetorial/grafo especializado como SoT | Estado autoritativo precisa permanecer humano, portátil e reconstruível |

## Traceability

| Requirement | Phase | Status |
|---|---|---|
| PROJ-01 | Phase 1 | Pending |
| PROJ-02 | Phase 2 | Pending |
| PROJ-03 | Phase 2 | Pending |
| PROJ-04 | Phase 2 | Pending |
| PROJ-05 | Phase 2 | Pending |
| WORK-01 | Phase 2 | Pending |
| WORK-02 | Phase 3 | Pending |
| WORK-03 | Phase 3 | Pending |
| WORK-04 | Phase 1 | Pending |
| WORK-05 | Phase 2 | Pending |
| AGNT-01 | Phase 3 | Pending |
| AGNT-02 | Phase 3 | Pending |
| AGNT-03 | Phase 3 | Pending |
| AGNT-04 | Phase 3 | Pending |
| AGNT-05 | Phase 3 | Pending |
| INTN-01 | Phase 1 | Pending |
| INTN-02 | Phase 2 | Pending |
| INTN-03 | Phase 2 | Pending |
| INTN-04 | Phase 2 | Pending |
| INTN-05 | Phase 4 | Pending |
| INTN-06 | Phase 2 | Pending |
| HRNS-01 | Phase 5 | Pending |
| HRNS-02 | Phase 5 | Pending |
| HRNS-03 | Phase 5 | Pending |
| HRNS-04 | Phase 5 | Pending |
| HRNS-05 | Phase 5 | Pending |
| HRNS-06 | Phase 5 | Pending |
| HRNS-07 | Phase 5 | Pending |
| MODE-01 | Phase 4 | Pending |
| MODE-02 | Phase 4 | Pending |
| MODE-03 | Phase 4 | Pending |
| MODE-04 | Phase 4 | Pending |
| MODE-05 | Phase 3 | Pending |
| MODE-06 | Phase 3 | Pending |
| CTXT-01 | Phase 5 | Pending |
| CTXT-02 | Phase 5 | Pending |
| CTXT-03 | Phase 3 | Pending |
| CTXT-04 | Phase 4 | Pending |
| CTXT-05 | Phase 5 | Pending |
| CTXT-06 | Phase 3 | Pending |
| CONF-01 | Phase 1 | Pending |
| CONF-02 | Phase 2 | Pending |
| CONF-03 | Phase 3 | Pending |
| CONF-04 | Phase 2 | Pending |
| CONF-05 | Phase 4 | Pending |
| LIFE-01 | Phase 1 | Pending |
| LIFE-02 | Phase 6 | Pending |
| LIFE-03 | Phase 6 | Pending |
| LIFE-04 | Phase 6 | Pending |

**Coverage:**
- v1 requirements: 49 total
- Mapped to phases: 49
- Unmapped: 0

---
*Requirements defined: 2026-08-22*
*Last updated: 2026-08-22 after Gate 0 harness decisions*
