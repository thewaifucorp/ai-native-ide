# Adapter ACP direto — achados e ponto de partida

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
