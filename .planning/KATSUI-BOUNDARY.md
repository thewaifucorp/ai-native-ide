# AI-Native IDE × Katsui Boundary

**Status:** ratificado para planejamento inicial  
**Objetivo:** impedir tanto canibalização acidental quanto limitação artificial da IDE

## Teste de decisão

```text
Uma pessoa precisa disso para possuir e evoluir um projeto local?
  Sim → IDE gratuita.

Uma organização precisa disso para ingerir, governar, compartilhar,
servir ou operar conhecimento/estado entre pessoas e sistemas?
  Sim → Katsui ou outro provider organizacional.
```

## IDE gratuita

- projeto semântico, repos e recursos reutilizáveis;
- editor, terminal, Git, preview e deploy/export;
- documentos e código editáveis;
- Local Truth Registry baseado em arquivos;
- relações locais SoT↔consumidores↔evidência;
- AAG/local graph provider;
- hooks e reconciliação locais;
- checks determinísticos;
- semantic evaluator geral limitado por budget;
- context compression local básica;
- permissions/effect broker básicos;
- agents/models/adapters neutros.

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

## Regra de produto

Capacidades gratuitas devem ser suficientes e honestas. Não precisam igualar profundidade, conectores, serving, governança, escala ou inteligência organizacional Katsui.

Se houver sobreposição futura, avaliar nesta ordem:

1. a capacidade é indispensável à promessa local da IDE?
2. a Katsui está vendendo uma feature commoditizada em vez de profundidade organizacional?
3. a integração pode transformar a IDE em canal de distribuição?
4. é necessário repivotar Katsui, separar package/provider ou mudar posicionamento?
5. somente depois considerar remover/limitar a capacidade da IDE.

---
*Last updated: 2026-08-22 after Company Brain scope audit.*
