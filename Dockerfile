FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm run railway:build \
  && test -f /app/artifacts/chapter-monitor/dist/public/index.html \
  && test -f /app/artifacts/api-server/dist/index.mjs

FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV SERVE_FRONTEND=true

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/artifacts/api-server/node_modules ./artifacts/api-server/node_modules
COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=builder /app/artifacts/chapter-monitor/dist/public ./artifacts/chapter-monitor/dist/public

CMD ["node", "--enable-source-maps", "./artifacts/api-server/dist/index.mjs"]