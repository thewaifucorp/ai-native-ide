# Guidance — imported

## Desempate

- id: guidance-000000
- estado: Active
- força: Suggestion
- escopo: project:/home/mario/Área de trabalho/waifucorp/ai-native-ide/apps/ide-theia/workspace
- duração: Permanent

Um lance precisa exceder estritamente o valor atual para assumir a posição.

## Intenção · auction-concurrency:leilão

- id: guidance-000001
- estado: Candidate
- força: Suggestion
- escopo: project:/home/mario/Área de trabalho/waifucorp/ai-native-ide/apps/ide-theia/workspace
- duração: Permanent

Dois lances simultâneos são serializados por transação, e o desempate é por valor selado — nunca por ordem de criação.

## como resolver empate

- id: guidance-000002
- estado: Candidate
- força: Suggestion
- escopo: project:/home/mario/Área de trabalho/waifucorp/ai-native-ide/apps/ide-theia/workspace
- duração: Permanent

Vence o maior valor selado. Empate exato é recusado, e ordem de criação nunca decide.

