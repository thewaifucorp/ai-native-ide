---
sketch: 001
name: ide-atmosphere
question: "Qual identidade visual sustenta trabalho sério e Game Mode?"
winner: "Instrumento v4 — Geologica + DM Mono"
tags: [atmosphere, shell, game-mode]
---

# Sketch 001: Instrumento

## Design Question

Qual atmosfera consegue expressar uma nova categoria de IDE sem parecer um VS Code tematizado, um dashboard SaaS ou um jogo infantil?

## Direção (v4 — "Instrumento", monocromático)

Histórico: a v1 (GPT) tinha três "variantes" que eram o mesmo DOM com paleta trocada, 8-9px e o clichê roxo+teal. A v2 usou dark quente + serifa + cobre — lido como AI-slop. A v3 esfriou a paleta mas ainda tinha azul como acento de marca. A v4 tira o acento: **a fundação é monocromática.**

- **Sem cor de marca.** Chrome inteiro em grafite neutro + branco. Ativo/selecionado/primário são resolvidos por **branco, peso e superfície** — nunca por hue.
- **Cor entra só carregando significado**, e é rara:
  - azul → **etapa/progressão** (lista de passos do agente, fio da pulse line, marco, chave EDIÇÃO na timeline);
  - âmbar → precisa de você;
  - verde → verificado;
  - vermelho → quebrou.
- **Uma família de UI + um mono como voz da máquina.** Hierarquia por peso e escala, sem fonte display de efeito. Intenção humana = sans branca maior; estado/custo/logs/timeline = mono cinza.
- **Controles no padrão de IDE, não de página web.** Isto foi refeito depois de a v3 ficar com cara de Bootstrap:
  - **secundário é fantasma** — sem borda nenhuma, só texto cinza que revela superfície no hover (padrão Zed/Fleet). A "pílula com borda 1px e texto cinza" é justamente o tell de UI gerada por IA;
  - **um primário sólido por contexto** (branco sobre escuro), com atalho de teclado inline (`⏎`);
  - **alturas fixas** (26/30px), não derivadas de padding;
  - **raios apertados** — controles 4px, painéis 7px, produto no preview 10px. Nada de 10px+ em botão;
  - **abas quadradas** com separador vertical e indicador de 2px no topo, em vez de pílulas arredondadas;
  - **avisos são barra lateral de 2px** (inset shadow) na linha afetada, não card com borda colorida em volta;
  - "Agora" virou **lista de linhas de estado**, não grade de cards (card é o container preguiçoso).
- **Ícones SVG autorais** (stroke 1.5 consistente), nada de glyph unicode. Selection, caret, scrollbar e focus tematizados.
- **Assinatura — pulse line:** a Activity Strip é um fio vivo no rodapé com checkpoints, edições, decisão pendente e a cabeça "agora". Clique expande a timeline auditável com restauração por checkpoint.
- **Preview claro neutro** dentro da IDE escura: o produto sendo construído parece coisa real, não mais um painel.

### Tipografia — em aberto, decidir no sketch

O sketch tem um **switcher de tipografia** (canto inferior direito, dentro do Dock) para comparar ao vivo. Anda com o layout inteiro, incluindo o preview do produto:

| | UI | Máquina | Caráter |
|---|---|---|---|
| A | Geologica | DM Mono | mecânico, feito para interface, denso |
| B | Archivo | Chivo Mono | grotesca industrial, mais peso e largura |
| C | Schibsted Grotesk | Fragment Mono | suíça neutra, mais quieta |

Nenhuma é Inter/Geist/Plus Jakarta/Space Grotesk (as faces já saturadas por UI gerada por IA). O switcher é andaime do sketch — sai na implementação, junto com a família escolhida.

## Game Mode: nível com recibo

O nível existe (`nível 7 · Explorer`) e aparece em três lugares de peso crescente: badge no avatar do rail, `nv 7` na pulse line, e o card completo no Dock. O que o diferencia de LevelUp e de gamificação de retenção:

- **o nível sempre mostra de onde veio.** O card lista "Rendeu hoje" com os eventos que sustentam o progresso (`+1 intenção esclarecida`, `+2 hipóteses testadas no preview`, `+1 finding resolvido sem regressão`) — recibo, não pontuação opaca;
- **a lista do que nunca rende é parte da interface**, escrita na cara: `tokens, horas, linhas, prompts`. Isso é a tese do produto virando UI;
- **progresso avança por outcome verificado.** No sketch, aprovar a migration (decisão explícita reconciliando intenção e implementação) move a barra de 64% para 72% — e nada mais move;
- **marco = objetivo real do projeto**, não tarefa inventada: "um lance disputado por duas pessoas ao mesmo tempo termina com um único vencedor", 3 de 5 critérios verificados;
- archetype continua descritivo e ocultável, nunca classe fixa nem gate.

Nível não concede permissão, ferramenta nem qualidade de modelo. Desligar o Game Mode remove os três indicadores sem tocar o estado do projeto.

## How to View

Abra `.planning/sketches/001-ide-atmosphere/index.html` no navegador (fontes vêm do Google Fonts; precisa de internet).

## Interações funcionais

- **Overview ↔ Build** pelo Navigator ou pelas tabs (home de situação vs intenção+preview).
- **Game Mode toggle** na titlebar: nível no Dock, badge no avatar, `nv 7` na pulse line, companion e marco — tudo some sem perder estado.
- **Permitir a migration** (home ou dock): a decisão resolve em todos os lugares ao mesmo tempo — card do dock, "Precisa de você", losango da pulse line, timeline, status e barra do nível.
- **Clicar na pulse line** expande a timeline com entradas tipadas (intenção, edição, checkpoint, decisão, evidence) e "restaurar".
- **Switcher de tipografia** (andaime do sketch, canto inferior direito): troca as três duplas de fonte ao vivo.

## What to Look For

- **Qual dupla de fonte** (A/B/C) você quer congelar como a do produto?
- Monocromático aguenta? A hierarquia sans-branca / mono-cinza deixa claro o que é intenção humana e o que é estado da máquina, sem cor ajudando?
- Azul restrito a etapa é suficiente para ler progresso, ou pede mais presença?
- Os controles agora parecem chrome de IDE ou ainda têm cara de web?
- A pulse line funciona como ponte ação → arquivo → preview, ou vira ruído?
- O nível com recibo é suficiente, ou quer mais camada de progressão (trilhas, cosméticos, temporadas)?
- Dá vontade de passar horas nessa atmosfera?

## Winner

**Instrumento v4 — Geologica + DM Mono.** Fundação monocromática, cor estritamente semântica, preview claro, controles compactos e pulse line como assinatura operacional. Progressão ocorre somente após outcomes verificados; valores exatos de custo ficam sob aprofundamento; decisões possuem uma superfície canônica no Context Dock.
