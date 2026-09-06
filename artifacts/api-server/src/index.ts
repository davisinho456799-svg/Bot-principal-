import app from "./app";
import { logger } from "./lib/logger";
import { pool, db } from "@workspace/db";
import { monitorConfigTable } from "@workspace/db/schema";
import { runMonitor } from "./services/monitor-service";
import { startBot } from "./bot/index.js";

const rawPort = process.env["PORT"];

async function startApplication() {
  try {
    await pool.query("select 1");
    logger.info("Conexão com o PostgreSQL confirmada");
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
    void startBot().catch((error) => {
      logger.error({ err: error }, "Falha ao iniciar o bot do Discord");
      process.exitCode = 1;
    });
    void scheduleMonitor();
  });
}

async function scheduleMonitor() {
  const [config] = await db.select().from(monitorConfigTable).limit(1);
  const intervalMinutes = Math.max(5, config?.intervalMinutes ?? 30);
  setTimeout(async () => {
    try {
      await runMonitor();
    } catch (error) {
      logger.error({ err: error }, "Scheduled monitor run failed");
    } finally {
      void scheduleMonitor();
    }
  }, intervalMinutes * 60_000);
}

void startApplication().catch((error) => {
  logger.error({ err: error }, "Falha ao iniciar a aplicação");
  process.exitCode = 1;
});