# AI-Native IDE

## What This Is

Uma IDE gratuita e agnóstica de modelos e agentes que ressignifica o ambiente de desenvolvimento para uma realidade em que intenção delegada, especificação e código são superfícies igualmente importantes. Ela permite que pessoas não técnicas construam, publiquem, operem e evoluam software real sem esconder os artefatos técnicos, enquanto oferece a pessoas técnicas controle suficiente para substituir uma IDE tradicional ou um agente de terminal.

A experiência combina prompting guiado, especificações vivas, edição direta, agentes intercambiáveis, guias contextuais e um harness semântico capaz de compreender o produto sendo construído. Projetos são unidades semânticas duráveis que podem agregar vários repositórios, pastas, serviços e ambientes; conversas são sessões dentro deles, nunca o contêiner do trabalho.

## Core Value

Transformar intenção em software real e continuamente controlável, mantendo intenção, especificação e implementação reconciliáveis por humanos e agentes.

## Business Context

- **Customer**: Primariamente pessoas não técnicas que querem construir ferramentas para si ou para seus negócios; secundariamente pessoas técnicas que também se beneficiam de prompting guiado, contexto durável e harnesses semânticos.
- **Revenue model**: A IDE deve permanecer gratuitamente utilizável; monetização potencial por rail de inferência/capacidade, marketplace, distribuição patrocinada transparente, serviços hospedados e ecossistema ShinAI. Assinatura é opcional, não premissa.
- **Success metric**: Pessoas conseguem criar e continuar operando software útil e real que antes exigiria contratar um desenvolvedor ou comprar um SaaS, escolhendo livremente seus agentes e modelos.
- **Strategy notes**: A conversa fundadora permanece integralmente registrada em `FIRST.md`.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Permitir construir aplicações reais como sites de lojas, ferramentas internas, microsaaS e agentes/chatbots a partir de intenções expressas em linguagem natural.
- [ ] Oferecer três modos configuráveis de construção: Full Vibes, Spec Mode e Hybrid.
- [ ] Tratar intenção/spec e código como estados igualmente reais, detectando divergências e ajudando o usuário a reconciliá-las.
- [ ] Tornar código, Markdown, arquivos, terminal e configuração diretamente acessíveis e editáveis, sem append-only ou artefatos aprisionados em conversas.
- [ ] Oferecer autocomplete de intenção/prompt que detecte ambiguidades, decisões ausentes, riscos e conhecimentos necessários, em vez de apenas completar texto.
- [ ] Oferecer harness semântico que compreenda o tipo de produto e encontre falhas além de lint ou análise sintática.
- [ ] Fornecer guias e explicações contextuais no momento em que conceitos e decisões se tornam relevantes.
- [ ] Organizar trabalho por projetos semânticos duráveis, aos quais múltiplos repositórios, diretórios, documentos, serviços e ambientes podem ser vinculados.
- [ ] Permitir que o mesmo recurso participe de múltiplos projetos sem duplicação, formando um grafo de contexto em vez de uma árvore rígida de diretórios.
- [ ] Tratar sessões como histórico temporal de trabalho sobre um projeto, com escopo explícito de recursos, e não como contêiner de arquivos ou fonte da verdade.
- [ ] Suportar profundidade progressiva numa interface única, configurável e capaz de salvar perfis sem separar usuários em produtos técnico e não técnico.
- [ ] Integrar modelos brutos, APIs, gateways, modelos locais, agentes completos e CLIs, preservando as capacidades nativas e a autenticação própria de cada integração quando possível.
- [ ] Usar um contrato de capacidades para agentes e explorar ACP como protocolo preferencial sem tornar a arquitetura dependente de uma implementação alpha específica.
- [ ] Permitir configuração de permissões por projeto e recurso, incluindo um modo irrestrito explícito, sem depender apenas de regras universais.
- [ ] Sustentar o uso contínuo do software após sua criação, incluindo evolução, manutenção e compreensão do estado em produção.

### Out of Scope

- Cobrar assinatura obrigatória para acessar a IDE — contradiz a estratégia de distribuição; serviços opcionais pagos continuam possíveis.
- Bloquear o usuário em um modelo, provider, agente ou infraestrutura ShinAI — neutralidade e capacidade de trazer ferramentas existentes são centrais.
- Esconder permanentemente código, documentos ou estado técnico — abstração deve ser progressiva e reversível.
- Usar conversas como estrutura primária de organização de projetos — sessões registram trabalho, mas não possuem o projeto.
- Reduzir o produto a uma interface de chat sobre um editor — a proposta exige novos primitives de intenção, reconciliação e análise semântica.
- Definir agora um mercado universal de tokens ou uma integração obrigatória com Katsui — são hipóteses estratégicas que exigem pesquisa e validação separadas.

## Context

A motivação é distributiva: desenvolvedores e, cada vez mais, pessoas não técnicas preferem construir ferramentas próprias a acumular assinaturas. IDEs tradicionais oferecem controle, mas pressupõem conhecimento técnico; ambientes conversacionais simplificam demais e escondem artefatos; agentes de terminal são poderosos, mas possuem organização, permissões, legibilidade e orientação insuficientes.

O primeiro território de produto inclui sites comerciais, ferramentas de gerenciamento para empresas, microsaaS pequenos e agentes/chatbots. `melhorlance.dev`, um leaderboard pago construído rapidamente por um engenheiro sênior, é uma referência do nível de aplicação pequena porém real que a IDE deve tornar acessível a uma pessoa menos técnica.

O produto pode servir como camada de distribuição da ShinAI e incentivar Katsui, Exia e Bastion sem necessariamente se tornar a própria Katsui. Conceitos e componentes desses produtos podem contribuir com roteamento de inferência, contexto, aprendizado, segurança e agentes especializados, mas qualquer dependência ou posicionamento formal permanece em aberto.

ACP parece uma base promissora para integrar agentes externos estruturadamente; ACPX pode ajudar em protótipos, mas está em alpha. APIs diretas, adaptadores de CLI e integrações locais continuarão necessários. O núcleo aberto é a direção preferida para confiança e ecossistema, mas licença e fronteira comercial ainda precisam de pesquisa.

## Constraints

- **Neutralidade**: Recursos essenciais não podem exigir um único modelo, agente ou provider — a distribuição depende de escolha real.
- **Controle**: Toda abstração deve permitir descida progressiva até arquivos e código reais — evitar o aprisionamento observado em ambientes conversacionais.
- **Persistência**: Decisões importantes não podem existir somente em chats ou comentários dispersos — humanos e agentes precisam de um estado compartilhado e versionável.
- **Interoperabilidade**: Integrações devem preservar capacidades próprias dos agentes e degradar com clareza quando um protocolo não oferecer determinada função.
- **Estratégia**: O acesso básico à IDE deve permanecer gratuito — monetização deve emergir dos mercados e serviços ao redor da criação.
- **Greenfield**: Não há implementação nem stack escolhida — decisões técnicas devem seguir pesquisa e protótipos dos riscos principais.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Suportar Full Vibes, Spec Mode e Hybrid | Diferentes pessoas e momentos exigem velocidades e graus de deliberação distintos | — Pending |
| Manter estado duplo entre intenção/spec e código | Documentos são legíveis por humanos; implementação é a realidade executável; divergência silenciosa entre eles é um gargalo central | — Pending |
| Projeto semântico acima de repositório ou conversa | Produtos reais podem ocupar vários repos e recursos; uma conversa é apenas um episódio de trabalho | — Pending |
| Permitir recursos compartilhados entre projetos | Infraestrutura, documentos e componentes podem servir a mais de um produto sem duplicação | — Pending |
| Usar uma interface com profundidade progressiva | Evita separar pessoas em uma experiência simplificada sem controle e outra excessivamente técnica | — Pending |
| Tratar agentes completos e modelos brutos como integrações distintas | Agentes possuem autenticação, ferramentas, sessões e capacidades que não cabem honestamente numa API uniforme de chat | — Pending |
| Preferir um núcleo aberto, sem escolher ainda a licença | Transparência e extensibilidade favorecem distribuição; a fronteira do moat e dos serviços comerciais ainda precisa ser definida | — Pending |
| Manter integração Katsui opcional até validação | A IDE pode distribuir o ecossistema ShinAI sem comprometer neutralidade ou sobrepor produtos prematuramente | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `$gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `$gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-08-22 after initialization*
