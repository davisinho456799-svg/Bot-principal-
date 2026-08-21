import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot/index.js";
import { pool } from "@workspace/db";

const rawPort = process.env["PORT"];

async function startApplication() {
  try {
    await pool.query("select 1");
    logger.info("Conexão com o PostgreSQL confirmada");
  } catch (err) {
    logger.error(
      { err },
      "Não foi possível conectar ao PostgreSQL. No Railway, configure DATABASE_URL ou NEON_DATABASE_URL com a URL do PostgreSQL.",
    );
    process.exitCode = 1;
    return;
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
      process.exitCode = 1;
    });
  });
}

void startApplication().catch((err) => {
  logger.error({ err }, "Falha ao iniciar a aplicação");
  process.exitCode = 1;
});
