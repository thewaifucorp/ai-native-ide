# AI-Native IDE — Tasks

Esta é a única fila operacional do projeto. Trabalhe de cima para baixo, salvo bloqueio explícito.

## Como usar

1. Pegue a primeira task não marcada cujo pré-requisito esteja concluído.
2. Leia `REQUIREMENTS.md` e a seção aplicável de `DESIGN.md`.
3. Implemente o menor slice vertical que satisfaça seus critérios.
4. Rode os checks relevantes e registre evidência no PR/commit ou sob a própria task.
5. Marque como concluída somente quando o critério observável estiver verdadeiro.

Não é necessário rodar GSD. `.planning/` preserva pesquisa e histórico, mas não governa a execução.

## Decisão operacional — execução do Gate 1

**Decidido em 2026-08-23.** O usuário não é o operador de QA de cada task. A
equipe executa e valida o Gate autonomamente; o usuário recebe somente builds
utilizáveis, evidência consolidada ou bloqueios que exijam credencial/decisão
externa.

### Regra de conclusão

Uma task só recebe `[x]` quando seu comportamento funciona no artifact Tauri,
além de passar os checks automatizados relevantes. Código parcialmente ligado,
mock, contrato estático, preview web e teste unitário não contam como aceitação
do aplicativo instalado.

### Ondas de execução

1. **Onda A — aplicação operável:** T02 e T03. A UI deixa de ser shell estático:
   intenção, projeto, diretório, orientação, Essential/Raw e host Tauri funcionam
   no artifact.
2. **Onda B — workspace controlado:** T04, T05 e T06. Persistência e mudanças
   externas, PTY, agente ACPX, effects, aprovação e rollback atravessam o host.
3. **Onda C — prova da categoria:** T07, T08 e T09. Benchmark transacional,
   preview, evidência, reconciliação e Game Mode completam a jornada.

Cada onda inclui implementação, testes, build/artifact e smoke test do host.
Autenticação de um provider externo pode exigir a conta do usuário; ausência de
autorização deve degradar explicitamente e nunca bloquear os demais fluxos.

### Estado de partida auditado

- T01 está concluída.
- T02–T09 possuem código exploratório e/ou testes de contrato, mas **nenhuma**
  está aceita ainda.
- O Gate 1 permanece aberto até as três ondas acima concluírem no aplicativo
  instalado.

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

- [x] Implementar entrada de intenção e autocomplete de ambiguidades/decisões/riscos.
- [x] Implementar orientação incremental durante a construção.
- [x] Construir shell React com Project Rail, Navigator, Work Surface, Context Dock e Activity Strip.
- [x] Implementar Essential e Raw como duas profundidades do mesmo estado.
- [x] Empacotar Geologica e DM Mono com fontes, hashes e licenças.

**Pronto quando:** usuário descreve o benchmark sem wizard, recebe orientação e alcança intenção, preview placeholder e código/raw na mesma interface.

**Evidência (2026-08-23):** `npm run check`, `cargo test --workspace` e
`cargo clippy --workspace --all-targets -- -D warnings` passaram. O bundle Linux
foi gerado como `.deb`/`.rpm`; o `.deb` foi instalado atomicamente em
`.local-install` e o binário Tauri foi aberto com sucesso em display virtual.

### T03 — Provar o host Tauri

- [x] Criar slice Tauri com fronteira privilegiada, Monaco, PTY e lifecycle de preview.
- [x] Validar subprocessos de agentes, streaming/eventos, filesystem watching, atalhos e múltiplas superfícies.
- [ ] Medir segurança, performance, consumo, empacotamento Linux e ergonomia de manutenção no artifact CI.
- [x] Definir gates objetivos que caracterizariam um blocker estrutural do Tauri.
- [x] Materializar manifestos, entrypoints e extension points do host Tauri.
- [x] Manter Electron apenas como fallback documentado; não implementar segundo host sem blocker comprovado.

**Pronto quando:** o artifact Tauri instalado executa o slice completo e nenhum gate estrutural falha; qualquer exceção possui evidência e decisão registrada.

**Evidência (2026-08-24):** o CI do GitHub validou o artifact Tauri em Linux e
Windows. Em Windows, `cargo test -p ai-native-ide-desktop --lib` passou os 8
testes, incluindo a golden journey que confirma streaming real pelo PTY; a
regressão ConPTY foi corrigida com backend Windows direto e caminhos de comando
em formato DOS. A aceitação da instalação Windows foi movida para T09 após o
MSI ter instalado somente seu atalho de desinstalação. Em Linux, `cargo test -p ai-native-ide-desktop --lib` passou 11
testes e `npm run check` passou 19; o pacote `.deb` foi gerado, instalado
atomicamente em `.local-install` e executado sob `xvfb` por 8 s. O host mantém
IPC tipado/allowlisted, Monaco, superfícies Preview/Terminal/Raw Evidence,
watcher nativo e Electron somente como fallback documentado.

### T04 — Projeto semântico mínimo

- [x] Persistir projeto, recursos, revisões, atividades e escopo de sessão no core Rust.
- [x] Abrir/criar projeto por intenção e associar um repo/diretório real.
- [x] Implementar bridge tipada UI ↔ host ↔ Rust para recursos e arquivos.
- [x] Detectar alterações externas e emitir atividade causal.

**Pronto quando:** fechar/reabrir mantém o projeto e mudanças dentro/fora da IDE convergem sem reimportação.

**Evidência (2026-08-23):** `open_semantic_project` reidrata recursos
persistidos e reinicia watchers sem repassar caminhos ao renderer. O watcher
nativo registra snapshots externos como revisões `ExternalUnknown` e o evento
observável entra no Activity Strip; revisões de effects mantêm a causalidade do
efeito aprovado. Testes Rust cobrem persistência/reabertura, escopo de sessão,
paths confinados e mudança externa; o client TypeScript cobre a reabertura pela
bridge tipada.

### T05 — PTY e agente reais

- [x] Ligar PTY Rust ao host e TerminalSurface com spawn/input/resize/output/cancel/exit/cleanup.
- [x] Provar backpressure, cancelamento e ausência de processos órfãos.
- [x] Testar adapters de `bastion-agent-runtime` para ACP, Codex e CLI/PTTY contra sua conformance suite.
- [x] Selecionar e integrar um caminho de agente real com autenticação, sessão e cancelamento.
- [x] Mostrar capabilities, limitações e degradações antes do uso.

**Pronto quando:** usuário executa terminal e uma sessão real de agente pela interface, cancela ambos e entende o que a IDE controla.

**Evidência (2026-08-24):** o host expõe sessões PTY opacas ao `TerminalSurface`,
com input/resize/poll/cancel, chunks de 16 KiB e limite nativo de 10 MiB por
PTY. `cargo test -p ai-native-ide-desktop --lib`, `cargo test -p ide-agent` e
`npm run check` passaram; uma sessão ACPX real respondeu sob política sem
permissões, enquanto a interface deixa explícita a fronteira read-only e a
degradação do provider.

### T06 — Effect broker e checkpoint

- [x] Registrar capabilities de workspace no `CapabilityRegistry` do Bastion e impedir rotas paralelas.
- [x] Aplicar policy da IDE por projeto/recurso no momento do efeito usando os gates do Core.
- [x] Implementar o Context Dock sobre a fila de approval e ligar aprovação ao payload exato.
- [x] Snapshot antes da mutação; executar somente via core privilegiado.
- [x] Alimentar Activity Strip com observer events, diff e rollback; rejeitar bypass e replay alterado.

**Pronto quando:** uma alteração real pausa, explica consequência, executa após aprovação e pode ser revertida; nenhum caminho direto contorna o broker.

**Evidência (2026-08-24):** `WorkspaceEffectBroker` registra a capability
`ide:workspace_write`, mantém aprovação por recurso e rejeita reuso de uma
aprovação com payload alterado. Os testes de workspace provam snapshot, escrita
aprovada, rollback e criação/remoção de arquivo; o Context Dock usa somente a
bridge tipada para propor, aprovar e reverter.

### T07 — Benchmark executável

- [x] Implementar leaderboard/leilão de posição com domínio transacional Rust.
- [x] Expor endpoint/processo Rust explícito ao servidor do benchmark.
- [x] Provar bids concorrentes, desempate, privacidade e consistência.
- [x] Alimentar o fluxo usando o agente e o effect broker reais.

**Pronto quando:** o benchmark funciona sob concorrência e o preview usa a mesma rota transacional testada.

### T08 — Preview, evidência e reconciliação

- [x] Supervisionar preview com starting/healthy/stale/broken/reconnecting.
- [x] Correlacionar erro ao efeito, atividade e arquivos causais.
- [x] Integrar AAG como provider externo opcional e degradável.
- [x] Registrar intenção/spec do benchmark e detectar uma divergência real.
- [x] Permitir reconciliar mudando implementação, intenção ou aceitando exceção escopada.

**Pronto quando:** uma falha provocada aponta sua causa e uma divergência bidirecional é resolvida com evidência, inclusive com AAG indisponível.

### T09 — Game Mode e journey completa

- [x] Emitir `OutcomeVerified` somente após evidência independente.
- [x] Conceder progresso apenas a outcomes verificados.
- [x] Implementar receipt e desligamento sem lacuna funcional.
- [x] Rodar jornada completa intenção → agente → efeito → preview → erro → evidência → reconciliação.
- [ ] Validar no CI o instalador Windows: instalação silenciosa deixa o executável principal no diretório do usuário antes de publicar o artifact.

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
