# Decisão: base do editor = Eclipse Theia (pivô)

**Data:** 2026-08-25 · **Status:** ratificada, em implementação (Milestone 1)

## O que muda

A base do editor passa a ser **Eclipse Theia** (browser/electron, Open VSX para
extensões VSCode). Isso **supera** as premissas escritas anteriores:
- `.planning/research/STACK.md` / `PROJECT.md`: "base = Tauri", "não é fork VSCode",
  "Monaco não é extension host". Continuam válidas como *contexto histórico*, mas a
  base efetiva agora é Theia.
- A app Tauri (`apps/desktop`) permanece como **track paralelo** por enquanto
  (comparação / fallback), não é removida.

## Por quê (provado por spike, 2026-08-25 — `apps/ide-theia`)

O usuário exige compatibilidade com **extensões VSCode (DB/Docker)** + um marketplace
de packs/skills, mantendo os **engines Bastion** e a **cara do 001**. O spike de 4 fases
provou:
1. Theia builda, sobe e roda **SQLTools** (extensão DB real) via Open VSX.
2. Um **engine Rust real (`ide-diff`)** roda como **serviço Theia** via sidecar (round trip provado).
3. A **paleta/tipografia do 001** aplica (tema + CSS).
4. A **IA completa do 001** é reproduzível (rail/navigator/work/dock/crumb/pulse) — mas o
   spike usou um *overlay* sobre o shell nativo escondido.

## O custo assumido conscientemente

- **Ecossistema:** Open VSX (não o Marketplace da Microsoft); provável **Open VSX privado**
  + QA por extensão. Imposto de upgrade mensal em rebinds de shell.
- **Gate de efeito mais fraco para extensões terceiras:** a policy/effect broker **não policia**
  o que uma extensão VSCode faz. Modelo: caminho AI-driven (vibecoder) 100% governado;
  extensões = ferramentas de poder do dev, opt-in, **fora** do loop de IA (cor roxa no design).
- Isto **contradiz** a premissa escrita "não depender do extension host do VSCode" — é um
  pivô deliberado, não um deslize.

## Fronteira Katsui — intacta

Ver `.planning/KATSUI-BOUNDARY.md` e a memória `ide-monetization-katsui-frontier`.
A IDE continua grátis/distribuição; **Iai Gate não é dado de graça**; a Loja da IDE é de
packs/skills de criador+consumidor (open + ads), **não** os registries organizacionais da
Katsui. O rail de inferência roteia pra Katsui/Iai Gate como upsell pago.

## Design de referência

Mockups: `.planning/sketches/001-ide-atmosphere` (instrumento) e
`.planning/sketches/003-extensions-marketplace` (onde entram extensões, loja, arquivos,
busca, git, rail global). Game Mode + pulse strip ("slime") preservados.

## O que já existe

`apps/ide-theia/` — app Theia 1.74.1 no repo, com: tema `instrument-dark` (001),
`engine-extension` (serviço + sidecar `ide-diff`), `instrument-shell-extension` (as 6 regiões
001 como ReactWidgets, hoje em overlay). Sobe com
`./node_modules/.bin/theia start --plugins=local-dir:plugins --hostname 0.0.0.0 --port 3010`.

## Milestone 1 (em curso)

Integração **real** do ApplicationShell (não overlay): rail/navigator/work/dock/crumb/pulse
como áreas de primeira classe hospedando **view-containers reais** do Theia — file explorer
real no modo Arquivos, SQLTools visível, engine sidecar wired, tema 001. Depois: modos
Busca/Git reais, marketplace unificado, engines completos como serviços, agente/preview.
