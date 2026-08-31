# Adapter ACP direto — construído, provado, e o que a medição derrubou

> **Estado em 2026-08-26, depois de construir:** o adapter existe
> (`bastion-core`, branch `feat/acp-direct-adapter`, commit `7df709f`), o IDE
> usa ele, e a ponte de permissão foi provada no Theia rodando. O plano abaixo
> foi escrito ANTES da medição e estava errado num ponto central — a seção
> "Correção pela medição" marca o quê. O resto continua valendo.
>
> ## Correção pela medição
>
> **O item 4 ("o broker é quem escreve", via `fs/write_text_file`) não existe.**
> Foi medido com `examples/acp_fs_probe.rs`, anunciando
> `clientCapabilities.fs.{read,write}TextFile = true`:
>
> | bridge | `fs/write` | `fs/read` | `request_permission` |
> |---|---|---|---|
> | `claude-agent-acp@0.70.0` | 0 | 0 | 1 |
> | `codex-acp@0.0.44` | 0 | 0 | 0 |
> | `opencode acp` | 0 | 0 | 0 |
>
> Todos escreveram com ferramenta nativa. O bundle do `claude-agent-acp` expõe
> `writeTextFile` e nunca o chama. Consequência direta: **a worktree e o
> `harvest` ficam**, `sandbox` continua `None`, e o texto "não é jaula" continua
> correto. A etapa 1 da "sequência depois do adapter", abaixo, foi escrita em
> cima dessa premissa falsa — só a parte de permissão dela valia, e foi feita.
>
> **`approvals` é por bridge, não por adapter.** Ser o cliente ACP garante que
> todo pedido chegue; não faz o agente perguntar. Só o `claude-agent-acp`
> perguntou.
>
> **As opções de permissão vêm com deny primeiro.** `options.first()` — o
> "auto-approve" do exemplo oficial do SDK — é uma negação contra esse bridge.
> Mapeamento é por `PermissionOptionKind`.
>
> ## O que ficou provado, e onde
>
> - `conformance.rs` ao vivo contra `claude-agent-acp`: 11 passam (incluindo
>   `permission_bridge_allow` e `permission_bridge_deny`), 3 pulam por falta de
>   `FaultInjection`. Reproduzir:
>   `nice -n 19 cargo run -j 2 --example acp_conformance -- claude-agent-acp all`
> - No Theia rodando: pedido de permissão vira card, `Permitir` libera e o
>   `ToolResult` chega, `Negar e encerrar` derruba o turno (`fim "Cancelled"`) e
>   o arquivo que o agente ia escrever nunca existiu.
> - Visto ao vivo, e é o que a UI avisa: o agente saiu da worktree por caminho
>   absoluto no primeiro turno. Quem segurou foi o portão, não o isolamento.
>
> ## Bugs que só apareceram rodando
>
> 1. `SessionSpec.permissions` ignorado pelo adapter (achado pelo sweep de
>    conformance).
> 2. Frames `tool_call_update` do ACP são patches incrementais, não snapshots: o
>    frame `completed` não traz `title` nem `locations`.
> 3. **Deadlock no IDE.** O sidecar processa uma requisição por vez e o
>    `next_event` do facade segurava o lock da sessão esperando evento — com o
>    agente parado num pedido de permissão, não vinha evento, então a resposta
>    nunca conseguia entrar. O agente esperava a decisão que esperava o agente.
>    Corrigido com espera limitada em `NEXT_EVENT_WAIT`.
>
> Os três com teste de regressão.

---

## Anotação original (2026-08-26, antes de construir)

Anotação para a próxima sessão. Escrita em 2026-08-26, depois de investigar por
que o caminho de escrita do agente hospedado não fecha.

## O problema, em uma frase

O IDE hospeda uma sessão ACP real, mas **não é o cliente ACP**. A cadeia é:

```
IDE → sidecar Rust → ide-agent (AcpxAgentFacade) → bastion-agent-runtime
    → acpx (cliente ACP headless) → claude-agent-acp → claude
```

Quem decide permissão em ACP é o cliente. O cliente é o `acpx`. Então o pedido de
escrita do agente é resolvido (negado) dentro do `acpx`, e o que chega até nós é
só um evento de observabilidade.

Observado no app: `Diff{+1/-1}` → `PermissionRequested{write-file}` →
`ToolResult{is_error}` → o agente respondendo "the edit was blocked — permission
denied". `allowed_actions` no `StartAgentSession` não muda isso.

## Achado que encurta o trabalho

O contrato **já foi desenhado para isto**. Em
`bastion-core/crates/bastion-agent-runtime/src/lib.rs`:

```rust
pub trait AgentRuntime { fn descriptor(); fn health(); fn respond_permission(); … }
pub enum ApprovalCoverage { Bridged, HarnessOwned }
pub enum SandboxCoverage { Honored, Partial, None }
```

`respond_permission` já é parte da trait, e `Bridged` significa "eventos de
permissão vão para a fila de aprovação". O `acpx.rs` documenta, com as palavras
dele, por que ele não consegue honrar isso:

> `policy_coverage.approvals = HarnessOwned`: acpx only exposes static, pre-spawn
> permission flags. Empirically, even without any of those flags the agent's
> `session/request_permission` calls are resolved *by acpx itself*… there is no
> observed way to intercept a request and answer it from the supervising process.
> `respond_permission` is therefore always an error; `PermissionRequest` events are
> still emitted purely for observability.

Ou seja: **o elo quebrado é só o transporte**. Um adapter que fale ACP direto entra
com `approvals = Bridged`, implementa `respond_permission`, e todo o resto da
cadeia (facade → sidecar → IDE → broker → card do dock) funciona sem mudança.

E o `acpx` não está ali por causa do `bastion-agent`: é o adapter A-04, escolhido
para não ter que implementar cliente ACP. Já existe um irmão, `codex.rs` (1585
linhas, Ciclo 2.2), que é adapter direto e probea confinamento de verdade. Vários
adapters com coberturas diferentes é o padrão da casa.

## Dívida que este achado derrubou (já corrigida no IDE)

`acpx.rs` também documenta `policy_coverage.sandbox = None`:

> acpx passes `--cwd` as a hint, **not an enforced jail**; nothing stops the wrapped
> agent writing outside the workspace root via an absolute path.

A worktree da sessão hospedada, portanto, **não é jaula**: evita escrita acidental
no projeto, não escrita deliberada por caminho absoluto. O texto da UI, o protocolo
e o `AGENT-SURFACE.md` foram corrigidos para dizer isso. Quem cobre o caso
deliberado é o observador de escritas externas mais o broker.

## O que construir

Um adapter novo em `bastion-core/crates/bastion-agent-runtime/` — provavelmente
`acp.rs` — que seja cliente ACP de verdade, falando JSON-RPC sobre stdio direto com
o bridge (`claude-agent-acp`, `codex-acp`, qualquer um):

1. `initialize` com negociação de capacidades, anunciando que o cliente trata
   permissão e filesystem;
2. `session/new` e `session/prompt`;
3. `session/request_permission` **respondível** → `respond_permission` deixa de ser
   erro, e a resposta vem da fila de aprovação do IDE (o card do dock);
4. `fs/read_text_file` e `fs/write_text_file` delegados ao cliente → **o broker é
   quem escreve**. Isto mata a worktree e o `harvest`: a escrita já nasce governada,
   com diff, snapshot e rollback, sem cópia intermediária;
5. `descriptor()` declarando honestamente `approvals = Bridged` e o que o adapter
   realmente aplica de sandbox.

`conformance.rs` (983 linhas) parece ser o gate que um adapter novo tem que passar —
ler antes de escrever o adapter.

## Cuidados

- **Build.** `bastion-core` é workspace grande. Nesta máquina, `cargo` livre trava
  o PC (verificado 2026-07-21). O sidecar compilou bem com `nice -n 19 cargo build
  -j 2` (debug 25s, release 3s); use a mesma contenção, ou CI.
- **Repo diferente.** É `~/Área de trabalho/projetos-pessoais/bastion-core`, e a
  decisão de que a IDE pode melhorar o `bastion-core` já foi tomada.
- **Contrato antes do código.** Definir: quem responde permissão quando ninguém
  está olhando (timeout), o que o `fs/write_text_file` devolve quando o broker
  recusa, e o que acontece se o agente pedir escrita fora da raiz.
- **Não jogar o acpx fora.** Ele continua útil como adapter de menor cobertura, e a
  sonda honesta que o IDE mostra hoje vem dele.

## Onde o IDE está esperando isso

- `apps/ide-theia/engine-sidecar/src/main.rs` — métodos `agent_*` já expostos.
- `apps/ide-theia/instrument-shell-extension/src/node/agent-session-service.ts` —
  sessão, worktree e `harvest`. Com `fs/*` delegado, a worktree e o `harvest`
  podem sair.
- `apps/ide-theia/instrument-shell-extension/src/browser/widgets/work-widget.tsx` —
  painel Build, onde a permissão apareceria como decisão.
- `instrument-shell-extension/AGENT-SURFACE.md` — o que o agente consegue e não
  consegue, para atualizar quando o adapter entrar.

## Sequência depois do adapter

A ordem importa: §4 mede efeito, e efeito de agente só existe direito depois de 1.

**1. Colher no IDE o que o adapter destrava** (pequeno)

- apagar a worktree e o `harvest` de `agent-session-service.ts`: com
  `fs/write_text_file` delegado, a escrita nasce no broker, sem cópia intermediária;
- `PermissionRequested` deixa de ser observabilidade e passa a ser o card de
  decisão no dock;
- refletir `approvals = Bridged` na UI e atualizar `AGENT-SURFACE.md` — a seção
  "o que o agente consegue" muda de significado;
- se o adapter declarar sandbox real (`Honored`/`Partial`), corrigir o texto que
  hoje diz "não é jaula".

**2. `broker_approve` por effect id** (sai da dívida, vira pré-requisito)

Hoje a aprovação do broker é posicional e eu contornei serializando: uma decisão
por projeto de cada vez (ver `governed-write-service.ts`, `APPROVE_DRAIN_LIMIT` e a
recusa de propostas empilhadas). Com o adapter respondendo permissão POR ESCRITA,
um turno que toca cinco arquivos vira cinco decisões em fila — o gargalo deixa de
ser teórico. Mudança em `crates/ide-domain`, pequena e bem delimitada. Depois dela,
remover as duas guardas do adaptador Node e os testes que as pinam.

**3. §4 — Overview e evidência** (próximo item da fila)

Hoje está honesto e vazio: a faixa diz `checks não executados` e o Overview tem
placeholder marcado `na fila` (ver `work-widget.tsx`, `renderQueuedSurfaces`).
É o motor de checks determinísticos, findings, preview e reconciliação. Regra que
já vale no resto do app: `unknown`/`not-run` nunca aparece como aprovação.

**4. §5 — Analisar projeto e materiais**

Já tem embrião: `product_candidates` detecta recursos e SoT sem gravar nada. §5 é
isso inteiro — stack, comandos, Git, serviços, integrações, com provenance, e
candidates revisáveis em vez de ativação silenciosa.

## Pendências que não bloqueiam

- **Canal de push** em vez do poll de 5s para proposta criada fora da janela
  (`adoptPendingProposal` em `instrument-capability-contribution.ts`).
- **Poll do observador** já usa watcher real; o que falta é atribuição de escrita
  vinda do terminal do próprio IDE (hoje cai em `unknown`, honesto mas pobre).
