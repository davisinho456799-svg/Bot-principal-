import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot/index.js";
import { pool } from "@workspace/db";

const rawPort = process.env["PORT"];
const DATABASE_STARTUP_TIMEOUT_MS = 20_000;

function withStartupTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`${label} excedeu ${DATABASE_STARTUP_TIMEOUT_MS}ms`)),
        DATABASE_STARTUP_TIMEOUT_MS,
      );
    }),
  ]);
}

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Promise rejeitada sem tratamento");
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Exceção não tratada — encerrando para o Render reiniciar");
  process.exit(1);
});

async function startApplication() {
  logger.info(
    {
      hasPort: Boolean(rawPort),
      hasDatabaseUrl: Boolean(process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL),
      hasDiscordToken: Boolean(
        process.env.DISCORD_BOT_TOKEN ??
          process.env.Discord_bot_key ??
          process.env.Discord_key,
      ),
    },
    "Iniciando aplicação",
  );

  try {
    await withStartupTimeout(pool.query("select 1"), "Conexão inicial com o PostgreSQL");
    logger.info("Conexão com o PostgreSQL confirmada");
  } catch (err) {
    logger.error(
      { err },
      "Não foi possível conectar ao PostgreSQL. Configure NEON_DATABASE_URL no Render.",
    );
    process.exit(1);
  }

  if (!rawPort) {
    logger.info("PORT não definido; iniciando como worker do Discord");
    await startBot();
    return;
  }

  const port = Number(rawPort);

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");

    void startBot().catch((err) => {
      logger.error({ err }, "Falha ao iniciar o bot do Discord");
      process.exit(1);
    });
  });
}

void startApplication().catch((err) => {
  logger.error({ err }, "Falha ao iniciar a aplicação");
  process.exit(1);
});
