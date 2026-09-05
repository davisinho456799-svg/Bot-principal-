import app from "./app";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { monitorConfigTable } from "@workspace/db/schema";
import { runMonitor } from "./services/monitor-service";
import { startDiscordCommandBot } from "./services/discord-command-service";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startDiscordCommandBot();
  void scheduleMonitor();
});

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
