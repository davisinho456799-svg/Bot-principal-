import app from "./app";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { startBot } from "./bot/index.js";
import { startDiscordScheduler } from "./discord-scheduler.js";
import { startMonitorScheduler } from "./services/monitor-scheduler.js";

const rawPort = process.env["PORT"];
const discordBotEnabled = process.env["DISCORD_BOT_ENABLED"] !== "false";

async function startApplication() {
  try {
    await pool.query("select 1");
    logger.info("Conexão com o PostgreSQL confirmada");
    if (discordBotEnabled) {
      startDiscordScheduler();
    } else {
      logger.info("Bot e schedulers do Discord desabilitados neste ambiente");
    }
  } catch (error) {
    logger.error(
      { err: error },
      "Não foi possível conectar ao PostgreSQL. Configure DATABASE_URL com a URL do PostgreSQL.",
    );
    process.exitCode = 1;
    return;
  }

  if (!rawPort) {
    logger.info("PORT não definido; iniciando como worker do Discord");
    if (discordBotEnabled) {
      await startBot();
    }
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
    if (discordBotEnabled) {
      void startBot().catch((error) => {
        logger.error({ err: error }, "Falha ao iniciar o bot do Discord");
        process.exitCode = 1;
      });
      void startMonitorScheduler();
    }
  });
}

void startApplication().catch((error) => {
  logger.error({ err: error }, "Falha ao iniciar a aplicação");
  process.exitCode = 1;
});