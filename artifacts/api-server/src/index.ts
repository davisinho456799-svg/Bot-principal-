import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot/index";
import { pool } from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Garante que tabelas criadas ou alteradas recentemente existam no banco de produção.
// Usa SQL direto (sem drizzle-kit) para ser confiável em qualquer ambiente.
async function runMigrations() {
  try {
    // ── usage_logs ──────────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usage_logs (
        id                SERIAL PRIMARY KEY,
        discord_user_id   TEXT      NOT NULL,
        discord_username  TEXT      NOT NULL,
        guild_id          TEXT,
        command           TEXT      NOT NULL,
        query             TEXT,
        created_at        TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    // ── assinaturas ─────────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS assinaturas (
        id               SERIAL PRIMARY KEY,
        discord_user_id  TEXT      NOT NULL,
        guild_id         TEXT      NOT NULL,
        manhwa_id        TEXT      NOT NULL,
        source           TEXT      NOT NULL,
        title            TEXT      NOT NULL,
        cover_url        TEXT,
        site_url         TEXT      NOT NULL,
        tipo             TEXT      NOT NULL DEFAULT 'manhwa',
        adult            BOOLEAN   NOT NULL DEFAULT FALSE,
        added_at         TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (discord_user_id, manhwa_id, guild_id)
      )
    `);

    // Colunas adicionadas depois da criação inicial — seguras de rodar sempre.
    await pool.query(`
      ALTER TABLE assinaturas
        ADD COLUMN IF NOT EXISTS tipo   TEXT    NOT NULL DEFAULT 'manhwa',
        ADD COLUMN IF NOT EXISTS adult  BOOLEAN NOT NULL DEFAULT FALSE
    `);

    logger.info("Migrations OK");
  } catch (err) {
    logger.warn({ err }, "Falha na migration de startup (não fatal)");
  }
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startKeepAlive(port);
});

runMigrations().then(() => {
  startBot().catch((err) => {
    logger.error({ err }, "Falha ao iniciar o bot do Discord");
  });
});

function startKeepAlive(serverPort: number) {
  const INTERVAL_MS = 8 * 60 * 1000; // 8 minutos
  setInterval(async () => {
    try {
      const res = await fetch(`http://localhost:${serverPort}/api/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      logger.debug({ status: res.status }, "Keep-alive ping OK");
    } catch (err) {
      logger.warn({ err }, "Keep-alive ping falhou");
    }
  }, INTERVAL_MS);
  logger.info({ intervalMin: 8 }, "Keep-alive iniciado");
}
