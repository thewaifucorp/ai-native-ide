# Roadmap: AI-Native IDE

## Overview

O v1 prova a nova categoria por uma jornada vertical antes de expandir a plataforma: uma pessoa descreve um microsaaS, recebe orientação semântica e chega a um preview executável. A partir dessa prova, o produto ganha projeto semântico durável, workspace real e agentes intercambiáveis; depois consolida intenção↔implementação, os três modos de construção e o harness baseado em evidência. O milestone termina somente quando o mesmo projeto pode ser publicado, reaberto, corrigido e republicado sem lock-in de infraestrutura.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): planned milestone work
- Decimal phases (2.1, 2.2): urgent insertions

- [ ] **Phase 1: Category Proof** - Provar a experiência intenção → orientação → construção → preview no benchmark e resolver os maiores unknowns arquiteturais.
- [ ] **Phase 2: Durable Semantic Project** - Fazer projeto, recursos, artefatos e decisões sobreviverem a sessões, caminhos e alterações externas.
- [ ] **Phase 3: Controlled Agent Workspace** - Entregar edição, terminal, checkpoints e agentes neutros com capacidades e efeitos honestamente expostos.
- [ ] **Phase 4: Intent Reconciliation and Modes** - Tornar intenção e implementação reconciliáveis nos modos Full Vibes, Spec e Hybrid.
- [ ] **Phase 5: Evidence-Based Harness** - Entregar checks, findings, grafo, contexto, packs e readiness explicáveis sem falsas garantias.
- [ ] **Phase 6: Publish, Observe, Evolve** - Completar a jornada gratuita de publicar, reabrir, corrigir e republicar um produto real e portável.

## Phase Details

### Phase 1: Category Proof

**Goal**: Uma pessoa consegue partir de uma descrição informal e experimentar a proposta diferenciadora da IDE num microsaaS benchmark executável, enquanto os riscos arquiteturais essenciais são resolvidos por evidência.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: PROJ-01, WORK-04, INTN-01, CONF-01, LIFE-01
**Success Criteria** (what must be TRUE):

  1. Usuário inicia um projeto descrevendo o microsaaS em linguagem comum, sem escolher stack, pastas ou preencher um wizard técnico.
  2. O autocomplete orientado por intenção revela ambiguidades, decisões ausentes, riscos e conceitos relevantes antes e durante a construção.
  3. Usuário atravessa intenção, construção, preview executável, evidência inicial e uma reconciliação do benchmark de leaderboard/leilão.
  4. Erros no preview são relacionados à atividade e aos artefatos que os produziram, em vez de aparecerem como uma falha sem contexto.

**Plans**: 15 plans

Plans:
**Wave 1**

- [ ] 01-01-PLAN.md — Verify freshness-flagged package identities before installation.

**Wave 2** *(blocked on Wave 1 completion)*

- [ ] 01-02-PLAN.md — Lock the shell-neutral contracts and failing golden journey.

**Wave 3** *(blocked on Wave 2 completion)*

- [ ] 01-03-PLAN.md — Deliver guided intent and the licensed progressive Instrument UI.

**Wave 4** *(blocked on Wave 3 completion)*

- [ ] 01-04-PLAN.md — Freeze the shared Rust fixture, host conformance contract, and rubric.

**Wave 5** *(blocked on Wave 4 completion)*

- [ ] 01-05-PLAN.md — Execute identical Tauri and Electron candidate slices.

**Wave 6** *(blocked on Wave 5 completion)*

- [ ] 01-06-PLAN.md — Select and materialize the evidence-winning desktop host.

**Wave 7** *(blocked on Wave 6 completion)*

- [ ] 01-07-PLAN.md — Persist semantic project, scoped resources, revisions, and causal activity.

**Wave 8** *(blocked on Wave 7 completion)*

- [ ] 01-08-PLAN.md — Connect real project/resources through the selected desktop bridge.

**Wave 9** *(blocked on Wave 8 completion)*

- [ ] 01-09-PLAN.md — Prove real PTY streaming, cancellation, cleanup, and safe rendering.

**Wave 10** *(blocked on Wave 9 completion)*

- [ ] 01-10-PLAN.md — Probe ACP and CLI/PTTY and select one honest real-agent path.

**Wave 11** *(blocked on Wave 10 completion)*

- [ ] 01-11-PLAN.md — Broker one reversible effect through Context Dock and Activity Strip.

**Wave 12** *(blocked on Wave 11 completion)*

- [ ] 01-12-PLAN.md — Run sealed bids through the explicit transactional Rust binary.

**Wave 13** *(blocked on Wave 12 completion)*

- [ ] 01-13-PLAN.md — Isolate, supervise, fail, recover, and causally explain preview.

**Wave 14** *(blocked on Wave 13 completion)*

- [ ] 01-14-PLAN.md — Degrade AAG honestly and reconcile the bid-privacy divergence.

**Wave 15** *(blocked on Wave 14 completion)*

- [ ] 01-15-PLAN.md — Gate Game Mode on evidence and close the complete local journey.

**UI hint**: yes

**Required validation gates:**

- Validar a arquitetura de experiência (Project Rail, Navigator, Work Surface, Context Dock e Activity Strip) com sketches navegáveis antes de consolidar o shell.
- Provar que o primeiro ciclo de Game Mode premia outcome verificável, não tokens, prompts ou tempo de tela, e pode ser desligado sem alterar capacidade funcional.
- Comparar Tauri e Electron com o mesmo slice, incluindo host privilegiado, editor, PTY, preview e empacotamento.
- Provar ACP e pelo menos um caminho CLI/PTTY com autenticação, cancelamento, resume e limites observados.
- Provar AAG como provider externo degradável, sem transformá-lo em SoT.
- Provar isolamento/effect brokering mínimo e documentar efeitos apenas observáveis.
- Provar um caso de divergência intenção↔implementação e reconciliação bidirecional.

### Phase 2: Durable Semantic Project

**Goal**: Usuários possuem um projeto semântico durável, multi-recurso e diretamente editável cuja verdade local não depende de conversa ou diretório raiz.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: PROJ-02, PROJ-03, PROJ-04, PROJ-05, WORK-01, WORK-05, INTN-02, INTN-03, INTN-04, INTN-06, CONF-02, CONF-04
**Success Criteria** (what must be TRUE):

  1. Usuário vincula múltiplos repos/diretórios, reutiliza um recurso em mais de um projeto e sempre enxerga o escopo ativo sem duplicar arquivos.
  2. Usuário edita código, Markdown, configuração, assets, intenção estruturada e specs diretamente; mudanças externas aparecem sem reimportação.
  3. Sessões podem abranger o projeto ou recursos selecionados, mas fechar conversas ou a IDE não elimina arquivos, decisões, escopos ou continuidade.
  4. Usuário declara autoridades locais por assunto/escopo, vê consumidores afetados e recebe propostas de sincronização sem tornar um documento autoridade global.
  5. A IDE detecta recursos e ferramentas, aplica defaults reversíveis e mantém a interface simples e o arquivo de configuração como duas visões do mesmo estado.

**Plans**: TBD
**UI hint**: yes

### Phase 3: Controlled Agent Workspace

**Goal**: Usuários constroem software real com workspace completo e agentes/modelos intercambiáveis, sabendo exatamente quais capacidades e efeitos a IDE controla.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: WORK-02, WORK-03, AGNT-01, AGNT-02, AGNT-03, AGNT-04, AGNT-05, MODE-05, MODE-06, CTXT-03, CTXT-06, CONF-03
**Success Criteria** (what must be TRUE):

  1. Usuário executa comandos num terminal real, acompanha mudanças e aceita, ajusta ou reverte checkpoints por diff sem precisar conhecer Git.
  2. Usuário conecta um agente ACP e um loop de modelo controlado pela IDE, inicia/cancela/retoma quando suportado e troca de agente sem perder o estado do projeto.
  3. Antes de usar um adapter, o usuário vê autenticação, custo, capacidades, efeitos, isolamento e degradações reais; capacidades ausentes não são simuladas silenciosamente.
  4. Permissões balanced funcionam por projeto/recurso e o usuário pode escolher YOLO explicitamente, mantendo visíveis o histórico e os efeitos não brokerados.
  5. Contexto enviado ao agente expõe origem e escopo, preserva autoridades verbatim, e toda compressão de tool output mantém a saída bruta acessível.

**Plans**: TBD
**UI hint**: yes

### Phase 4: Intent Reconciliation and Modes

**Goal**: Usuários escolhem o ritmo de construção sem fragmentar o projeto e resolvem explicitamente divergências entre o que pretendem e o que o software faz.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: INTN-05, MODE-01, MODE-02, MODE-03, MODE-04, CTXT-04, CONF-05
**Success Criteria** (what must be TRUE):

  1. Usuário alterna entre Full Vibes, Spec Mode e Hybrid no mesmo projeto sem perder evidência nem criar artefatos incompatíveis.
  2. Full Vibes mantém o fluxo com hipóteses registradas; Spec Mode resolve contratos antes de efeitos duráveis; Hybrid separa protótipo descartável e promoção reconciliada.
  3. Quando spec/intento e comportamento divergem, o usuário vê evidência e escolhe mudar implementação, mudar intenção ou aceitar uma exceção escopada.
  4. O primeiro uso chega com Hybrid, profundidade progressiva, balanced, camadas 0/1, checkpoints e background inference desligada, sem impedir personalização posterior.
  5. Respostas permanecem concisas no fluxo comum e se aprofundam quando conceito, risco ou decisão exige compreensão.

**Plans**: TBD
**UI hint**: yes

### Phase 5: Evidence-Based Harness

**Goal**: Usuários recebem orientação e readiness baseadas em evidência, com custo e incerteza explícitos, sem warning firehose nem dependência organizacional da Katsui.
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: HRNS-01, HRNS-02, HRNS-03, HRNS-04, HRNS-05, HRNS-06, HRNS-07, CTXT-01, CTXT-02, CTXT-05
**Success Criteria** (what must be TRUE):

  1. Usuário recebe checks determinísticos gratuitos e findings semânticos incrementais com afirmação, origem, evidência, confiança, severidade e remediação visíveis.
  2. Usuário navega de requisito/assunto para SoTs, implementação, consumidores e evidência via provider local; sem o provider, o projeto funciona e fatos estruturais ficam `unknown`.
  3. Usuário ativa ou desfaz o starter pack do benchmark, entende o que ele adiciona e recebe deep evaluation/readiness antes de promoção ou publicação.
  4. Hipótese, `unknown`, `not-run` e evidência inconclusiva nunca aparecem como aprovados; usuário pode corrigir, rejeitar ou aceitar risco com justificativa e escopo.
  5. Findings equivalentes são deduplicados por consequência e momento, enquanto budget e custo de inferência podem ser vistos/limitados e nada pago roda em idle por default.

**Plans**: TBD
**UI hint**: yes

### Phase 6: Publish, Observe, Evolve

**Goal**: Uma pessoa não técnica consegue possuir o ciclo de vida do microsaaS benchmark, da publicação à correção, sem assinatura obrigatória ou infraestrutura ShinAI compulsória.
**Mode:** mvp
**Depends on**: Phase 5
**Requirements**: LIFE-02, LIFE-03, LIFE-04
**Success Criteria** (what must be TRUE):

  1. Usuário publica ou exporta o benchmark, conserva código e documentos editáveis e pode escolher infraestrutura não ShinAI.
  2. Usuário reabre o projeto publicado, relaciona um problema observado aos artefatos, altera spec ou implementação e publica uma nova versão pelo mesmo projeto.
  3. No caminho feliz inicial, o usuário fornece somente a intenção, aceita/troca o agente detectado e confirma o primeiro efeito externo irreversível.
  4. A jornada distribuída permanece funcional com recursos locais gratuitos e providers opcionais, sem exigir Company Brain, conectores organizacionais ou rail Katsui.

**Plans**: TBD
**UI hint**: yes

## Coverage

| Category | Requirements | Phase |
|---|---:|---|
| Semantic Projects | 5 | Phases 1-2 |
| Real Workspace | 5 | Phases 1-3 |
| Agents and Models | 5 | Phase 3 |
| Intent and Truth | 6 | Phases 1-4 |
| Harness and Evidence | 7 | Phase 5 |
| Modes, Policy and Effects | 6 | Phases 3-4 |
| Context and Guidance | 6 | Phases 3-5 |
| Configuration Experience | 5 | Phases 1-4 |
| Build, Publish and Continue | 4 | Phases 1 and 6 |
| **Total** | **49** | **49 mapped exactly once** |

## Progress

**Execution Order:** Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6.

| Phase | Plans Complete | Status | Completed |
|---|---:|---|---|
| 1. Category Proof | 0/15 | Not started | - |
| 2. Durable Semantic Project | 0/TBD | Not started | - |
| 3. Controlled Agent Workspace | 0/TBD | Not started | - |
| 4. Intent Reconciliation and Modes | 0/TBD | Not started | - |
| 5. Evidence-Based Harness | 0/TBD | Not started | - |
| 6. Publish, Observe, Evolve | 0/TBD | Not started | - |
