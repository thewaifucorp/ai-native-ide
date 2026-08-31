# AI-Native IDE — Requirements

Este é o contrato canônico do produto. Ele descreve **o que** precisa existir, sem prescrever a ordem de implementação. `DESIGN.md` define como o sistema funciona e `TASKS.md` é a fila de execução.

## Visão

Uma IDE desktop gratuita, local-first e agnóstica de modelos/agentes para pessoas que querem construir software real sem precisar dominar uma IDE tradicional. Ela combina intenção guiada, especificações editáveis, código acessível, agentes intercambiáveis e verificação baseada em evidência.

O produto não é um chat com editor. Projeto, intenção, arquivos, decisões e evidências sobrevivem às conversas.

## Usuários e trabalhos principais

O usuário primário é uma pessoa pouco técnica construindo para si ou para seu negócio. O usuário secundário é técnico e quer orientação, contexto durável e controle sem perder acesso ao sistema real.

O v1 deve permitir construir e continuar operando pelo menos:

- um site de loja;
- uma ferramenta interna de gerenciamento;
- um microsaaS pequeno;
- um chatbot ou agente para um negócio.

O benchmark inicial é um microsaaS de leaderboard/leilão de posições: pequeno de entender, mas suficiente para exercitar interface, estado, concorrência, abuso, preview, evidência e publicação.

## Requisitos v1

### Projeto semântico

- [ ] **PROJ-01** Criar um projeto descrevendo a intenção ou abrir um produto existente sem escolher estrutura técnica primeiro.
- [ ] **PROJ-02** Vincular múltiplos repositórios e diretórios e visualizar claramente o escopo ativo.
- [ ] **PROJ-03** Reutilizar um recurso em mais de um projeto sem duplicar arquivos.
- [ ] **PROJ-04** Iniciar sessões sobre o projeto inteiro ou recursos selecionados; sessões nunca possuem os arquivos.
- [ ] **PROJ-05** Fechar e retomar um projeto sem depender do transcript anterior.
- [ ] **PROJ-06** Analisar projeto existente e produzir candidatos revisáveis de recursos, stack, comandos, configurações, integrações, Guidances e SoTs, declarando lacunas como `unknown`.

### Workspace real

- [ ] **WORK-01** Abrir, criar e editar código, Markdown, configuração e assets diretamente.
- [ ] **WORK-02** Executar comandos num PTY real ligado ao projeto.
- [ ] **WORK-03** Inspecionar diff e aceitar, ajustar ou reverter checkpoints sem exigir conhecimento de Git.
- [ ] **WORK-04** Abrir preview executável e relacionar erros à atividade e aos artefatos causais.
- [ ] **WORK-05** Detectar e reconciliar alterações externas sem reimportar o projeto.
- [ ] **WORK-06** Distinguir assets do produto de referências externas, preservando proveniência destas e permitindo vincular ambas ao trabalho do projeto.
- [ ] **WORK-07** Oferecer Source Control real — stage, commit e branch — no mesmo projeto, sem exigir que pessoa não técnica use Git para avançar.
- [ ] **WORK-08** Buscar, instalar, atualizar e gerenciar extensões pelo provider ativo, declarando origem, capabilities e degradação.
- [ ] **WORK-09** Depurar por sessão real/DAP com breakpoints e configurações de launch/attach; logs não contam como debugger.

### Intenção, specs e verdade local

- [ ] **INTN-01** Autocomplete de intenção revela ambiguidades, decisões ausentes, riscos e conceitos relevantes antes e durante a construção.
- [ ] **INTN-02** Intenção estruturada e specs são documentos diretamente editáveis.
- [ ] **INTN-03** Arquivos podem ser declarados autoritativos por assunto e escopo, nunca automaticamente para tudo.
- [ ] **INTN-04** Decisões encontradas em sessões viram candidates revisáveis, não verdade silenciosa ou comentário perdido.
- [ ] **INTN-05** Detectar divergência entre intenção/spec e comportamento e permitir mudar implementação, mudar intenção ou aceitar exceção escopada.
- [ ] **INTN-06** Mostrar consumidores de uma decisão/SoT e propor sincronização quando ela mudar.
- [ ] **INTN-07** Preservar anotações editáveis por tema durante exploração, com provenance das mensagens, referências e artefatos que as originaram.
- [ ] **INTN-08** Distinguir em anotações proposta, decisão confirmada, pergunta aberta, alternativa e item substituído, sem converter anotação em verdade silenciosa.
- [ ] **INTN-09** Conciliar anotações com Guidances, SoTs e Features, expondo convergências, duplicatas, conflitos e candidatos de promoção sem mesclagem automática.
- [ ] **INTN-10** Composer de intenção propõe ambiguidades, decisões ausentes, requisitos esquecidos, contradições e consequências como candidates editáveis antes de instruir agentes.

### Ajuda contextual

- [ ] **HELP-01** Explicar conceitos, riscos e escolhas relevantes em linguagem comum no momento em que surgem, sem transformar ajuda em Guidance de agente ou bloqueio automático.
- [ ] **HELP-02** Ajuda contextual é local/neutra no v1 e declara provider, origem, cobertura e degradação quando usar fonte externa.

### Agentes e modelos

- [ ] **AGNT-01** Conectar ao menos um agente externo via ACP preservando autenticação, sessão e capacidades reais.
- [ ] **AGNT-02** Oferecer ao menos um loop controlado pela IDE para modelo via API, gateway ou servidor local.
- [ ] **AGNT-03** Iniciar, acompanhar, cancelar e retomar sessões quando o adapter suportar.
- [ ] **AGNT-04** Expor antes do uso capacidades, autenticação, custos, efeitos e limitações de cada adapter.
- [ ] **AGNT-05** Trocar de agente sem perder intenção, decisões, arquivos ou evidências duráveis.
- [ ] **AGNT-06** Definir Project Agents locais e versionáveis, conectando cada definição a adapters/capabilities reais sem acoplar o projeto a um vendor.
- [ ] **AGNT-07** Executar times de Project Agents com roster, tarefas, blockers, mailbox, handoffs e escopos de escrita reconstruíveis a partir do projeto; sessões e credenciais não são artefatos versionados.

### Features, tasks e verificação

- [ ] **FEAT-01** Modelar Features como resultados de produto, Tasks como trabalho concreto e Subtasks somente quando a decomposição for útil; Epic/Story não são obrigatórios e uma Task pode existir sem Feature.
- [ ] **FEAT-02** Permitir que uma Task apoie uma ou mais Features, declarando a relação entre cada evidência e o critério que ela suporta.
- [ ] **FEAT-03** Features possuem critérios observáveis versionados; Tasks/Subtasks possuem verificações proporcionais ao impacto ou herdam a prova do item pai quando apropriado.
- [ ] **FEAT-04** Agente pode propor plano de verificação dinâmico antes de executar; pessoa pode revisá-lo e uma alteração posterior nos critérios cria nova revisão, sem apagar nem estreitar silenciosamente o contrato anterior.
- [ ] **FEAT-05** Calcular estado de Feature a partir de critérios e evidências atuais: não iniciado, em andamento, implementado não verificado, parcialmente verificado, verificado, bloqueado ou evidência desatualizada.
- [ ] **FEAT-06** Não marcar Feature como verificada por declaração de agente, diff, screenshot ou preview aberto; toda evidência declara tipo, escopo, origem, revisão e condições de invalidação.
- [ ] **FEAT-07** Expor Status central com resumo compacto no Overview, detalhes por Feature e pergunta “como sabemos disso?”; concluir Task não promove automaticamente a Feature.

### Capabilities e Harness Providers

- [ ] **CAP-01** Registrar Harness Providers versionados que declarem artefatos, workflow, hierarquia, status, UI/comandos, verificadores, evidências, cobertura, limitações, degradação e migração.
- [ ] **CAP-02** Permitir um provider exclusivo por projeto para workflow/hierarquia/status principal e providers componíveis para checks, packs, visualizações e importadores.
- [ ] **CAP-03** Ativar/suspender/migrar Harness Provider preserva os artefatos e histórico do provider anterior; a troca é explícita e reversível.
- [ ] **CAP-04** Nenhum provider/plugin contorna broker, sandbox, credenciais, snapshots, rollback ou receipts; declaração de status externa mantém provenance e não é promovida a prova universal sem evidência compatível.

### Modos, permissões e efeitos

- [ ] **MODE-01** Full Vibes, Spec Mode e Hybrid operam sobre o mesmo projeto e podem ser alternados sem migração.
- [ ] **MODE-02** Full Vibes preserva hipóteses e dívidas sem interromper o fluxo por findings não bloqueantes.
- [ ] **MODE-03** Spec Mode resolve contratos relevantes antes de efeitos duráveis.
- [ ] **MODE-04** Hybrid distingue protótipo descartável de estado durável e reconcilia na promoção.
- [ ] **MODE-05** Permissões funcionam por projeto e recurso; YOLO é explícito e mantém histórico.
- [ ] **MODE-06** Todo efeito controlável passa por policy determinística no momento do efeito; degradações são visíveis.
- [ ] **MODE-07** Cada estágio de segurança/egress possui um único provider semântico autoritativo; providers externos declaram cobertura, transformação, retenção e modo de falha.

### Harness e evidência

- [ ] **HRNS-01** Checks determinísticos cobrem build, testes, segredos, escopo, efeitos e estado sem inferência paga.
- [ ] **HRNS-02** Findings semânticos mostram afirmação, evidência, confiança, severidade e remediação.
- [ ] **HRNS-03** Packs de domínio são declarativos, explicáveis, reversíveis e sem execução irrestrita por padrão.
- [ ] **HRNS-04** Readiness/deep evaluation ocorre em checkpoints como promoção e publicação, não continuamente.
- [ ] **HRNS-05** `unknown`, `not-run`, hipótese e evidência inconclusiva nunca aparecem como aprovação.
- [ ] **HRNS-06** Usuário pode corrigir, rejeitar ou aceitar temporariamente um finding com justificativa e escopo.
- [ ] **HRNS-07** Findings equivalentes são deduplicados e apresentados no momento/consequência relevantes.

### Contexto e orientação

- [ ] **CTXT-01** Navegar de requisito/assunto para documentos, implementação, consumidores e evidências.
- [ ] **CTXT-02** A IDE continua funcional sem AAG; fatos indisponíveis ficam `unknown`.
- [ ] **CTXT-03** Saída bruta permanece acessível quando houver compressão ou deduplicação.
- [ ] **CTXT-04** Respostas são concisas por padrão e aprofundam quando risco, conceito ou decisão exige.
- [ ] **CTXT-05** Budget de inferência é visível e limitável; nada pago roda em idle por padrão.
- [ ] **CTXT-06** Contexto enviado ao agente expõe origem e escopo e preserva policies/requisitos/evidências verbatim.
- [ ] **CTXT-07** Pessoa pode inspecionar o contexto efetivamente entregue a cada execução do agente, incluindo inclusões, exclusões, origem, versão, escopo e limites aplicados.
- [ ] **CTXT-08** Atividade do projeto projeta os eventos locais/Bastion pertinentes com causalidade, recursos afetados, resultado e evidência, sem reproduzir telemetria ou governança organizacional da Katsui.
- [ ] **CTXT-09** AAG torna impacto e mudanças estruturais compreensíveis; sua análise permanece observacional, revisável e degradável.
- [ ] **CTXT-10** Context Compiler monta pacote mínimo e explícito por execução, em vez de despejar projeto/transcript/mapa/Features/Tasks/Anotações inteiros; conteúdo adicional usa retrieval governado ou permanece `unknown`.

### Guidance

- [ ] **GUID-01** Usuário pode manter orientações persistentes sobre linguagem, desenvolvimento, design, agentes e efeitos sem depender do histórico das sessões.
- [ ] **GUID-02** Cada orientação declara nome, tipo, escopo, aplicação, força, origem, duração, prioridade e proprietário de forma compreensível.
- [ ] **GUID-03** Orientações podem valer para a pessoa, projeto, recurso/caminho ou tarefa/sessão, e somente as aplicáveis entram no contexto do agente.
- [ ] **GUID-04** A IDE distingue orientação futura, decisão histórica, memória factual e fonte de verdade, sem promover uma categoria à outra silenciosamente.
- [ ] **GUID-05** Correções recorrentes podem gerar candidates, mas nenhuma preferência inferida torna-se orientação ativa sem revisão do usuário.
- [ ] **GUID-06** Ao registrar uma instrução, o usuário pode usá-la somente agora, incorporá-la a um conjunto existente, criar orientação estável ou registrá-la apenas como decisão histórica.
- [ ] **GUID-07** A IDE detecta duplicatas, conflitos, sobreposição, obsolescência e regras pontuais salvas como permanentes, propondo merge, expiração ou arquivamento.
- [ ] **GUID-08** Usuário pode ver exatamente quais orientações foram compiladas para a atividade atual, sua origem e por que se aplicam.
- [ ] **GUID-09** Guidance permanece local, editável, versionável e portável; a interface e os arquivos representam o mesmo estado.
- [ ] **GUID-10** A IDE pode importar formatos externos como steering files, `AGENTS.md` e instruções equivalentes sem adotar sua desorganização como modelo interno.

### Configuração e UX

- [ ] **CONF-01** Começar descrevendo o produto, sem wizard técnico.
- [ ] **CONF-02** Detectar Git, recursos, AAG, agentes e providers e aplicar defaults reversíveis com degradação visível.
- [ ] **CONF-03** Perguntar somente quando necessário, explicando consequência em linguagem comum.
- [ ] **CONF-04** Interface simples e arquivo completo de configuração representam o mesmo estado.
- [ ] **CONF-05** Defaults: Hybrid, profundidade progressiva, balanced, harness 0/1, checkpoints, providers locais reversíveis para toda capability e inferência idle desligada; agentes são a única escolha inicial obrigatória.
- [ ] **CONF-06** Toda capability conectável mostra provider ativo, cobertura e degradação, permite provider neutro quando existir e oferece conexão contextual para a solução Katsui correspondente.

### Criar, publicar e continuar

- [ ] **LIFE-01** Completar intenção → construção → preview → evidência → reconciliação no benchmark.
- [ ] **LIFE-02** Exportar/publicar sem perder código nem exigir infraestrutura ShinAI.
- [ ] **LIFE-03** Reabrir produto publicado, observar problema, corrigir spec/implementação e republicar.
- [ ] **LIFE-04** Caminho feliz exige somente intenção, aceitar/trocar agente e confirmar o primeiro efeito externo irreversível.
- [ ] **LIFE-05** Compartilhar preview ou revisão externa, quando habilitado, preserva o vínculo entre observação, artefato e feedback sem exigir colaboração em tempo real.

## Requisitos posteriores ao v1

- Voz como superfície completa de intenção e controle.
- Editor visual reconciliado com código e intenção.
- Agentes paralelos/background supervisionados.
- Marketplace de packs e adapters assinados; plugins com capabilities e sandbox de distribuição. O contrato, sandbox e ativação de Harness Provider já existem no v1.
- Colaboração em tempo real e visão de portfólio.
- Telemetria e operação contínua de produção.
- Katsui Company Brain e outros providers organizacionais opcionais.
- Capacidade patrocinada, settlement de inferência e descoberta patrocinada transparente, somente após validação técnica, econômica e regulatória.

## Fora do escopo do v1

- Paridade completa com VS Code e seu ecossistema.
- Esconder permanentemente código, documentos ou estado técnico.
- Organizar o produto por chats.
- Exigir Katsui, ShinAI, um agente, modelo ou provider específico.
- Embutir Company Brain, Slack, Teams, Notion, Drive, CRM ou ERP no core gratuito.
- Marketplace antes de contracts, sandbox e assinatura estarem estáveis.
- Mercado de tokens como dependência do produto.
- Garantir genericamente que software está seguro ou correto.
- Inferência paga oculta em background.

## Restrições de plataforma

- A IDE é um embedding host de componentes selecionados do `bastion-core`; ela não reimplementa capabilities, approvals, egress, memória governada, providers ou agent runtimes sem necessidade demonstrada.
- Reuso do Bastion é uma decisão de infraestrutura, não uma redução dos requisitos ou da identidade da IDE.
- A IDE não depende do produto `bastion-agent`, de seu daemon, canais, Life OS, personas, Cabinet ou interfaces.
- Projeto semântico, Guidance, intenção/specs, Local Truth Registry, workspace, preview, findings, reconciliação e UX permanecem domínios da IDE.
- Quando um contrato do Core for insuficiente para um requisito legítimo da IDE, ele deve ser estendido no `bastion-core` ou adaptado explicitamente pelo host; a limitação não pode ser escondida nem convertida silenciosamente em escopo menor.
- Dependências do Core devem ser pinadas por release ou revisão, passar por testes de conformance da IDE e possuir caminho de atualização controlado.
- A experiência essencial continua local-first, gratuita e exportável mesmo usando componentes Bastion.
- O computador principal pode compilar e testar Rust localmente quando isso acelerar o trabalho, mas não deve acumular os artefatos resultantes; o GitHub é o local de preservação dos builds completos.
- A máquina local mantém somente a versão instalada atualmente em teste. Novos artefatos substituem atomicamente a versão anterior; versões e builds históricos permanecem no GitHub.
- Artefatos e caches Rust locais possuem política rígida de orçamento, inspeção e limpeza escopada após compilação. Nenhuma rotina pode apagar caches globais ou diretórios amplos sem alvo explícito e validação.

## Critério de sucesso do v1

Uma pessoa pouco técnica consegue criar, compreender, publicar, reabrir e evoluir o benchmark usando a IDE; uma pessoa técnica alcança código, terminal e evidência bruta sem lutar contra a abstração; ambas podem trocar agente/provider e sair com todos os seus artefatos.
