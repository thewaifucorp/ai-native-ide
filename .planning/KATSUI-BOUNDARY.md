# AI-Native IDE × Katsui Boundary

**Status:** ratificado para planejamento inicial  
**Objetivo:** fazer da IDE uma superfície forte de criação agent-first e de distribuição
das soluções Katsui, sem transformá-la num substituto local dos produtos premium.

## Teste de decisão

```text
Uma pessoa precisa disso para construir e evoluir software no projeto local?
  Sim → pode existir na IDE.

Essa versão local resolve o trabalho tão bem que elimina o motivo para usar
o produto Katsui correspondente?
  Sim → redesenhar como capability limitada/conector, não replicar o produto.

Existe uma solução Katsui para a capability?
  Sim → a IDE deve expor provider neutro/local e uma rota contextual
  `Conectar Katsui`, com cobertura e degradações explícitas.
```

## IDE gratuita

- projeto semântico, repos e recursos reutilizáveis;
- editor, busca, terminal, Source Control, extensões, debugger, checks, preview e
  deploy/export;
- documentos e código editáveis;
- Local Truth Registry baseado em arquivos;
- relações locais SoT↔consumidores↔evidência;
- AAG/local graph provider;
- análise local de projeto existente e candidates revisáveis de Guidance/SoT/configuração;
- referências externas com proveniência e assets versionados do projeto;
- inspeção do contexto efetivamente enviado ao agente;
- Activity Strip básico do projeto, projetado de eventos Bastion Core pertinentes;
- Anotações de exploração e reconciliação local com SoTs/Guidances/Features;
- Features, Tasks e Subtasks locais com evidência e Status calculado por projeto;
- composer de intenção e ajuda contextual neutros; providers externos são opcionais;
- Harness Providers locais/versionáveis sobre capabilities do Core, inclusive adapters
  de workflow como GSD, sem substituir os invariantes do host;
- hooks e reconciliação locais;
- checks determinísticos;
- semantic evaluator geral limitado por budget;
- context compression local básica;
- permissions/effect broker básicos;
- agents/models/adapters neutros.
- Project Agents definidos pelo usuário, times, tarefas, handoffs e effects sobre
  o projeto; não são Digital Workers nem usam a Company Brain como estado canônico.

## Katsui/provider organizacional

- Slack, Teams, Notion, Drive, CRM, ERP e conectores;
- Mugen ingestion/ETL;
- Company Brain Knowledge Layer e Ontology Layer;
- retrieval, rewrite, rerank e stores por owner;
- registries organizacionais de skills/prompts/regras/tooling;
- propagação, aprovação e rollback cross-project/agent;
- Kekkai completo;
- Iai Gate routing/cache/compression/economics;
- Shiori avançado;
- tenancy, cloud, Control Tower, Agent Dojo e objetos vivos;
- governança e estado operacional organizacionais.
- telemetria contínua, workforce, SLAs e painéis de operação/Control Tower.

## Regra de produto

Capacidades gratuitas devem ser suficientes e honestas, mas não podem virar um
substituto local de um produto Katsui. A IDE usa contratos do Bastion Core e pode
conectar componentes externos; a integração mostra o valor Katsui no lugar onde a
capability é usada, não como upsell genérico.

Se houver sobreposição futura, avaliar nesta ordem:

1. ela é indispensável à promessa de construção agent-first da IDE?
2. qual produto Katsui a capability pode promover e qual profundidade permanece
   exclusiva/mais forte nele?
3. o provider local disputa autoridade, retenção, segurança ou estado do produto
   Katsui? Se sim, reduzir a capability ou transformá-la em conector.
4. a integração pode explicar honestamente cobertura, limites e motivo para conectar
   Katsui?
5. somente então implementar.

---
*Last updated: 2026-08-26 after exploration, Feature/Task and verification reconciliation.*
