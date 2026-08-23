# Experience Vision: AI-Native IDE

**Status:** direção de produto para validação por sketches e benchmark  
**Escopo:** arquitetura de informação, interação e direção visual  
**Não congela:** marca, paleta final, tipografia final, mascote ou biblioteca de componentes

## Tese de experiência

A IDE não deve parecer um chat que ocasionalmente revela arquivos, nem um VS Code que ganhou uma sidebar de IA. Sua superfície principal é o estado vivo do produto: o que o usuário quer, o que está sendo feito, o que existe de fato, o que precisa de atenção e o que já pode ser experimentado.

O código continua sendo uma superfície de primeira classe, mas não precisa ser a primeira superfície para toda pessoa ou todo momento.

## Anatomia permanente

```text
┌ Project Rail ┬ Project Navigator ┬ Work Surface ┬ Context Dock ┐
│ projetos     │ visão / recursos  │ conversa     │ agente       │
│ e escopo     │ intenção / código │ editor/docs  │ evidência    │
│ ativo        │ sessões / entrega │ preview/term │ permissões   │
├──────────────┴───────────────────┴──────────────┴──────────────┤
│ Activity Strip: ação atual · efeitos · custo · checks · estado │
└────────────────────────────────────────────────────────────────┘
```

### 1. Project Rail

- Troca entre projetos sem confundir projeto com repositório ou conversa.
- Mostra saúde, atividade em curso e atenção necessária com sinais discretos.
- Recursos compartilhados aparecem vinculados, não duplicados.

### 2. Project Navigator

Uma navegação orientada ao produto, com cinco perspectivas sobre o mesmo estado:

- **Overview:** objetivo atual, próximo resultado utilizável, decisões abertas e estado do produto.
- **Build:** intenção, specs, tarefas e sessões em andamento.
- **Resources:** repositórios, arquivos, serviços, ambientes e assets reais.
- **Evidence:** findings, checks, divergências, testes e readiness.
- **Ship:** preview, versões, publicação, observação e continuidade.

O explorer de arquivos é parte de Resources e pode ficar permanentemente aberto, mas não monopoliza a organização do projeto.

### 3. Work Surface

Área central com tabs e splits verdadeiros. Pode hospedar conversa orientada a objetivo, editor de código, Markdown, intenção estruturada, terminal, diff, preview e painéis de evidência. Tudo pode ser aberto lado a lado; nenhuma superfície fica presa a uma conversa ou em modo append-only.

### 4. Context Dock

Painel lateral colapsável que responde quatro perguntas:

- Quem está agindo?
- Com qual contexto e escopo?
- O que pretende fazer e quais efeitos pode produzir?
- O que exige decisão humana agora?

Agrupa agente/modelo, context envelope, permissões, custo/budget e evidence relevante. Não vira um segundo painel de configurações.

### 5. Activity Strip

Barra operacional persistente e compacta. Mostra execução atual, checkpoints, efeitos observados, custo, checks e estado do preview. Expande para uma timeline auditável. É a ponte entre ações de agentes, arquivos modificados e resultado percebido.

## Home do projeto

Ao abrir um projeto, a IDE mostra uma página de situação — não uma conversa vazia e não uma árvore de arquivos isolada.

Ordem default:

1. **Continue construindo:** objetivo e próximo resultado concreto.
2. **Agora:** agentes, tarefas e previews ativos.
3. **Precisa de você:** decisões, permissões, divergências e falhas com consequência.
4. **Produto:** componentes/áreas já construídos e seu estado.
5. **Recentes:** sessões e mudanças como histórico temporal.

Um projeto novo substitui essa home por um canvas de intenção: “O que você quer colocar para funcionar?”. O autocomplete semântico ajuda enquanto a pessoa descreve, sem abrir um wizard técnico.

## Profundidade progressiva

Profundidade é uma propriedade de cada painel, não três produtos diferentes.

- **Essencial:** resultado, preview, decisões e explicações em linguagem comum.
- **Detalhado:** specs, plano, evidence, diffs e recursos afetados.
- **Raw:** arquivos, código, terminal, logs, payloads e configuração completa.

Full Vibes, Spec Mode e Hybrid alteram o ritmo e os gates do trabalho; não escondem nem removem superfícies. Perfis de layout podem trocar densidade e disposição sem mudar o estado subjacente.

## Composição default

- Centro: conversa/objetivo ao lado do preview durante criação inicial.
- Navigator: produto e recursos, com árvore de arquivos a um clique.
- Dock: agente e decisões que requerem atenção; recolhido quando vazio.
- Terminal e logs: drawer inferior, abrindo automaticamente apenas em falha relevante.
- Código e Markdown: tabs normais, editáveis, com split e diff.
- Evidence: aparece junto do artefato e da consequência, não como warning firehose global.

A interface lembra ferramentas criativas e ambientes operacionais mais do que um dashboard SaaS. Deve ser densa quando necessário, silenciosa no caminho feliz e visualmente legível para quem não conhece convenções de IDE.

## Game Mode

Game Mode é um perfil de feedback opcional sobre o mesmo produto, não uma economia artificial e não uma skin que reduz capacidade.

### Princípios herdados do Bastion

- Nunca premiar tokens consumidos, tempo sentado ou quantidade de prompts.
- Progressão cosmética não concede permissões, ferramentas ou qualidade de modelo.
- Pausas e cuidado não removem progresso nem envergonham o usuário.
- O modo pode ser desligado sem perder estado do projeto.

### Eventos dignos de progresso

- intenção importante esclarecida;
- spec/checkpoint concluído;
- teste ou critério verificável satisfeito;
- finding real resolvido sem regressão;
- feature experimentada no preview;
- entrega publicada ou atualização concluída;
- decisão explícita reconciliando intenção e implementação;
- pausa saudável depois de atividade contínua.

Eventos repetitivos, mudanças revertidas, geração volumosa e gasto de tokens não rendem progresso por si mesmos. O sistema premia outcomes confirmados e aprendizagem, não produção de ruído.

### Expressão visual

- Companion/mascote opcional, reativo ao estágio do trabalho: explorar, especificar, construir, verificar, corrigir e publicar.
- Pequenas celebrações nos marcos; nenhuma animação contínua disputando atenção.
- Missões representam objetivos reais do projeto, nunca tarefas inventadas para retenção.
- Progressão visual pode liberar cosméticos, ambientes, trilhas e variações do companion, nunca capacidade funcional.
- Respeitar reduced motion e possuir intensidade configurável.

### Archetypes descritivos

O Game Mode pode interpretar padrões de construção como identidade descritiva e mutável, nunca como classe fixa, ranking de valor ou gate funcional:

- **Explorer:** experimenta e valida hipóteses rapidamente.
- **Architect:** esclarece contratos, estrutura e dependências.
- **Finisher:** transforma protótipos em entregas completas.
- **Guardian:** resolve riscos e melhora confiabilidade.
- **Operator:** mantém e evolui produtos publicados.

Uma pessoa pode expressar vários archetypes ao mesmo tempo e mudar ao longo do projeto. Toda inferência deve mostrar quais eventos a sustentam, permitir ocultar/corrigir a leitura e evitar conclusões sobre produtividade baseadas em tokens, horas ou volume de código.

### Referência: LevelUp for VS Code (`levelupvscode.com`)

O produto comercial de Sinan Fischer é referência útil para a camada de apresentação: indicador persistente e discreto na status bar, dashboard-cockpit, Focus Points, Activity Tracker, Vault, metas, milestones, gráficos, Cortex e celebrações opcionais dentro do editor. Seu repositório público contém documentação; a implementação do produto não deve ser tratada como open source.

A IDE não deve copiar seu mecanismo de pontuação. O LevelUp mede atividade, keystrokes, linhas, tempo de foco e review e transforma FP acumulados em XP. Mesmo com multiplicadores de qualidade e mitigação de spam, numa IDE agentic isso poderia premiar geração, consumo e atividade manipulável. Usar apenas como referência de linguagem visual, feedback e ritual de progresso; os inputs da nossa progressão devem ser eventos semânticos e evidence-backed outcomes do harness.

O modo padrão continua profissional. Game Mode deve ser suficientemente bom para ser desejado, mas completamente dispensável para usar toda a IDE.

## Findings e permissões

- Findings aparecem no contexto do que podem quebrar e oferecem: entender, corrigir, rejeitar ou aceitar risco.
- Severidade e confiança são visualmente distintas.
- Permissões são pedidas no momento do efeito e formuladas pela consequência.
- Regras podem ser salvas por projeto, recurso, agente ou tipo de efeito.
- YOLO permanece explícito e visível; não transforma a Activity Strip em falsa garantia de controle.

## Direção para implementação

A Fase 1 deve implementar apenas o shell necessário para testar a categoria:

- Project Rail com um projeto benchmark;
- Navigator com Overview, Build, Resources e Evidence;
- Work Surface com intenção/conversa, editor, preview e diff mínimo;
- Context Dock com agente, escopo e uma decisão;
- Activity Strip ligando ação, mudança e preview;
- um primeiro ciclo do Game Mode baseado em outcome verificável.

Tauri e Electron devem ser comparados usando exatamente esse mesmo slice. Escolher stack antes desse protótipo criaria uma comparação abstrata e esconderia os custos das superfícies mais importantes.

## Questões para sketches

Os sketches devem comparar, sem mudar a arquitetura de informação:

1. experiência visual mais editorial/calm versus mais lúdica/ambiental;
2. conversa e preview lado a lado versus canvas central alternável;
3. companion persistente discreto versus presença somente em marcos;
4. densidade default para uma pessoa não técnica que ainda quer sentir controle.

---
*Last updated: 2026-08-22 after AAG-assisted review of Bastion Game Mode.*
