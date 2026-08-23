import { config, syncConfiguredChannel } from "./routes/discord";
import { logger } from "./lib/logger";

let running = false;

export function startDiscordScheduler() {
  if (running) return;
  running = true;
  setInterval(async () => {
    try {
      const current = await config();
      if (!current.enabled || !current.channelId) return;
      const elapsed = current.lastSyncedAt ? Date.now() - current.lastSyncedAt.getTime() : Infinity;
      if (elapsed < current.intervalMinutes * 60_000) return;
      await syncConfiguredChannel();
      logger.info({ intervalMinutes: current.intervalMinutes }, "Season table synced automatically");
    } catch (error) {
      logger.error({ err: error }, "Automatic Discord sync failed");
    }
  }, 60_000);
}