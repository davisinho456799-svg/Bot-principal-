import { db } from "@workspace/db";
import { monitorConfigTable } from "@workspace/db/schema";
import { logger } from "../lib/logger.js";
import { runMonitor } from "./monitor-service.js";

export async function startMonitorScheduler(): Promise<void> {
  const [config] = await db.select().from(monitorConfigTable).limit(1);
  const intervalMinutes = Math.max(5, config?.intervalMinutes ?? 30);

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