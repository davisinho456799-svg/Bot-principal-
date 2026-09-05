# Panel Watch — Chapter Monitor

Panel Watch monitors public chapter listings for Lezhin, Toomics, and Toptoon and publishes grouped thumbnail-only release strips to Discord.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL`, `DISCORD_BOT_TOKEN`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/chapter-monitor` — responsive configuration dashboard for watchlist, manual runs, channel selection, and health.
- `artifacts/api-server/src/routes/monitor.ts` — monitor API endpoints, Discord channel discovery, and persisted configuration.
- `artifacts/api-server/src/services/monitor-service.ts` — public listing polling, thumbnail extraction, deduplication, grouped strip generation, and Discord publishing.
- `lib/db/src/schema/monitor.ts` — works, detected chapters, activity, and monitor configuration tables.
- `lib/api-spec/openapi.yaml` — source of truth for generated monitor API clients and Zod schemas.

## Architecture decisions

- The app uses the Discord bot token for channel listing and message delivery; the user OAuth connection is not sufficient for channel writes.
- The first check for a newly added work captures a baseline without publishing the existing backlog.
- Chapter identity is stored per work using platform, chapter number, and thumbnail URL so old releases are never reposted.
- Release strips are generated as thumbnail-only SVG attachments and split into groups of up to five chapters for legibility.
- When no destination is configured, the first accessible channel named `previw` is selected automatically.

## Product

- Dashboard for monitored works, recent activity, health, and manual runs.
- Watchlist CRUD for Lezhin, Toomics, and Toptoon listing URLs.
- Discord channel discovery by guild/channel name, with automatic `previw` selection.
- Discord slash commands for adding and listing monitored works without opening the dashboard.
- Scheduled checks plus persistent deduplication of detected chapters.
- Grouped, numbered thumbnail strips with automatic splitting.

## User preferences

- The user's Discord destination is the channel named `previw` when it is accessible to the bot.

## Gotchas

- Site HTML and anti-bot rules can change; keep platform-specific parsing refinements isolated in `monitor-service.ts`.
- The monitor intentionally baselines existing chapters on first check, so a new work does not flood Discord with its full history.
- The app's managed workflows provide `PORT` and `BASE_PATH`; do not start artifact dev servers manually for preview debugging.
- The Discord command listener uses the same `DISCORD_BOT_TOKEN` and registers `/manhwa adicionar` and `/manhwa listar` per accessible guild.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
