FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm run railway:build

FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV SERVE_FRONTEND=true

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/artifacts/api-server/node_modules ./artifacts/api-server/node_modules
COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=builder /app/artifacts/chapter-monitor/dist ./artifacts/chapter-monitor/dist

CMD ["node", "--enable-source-maps", "./artifacts/api-server/dist/index.mjs"]