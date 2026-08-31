# Como trabalhar neste projeto

Este é o leilão de lances selados. O ranking vive em src/auction.ts e a intenção
declarada está em [intenção do produto](docs/product-intent.md).

# Desempate

Um lance precisa exceder estritamente o valor atual para assumir a posição.
Ordem de criação nunca decide empate.

# Privacidade do leaderboard

A listagem pública não expõe o id do lance. O preview em src/server.ts existe
para conferir isso na resposta real.

# Como medir

Rode `npm run test` antes de propor mudança no ranking. Referência de formato de
lance: https://exemplo.test/sealed-bid-spec
