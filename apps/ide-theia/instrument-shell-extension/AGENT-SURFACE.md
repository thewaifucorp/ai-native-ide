# Superfície de agente

Tudo que a casca faz por clique também é alcançável por um agente. Duas portas,
nenhuma delas privilegiada em relação à outra.

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
