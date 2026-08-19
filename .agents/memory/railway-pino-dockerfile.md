---
name: Railway + pino Dockerfile path
description: Pino embeds the absolute build-time path for thread-stream-worker; the Docker runtime must preserve that path.
---

## Rule
When bundling with esbuild + `esbuild-plugin-pino`, the plugin embeds the **absolute build-time path** of `thread-stream-worker.mjs` into the bundle. If the Dockerfile copies `dist/` to a different path in the final image, pino crashes at runtime with `Cannot find module '.../thread-stream-worker.mjs'`.

**Fix:** In the final Docker stage, copy the dist folder to the **same relative path** it had during the build:

```dockerfile
# Builder stage: WORKDIR /app, builds to /app/artifacts/api-server/dist/
COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist
CMD ["node", "--enable-source-maps", "./artifacts/api-server/dist/index.mjs"]
```

**Why:** esbuild-plugin-pino resolves and hard-codes the path to pino's worker files at build time. Moving the dist folder breaks that hard-coded path.

**How to apply:** Any time this monorepo's api-server is containerized, keep `/app/artifacts/api-server/dist/` as the runtime path, not `/app/dist/`.

## Also noted
- Fly.io free tier requires a credit card — Railway (railway.app) is the confirmed working host (no card needed, $5/month free credit).
- Railway auto-deploys on push to the `bot` branch via the connected GitHub repo.
- Node 22 required (pnpm 11+ requires Node ≥ 22.13).
