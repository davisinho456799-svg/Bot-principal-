# Bot de Manhwa — Discord Bot

Bot do Discord para busca, rastreamento e gerenciamento de manhwas, mangás e animes. Integra AniList, MangaDex, Comick, MangaUpdates, Jikan (MAL), Kitsu, AniDB, VNDB e Exa AI.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — roda o servidor + bot (porta 5000)
- `pnpm run typecheck` — typecheck completo em todos os pacotes
- `pnpm run build` — typecheck + build de todos os pacotes
- `pnpm --filter @workspace/api-spec run codegen` — regenera hooks e schemas a partir do OpenAPI
- `pnpm --filter @workspace/db run push` — aplica schema no banco (dev only)
- Required env: `DATABASE_URL` — Postgres connection string, `DISCORD_BOT_TOKEN` — token do bot

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Bot: Discord.js 14
- DB: PostgreSQL + Drizzle ORM
- Validação: Zod (`zod/v4`), `drizzle-zod`
- Build: esbuild (ESM bundle)

## Onde ficam as coisas

- `artifacts/api-server/src/bot/` — todo o código do bot (comandos, integrações, serviços)
- `artifacts/api-server/src/bot/commands/` — slash commands do Discord
- `lib/db/src/schema/index.ts` — schema completo do banco de dados
- `render.yaml` — blueprint de deploy no Render

## Tabelas do banco de dados

- `favoritos` — lista de favoritos por usuário Discord
- `lista_leitura` — lista de leitura com status (lendo, concluído, planejo, pausado, abandonado)
- `notificacao_canais` — canais de notificação por servidor Discord
- `capitulos_rastreados` — rastreamento de capítulos para notificações
- `search_cache` — cache de busca de 24h para reduzir chamadas às APIs
- `title_aliases` — mapeamento de títulos alternativos → título canônico
- `description_matches` — aprendizado histórico de busca por descrição

## Comandos do Bot

`/manhwa`, `/buscar`, `/top`, `/lancamentos`, `/aleatorio`, `/recomendar`, `/similar`, `/comparar`, `/autor`, `/favoritos`, `/lista`, `/perfil`, `/ranking`, `/notificar`, `/anime`, `/vn`, `/ajuda`

## Variáveis de ambiente (obrigatórias)

- `DISCORD_BOT_TOKEN` — token do bot no Discord Developer Portal
- `DATABASE_URL` — connection string do PostgreSQL
- `PORT` — porta HTTP (definida automaticamente pelo Render)
- `EXA_API_KEY` — (opcional) chave da API Exa para links diretos de scan

## Deploy no Render

Ver `render.yaml` na raiz do projeto. O Render usa:
- **Build:** `npm install -g pnpm && pnpm install && pnpm --filter @workspace/api-server run build`
- **Start:** `node --enable-source-maps artifacts/api-server/dist/index.mjs`

## User preferences

_Communicate in Brazilian Portuguese._

## Gotchas

- Após qualquer mudança no schema (`lib/db/src/schema/index.ts`), rodar `pnpm --filter @workspace/db run push` para aplicar no banco.
- O bot precisa de `DISCORD_BOT_TOKEN` para iniciar; sem ele, o servidor HTTP sobe mas o bot não.
- O keep-alive faz ping a cada 8 minutos para evitar que o Render hiberne o serviço gratuito.

## Pointers

- Ver a skill `pnpm-workspace` para estrutura do workspace, TypeScript e detalhes dos pacotes.
