---
name: Notification baseline retry
description: Regra para não consumir capítulos quando uma notificação do Discord falha.
---

O caminho de notificações baseado em Jikan/MAL deve comparar com `capitulos_rastreados.last_chapters` e só avançar essa linha de base depois de um envio bem-sucedido, ou quando não existe canal configurado. O histórico de alterações do MAL é informativo e não deve mascarar uma tentativa de envio que falhou.

**Why:** Gravar o capítulo atual antes de chamar o Discord fazia `sendNotification()` retornar `false`, mas o próximo ciclo enxergava o capítulo como já processado e nunca tentava novamente.

**How to apply:** Ao alterar o verificador automático, preserve a linha de base em falhas de canal, registre o motivo de um retorno `false` e diferencie `changed: false` da rota legada de uma falha de envio do Discord.