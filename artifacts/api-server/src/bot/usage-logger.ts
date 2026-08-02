import { db } from "@workspace/db";
import { usageLogsTable } from "@workspace/db/schema";
import { logger } from "../lib/logger.js";

export async function logUsage(opts: {
  discordUserId: string;
  discordUsername: string;
  guildId?: string | null;
  command: string;
  query?: string | null;
}): Promise<void> {
  try {
    await db.insert(usageLogsTable).values({
      discordUserId: opts.discordUserId,
      discordUsername: opts.discordUsername,
      guildId: opts.guildId ?? null,
      command: opts.command,
      query: opts.query ?? null,
    });
  } catch (err) {
    logger.warn({ err }, "Falha ao registrar uso");
  }
}
