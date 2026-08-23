# AI-Native IDE — Tasks

Esta é a única fila operacional do projeto. Trabalhe de cima para baixo, salvo bloqueio explícito.

## Como usar

1. Pegue a primeira task não marcada cujo pré-requisito esteja concluído.
2. Leia `REQUIREMENTS.md` e a seção aplicável de `DESIGN.md`.
3. Implemente o menor slice vertical que satisfaça seus critérios.
4. Rode os checks relevantes e registre evidência no PR/commit ou sob a própria task.
5. Marque como concluída somente quando o critério observável estiver verdadeiro.

Não é necessário rodar GSD. `.planning/` preserva pesquisa e histórico, mas não governa a execução.

## Fase 1 — Provar a categoria

**Objetivo:** provar a jornada intenção → orientação → construção → preview → evidência → reconciliação e resolver a arquitetura desktop por evidência.

### T01 — Fundação segura

- [x] Confirmar versões, licenças e legitimidade das dependências candidatas.
- [x] Criar workspace TypeScript/Rust, scripts `dev`, `lint`, `typecheck` e `test`.
- [x] Definir contratos tipados shell-neutral para projeto, atividade, efeito, evidência e host.
- [x] Pinçar por revisão/release os crates necessários do `bastion-core` e registrar política de atualização.
- [x] Criar um embedding-host slice offline usando runtime, memory e capability registry reais.
- [x] Mapear requisitos da IDE para contratos existentes, extensões upstream e adapters exclusivos do host.
- [x] Criar GitHub Actions para fmt, lint, testes Rust/TypeScript, build Tauri e artifact Linux instalável.
- [x] Criar script de download/instalação atômica do artifact aprovado, substituindo somente o build local anterior e preservando dados.
- [x] Criar preflight de espaço e limpeza escopada para `target/`, staging e downloads do projeto.
- [x] Permitir build/test Rust local completo ou por package e executar limpeza segura de artifacts locais depois do uso.
- [x] Criar golden journey failing-first que falha somente por comportamento ainda ausente.

**Pronto quando:** workspace valida de forma reproduzível no GitHub; o artifact aprovado substitui atomicamente a única instalação local; limpeza não alcança caminhos externos; golden journey reconhece a falha esperada e rejeita falhas acidentais.

**Evidência (2026-08-23):** [CI 32627109548](https://github.com/thewaifucorp/ai-native-ide/actions/runs/32627109548) passou todos os checks, gerou e publicou o artifact Linux. O artifact foi baixado, instalado atomicamente em `.local-install`, validado via `--appimage-version` e os diretórios de download/staging foram removidos.

### T02 — Intent + Instrument inicial

- [ ] Implementar entrada de intenção e autocomplete de ambiguidades/decisões/riscos.
- [ ] Implementar orientação incremental durante a construção.
- [ ] Construir shell React com Project Rail, Navigator, Work Surface, Context Dock e Activity Strip.
- [ ] Implementar Essential e Raw como duas profundidades do mesmo estado.
- [ ] Empacotar Geologica e DM Mono com fontes, hashes e licenças.

**Pronto quando:** usuário descreve o benchmark sem wizard, recebe orientação e alcança intenção, preview placeholder e código/raw na mesma interface.

### T03 — Provar o host Tauri

- [ ] Criar slice Tauri com fronteira privilegiada, Monaco, PTY e lifecycle de preview.
- [ ] Validar subprocessos de agentes, streaming/eventos, filesystem watching, atalhos e múltiplas superfícies.
- [ ] Medir segurança, performance, consumo, empacotamento Linux e ergonomia de manutenção no artifact CI.
- [ ] Definir gates objetivos que caracterizariam um blocker estrutural do Tauri.
- [ ] Materializar manifestos, entrypoints e extension points do host Tauri.
- [ ] Manter Electron apenas como fallback documentado; não implementar segundo host sem blocker comprovado.

**Pronto quando:** o artifact Tauri instalado executa o slice completo e nenhum gate estrutural falha; qualquer exceção possui evidência e decisão registrada.

### T04 — Projeto semântico mínimo

- [ ] Persistir projeto, recursos, revisões, atividades e escopo de sessão no core Rust.
- [ ] Abrir/criar projeto por intenção e associar um repo/diretório real.
- [ ] Implementar bridge tipada UI ↔ host ↔ Rust para recursos e arquivos.
- [ ] Detectar alterações externas e emitir atividade causal.

**Pronto quando:** fechar/reabrir mantém o projeto e mudanças dentro/fora da IDE convergem sem reimportação.

### T05 — PTY e agente reais

- [ ] Ligar PTY Rust ao host e TerminalSurface com spawn/input/resize/output/cancel/exit/cleanup.
- [ ] Provar backpressure, cancelamento e ausência de processos órfãos.
- [ ] Testar adapters de `bastion-agent-runtime` para ACP, Codex e CLI/PTTY contra sua conformance suite.
- [ ] Selecionar e integrar um caminho de agente real com autenticação, sessão e cancelamento.
- [ ] Mostrar capabilities, limitações e degradações antes do uso.

**Pronto quando:** usuário executa terminal e uma sessão real de agente pela interface, cancela ambos e entende o que a IDE controla.

### T06 — Effect broker e checkpoint

- [ ] Registrar capabilities de workspace no `CapabilityRegistry` do Bastion e impedir rotas paralelas.
- [ ] Aplicar policy da IDE por projeto/recurso no momento do efeito usando os gates do Core.
- [ ] Implementar o Context Dock sobre a fila de approval e ligar aprovação ao payload exato.
- [ ] Snapshot antes da mutação; executar somente via core privilegiado.
- [ ] Alimentar Activity Strip com observer events, diff e rollback; rejeitar bypass e replay alterado.

**Pronto quando:** uma alteração real pausa, explica consequência, executa após aprovação e pode ser revertida; nenhum caminho direto contorna o broker.

### T07 — Benchmark executável

- [ ] Implementar leaderboard/leilão de posição com domínio transacional Rust.
- [ ] Expor endpoint/processo Rust explícito ao servidor do benchmark.
- [ ] Provar bids concorrentes, desempate, privacidade e consistência.
- [ ] Alimentar o fluxo usando o agente e o effect broker reais.

**Pronto quando:** o benchmark funciona sob concorrência e o preview usa a mesma rota transacional testada.

### T08 — Preview, evidência e reconciliação

- [ ] Supervisionar preview com starting/healthy/stale/broken/reconnecting.
- [ ] Correlacionar erro ao efeito, atividade e arquivos causais.
- [ ] Integrar AAG como provider externo opcional e degradável.
- [ ] Registrar intenção/spec do benchmark e detectar uma divergência real.
- [ ] Permitir reconciliar mudando implementação, intenção ou aceitando exceção escopada.

**Pronto quando:** uma falha provocada aponta sua causa e uma divergência bidirecional é resolvida com evidência, inclusive com AAG indisponível.

### T09 — Game Mode e journey completa

- [ ] Emitir `OutcomeVerified` somente após evidência independente.
- [ ] Conceder progresso apenas a outcomes verificados.
- [ ] Implementar receipt e desligamento sem lacuna funcional.
- [ ] Rodar jornada completa intenção → agente → efeito → preview → erro → evidência → reconciliação.

**Pronto quando:** autorização, tokens, prompts, tempo e linhas não geram progresso; a golden journey passa no host real.

### Gate da Fase 1

- [ ] Uma pessoa parte de uma descrição informal e chega ao benchmark executável.
- [ ] O host Tauri passou pelos gates de viabilidade no artifact produzido pelo GitHub.
- [ ] PTY, agente, efeito, preview, evidência e reconciliação atravessam uma rota real de ponta a ponta.
- [ ] Erros de preview apontam atividade e artefatos causais.

**Estado (2026-08-23):** existem slices e testes de contrato para partes dessa
jornada, mas eles não constituem aceitação do Gate. Em especial, a interação do
aplicativo instalado com agente, diretório, efeitos e preview ainda precisa funcionar
e ser verificada no host Tauri antes de qualquer item acima ser marcado.

## Fase 2 — Tornar o projeto durável

**Objetivo:** fazer projeto, recursos, arquivos, specs e decisões sobreviverem a sessões, caminhos e alterações externas.

### T10 — Multi-repo e recursos reutilizáveis

- [ ] Vincular múltiplos repos/diretórios/serviços/ambientes.
- [ ] Permitir um recurso em múltiplos projetos sem duplicação.
- [ ] Tornar escopo de cada sessão explícito.
- [ ] Implementar edição real de código, Markdown, config e assets.

### T11 — Local Truth Registry

- [ ] Declarar autoridades por assunto/escopo e precedência.
- [ ] Capturar decisões de sessão como candidates revisáveis.
- [ ] Mapear consumidores e propor sincronização.
- [ ] Preservar tudo em arquivos locais/versionáveis.
- [ ] Implementar Guidance Library com poucos conjuntos estáveis e registry de metadados.
- [ ] Suportar orientação pessoal, de projeto, recurso/caminho e tarefa/sessão.
- [ ] Implementar os quatro destinos: usar agora, incorporar, criar estável ou registrar como decisão histórica.
- [ ] Mostrar `Applied now` com origem, escopo e motivo de cada orientação compilada.
- [ ] Detectar duplicata, conflito, obsolescência e duração inadequada sem alterar regras silenciosamente.
- [ ] Importar steering files e formatos equivalentes como candidates classificados e revisáveis.

### T12 — Configuração simples e completa

- [ ] Detectar recursos/providers e aplicar defaults reversíveis.
- [ ] Implementar configuração just-in-time em linguagem comum.
- [ ] Unificar UI simples e arquivo completo sobre o mesmo schema.
- [ ] Criar perfis de layout/profundidade sem fragmentar projeto.

### Gate da Fase 2

- [ ] Um projeto reúne múltiplos recursos e pode reutilizá-los sem duplicação.
- [ ] Fechar sessões ou a IDE não perde estado durável.
- [ ] Código, Markdown, config, assets, intenção e specs são editáveis diretamente.
- [ ] SoTs locais e consumidores sobrevivem em arquivos versionáveis.
- [ ] Guidance persiste fora das sessões, aplica somente o escopo relevante e não acumula instruções pontuais como regras eternas.

## Fase 3 — Entregar o workspace controlado

**Objetivo:** completar edição, terminal, diff e agentes intercambiáveis com capacidades e efeitos honestamente expostos.

### T13 — Diff e checkpoints completos

- [ ] Inspeção/edição de diff, accept parcial e rollback compreensível.
- [ ] Policies por projeto, recurso, ferramenta e efeito.
- [ ] YOLO explícito com histórico integral.

### T14 — Matriz de adapters

- [ ] Adapter ACP completo baseado em `bastion-agent-runtime`.
- [ ] Loop de modelo controlado pela IDE.
- [ ] Sessão start/cancel/resume conforme capability.
- [ ] Troca de agente sem perda de estado.
- [ ] Renderizar `PolicyCoverage`, custos, contexto enviado e raw output.

### Gate da Fase 3

- [ ] Usuário opera terminal, diff e checkpoint sem precisar dominar Git.
- [ ] ACP e um loop controlado pela IDE funcionam de verdade.
- [ ] Trocar agente não perde estado do projeto.
- [ ] Permissões por recurso e YOLO explícito mantêm histórico e degradações visíveis.

## Fase 4 — Consolidar modos e reconciliação

**Objetivo:** permitir ritmos diferentes de construção no mesmo projeto e resolver divergências entre intenção e comportamento.

### T15 — Full Vibes, Spec e Hybrid

- [ ] Policies de interrupção específicas de cada modo.
- [ ] Promoção de protótipo em Hybrid.
- [ ] Specs editáveis e reconciliação compartilhada entre modos.
- [ ] Troca de modo sem migração nem perda de evidência.

### T16 — Contexto e orientação madura

- [ ] Context compiler com provenance e budget.
- [ ] Resposta adaptativa concisa/detalhada.
- [ ] Navegação assunto → SoT → implementação → evidência.
- [ ] Raw output sempre acessível.

### Gate da Fase 4

- [ ] Full Vibes, Spec e Hybrid compartilham os mesmos artefatos e evidências.
- [ ] Trocar modo não exige migração nem perde estado.
- [ ] Divergência pode ser resolvida mudando intenção, implementação ou exceção escopada.
- [ ] Defaults funcionam sem setup e aprofundamento permanece disponível.

## Fase 5 — Entregar o harness baseado em evidência

**Objetivo:** oferecer checks e orientação explicáveis, budgetados e honestos, sem warning firehose ou falsas garantias.

### T17 — Camada 0 determinística

- [ ] Build/test/typecheck, secrets, dependencies, Git/diff e effects.
- [ ] Estados passed/failed/unknown/not-run.
- [ ] Findings revisáveis e deduplicados.

### T18 — Camada 1 semântica

- [ ] Avaliadores de ambiguidades, riscos, decisões e divergências.
- [ ] Evidência, confiança, severidade e remediação em todo finding.
- [ ] Cache, budget e nenhuma inferência paga idle.

### T19 — Packs e deep evaluation

- [ ] Formato declarativo e sandbox/capabilities.
- [ ] Starter pack do benchmark reversível.
- [ ] Readiness em promoção/publicação.
- [ ] Correção, falso positivo e exceção escopada.

### Gate da Fase 5

- [ ] Checks determinísticos e semânticos distinguem fato, hipótese, unknown e not-run.
- [ ] Todo finding possui evidência, confiança, severidade, remediação e revisão.
- [ ] AAG melhora navegação, mas sua ausência não quebra nem falsifica o projeto.
- [ ] Pack e readiness do benchmark são explicáveis, reversíveis e budgetados.

## Fase 6 — Publicar, observar e evoluir

**Objetivo:** completar o ciclo de vida gratuito e portável de um produto publicado até sua correção e republicação.

### T20 — Exportar e publicar

- [ ] Fluxo local gratuito de export/deploy sem lock-in.
- [ ] Primeiro efeito externo irreversível com confirmação just-in-time.
- [ ] Evidência e rollback/compensação quando possível.

### T21 — Operar e republicar

- [ ] Reabrir produto publicado no mesmo projeto.
- [ ] Relacionar problema observado a recursos e intenção.
- [ ] Corrigir spec/implementação e publicar nova versão.
- [ ] Validar jornada completa com pessoa pouco técnica.

### Gate da Fase 6 / v1

- [ ] Benchmark pode ser exportado/publicado sem infraestrutura ShinAI obrigatória.
- [ ] Projeto publicado pode ser reaberto, diagnosticado, corrigido e republicado.
- [ ] Caminho feliz pede somente intenção, agente e primeiro efeito externo irreversível.
- [ ] Pessoa pouco técnica completa a jornada e pessoa técnica preserva acesso raw.

## Futuro, não iniciar antes do v1

- [ ] Voz e edição visual.
- [ ] Agentes paralelos/background.
- [ ] Marketplace e plugins executáveis.
- [ ] Colaboração multiplayer e portfólio.
- [ ] Observabilidade de produção avançada.
- [ ] Katsui Company Brain/provider organizacional.
- [ ] Economia de capacidade/tokens e distribuição patrocinada.
