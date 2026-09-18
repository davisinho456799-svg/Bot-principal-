import { db } from "@workspace/db";
import { monitorConfigTable } from "@workspace/db/schema";
import { logger } from "../lib/logger.js";
import { runMonitor } from "./monitor-service.js";
import { getMonitorIntervalMinutes } from "./monitor-interval.js";

export async function startMonitorScheduler(): Promise<void> {
  const [config] = await db.select().from(monitorConfigTable).limit(1);
  const intervalMinutes = getMonitorIntervalMinutes(config?.intervalMinutes);

  setTimeout(async () => {
    try {
      await runMonitor();
    } catch (error) {
      logger.error({ err: error }, "Scheduled monitor run failed");
    } finally {
      void startMonitorScheduler();
    }
  }, intervalMinutes * 60_000);
}