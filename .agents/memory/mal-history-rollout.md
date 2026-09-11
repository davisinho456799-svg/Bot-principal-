---
name: MAL history rollout
description: Retenção e ordem segura para ativar o histórico de metadados do MAL/Jikan.
---

O histórico do MAL deve guardar o snapshot inicial e no máximo 10 alterações posteriores por título; alterações de sinopse, nota e status são registradas sem notificação, enquanto aumento de capítulos pode notificar.

**Why:** O usuário quer detectar mudanças sem deixar o PostgreSQL crescer indefinidamente, e a tabela nova precisa existir na Neon antes de o worker executar esse caminho em produção.

**How to apply:** Antes de ativar ou publicar mudanças que usem esse histórico, aplicar o schema na Neon sem apagar dados existentes e só criar commit/push após autorização explícita do usuário.