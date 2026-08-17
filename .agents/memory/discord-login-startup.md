---
name: Discord login startup
description: Regras para resolver o token e aguardar o Gateway do Discord em ambientes de deploy.
---

O token do Discord deve ser escolhido entre variáveis não vazias, com espaços externos removidos, e o tempo de espera do Gateway deve ser configurável por ambiente, mantendo um limite padrão generoso para cold starts. A conexão deve ser supervisionada com novas tentativas e nunca derrubar a API por indisponibilidade temporária do Discord.

**Why:** Deploys podem demorar mais que um timeout curto para completar o handshake do Gateway; além disso, uma variável principal vazia pode impedir o uso de uma variável legada válida. O Discord é uma dependência externa e não deve tornar o endpoint HTTP indisponível.

**How to apply:** Ao alterar a inicialização do bot, preserve o diagnóstico sem expor o token, aceite `DISCORD_LOGIN_TIMEOUT_MS` para redes lentas, diferencie falha de credencial de atraso de conexão nos logs, destrua clientes que expiraram e use backoff para tentar novamente.