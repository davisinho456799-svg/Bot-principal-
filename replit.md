# Bot de Notificação Discord + MAL

API para monitorar atualizações de mangás/animes no MyAnimeList e notificar membros do Discord via bot.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — contrato da API (source of truth)
- `lib/db/src/schema/subscriptions.ts` — tabela de assinaturas
- `lib/db/src/schema/malSnapshots.ts` — tabela de snapshots (máx. 2 por assinatura)
- `artifacts/api-server/src/routes/subscriptions.ts` — rotas de assinatura e check
- `artifacts/api-server/src/lib/mal.ts` — integração com a API do MAL

## Architecture decisions

- Snapshots limitados a 2 por assinatura: a mais antiga é apagada a cada novo check para não pesar no banco
- `changed: true` apenas quando `chapters` aumenta — outros campos (sinopse, nota, status) são armazenados mas não disparam notificação
- MAL API usa `X-MAL-CLIENT-ID` no header — sem OAuth, só leitura de dados públicos

## Product

- Membros do Discord usam `/assinar adicionar` para monitorar mangás/animes do MAL
- O bot chama `POST /api/subscriptions/{id}/check` periodicamente
- Se `changed: true`, o bot menciona o membro no canal informando novo capítulo

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
