import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot/index";

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
  startKeepAlive(port);
});

startBot().catch((err) => {
  logger.error({ err }, "Falha ao iniciar o bot do Discord");
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
