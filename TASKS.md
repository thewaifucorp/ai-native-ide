# AI-Native IDE — Fila de implementação

## Decisão

`apps/ide-theia/` é o único app ativo. Theia é a casca; o sidecar Rust/Bastion é a fronteira privilegiada.

`apps/desktop/` Tauri fica somente como fonte de crates, testes e comportamentos provados. Não recebe feature, release ou aceite novo.

## Base reutilizável

- Theia: tema, Explorer, Monaco, busca, Git real e Open VSX.
- Sidecar: broker com approval, snapshot, rollback e diff.
- Probe `AcpxAgentFacade` e AAG quando o grafo já existe.
- Crates/testes para projeto semântico, PTY, agentes, preview, evidência e reconciliação.

Isso não conta como entrega até ser exibido e provado no app Theia.

## Fora da fila

- Tauri, Electron, Game Mode como gate, voz, editor visual, colaboração em tempo real,
  marketplace amplo, capacidade patrocinada, workforce e adapter GSD real.

## Regras

- Executar na ordem. Item posterior só inicia com evidência real do anterior.
- Mock, screenshot, demo guiada, fala de agente ou teste isolado não provam feature.
- Preservar worktree; rodar testes/builds focados e `git diff --check`.
- `DESIGN.md` e `REQUIREMENTS.md` são o contrato; este arquivo é a ordem única.

## Sequência única

### 1. Plataforma de capabilities

Registry com estado, detecção, instalação, provider, cobertura e degradação. Grafo: ausente → gerar AAG → abrir. Ferramentas e uma segunda capability. `Conectar Katsui` contextual. Harness Provider versionado: slots exclusivos de workflow/hierarquia/status, extensões componíveis, migração e nenhum bypass de broker/sandbox/credentials/rollback/receipts.

**Pronto:** Grafo gera/abre; duas capabilities usam o chassi; provider de teste assume/suspende slot sem perder estado.

**PROVADO (2026-08-26, app Theia ativo em `./workspace`):**

- Registry genérico (`capability-registry-service.ts`) + definições (`capability-definitions.ts`);
  chassi não conhece nenhuma capability. `unknown` quando o detector falha; `installable`
  só com ação real e precondição verificada agora; re-detecção depois da ação.
- Três capabilities pelo mesmo chassi: **Grafo (aag)**, **Agentes (adaptador ACP)** e
  **Governança (broker)** — artefato em disco, sonda de adaptador e sonda de sidecar.
- Grafo no workspace: `not-installed` → `Gerar AAG` (`aag bigbang --no-install`) → `ready`
  com `graph.html` real renderizado no iframe sem reload manual (URL carrega selo de detecção).
  Rota `/capability/:id/site/:file` só serve raiz já detectada (403 fora da allow-list).
- `Conectar Katsui` aparece apenas em Agentes (única que declara provider Katsui) e não
  cria conexão nenhuma — informa endpoint/credencial que faltam.
- Harness Provider: manifesto versionado, slots exclusivos (workflow/hierarquia/status),
  extensões componíveis, `activate/suspend/migrate` preservando itens, rival recusado com
  conflito nomeado, e `providerEffect` só pelo broker — proposta `awaiting` no card do dock,
  `Permitir` gravou o arquivo real e `Reverter` restaurou o snapshot (md5 idêntico ao original).
- 25 testes focados: `yarn --cwd apps/ide-theia test:ext` (inclui o ciclo real ausente → gerar → pronto do aag).

### 1b. Honestidade de UI e correção de governança

**PROVADO (2026-08-26, app Theia ativo):** passe de honestidade na casca — nenhuma
superfície afirma fato de projeto que ninguém mediu — e a correção de um furo real
de governança encontrado durante essa limpeza.

- Removido o que era atmosfera vestida de dado: card de decisão mock, item
  inventado em "Precisa de você", "Agora" com agente e preview fictícios,
  "Marco atual 3 de 5", quatro "Recentes" com horário, duas abas de arquivo falsas,
  conversa e site renderizado falsos no Build, progressão gamificada no dock
  (nível 7, barra 64%, "Rendeu hoje"), segundo projeto "Loja Aurora" na rail,
  badge de notificação "1", nível no avatar, pill "Hybrid · local",
  e no pulse: "3 arquivos", "checks 4/5", "preview ✓", "nv 7" e a timeline de
  seis eventos inventados.
- No lugar: Overview mostra projeto real, capabilities detectadas, sonda do agente,
  slots do harness, recursos e a trilha real de efeitos; o pulse mostra recursos
  reais, `checks não executados` (apagado, nunca verde), decisões reais e notches
  vindos da trilha do broker; a timeline É a trilha do broker. Superfície ainda não
  construída aparece como placeholder marcado `na fila`, não como número.
- Rail e crumb: botões que não fazem nada foram removidos ou desabilitados com
  rótulo honesto; notificações e preferências agora abrem as views reais do Theia.
- Fila de modos não cabia mais em coluna estreita: os botões transbordavam para
  cima da tab bar do editor e ela engolia os cliques. Agora quebram linha.
- View Ferramentas virou acordeão com resumo por seção (`2/3 prontas`,
  `3/3 slots`, `N eventos`); só Capabilities abre por padrão.

**Furo de governança corrigido (era nosso, não do broker):** o gate de aprovação do
sidecar persiste em `.instrument/effects.sqlite3` e casa a autorização por
(owner, effect id, caminho, conteúdo). O adaptador numerava efeitos `w1, w2, …` com
contador que **reiniciava em 1 a cada boot do backend**. Uma aprovação concedida em
uma sessão e não consumida casava com a primeira proposta da sessão seguinte, e o
broker **executava a escrita no primeiro propose, sem ninguém decidir** — observado
no app (arquivo alterado no disco) e reproduzido contra o sidecar real
(propose `w1` + approve, reinicia sidecar, propose `w1` igual → `{written: true}`).
Correção: effect id com prefixo único por processo, mais uma guarda que, se um
propose de enfileiramento voltar executado, reverte pelo snapshot do broker,
re-propõe e **reporta** — inclusive o caso em que o rollback falha e os bytes
ficaram no disco (aí a proposta volta como `approved`, nunca como `awaiting`).
Coberto por 7 testes novos (32 no total).

### 1c. Superfície de agente

**PROVADO (2026-08-26, sem UI nenhuma):** as garantias do IDE deixaram de exigir
mouse. Antes disso o registry, o harness e o broker só eram alcançáveis pela casca
— um agente rodando ao lado escreveria arquivos por trás de tudo isso.

- **Artefatos, não código.** Provider de harness é arquivo versionado em
  `.harness/providers/<id>.json`, e trabalho é arquivo em
  `.harness/items/<id>/*.md`, no diretório que o próprio manifesto declara.
  Ficava em `.instrument/` (gitignored) — o que quebrava CAP-01/CAP-03, porque
  manifesto e artefato precisam ser revisáveis num PR. O manifesto agora declara
  `artifacts`, `coverage`, `limitations` e `migratesFrom`.
- Provado: manifesto escrito à mão em disco, **sem nenhuma chamada de API**, é
  descoberto, valida, assume slots exclusivos, contribui extensões e migra de
  versão movendo os artefatos. Manifesto inválido é logado e ignorado, nunca
  derruba o projeto.
- **MCP em `POST /mcp`** no backend do Theia, sobre os MESMOS serviços da UI:
  13 ferramentas (capability list/install, governed propose/approve/rollback/trail,
  harness snapshot/register/activate/suspend/migrate/add_items/provider_effect).
  Loopback + bearer token em `~/.instrument-ide/mcp-token` (0600); `GET /mcp` diz
  onde está o token sem revelá-lo. Sem token: 401.
- **Ciclo completo provado nos dois sentidos:** agente propôs por MCP uma mudança
  real em `src/auction.ts` (o desempate), o arquivo não mudou, a proposta apareceu
  no dock da pessoa com o diff real e o aviso de que veio de fora da janela, a
  pessoa aprovou, o agente viu `executed` na trilha e reverteu. `pending()` +
  adoção no frontend existem porque proposta de agente nasce fora da UI.
- Documentado em `instrument-shell-extension/AGENT-SURFACE.md`, com o que o agente
  **não** consegue fazer por construção.

**Watcher real e atribuição de autoria (fecha 1d):**

- Poll de 8s substituído pelo watcher de filesystem do próprio Theia
  (`FileService.onDidFilesChange`, debounce de 900ms + rede de segurança de 60s).
  Escrita externa aparece em ~2s, medido no app.
- **Ledger de autoria** (`write-source-ledger.ts`): toda escrita que o IDE faz se
  registra — save do editor, efeito aprovado pelo broker, chamada MCP, artefato do
  harness. No scan, o observador **subtrai as próprias escritas**: elas entram na
  referência automaticamente com recibo `auto-reconciled` e ficam listadas como
  "conciliado automaticamente". Sobra em `drifts` só o que o IDE não consegue
  atribuir.
- Sem isso o observador gritava lobo: a pessoa salvando no Monaco aparecia como
  "escrita fora do IDE". Provado no app: `X` digitado no README + Ctrl+S →
  `auto-reconciled | README.md | escrita do próprio IDE (editor)`, zero alarme;
  `echo >> src/auction.ts` por fora → `autoria: não identificada`, reversão pelo
  broker, arquivo restaurado.
- Nota velha não reivindica escrita nova: a atribuição só vale se o registro estiver
  a menos de 10s do mtime do arquivo. Testado.
- `git checkout` feito por fora é corretamente reportado como escrita externa
  não identificada — o que é a resposta certa.

**Segundo furo de governança corrigido:** `broker_approve(root, owner)` autoriza o
efeito pendente **mais antigo** do escopo, não um effect id. Com mais de uma
proposta pendente — trivial quando agentes propõem — aprovar a proposta B
autorizava a proposta A. Observado no app: `broker did not execute approved effect
… (got {awaiting_approval:true})`. Duas guardas: uma decisão por projeto de cada
vez (segunda proposta é recusada com id e caminho da bloqueadora) e drenagem de
autorizações antigas até a decisão cair no efeito certo, reportando quantas foram
drenadas. Correção definitiva é o sidecar aprovar por effect id — registrado como
dívida no AGENT-SURFACE.md. 40 testes.

### 1d. Escritas fora do IDE (WORK-05)

**PROVADO (2026-08-26, app Theia ativo):** o furo que faltava para desenvolvimento
dirigido por agente. A governança só valia para escrita que passasse por dentro do
IDE — mas o agente que a pessoa usa escreve com as ferramentas dele. Nesse caminho
não havia snapshot, recibo, rollback nem nada no dock: para o agente real, o
broker era decorativo.

Exigir que todo agente adote uma API do IDE não resolve. A interface comum entre
pessoa e agente é o filesystem, então o IDE observa o filesystem.

- Referência de conteúdo dos arquivos de texto em `.instrument/baseline/`
  (runtime, gitignored), criada no primeiro scan — projeto intacto não é drift.
- Comparação periódica: `modified` / `created` / `deleted`, com linhas +/- pelo
  engine Rust real e se os bytes anteriores existem para restaurar.
- Aparece em "Precisa de você", na faixa (`N fora do IDE`) e na seção "Escritas
  fora do IDE" da view Ferramentas.
- Duas conciliações: **Aceitar** (bytes atuais viram referência, arquivo intocado,
  recibo) e **Propor reversão** (bytes anteriores vão ao broker como proposta, com
  snapshot da versão do agente, aprovação e rollback próprios — desfazer é um
  efeito governado como qualquer outro).
- Nunca bloqueia escrita, nunca edita arquivo por conta própria. Cobertura é
  declarada: binário, >512 KB, symlink e diretório de build vão para `skipped`
  com o motivo; binário alterado é detectado mas não restaurável, e isso é dito.
- Também pelo MCP: `external_scan`, `external_baseline`, `external_accept`,
  `external_propose_revert` — o agente concilia o que ele mesmo escreveu por fora.

Prova ponta a ponta: o "agente" alterou `src/auction.ts` e criou `src/tiebreak.md`
escrevendo direto no disco, sem tocar o IDE. O IDE detectou os dois em segundos
(`2 fora do IDE`), mostrou `+2/-2` no arquivo alterado, a reversão virou proposta
no dock com o diff, foi aprovada e o arquivo voltou ao original; o arquivo novo foi
aceito como nova referência. 51 testes.

### 1e. Sessão de agente hospedada (caminho pré-disco)

**Sidecar (provado, compilado nesta máquina em debug e release, 8 testes):** o
crate `ide-agent` já tinha a sessão ACP inteira; o sidecar só expunha
`agent_probe`. Agora expõe `agent_start_session`, `agent_submit_task`,
`agent_next_event`, `agent_cancel` e `agent_session_status`, com registry de
facades por adaptador e `read_only` verdadeiro por padrão.

**Sessão ACP real provada ponta a ponta** (bridge `@agentclientprotocol/claude-agent-acp`
0.70.0 instalado): sessão aberta, tarefa submetida, `MessageDelta` streamando,
`ToolCall`/`ToolResult` de Bash e Read, `Artifact`, `Diff`, `Usage`, `Ended Success`,
`cancel`. O IDE hospeda a sessão no painel Build.

**Isolamento pré-disco:** a sessão roda com `workspace_root` numa worktree git do
projeto (fallback para cópia isolada quando o projeto não é repo git — a garantia
precisa de cópia, não de git). `Colher mudanças` compara worktree com projeto e
propõe cada mudança pelo broker, uma decisão por vez.

**Bloqueio resolvido (2026-08-26): a permissão agora é decidida no IDE.** O
bloqueio anterior era de transporte, não de política: o `acpx` é um cliente ACP
de terceiro, então respondia `session/request_permission` sozinho e negava tudo;
o IDE só via o aviso. Foi construído um adapter ACP direto em `bastion-core`
(`bastion_agent_runtime::acp`, branch `feat/acp-direct-adapter`, commit
`7df709f`) que faz o sidecar ser o cliente ACP, e o `ide-agent` passou a usá-lo.

**Provado no Theia rodando**, não em teste: o pedido do agente vira card no
painel Build com `Permitir` / `Negar` / `Negar e encerrar` **e o diff proposto**
(o card mostrou `linha um / linha dois`, e foi exatamente isso que o arquivo
recebeu ao aprovar); aprovar libera e o `ToolResult` chega; `Negar e encerrar` derruba o turno (`fim "Cancelled"`) e o
arquivo que o agente ia escrever nunca existiu. Antes disso, `conformance.rs` ao
vivo contra `claude-agent-acp@0.70.0`: 11 passam, incluindo
`permission_bridge_allow` e `permission_bridge_deny`; 3 pulam por falta de
`FaultInjection`.

**O que a medição derrubou, e por isso NÃO mudou:** o plano previa delegar
escrita ao cliente por `fs/write_text_file`, matando a worktree e o `harvest`.
Medido com `examples/acp_fs_probe.rs`, com a capability anunciada: `claude-agent-acp`,
`codex-acp` e `opencode` fizeram **zero** chamadas de `fs/write_text_file` — todos
escrevem com ferramenta nativa. Então worktree e `harvest` ficam, `sandbox`
continua `None`, e "não é jaula" continua verdade — foi visto o agente sair da
worktree por caminho absoluto no primeiro turno.

**Ressalva medida:** a ponte vale para os agentes que perguntam. `claude-agent-acp`
pergunta antes de editar; `codex-acp` e `opencode` resolvem internamente e não
perguntam. O `descriptor()` declara `approvals` por bridge em vez de prometer um
portão que aquele agente não usa.

**Bugs que só apareceram rodando**, os três com teste de regressão:
`SessionSpec.permissions` ignorado pelo adapter; frames `tool_call_update` lidos
como snapshot quando são patch incremental (o frame `completed` não traz `title`
nem `locations`); e um deadlock — o sidecar trata uma requisição por vez e o
`next_event` segurava o lock da sessão esperando evento, então com o agente
parado num pedido de permissão a resposta nunca conseguia entrar.

Defeito meu corrigido no caminho: falha de poll era engolida e o painel ficava em
`working` para sempre, mentindo. Agora três falhas seguidas param o loop e dizem
por quê; submit recusado também aparece.

### §4 — Checks determinísticos no Overview

**Pronto e provado no app.** O Overview dizia "checks não executados" porque
ninguém ligava o fio, não porque faltasse motor: `crates/ide-harness` já
avaliava fatos observados em findings com estado, evidência e remediação, e já
mantinha `unknown` e `not_run` separados de aprovação. Só que o único chamador
de `run_layer0` no repo era o app Tauri antigo — o sidecar do Theia nem
dependia do crate.

Agora depende. `engine-sidecar/src/harness.rs` colhe os fatos (git porcelain,
varredura de texto com raiz e limites, lockfiles, efeitos pendentes) e entrega
ao motor, que continua sem tocar em processo ou disco.

**Comandos são declarados, não detectados**, em `.instrument/checks.json`.
Detecção de stack com provenance é o §5; adivinhar aqui duplicaria pior e faria
o IDE rodar algo que ninguém escreveu. Quando o §5 chegar, ele propõe candidatos
para esse mesmo arquivo.

**Rodar é ato explícito.** `run_tools` é false por padrão: atualizar painel
nunca executa comando que veio com o repositório.

Medido na tela, com o workspace de demonstração: `2 passou · 2 falhou ·
1 desconhecido · 2 não executado`, com Git `não executado` ("não é repositório
Git"), lockfile `falhou`, e Build `passou` mostrando
`` `node … --check src/main.ts` saiu com código 0 `` — a promessa de que todo
resultado carrega o comando cru que o produziu, cumprida. `typecheck` aparece
como não executado dizendo que não há comando declarado para ele.

Dois defeitos meus achados só rodando, ambos com teste: dois findings de lock
colidindo no mesmo id (o motor chaveia por manifesto — agora é um lock por
manifesto), e a costura camelCase entre `ide_harness` e o wrapper do sidecar,
que fazia o contador de "não executado" sumir da tela.

### 2. Workspace técnico

Debug/DAP real com breakpoints, launch/attach, step, stack e variáveis. Terminal/PTy real. Diff/checkpoint/rollback pelo broker. Git, Open VSX e saída raw acessíveis.

**Pronto:** debug e terminal rodam no projeto; escrita é inspecionável e reversível.

**PROVADO (2026-08-26, app Theia ativo em `./workspace`):**

- **DAP real** via `ms-vscode.js-debug` 1.117.0 + `.theia/launch.json` do projeto (launch e attach).
  Launch: breakpoint em `src/main.ts:14` (F9) → F5 → `PAUSED ON BREAKPOINT`, pilha real
  (`main.ts14:16` + frames de `<node_internals>`), escopos `Module`/`Global`; F10 avançou para
  `main.ts15:16` e `ranked: (3) [{…}, {…}, {…}]` apareceu em Variables; F5 finalizou com a saída
  real no Debug Console. Attach: `node --inspect-brk=9229 src/main.ts` externo → config `Anexar`
  → `Remote Process [0] · PAUSED ON DEBUGGER STATEMENT`.
- Modo **Depuração** na fila de modos abre o view-container real do `@theia/debug`
  (threads, call stack, variables, watch, breakpoints + seções do js-debug).
- **Terminal/PTY real**: aberto pela view Ferramentas, `pwd` = raiz do workspace, `node src/main.ts`
  rodou de verdade (saída e PID gravados por redirecionamento — o xterm renderiza em canvas).
- **Escrita inspecionável e reversível**: propor → `Permitir` → `Reverter` em `docs/product-intent.md`,
  e a trilha **raw** do broker lida sob demanda mostra a sequência completa
  `proposed → awaiting_approval → snapshot_created → executed → rolled_back`.
- **Git, Open VSX e saída raw acessíveis**: modo Git (SCM real) + botões Terminal / Saída raw /
  Open VSX / SQLTools na view Ferramentas — a casca esconde a barra nativa, então estas são as
  portas explícitas.
- Limpeza de honestidade no caminho: o card de decisão *mock* ("Executar migration no banco local?"
  e seu estado "VERIFICADA") foi removido — ele mascarava o estado real da escrita governada.
  Sem proposta, o dock diz `NADA AGUARDANDO`. O item inventado em "Precisa de você" saiu,
  e o pulse conta só decisões reais (`0 decisões`).
- A proposta demo agora só usa o editor ativo se for `.md` (antes injetava comentário markdown
  em `.ts`), e `apps/ide-theia/.gitignore` deixou de engolir o `.theia/launch.json` do workspace.

### 3. Projeto semântico e SoTs

Produto/SoT reais: recursos, autoridades, consumidores, divergências e arquivo causal. Resolver pelo broker; vazio/unknown honesto.

**Pronto:** mudança real cria, mostra e resolve divergência.

**PROVADO (2026-08-26, app Theia ativo):**

- Artefatos versionados em `.product/`: `sot/<id>.json` (fonte da verdade, com
  afirmações que trazem check verificável) e `resources/<id>.json` (recurso, com
  autoridade e consumidores). Pessoa e agente escrevem nos mesmos arquivos.
- **Divergência é calculada, nunca declarada.** Ninguém grava "divergente: sim":
  cada afirmação tem `check` (`absent-in-file` / `present-in-file`) sobre arquivo
  real, e divergência é check que falhou. SoT com afirmação sem check é recusado.
- Honestidade de vazio: sem artefato → `declared: false`, não modelo inventado;
  arquivo ausente, ilegível, grande demais ou fora da raiz → `unknown`, nunca
  conformidade; artefato ilegível é reportado sem derrubar o modelo; recurso sem
  autoridade é lacuna declarada (`withoutAuthority`), não erro.
- Exceção escopada é edição do próprio SoT, com motivo e data, revisável em diff —
  aparece como `excepted`, nunca como `ok`.
- **Resolver passa pelo broker.** Dois lados oferecidos: mudar a implementação ou
  registrar exceção na intenção. Ambos voltam como proposta com diff no dock.
- Ciclo completo no app: `a.createdAt - b.createdAt` em `src/auction.ts:18`
  aparece como DIVERGENT afetando o recurso `ranking`; `Mudar implementação` →
  proposta `+0/-1` no dock → `Permitir` → "nenhuma divergência aberta" →
  `Reverter` → divergência volta. O modelo recalcula sozinho pelo watcher.
- A view Produto deixou de ser esboço (seções fixas com tag `mock`) e passou a
  renderizar só o modelo lido do disco.
- Também no MCP: `product_model`, `product_candidates`, `product_declare_sot`,
  `product_declare_resource`, `product_resolve_options`, `product_resolve`.
- `Analisar projeto` (PROJ-06) devolve candidatos de recurso/SoT do que existe e
  **não grava nada** — candidato não é ativação.

15 testes novos (70 no total).

### 4. Overview e evidência

Preview, checks, findings e reconciliação reais; evidence/comandos raw sob demanda; `unknown`/`not-run` não ficam verdes; instalar um pack local.

**Pronto:** mudar projeto muda Overview e suas evidências.

### 5. Analisar projeto e materiais

**Analisar projeto** detecta recursos, stack, comandos, Git, serviços, instruções, integrações e relações. Gera candidates revisáveis de Guidance/SoT/config; referências têm provenance e assets ficam no workspace.

**Pronto:** projeto existente produz análise/candidates reais, sem ativação silenciosa.

### 6. Contexto do agente e atividade

Mostrar prompt/contexto efetivo, inclusões/exclusões, origem, versão, escopo, policy e limites. Compilar pacote mínimo; restante só via retrieval governado ou `unknown`. Activity mostra apenas eventos Bastion do projeto, não Control Tower.

**Pronto:** pessoa sabe o que o agente recebeu, sem despejo do projeto inteiro.

### 7. Anotações e reconciliação

Notas por tema para propostas, decisões, perguntas, alternativas e itens substituídos, ligadas a mensagens/referências/arquivos/SoTs/Features/Tasks. Notas ocupam a Work Surface. **Conciliar e reconciliar** compara notas, Guidances, SoTs e Features; qualquer promoção/merge/descarte é humano.

**Pronto:** conflito entre notas pode ser encontrado e reconciliado explicitamente.

### 8. Intenção guiada e ajuda contextual

Composer sugere ambiguidades, decisões, requisitos esquecidos, contradições e consequências como candidates editáveis. Só após revisão viram artefatos. Ajuda explica escolhas/riscos sem virar instrução do agente ou bloqueio padrão.

**Pronto:** intenção melhora sem rewrite oculto ou estado silencioso.

### 9. Features, Tasks e Status

Feature → Task → Subtask opcional; Task direta e multi-Feature são válidas. Critérios/evidências versionados; agente propõe verificação. Status calcula: não iniciado, em andamento, implementado não verificado, parcialmente verificado, verificado, bloqueado ou evidência desatualizada.

**Pronto:** task concluída não promove feature; mudança relevante torna prova antiga stale.

### 10. Adapters controlados

ACP e loop controlado: start/cancel/resume, custo, raw output e `PolicyCoverage`. Troca preserva projeto e não contorna broker.

**Pronto:** dois caminhos reais funcionam ou degradam honestamente.

### 11. Sessão de agente e efeitos

Probe vira sessão viva; writes/commands passam por Permitir/Reverter e rollback.

**Pronto:** agente muda projeto pelo mesmo caminho governado da pessoa.

### 12. Prova ponta a ponta Theia

Intenção → agente → efeito aprovado → preview → falha provocada → evidência → reconciliação; falha liga atividade/artefatos; outcome só após observação independente.

**Pronto:** jornada roda no artifact Theia aceito, não no Tauri ou demo web.

### 13. Projetos duráveis e configuração

Multi-repo/diretórios/serviços/ambientes e recursos reutilizáveis. Truth Registry e Guidance Library persistem autoridade, consumidores, lifecycle, `Applied now`, higiene e steering importado. UI simples e arquivo de config usam o mesmo schema.

**Pronto:** reabrir preserva projeto e Guidance sem transcript.

### 14. Modos e navegação madura

Full Vibes, Hybrid e Spec são policies do mesmo projeto; troca não perde estado; assunto → SoT → implementação → evidência funciona com AAG degradável.

**Pronto:** projeto troca de modo sem migração ou perda.

### 15. Harness completo

Checks determinísticos: build, testes, tipos, segredos, dependências, Git/diff e effects. Semânticos: ambiguidade, risco, decisões e divergência. Packs sandboxed e deep evaluation em checkpoint/promoção/publicação.

**Pronto:** Harness explica o que sabe e o que não verificou.

### 16. Publicar e evoluir

Export/deploy sem exigir ShinAI/Katsui; confirmação de efeito externo e evidência/rollback. Reabrir publicado, ligar problema ao projeto, corrigir e republicar.

**Pronto:** pessoas não técnicas e técnicas completam o ciclo sem lock-in.

### 17. Times de Project Agents

Definições/manifests versionáveis; spawn local, divisão, roster, mailbox, blockers, handoffs, escopos e effects governados. Pipeline/líder-LLM, budget local e um provider policy/egress por estágio.

**Pronto:** time local trabalha num projeto com contexto/efeitos reconstruíveis pelo ledger, sem virar Agent Dojo ou Control Tower.
