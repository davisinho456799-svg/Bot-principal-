FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace config
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./

# Copy all packages needed for build
COPY lib/ ./lib/
COPY artifacts/api-server/ ./artifacts/api-server/

# Install dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts

# Build the bot
RUN pnpm --filter @workspace/api-server run build

# ---- Runtime stage ----
FROM node:22-alpine

WORKDIR /app

# yt-dlp + ffmpeg para streaming de áudio do YouTube sem bloqueio de IP
# Instala ffmpeg e a versão mais recente do yt-dlp via pip (apk pode ter versão antiga)
RUN apk add --no-cache ffmpeg python3 py3-pip && \
    pip3 install --no-cache-dir --break-system-packages yt-dlp

# Preserva o caminho exato usado no build (pino embute o path absoluto dos workers)
COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist

CMD ["node", "--enable-source-maps", "./artifacts/api-server/dist/index.mjs"]
