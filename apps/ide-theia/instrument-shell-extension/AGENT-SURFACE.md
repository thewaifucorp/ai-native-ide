# Superfície de agente

Desenvolvimento dirigido por agente não significa duas interfaces (uma pra pessoa,
uma pra máquina). Significa que **pessoa e agente escrevem no mesmo lugar**: os
arquivos do projeto. O IDE precisa valer para os dois.

Três portas, nenhuma privilegiada:

1. **O disco** — o agente escreve com as ferramentas dele; o IDE observa,
   diferencia e concilia (seção "Escritas fora do IDE", abaixo).
2. **Artefatos em arquivo** — harness, trabalho e configuração são arquivos
   versionados que pessoa e agente editam igualmente.
3. **MCP** — quando o agente quer as garantias *antes* de escrever (proposta com
   aprovação, snapshot, recibo) em vez de depois.

## 1. Artefatos em arquivo

O harness do projeto é arquivo, não código compilado no IDE:

```
.harness/
  providers/<id>.json     manifesto versionado do provider  (commitado, revisável em PR)
  items/<id>/*.md         artefatos de trabalho do provider
  state.json              slots, status e recibos
```

Um agente registra um método de trabalho **escrevendo** `.harness/providers/meu.json`:

```json
{
  "id": "meu-metodo",
  "label": "Método da casa",
  "version": "0.1.0",
  "manifestVersion": 1,
  "claims": ["workflow", "work-hierarchy"],
  "extensions": { "checks": ["casa:lint"], "packs": [], "importers": [], "views": [] },
  "artifacts": { "itemsDir": ".harness/items/meu-metodo", "itemExtension": ".md" },
  "coverage": ["workflow de 3 estados"],
  "limitations": ["não roda checks de verdade"],
  "workflow": { "states": ["aberto", "fazendo", "feito"], "initial": "aberto" },
  "hierarchy": { "levels": ["epico", "tarefa"] }
}
```

O registry descobre o arquivo, valida e passa a tratá-lo como provider de
primeira classe: pode assumir slots exclusivos, contribuir extensões e ser
migrado. Criar trabalho é escrever `.harness/items/meu-metodo/tarefa.md`.

Manifesto inválido é **reportado no log e ignorado** — nunca derruba o projeto,
nunca é silenciosamente corrigido.

## 2. MCP em `POST /mcp`

O backend do Theia expõe as MESMAS operações que a UI usa.

- Descoberta sem autenticação: `GET /mcp` devolve versão do protocolo, lista de
  ferramentas e **onde** está o token.
- Autenticação: `Authorization: Bearer <conteúdo de ~/.instrument-ide/mcp-token>`.
  O arquivo é criado no boot com modo `0600`. Só loopback é aceito.
- Transporte: JSON-RPC 2.0 num único POST (`initialize`, `tools/list`,
  `tools/call`). Sem SSE — nada fica esperando stream.

```bash
TOKEN=$(cat ~/.instrument-ide/mcp-token)
curl -s localhost:3010/mcp -H "Authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
```

### Ferramentas

| Ferramenta | O que faz |
|---|---|
| `capability_list` | estado detectado de cada capability do projeto |
| `capability_install` | roda a ação real (ex: indexar o grafo aag) e re-detecta |
| `governed_propose` | propõe a escrita de um arquivo — **para no gate de aprovação** |
| `governed_approve` | aplica uma proposta já decidida por uma pessoa |
| `governed_rollback` | restaura o snapshot do broker |
| `governed_trail` | trilha crua: proposto → aguardando → snapshot → executado → revertido |
| `harness_snapshot` | providers descobertos, slots, extensões, artefatos, recibos |
| `harness_register` | grava um manifesto (equivalente a escrever o arquivo) |
| `harness_activate` / `harness_suspend` | assume / libera slots exclusivos |
| `harness_migrate` | troca a versão do manifesto preservando artefatos |
| `harness_add_items` | cria artefatos de trabalho |
| `harness_provider_effect` | propõe escrita em nome de um provider ativo |
| `external_scan` | escritas feitas fora do IDE, com diff real e se dá para reverter |
| `external_baseline` | refaz a referência do projeto |
| `external_accept` | adota os bytes atuais como referência (não altera arquivo) |
| `external_propose_revert` | propõe restaurar os bytes anteriores pelo broker |

## Escritas fora do IDE (o caso normal)

O agente que a pessoa já usa escreve com o `Write`/`Edit` dele. Não passa por
`governed_propose`, não conhece o broker. Antes isso era invisível para o IDE —
sem snapshot, sem recibo, sem rollback. Exigir que todo agente adote uma API
específica não é solução; a interface comum é o filesystem, então o IDE observa o
filesystem.

Como funciona:

- o IDE mantém uma **referência** dos arquivos de texto do projeto em
  `.instrument/baseline/` (estado de runtime, gitignored);
- a cada poucos segundos compara o disco com a referência e mostra o que mudou
  fora dele: caminho, tipo (`modified` / `created` / `deleted`), linhas +/- pelo
  engine Rust real, e se dá para restaurar;
- aparece em "Precisa de você" no Overview, na faixa inferior (`N fora do IDE`) e
  na seção "Escritas fora do IDE" da view Ferramentas;
- duas conciliações: **Aceitar** (os bytes atuais viram a nova referência; nenhum
  arquivo é tocado) ou **Propor reversão** (os bytes anteriores vão ao broker como
  proposta — com snapshot da versão do agente, aprovação e rollback próprios).

O observador **nunca** bloqueia uma escrita e **nunca** edita um arquivo por conta
própria. Ele torna visível o que era invisível e devolve a decisão para a pessoa.

Cobertura declarada, não presumida: binários, arquivos acima de 512 KB, symlinks e
diretórios de build/dependência aparecem em `skipped` com o motivo. Um binário que
muda é detectado, mas não é restaurável pelo IDE — isso é dito, não escondido.

Pelo MCP as mesmas operações são `external_scan`, `external_baseline`,
`external_accept` e `external_propose_revert` — ou seja, o agente pode conciliar o
que ele mesmo escreveu por fora.

## O que o agente NÃO consegue

Por construção, não por configuração:

- **Escrever arquivo do projeto sem aprovação.** `governed_propose` volta
  `awaiting` e nada toca o disco. A pessoa decide no dock; o agente vê o
  resultado em `governed_trail`.
- **Empilhar decisões.** Enquanto uma escrita aguarda, uma segunda proposta é
  recusada com o id e o caminho da que está bloqueando. A aprovação do broker é
  posicional (a mais antiga da fila), então propostas empilhadas poderiam trocar
  de lugar — o adaptador recusa em vez de arriscar.
- **Tomar um slot exclusivo já ocupado.** Recusa com conflito nomeado; nunca
  mescla dois workflows.
- **Declarar artefatos fora do projeto.** `artifacts.itemsDir` é confinado à raiz.

E o que ele **consegue**, e não deve ser confundido com o de cima:

- **Escrever fora da worktree por caminho absoluto.** O adapter direto de ACP
  (`bastion_agent_runtime::acp`) declara `policy_coverage.sandbox = None`, igual
  ao `acpx`: o `cwd` do `session/new` é dica, não jaula. A worktree evita o
  acidente, não a intenção. Quem cobre esse caso é o observador de escritas
  externas, não o "isolamento" da sessão.

  Isso foi **visto acontecer** na prova do adapter novo: o agente rodou
  `cd "<raiz do repo>" && wc -l <arquivo>` — saiu da worktree por caminho
  absoluto no primeiro turno, sem esforço. O que segurou não foi isolamento, foi
  o portão de permissão: o comando parou num card e só rodou porque foi
  aprovado.

## O que MUDOU com o adapter direto de ACP

O sidecar agora é o cliente ACP. Antes, o `acpx` respondia
`session/request_permission` sozinho e o IDE recebia um aviso do que já tinha
sido decidido (`approvals = HarnessOwned`, `respond_permission` sempre erro).

Agora o pedido **para no IDE** e o agente fica bloqueado até alguém responder.
Cada pedido vira um card no painel Build **com o diff proposto**, quando é uma
escrita: o `claude-agent-acp` manda os bytes junto do pedido, então a decisão é
tomada sobre o conteúdo, não sobre "o agente quer escrever um arquivo". Provado:
o card mostrou `linha um / linha dois` e foi exatamente isso que o arquivo
recebeu ao aprovar.

Duas honestidades no preview: conteúdo anterior não informado aparece como
**"sem conteúdo anterior informado"**, nunca como arquivo vazio; e preview
cortado (acima de 64KB por lado) é **marcado como cortado**, porque aprovar um
diff que não se viu inteiro sem saber disso é pior que não ver nada. Pedido que
não é escrita (um comando) diz que não há diff, em vez de mostrar nada e parecer
vazio.

O card tem três saídas: `Permitir`,
`Negar` (só aquele pedido) e `Negar e encerrar` (nega e derruba o turno, para o
agente não tentar o mesmo objetivo por outra ferramenta não vigiada). Sem
resposta, o pedido morre no timeout da tarefa — e **não respondido conta como
negado**, nunca como aprovado.

Duas ressalvas honestas, ambas medidas e não supostas:

- **Vale para os agentes que perguntam.** Ser o cliente ACP garante que todo
  pedido chegue; não obriga o agente a pedir. Medido: `claude-agent-acp` pergunta
  antes de editar; `codex-acp` e `opencode` resolveram a mesma escrita
  internamente e não perguntaram. O `descriptor()` declara isso por bridge.
- **A escrita continua sendo nativa do agente.** O IDE anuncia
  `clientCapabilities.fs.{read,write}TextFile = true` e implementa os dois
  métodos com a raiz imposta, mas nenhum bridge testado os usou. Então a worktree
  e o `harvest` continuam sendo o caminho governado para o projeto — não dá para
  trocá-los por escrita mediada pelo broker.

## Dívida conhecida (precisa mudar no sidecar Rust)

`broker_approve(root, owner)` autoriza **o efeito pendente mais antigo** daquele
escopo, não um effect id. Isso já causou dois incidentes reais, ambos corrigidos
no adaptador:

1. Effect ids reiniciavam em `w1` a cada boot, então uma aprovação não consumida
   de uma sessão anterior casava com a primeira proposta da sessão seguinte e o
   broker gravava sem ninguém decidir. Corrigido com id único por processo.
2. Com mais de um efeito pendente, aprovar a proposta B autorizava a proposta A.
   Corrigido serializando decisões por projeto e drenando autorizações antigas
   até a decisão cair no efeito certo (reportando quantas foram drenadas).

A correção definitiva é `broker_approve` receber o effect id. Enquanto o sidecar
não mudar, as duas guardas acima mantêm a invariante: **nenhuma escrita é aplicada
sem que uma pessoa tenha decidido exatamente aquele diff.**
