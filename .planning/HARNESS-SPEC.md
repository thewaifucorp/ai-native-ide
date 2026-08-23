# HARNESS-SPEC — AI-Native IDE

**Status:** Gate 0 em discussão  
**Criado:** 2026-08-22  
**Autoridade:** contrato vivo do harness default; decisões abertas permanecem explicitamente abertas  
**Contexto fundador:** `FIRST.md`  
**Contexto do produto:** `.planning/PROJECT.md`  
**Pesquisa:** `.planning/research/SUMMARY.md`

## 1. Propósito

O harness default é o sistema que envolve modelos e agentes para tornar a construção de software guiada, observável, verificável e reconciliável. Ele não é um segundo agente, um prompt monolítico nem apenas um lint operado por IA.

O harness deve permitir que pessoas não técnicas construam e mantenham software real sem esconder código, documentos ou incerteza. Para pessoas técnicas, deve acrescentar contexto, economia, evidência e controle sem reduzir acesso ao sistema subjacente.

Seu ciclo central é:

```text
intenção guiada
    → construção observável
    → evidência
    → findings
    → reconciliação entre intenção/spec e implementação
```

## 2. Dois eixos complementares

A composição default possui dois eixos que não se substituem:

1. **Camadas de avaliação:** quais tipos de checks o harness executa.
2. **Subsistemas de suporte:** como o harness obtém contexto, dispara checks, controla efeitos e produz evidência.

## 3. As quatro camadas de avaliação

### 3.1 Camada 0 — invariantes universais

Sempre ativa, barata e preferencialmente determinística.

Inclui, conforme aplicável:

- segredos e credenciais;
- permissões e escopo de recursos;
- comandos destrutivos;
- efeitos externos;
- build, testes e typecheck;
- dependências e vulnerabilidades observáveis;
- estado Git, diff e checkpoints;
- proveniência de contexto e artefatos;
- policies universais do projeto;
- distinção obrigatória entre `passed`, `failed`, `unknown` e `not-run`.

Esta camada fornece fatos e gates objetivos. Ausência de finding nunca prova segurança total.

### 3.2 Camada 1 — compreensão semântica geral do produto

Ativa por default, incremental, cacheada, sujeita a budget e majoritariamente não bloqueante.

Inclui:

- ambiguidades na intenção;
- decisões ausentes;
- contradições entre requisitos;
- requisito sem implementação ou evidência;
- implementação sem intenção registrada quando relevante;
- mudança de comportamento sem reconciliação documental;
- riscos prováveis;
- conhecimentos e conceitos que o usuário precisa compreender naquele momento;
- sugestões de especificação, teste e remediação.

Resultados probabilísticos são hipóteses com confiança e evidência, nunca fatos disfarçados.

### 3.3 Camada 2 — packs de domínio

Detectados ou escolhidos de forma transparente. A IDE pode sugerir ativação, mas deve mostrar o que foi ativado, por quê e qual custo/capacidade adiciona.

Exemplos:

- e-commerce e lojas;
- pagamentos;
- autenticação;
- marketplace e leilão;
- ferramenta interna;
- chatbot/agente comercial;
- saúde;
- aplicações infantis;
- infraestrutura e deploy.

Packs podem incluir invariantes, perguntas guiadas, evaluators, guias, templates, corpus de exemplos e critérios de readiness. Não recebem execução nativa irrestrita por default.

### 3.4 Camada 3 — avaliações profundas

Executadas em checkpoints relevantes, não continuamente sem necessidade.

Exemplos de gatilho:

- promover protótipo descartável a produto durável;
- concluir uma feature;
- publicar/deployar;
- migrar banco;
- alterar autenticação ou pagamento;
- mudar contrato compartilhado;
- declarar um problema resolvido.

Podem usar análise mais cara, gerar testes, executar cenários e comparar comportamento observado com intenção.

## 4. As cinco partes inseparáveis

### 4.1 Local Truth Registry

Registra quais fontes possuem autoridade para quais perguntas, seu escopo, precedência, consumidores e relações. Não copia necessariamente o conteúdo: arquivos locais continuam sendo dados humanos, editáveis e versionáveis.

Tipos de autoridade não devem ser confundidos:

- intenção do produto;
- contrato de domínio;
- decisão arquitetural;
- implementação observada;
- estado operacional;
- backlog;
- evidência;
- histórico de decisão.

O sistema não escolhe silenciosamente entre duas fontes autoritativas conflitantes. O conflito vira finding revisável.

Exemplo conceitual:

```yaml
truth:
  - id: product-contract
    source: docs/PRODUCT.md
    authority: declared-intent
    scope: project

  - id: payment-contract
    source: docs/PAYMENTS.md
    authority: domain-contract
    consumers:
      - resource: frontend
      - resource: api
      - resource: workers
```

### 4.2 Lifecycle Hook Bus

Oferece eventos confiáveis da IDE, independentes da boa vontade do agente.

Eventos candidatos:

- session/project start;
- pre/post search;
- pre/post read;
- pre/post edit;
- pre/post tool/effect;
- dependency/install;
- test/build;
- checkpoint;
- session completion;
- prototype promotion;
- deploy/publish;
- runtime observation;
- external file change.

Hooks podem observar, enriquecer contexto, produzir finding, solicitar confirmação ou acionar policy. Nem todo adapter permite interceptar todos os eventos; a degradação precisa ser visível.

Hooks documentais:

- antes de editar, apresentar contratos e decisões aplicáveis;
- depois de editar código, marcar consumidores documentais potencialmente stale;
- depois de editar uma fonte autoritativa, calcular consumidores afetados;
- em checkpoint, verificar a cadeia decisão → spec → implementação → evidência;
- ao encerrar sessão, identificar decisões ainda presas no chat;
- antes do deploy, mostrar divergências aceitas, desconhecidas e bloqueantes.

Uma fonte autoritativa nunca é reescrita silenciosamente. O hook detecta, explica, propõe patch e aplica conforme modo/policy, mantendo o efeito no histórico.

### 4.3 AAG / Knowledge and Evidence Graph Provider

AAG é o provider estrutural inicial preferido para fatos observados de código e documentos.

Capacidades existentes relevantes:

- indexação local determinística com tree-sitter e SQLite;
- atualização incremental;
- código, documentos, contratos e mídia no grafo;
- relações de explicação/referência;
- proveniência `Declared` versus `Observed`;
- confiança `EXTRACTED`, `INFERRED` e `AMBIGUOUS`;
- callers, impacto, processos, fluxos e navegação;
- grupos de repositórios e workspaces;
- hooks de busca, edição e início de sessão;
- MCP, CLI e protocolo exportável.

Fronteira:

```text
AAG
  = grafo recomputável do que existe nos recursos

Intent/Truth Graph da IDE
  = o que o projeto declara, decide e espera

Evidence Index
  = relações revisáveis entre declaração e observação
```

AAG não é a fonte de verdade da IDE. A integração inicial deve preservar AAG como produto OSS independente, preferindo processo/MCP/protocolo antes de acoplar crates internas.

### 4.4 Context Compiler

Seleciona, organiza e comprime contexto para humanos e agentes. Não decide verdade nem enforcement.

Três superfícies independentes:

1. **Apresentação:** verbosidade, explicação técnica/simplificada, perfis como Caveman.
2. **Saída de ferramentas:** RTK, deduplicação, truncamento e seleção de logs.
3. **Memória/contexto do agente:** navegação, seleção de fontes, budget, sumarização, cache e compressão via provider opcional.

RTK pode ser ligado automaticamente em ferramentas compatíveis. Caveman pode ser um perfil de apresentação. Shiori/Iai Gate podem fornecer compressão e economia avançadas sem se tornarem dependências obrigatórias.

Nunca comprimir como autoridade sem preservação verbatim e referência:

- policies e permissões;
- comandos destrutivos;
- código/diff usado como evidência;
- requisitos canônicos;
- valores financeiros;
- estados `unknown`, `assumed`, `verified`, `failed`;
- proveniência.

Nenhuma inferência billable roda em idle sem escolha e budget claros.

### 4.5 Semantic Evaluators and Reconciler

Executa as quatro camadas, produz findings e ajuda a reconciliar intenção/spec e implementação.

Todo finding deve conter:

- identidade estável;
- evaluator e versão;
- camada;
- origem;
- escopo;
- afirmação;
- evidência e proveniência;
- confiança;
- severidade;
- remediação sugerida;
- enforcement aplicável;
- estado de revisão;
- exceção, justificativa, escopo e prazo quando existir.

A IA pode levantar hipóteses e gerar candidatos a testes/evidências. Ela não escolhe sozinha o enforcement nem declara sua própria hipótese como prova.

## 5. Control plane ampliado

As cinco partes acima dependem de três capacidades estruturais adicionais da IDE:

1. **Project Model:** projetos semânticos, recursos reutilizáveis, repos, artefatos e sessões.
2. **Policy & Effect Broker:** permissões, segredos, comandos, escritas, rede e publicação.
3. **Agent Adapters:** ACP, CLI, PTY, APIs, modelos locais e agentes próprios, com capability negotiation e degradação explícita.

Essas capacidades são substrato do produto, não plugins opcionais do harness.

## 6. Responsabilidade da IDE versus competência do agente

### A IDE deve garantir

- identidade, escopo e autoridade dos recursos;
- projeto e sessão como domínios distintos;
- proveniência do contexto;
- lifecycle hooks;
- capabilities e limitações declaradas dos adapters;
- enforcement no effect broker/sandbox quando possível;
- estado e evidência dos findings;
- budgets e custos visíveis;
- reconciliação proposta/revisável;
- acesso direto e editável a código, Markdown e configuração.

### Agentes/packs podem fornecer

- conhecimento de domínio;
- competências de frameworks;
- estratégias de construção;
- geração de testes;
- investigação de findings;
- propostas de spec e remediação;
- uso especializado de ferramentas como AAG.

### Não confiar somente ao agente

- decidir quais documentos são canônicos;
- registrar se uma decisão foi incorporada;
- escolher o próprio enforcement;
- declarar a própria saída como verificada;
- autorizar os próprios efeitos;
- esconder origem de contexto;
- decidir gasto de análise sem budget.

## 7. Modos de construção

Full Vibes, Spec Mode e Hybrid usam o mesmo projeto, truth registry, findings e evidências. Modos alteram momento e limiar de interrupção; não alteram a verdade nem apagam evidência.

### Full Vibes

- prioriza fluxo e construção;
- permite avançar com mais hipóteses e avisos;
- registra decisões e dívidas para reconciliação posterior;
- ainda respeita policies bloqueantes objetivas.

### Spec Mode

- resolve ambiguidades e decisões importantes antes de efeitos duráveis;
- explicita contratos, consumidores e evidências esperadas;
- usa checks semânticos mais cedo.

### Hybrid

- materializa um preview/protótipo descartável para provocar decisões;
- distingue claramente estado experimental de estado durável;
- usa um checkpoint para promover o protótipo e consolidar spec/intento.

## 8. Fronteira AI-Native IDE versus Katsui Company Brain

### 8.1 Capacidade gratuita necessária na IDE

A IDE inclui um **Local Truth Registry**, porque sem ele o estado dual intenção/spec ↔ código não funciona.

Inclui gratuitamente:

- declarar arquivos locais como autoridades por escopo;
- ligar documentos a recursos, repos e consumidores;
- navegar documentos locais;
- busca estrutural/lexical local;
- detectar staleness e divergência;
- propor patches de sincronização;
- preservar decisões fora do chat;
- usar Git e evidências recomputáveis.

Arquivos locais continuam sendo os dados. A IDE não oferece gratuitamente um store corporativo completo disfarçado.

### 8.2 Capacidade Katsui Company Brain

Company Brain é o **Organization Truth Provider** recomendado e mais completo.

Permanece fora do núcleo gratuito:

- ingestão automática de Slack, Teams, Notion, Drive, CRM, ERP e outras fontes;
- Mugen para extração, transformação e carga;
- store organizacional independente de arquivos locais;
- RAG corporativo, embeddings, rewrite e rerank;
- registries corporativos versionados de skills, prompts, regras e tooling;
- propagação de políticas entre equipes, agentes e projetos;
- aprendizado coletivo e curadoria organizacional;
- Knowledge Layer multi-owner;
- Ontology Layer e objetos de negócio vivos;
- timeline operacional, Safe-DB e named actions;
- cloud sync, governança, isolamento e controles empresariais.

Fronteira resumida:

```text
AI-Native IDE Local Truth Registry
  = autoridade local do projeto

Katsui Company Brain
  = memória e estado autoritativos da organização
```

A IDE deve aceitar providers alternativos e funcionar offline. Katsui não é dependência obrigatória nem recebe recomendação oculta. A integração pode ser especialmente profunda e servir como distribuição natural.

### 8.3 Outros componentes Katsui como providers opcionais

| Capacidade | Núcleo da IDE | Provider Katsui potencial |
|---|---|---|
| Grafo estrutural local | Contrato/provider | AAG |
| Compressão básica e budgets | Context Compiler | Shiori/Iai Gate |
| Routing/model economics | Adapter/gateway neutro | Iai Gate |
| Conhecimento organizacional | Interface de provider | Company Brain |
| Ingestão empresarial | Fora do núcleo | Mugen |
| Guardrails avançados | Policies base | Kekkai Shield |
| Workers/agentes especializados | Adapter/plugin | Bastion/Katsui |

Capacidades locais da IDE devem ser suficientes e honestas, mas não precisam replicar profundidade, conectores, governança ou serving do produto Katsui.

## 9. Princípios de segurança e honestidade

- ACP não é sandbox.
- Observar efeito não equivale a poder impedi-lo.
- Garantia forte só existe para efeitos brokerados ou executados em isolamento controlado.
- `unknown` nunca aparece como `passed`.
- Finding probabilístico nunca aparece como fato determinístico.
- A IA não escolhe enforcement.
- O harness não reescreve intenção ou código silenciosamente.
- O harness não executa inferência paga em idle sem escolha clara.
- Recomendação patrocinada, Katsui ou de outro provider deve ser identificada.
- Monetização nunca pode criar incentivo para warnings artificiais ou consumo desnecessário.

## 10. Modelo decidido de SoT e autoridade

Uma fonte não é autoridade absoluta. Um `AuthorityGrant` declara quais assuntos ela governa, em qual escopo e durante qual validade.

Objetos mínimos:

| Objeto | Responsabilidade |
|---|---|
| `TruthSource` | Arquivo ou provider que contém declarações humanas/machine-readable |
| `AuthorityGrant` | Assuntos, escopo, precedência e validade que uma fonte governa |
| `Decision` | Escolha explícita, justificativa, status e relação de supersessão |
| `ConsumerLink` | Recurso, contrato, pack ou projeto que deve respeitar a decisão |
| `Evidence` | Observação que sustenta, contradiz ou deixa a declaração inconclusiva |
| `Conflict` | Divergência revisável entre autoridades ou entre declarado e observado |

Estados de decisão:

```text
candidate → provisional → accepted → superseded → archived
```

- Sessões criam `candidate` automaticamente para nenhuma decisão importante morrer no transcript.
- Policy explícita pode promover automaticamente classes delimitadas.
- Sem policy, automação pode chegar a `provisional`, nunca a `accepted`.
- Full Vibes captura e reconcilia em checkpoint; Spec interrompe decisões contratuais antes do efeito durável; Hybrid consolida na promoção do protótipo.
- Precedência é resolvida por assunto, escopo, status, especificidade, validade/versão e supersessão explícita; nunca por uma ordem global "docs vencem código".
- Intenção aceita e comportamento observado permanecem duas verdades revisáveis. Contradição gera `Conflict`.
- Arquivos/manifests guardam o estado autoritativo portátil; SQLite guarda projeções, índices, cache, sessões e findings recomputáveis.

## 11. Taxonomia decidida de evaluators

| Classe | Fonte principal | Exemplos | Pode provar? |
|---|---|---|---|
| Deterministic | ferramentas locais | build, teste, schema, segredo, policy | Sim, somente a afirmação medida |
| Structural | AAG/LSP/AST/Git | callers, dependências, superfície afetada | Sim para fatos extraídos; inferências mantêm confiança |
| Contract | SoTs/schemas/consumidores | spec↔API, decisão↔implementação | Prova conformidade ao contrato observado, não correção do contrato |
| Runtime | preview/test/probe/telemetria | comportamento, erro, latência, fluxo | Sim para a execução observada |
| Semantic | modelo + contexto com provenance | ambiguidade, risco, contradição provável | Não sozinho; produz hipótese |
| Domain Pack | regras/evals do domínio | pagamento, marketplace, saúde | Depende do evaluator interno; pack não eleva confiança por si |
| Readiness | agrega evidências | pronto para promover/deployar | Conclusão condicionada e explicável, nunca selo absoluto |

Evaluators apenas produzem findings/evidências. Policy separada transforma findings em UX ou enforcement.

## 12. Contrato decidido de finding e evidência

```yaml
finding:
  id: stable-id
  evaluator: evaluator-id@version
  layer: universal|semantic|domain|deep
  assertion: human-readable claim
  scope: [project/resource/artifact/span]
  evidence:
    - kind: deterministic|structural|runtime|human|model
      source: stable-reference
      observed_at: timestamp
      result: supports|contradicts|inconclusive
  confidence: exact|high|medium|low|unknown
  severity: info|low|medium|high|critical
  disposition: open|accepted-risk|fixed|false-positive|superseded
  remediation: optional
  enforcement: inform|suggest|warn|require-confirmation|block-by-policy
  exception:
    reason: optional
    scope: optional
    expires_at: optional
```

Regras:

- `verified` exige evidência determinística, runtime ou aceitação humana claramente escopada.
- Evidência de modelo nunca se autoeleva a `verified`.
- Findings são deduplicados por afirmação, escopo, evaluator e versão relevante.
- Evidência vencida ou invalidada reabre a conclusão.
- Exceções possuem justificativa, escopo e preferencialmente expiração.
- `unknown`, `not-run` e `inconclusive` permanecem visíveis.

## 13. Pipeline e lifecycle decididos

```text
H0 scope + provenance
  → H1 preflight de intenção/contexto
  → H2 inspeção do plano
  → H3 admissão de efeitos
  → H4 observação de ações/artefatos
  → H5 avaliação de resultado
  → H6 reconciliação/checkpoint
```

- Checks determinísticos incrementais rodam em mudanças relevantes.
- Checks semânticos rodam em fronteiras de turno/mudança significativa, com debounce, cache e budget.
- Deep evals rodam em checkpoints, promoção, deploy ou sob demanda.
- Hooks de agente são sinais adicionais; os eventos da IDE são a autoridade de lifecycle.
- Efeitos fora do broker podem ser observados posteriormente, mas não vendidos como previamente controlados.

## 14. Matriz decidida de modos e enforcement

| Situação | Full Vibes | Spec Mode | Hybrid |
|---|---|---|---|
| Ambiguidade comum | registra/sugere sem interromper | resolve antes de efeito durável | registra no protótipo; resolve na promoção |
| Decisão contratual | provisional + checkpoint | requer decisão antes de construir | provisional até promotion gate |
| Finding semântico | informa/avisa | pode exigir confirmação por policy | informa no protótipo; gate na promoção |
| Check determinístico falho | visível; policy decide | visível; policy decide | visível; policy decide |
| Efeito irreversível/externo | perfil de permissão decide | perfil + spec decide | bloqueado no sandbox; confirma na promoção |
| Evidência | nunca apagada | nunca apagada | nunca apagada |

Enforcement pertence a policy determinística:

```text
inform < suggest < warn < require-confirmation < block-by-policy
```

- Modelo pode sugerir severidade/enforcement, mas não aplicá-los.
- O perfil default é `balanced`: leitura/busca/edição dentro dos recursos declarados e comandos locais reversíveis fluem; rede, instalação, segredo, fora-do-escopo, deploy e ações destrutivas pedem confirmação contextual.
- `YOLO` é uma escolha explícita por projeto/escopo e pode ampliar autorizações. A UI continua mostrando efeitos e evidência sem interromper.
- Integridade da própria IDE, falsificação de evidência e recomendação patrocinada oculta não são relaxadas por YOLO.

## 15. Autoridade decidida da IA

A IA pode:

- detectar e classificar candidatos;
- propor severidade, remediação e perguntas;
- gerar testes, probes e patches;
- relacionar intenção a candidatos de implementação;
- recomendar promoção ou enforcement.

A IA não pode sozinha:

- transformar hipótese em fato;
- transformar candidate em accepted sem policy;
- escolher ou alterar policy;
- declarar o próprio patch correto;
- esconder evidência contrária;
- escrever memória autoritativa silenciosamente;
- aumentar budget ou selecionar caminho patrocinado sem transparência.

Teste gerado por IA se torna evidência somente quando executado e escopado; ainda pode provar apenas o que testou.

## 16. Guarantees decididas por adapter

| Adapter | Sessão estruturada | Efeitos interceptáveis | Auth própria | Guarantee default |
|---|---:|---:|---:|---|
| Agente nativo/tool-mediated | Sim | Alta | IDE/provider | Controle e observação fortes dentro do broker |
| API/modelo bruto | Sim | Alta quando usa tools da IDE | API/gateway | IDE controla o loop e efeitos brokerados |
| ACP | Sim | Variável por capability/implementação | Agente | Sessão observável; ACP não implica sandbox |
| CLI com RPC/JSON | Parcial/alta | Variável | CLI | Estruturado onde o protocolo expõe; restante degradado |
| PTY/TUI | Baixa | Baixa sem isolamento externo | CLI | Observação e containment do processo; sem introspecção presumida |
| Modelo/local server | Sim via adapter | Alta no loop da IDE | Local | Sem egress por default; qualidade/capabilities declaradas |

Cada sessão mostra um capability card: leitura, escrita, terminal, cancelamento, resume, permissão, diff, tool events, custo e isolamento. Feature indisponível não é emulada silenciosamente.

## 17. Context Compiler e economia de tokens decididos

- Default de apresentação é **adaptive concise**: curto para progresso e operação comum; expansão contextual para conceito, risco e decisão.
- Usuário pode escolher verbosidade e salvar perfil; Caveman é provider/perfil opcional, não linguagem obrigatória do produto.
- RTK ou equivalente é ativado automaticamente quando existe adapter seguro para o comando; fallback preserva saída bruta acessível.
- Tool output é deduplicado, classificado e comprimido antes de entrar no contexto, mantendo ponteiro para o bruto.
- Navegação usa SoTs, escopo do projeto e AAG para recuperar o menor contexto suficiente com provenance.
- Specs/policies/evidências são referenciadas verbatim quando governam a tarefa; sumarização nunca substitui autoridade.
- Camada 0 e indexação local são gratuitas/offline.
- Inferência semântica usa o caminho conectado pelo usuário, cota patrocinada transparente ou rail opcional, sempre com budget visível.
- Nenhuma inferência billable roda em idle por default.
- Cache, incrementalidade e invalidação por evidência são requisitos do evaluator.

## 18. Packs de domínio decididos

- Packs declarativos e sem execução nativa podem ser detectados e sugeridos automaticamente.
- O default inicial ativa um starter pack apropriado apenas com aviso claro, preview das capacidades e undo imediato.
- Packs executáveis, com rede ou efeitos exigem instalação/permissão explícitas.
- Pack declara evaluators, guias, intents, templates, evidence needs, custo e capabilities.
- Usuário pode desligar ou trocar pack sem perder documentos/decisões.
- Marketplace e signing ficam depois da validação do contrato local.

## 19. Benchmark inicial decidido

O primeiro benchmark é um **microsaaS de leaderboard/leilão de visibilidade**, inspirado no nível de produto do Melhor Lance, sem copiar sua implementação.

Motivos:

- é compreensível por uma pessoa não técnica;
- exige produto, UI, persistência, pagamento, concorrência, abuso, analytics e deploy;
- permite variantes deliberadamente defeituosas;
- exercita intenção↔código e mais de uma camada do harness;
- é pequeno o bastante para um slice ponta a ponta.

Corpus inicial inclui, no mínimo:

- lance que pode diminuir;
- concorrência que vende a mesma posição;
- pagamento aprovado sem atualização ou vice-versa;
- webhook repetido;
- URL maliciosa/SSRF;
- segredo exposto;
- ranking divergente da spec;
- analytics sem consentimento declarado;
- documento stale após mudança de regra;
- finding semanticamente plausível porém falso para medir ruído.

## 20. Fronteira técnica AAG decidida

- Fase inicial: AAG como processo/provider externo, consumido por protocolo exportável, CLI estruturada e/ou MCP.
- A IDE mantém overlay próprio de projeto, SoT, intent e evidence links.
- File watching e reindexação pertencem ao provider, coordenados pelo hook bus.
- Falha/staleness do AAG degrada structural findings para `unknown`; nunca bloqueia o editor por indisponibilidade do grafo.
- Embedding direto de crates exige spike posterior de ABI, ciclo de release, migração e ownership.
- AAG continua OSS e útil fora da IDE; a integração profunda é vantagem de ecossistema, não lock-in.

## 21. UX decidida para findings e reconciliação

- Sem firehose de warnings: findings são deduplicados, agrupados por consequência e priorizados por momento.
- A interface principal fala em impacto no produto; detalhe técnico e evidência ficam a um gesto.
- Inline somente quando a intervenção é local e acionável.
- Um `Readiness` view agrega o que impede promoção/deploy, o que foi aceito e o que permanece desconhecido.
- Todo finding responde: o que pode acontecer, por que o sistema acredita nisso, qual evidência possui, como investigar/corrigir e como aceitar exceção.
- Reconciliação oferece três direções explícitas: mudar implementação, mudar intenção ou aceitar divergência escopada.
- Histórico preserva quem/qual agente tomou a decisão, sem transformar transcript em banco.

## 22. Configuração e progressive disclosure decididos

O objetivo é **zero-config até o momento em que uma escolha seja realmente necessária**.

### 22.1 Princípios

- Não apresentar uma settings matrix no primeiro uso.
- Detectar recursos, agentes, providers, Git, AAG e capabilities automaticamente.
- Usar defaults seguros, reversíveis e visíveis.
- Perguntar just-in-time, com consequência em linguagem comum.
- Salvar escolhas por projeto e permitir promover a perfil reutilizável.
- Busca de configuração por intenção: "deixe o agente publicar sem perguntar".
- Configuração avançada continua editável como arquivo, mas não é requisito de uso.
- Nunca limitar silenciosamente capacidade porque um setup opcional foi pulado; mostrar feature degradada no momento relevante.

### 22.2 Apenas três escolhas iniciais conceituais

Elas não precisam aparecer num wizard único; surgem quando necessárias:

1. **O que estamos construindo?** Nome/intenção inicial ou projeto existente.
2. **Com quem construir?** Agente/modelo detectado, login existente, provider/local ou opção patrocinada transparente.
3. **Quanto controle deseja agora?** `balanced` default; Full Vibes/Spec/Hybrid e YOLO são escolhas simples e independentes.

### 22.3 Defaults do primeiro uso

| Configuração | Default |
|---|---|
| Modo de construção | Hybrid |
| Interface | profundidade progressiva |
| Permissões | balanced por projeto |
| Harness | Camadas 0 e 1 ativas |
| Domain pack | detectar, mostrar e ativar starter declarativo com undo |
| Grafo | AAG local automático quando disponível |
| Decisões | capturar candidates; promover conforme modo/policy |
| Checkpoints | automáticos, locais e reversíveis |
| Verbosidade | adaptive concise |
| Tool output | compressão local automática com raw acessível |
| Inferência background | desligada |
| Readiness | profundo em promoção/deploy |

### 22.4 Configuração opcional/avançada

- adapters e model routing;
- policies por recurso/efeito;
- budgets;
- packs e evaluators;
- SoT authority grants;
- layout/perfis/atalhos;
- compressão e verbosidade;
- AAG providers;
- truth providers organizacionais;
- telemetria e privacidade;
- deploy/runtime providers.

O usuário comum não precisa abrir essa área. A configuração permanece poderosa para evitar uma experiência amputada.

## 23. Economia decidida do harness

- Core local, Local Truth Registry, AAG estrutural, hooks e checks determinísticos não exigem pagamento à ShinAI.
- Evaluators semânticos podem usar assinatura/agente existente, BYOK, modelo local, cota patrocinada ou rail ShinAI.
- O custo aparece por tarefa/evaluator, não escondido em configuração global obscura.
- Budget default impede loops de reavaliação; invalidação incremental evita repetir trabalho.
- Usuário pode escolher `local-only`, `use-my-agent`, `lowest-cost`, `best-quality` ou provider específico.
- Findings não aumentam budget nem acionam modelo caro sozinhos.
- Caminho patrocinado é identificado e não altera policy ou conclusão.
- A hipótese de taxa/mercado de capacidade permanece experimento de distribuição, não dependência do harness v0.

## 24. Fronteira open-core decidida provisoriamente

- Editor/cliente e formatos locais: open source.
- Protocolos, schemas, SDK de packs/adapters e compatibility tests: Apache-2.0 quando separáveis.
- Distribuição oficial do editor: marca e serviços ShinAI reservados.
- Editor integrado: direção GPL-3.0-or-later para manter forks distribuídos abertos, sujeita a revisão jurídica e de compatibilidade antes do primeiro release público.
- Marketplace, signing service, hosted inference, sync/cloud, sponsorship exchange e settlement: serviços controlados pela ShinAI.
- Packs podem escolher licença compatível; plugins proprietários exigem boundary de processo/protocolo que não contamine o core.
- Nenhuma feature essencial de portabilidade ou uso de agentes externos depende do serviço oficial.

## 25. Ratificação da fronteira IDE × Katsui

### A IDE precisa oferecer gratuitamente

- projeto semântico local e multi-recurso;
- arquivos/código/docs editáveis;
- Local Truth Registry;
- hooks locais;
- AAG/estrutura local;
- checks determinísticos e semântica geral limitada por budget;
- compressão local básica;
- permissões e effect broker básicos;
- adapters abertos;
- reconciliação local;
- checkpoints, preview e caminho de deploy/export.

Sem essas capacidades, o produto não cumpre sua promessa e vira um cliente artificialmente limitado da Katsui.

### A IDE não replica gratuitamente

- Company Brain KL/OL;
- ingestão Mugen e conectores corporativos;
- retrieval/RAG organizacional avançado;
- registries e propagação organizacionais;
- Kekkai completo e governança cross-actor;
- Iai Gate completo de routing/cache/economia;
- Shiori avançado como serviço/modelo;
- cloud Katsui, tenancy, control tower ou Agent Dojo;
- ontology de objetos vivos e Safe-DB/actions.

### Critério de fronteira

```text
Necessário para uma pessoa possuir e evoluir um projeto local
  → capacidade da IDE

Necessário para uma organização ingerir, governar, compartilhar,
servir e operacionalizar conhecimento/estado entre pessoas e sistemas
  → Katsui/provider organizacional
```

Se futura validação mostrar que o valor pago da Katsui era apenas uma capacidade local commoditizada, a resposta é repivotar a Katsui para profundidade organizacional, não degradar deliberadamente a IDE.

## 26. Gate 0 — estado

Decisões de produto e arquitetura do harness default estão fechadas para criação de requisitos e roadmap. Permanecem gates de validação, não perguntas conceituais:

1. executar spikes de ACP/CLI/PTTY e confirmar guarantees reais;
2. validar Tauri versus Electron num slice;
3. testar boundary AAG por processo/protocolo;
4. construir corpus benchmark e medir precision/recall/custo;
5. validar UX/defaults com pessoas não técnicas;
6. revisar GPL/Apache e boundary de plugins juridicamente;
7. revisar unidade econômica dos caminhos de inferência.

---
*Last updated: 2026-08-22 after founder discussion on harness composition, SoTs, AAG, context compression and Katsui boundaries.*
