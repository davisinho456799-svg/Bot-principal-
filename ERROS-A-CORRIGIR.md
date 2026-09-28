# Erros e ajustes pendentes do bot

Este arquivo é apenas uma lista para a próxima pessoa corrigir. A lógica do bot não foi alterada nesta etapa.

## 1. Erro que impede o build

- [ ] Corrigir o erro `Could not resolve "discord.js"` no `artifacts/api-server`.
- [ ] Reinstalar ou alinhar as dependências do pacote do servidor com o `pnpm-lock.yaml`.
- [ ] Confirmar que o `discord.js` está disponível no ambiente antes de iniciar o bot.
- [ ] Depois disso, rodar o typecheck e o build novamente. Enquanto esse erro existir, o servidor não inicia.

## 2. Configuração obrigatória para executar o bot

- [ ] Configurar `NEON_DATABASE_URL` ou `DATABASE_URL` com o PostgreSQL correto.
- [ ] Configurar o token do Discord em `DISCORD_BOT_TOKEN` (os nomes antigos `Discord_bot_key` e `Discord_key` ainda aparecem como alternativas).
- [ ] Confirmar que o banco recebeu todas as tabelas e alterações do schema antes de iniciar as notificações.
- [ ] Conferir os logs de inicialização para garantir que o PostgreSQL e o Discord conectaram.

## 3. Fontes de capítulos

- [ ] Usar **Comick** como fonte principal de capítulos.
- [ ] Usar **MangaUpdates** como fonte oficial principal/alternativa de capítulos quando houver autenticação e dados válidos.
- [ ] Usar **MangaDex** somente como fallback quando Comick ou MangaUpdates falharem ou não retornarem um capítulo real.
- [ ] Não usar timestamp, `updatedAt` ou outra data de atualização como se fosse número de capítulo.
- [ ] Quando uma fonte falhar, tentar a próxima sem travar o comando nem interromper o worker de notificações.
- [ ] Comparar resultados por título/obra antes de aceitar o fallback, para não pegar o capítulo de outra série.
- [ ] Selecionar apenas uma fonte real por verificação, evitando notificações duplicadas.
- [ ] Confirmar que capítulos vazios, `0`, `null` ou inválidos não sejam tratados como lançamento novo.
- [ ] Conferir o filtro de idioma e de edição no MangaDex para evitar escolher uma versão inesperada da obra.
- [ ] Confirmar que as credenciais opcionais do MangaUpdates (`MANGAUPDATES_USERNAME` e `MANGAUPDATES_PASSWORD`) estão configuradas quando essa fonte for usada.
- [ ] Manter o refresh da sessão do MangaUpdates quando a API responder `401`.
- [ ] Não usar o RSS público do MangaUpdates como feed individual de uma série: ele não é confiável para esse uso.

## 4. Metadados

- [ ] Usar **MAL/Jikan** e **AniList** para metadados: título, sinopse, capa, nota, gêneros, status e ano.
- [ ] Não tratar MAL/Jikan ou AniList como fonte oficial de capítulos atuais quando o campo de capítulos estiver vazio ou desatualizado.
- [ ] Conferir o vínculo entre o ID do metadado e a obra encontrada no Comick/MangaUpdates/MangaDex.
- [ ] Evitar substituir metadados corretos por uma correspondência de título incorreta.
- [ ] Tratar limites de requisição e respostas `429`, `401`, `403`, `404` e `5xx` sem quebrar a busca.

## 5. Registro de erros

- [ ] Registrar no histórico qual fonte falhou, qual foi o status HTTP e qual obra estava sendo consultada.
- [ ] Registrar também timeout, resposta vazia e erro de formato da API.
- [ ] Mostrar no diagnóstico qual foi a fonte principal tentada, quais fallbacks foram tentados e qual fonte foi escolhida.
- [ ] Não esconder falhas importantes em `catch` vazio quando elas forem necessárias para investigar notificações que não chegaram.
- [ ] Não enviar tokens, senhas ou credenciais nos logs.

## 6. Notificações

- [ ] Não enviar notificação quando nenhuma fonte retornar um capítulo real.
- [ ] Não atualizar a linha de base do banco usando um valor proxy ou inválido.
- [ ] Garantir que uma mesma atualização gere somente uma notificação.
- [ ] Confirmar que o worker continua rodando mesmo quando uma API externa está indisponível.
- [ ] Testar uma obra com capítulo novo, uma obra sem dados e uma obra com a fonte principal fora do ar.

## 7. Publicação

- [ ] A branch `bot` original não foi sobrescrita.
- [ ] O estado documentado foi publicado na branch `bot-atualizacao`.
- [ ] Para atualizar a branch `bot`, será necessário fazer o merge ou um force push com uma conexão GitHub que tenha permissão de escrita.

## Documentação de referência já existente

- `.agents/memory/mangaupdates-api.md`
- `.agents/memory/notification-source-fallback.md`
- `.agents/memory/notification-http-status-logging.md`
- `.agents/memory/render-discord-worker.md`
- `.agents/memory/discord-component-interactions.md`