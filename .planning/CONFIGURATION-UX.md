# Configuration UX Contract

**Status:** decisão inicial  
**Autoridade:** experiência default de configuração da AI-Native IDE  
**Detalhamento de harness:** `.planning/HARNESS-SPEC.md` §22

## Princípio

O usuário deve conseguir começar a construir antes de compreender o sistema de configuração. Poder não pode exigir setup antecipado; escolhas aparecem quando possuem contexto e consequência compreensíveis.

## Modelo

```text
Detectar automaticamente
    → aplicar default reversível
    → revelar a escolha no momento relevante
    → permitir aprofundar/editar
    → salvar por projeto ou perfil
```

## Três classes

### Necessária agora

Perguntar somente quando não existe caminho seguro/funcional para continuar. Exemplos: qual projeto abrir, como autenticar o agente escolhido, confirmar primeiro deploy.

### Default administrado pela IDE

A IDE detecta, escolhe e informa sem bloquear. Exemplos: Hybrid, balanced permissions, AAG local, checkpoints, adaptive concise, harness layers 0/1.

### Opcional/avançada

Permanece pesquisável e editável, mas não ocupa onboarding. Exemplos: routing, policies por ferramenta, budget granular, packs, layout, schemas de authority e providers organizacionais.

## Regras de UX

- Sem wizard longo.
- Sem settings dump antes do primeiro artefato.
- Perguntas em linguagem de consequência, não nomes internos.
- Uma recomendação clara por pergunta.
- Sempre oferecer undo/reconfiguração.
- Configuração por intenção e busca semântica.
- Interface simples e arquivo de configuração completo representam o mesmo estado.
- Feature degradada explica o que falta no momento de uso.
- Modo de construção e perfil de permissão são conceitos separados.
- Layout/perfil muda apresentação; não cria projeto incompatível.

## First-run target

Em um projeto novo, o caminho feliz deve exigir no máximo:

1. descrever o que quer construir;
2. aceitar ou trocar o agente/modelo detectado;
3. confirmar apenas o primeiro efeito que ultrapasse o escopo local/reversível.

Qualquer pergunta adicional precisa justificar por que não pode esperar.

---
*Last updated: 2026-08-22 after founder direction on simplified configuration.*
