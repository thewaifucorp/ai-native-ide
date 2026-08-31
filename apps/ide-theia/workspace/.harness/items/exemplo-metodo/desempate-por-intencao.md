# Desempate por intenção

- estado: aberto
- nivel: tarefa

`src/auction.ts` desempata por `createdAt`, e `docs/product-intent.md` diz que
ordem de criação não pode decidir. Este artefato existe para provar o contrato:
foi criado como arquivo, é lido pelo registry, aparece na view Ferramentas, e
sobrevive a activate/suspend/migrate do provider.

Uma pessoa ou um agente edita este arquivo direto. O IDE lê o que está no disco.
