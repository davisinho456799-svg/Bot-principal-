import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, errorLogsTable } from "@workspace/db";
import {
  CreateErrorLogBody,
  ListErrorLogsQueryParams,
} from "@workspace/api-zod";
import { recordError, serializeErrorLog } from "../lib/error-logging";

const router: IRouter = Router();

router.get("/errors", async (req, res): Promise<void> => {
  const parsed = ListErrorLogsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const conditions = parsed.data.guild_id
    ? [eq(errorLogsTable.discordGuildId, parsed.data.guild_id)]
    : [];
  const rows = await db
    .select()
    .from(errorLogsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(errorLogsTable.createdAt))
    .limit(parsed.data.limit ?? 25);

  res.json(rows.map(serializeErrorLog));
});

router.post("/errors", async (req, res): Promise<void> => {
  const parsed = CreateErrorLogBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const body = parsed.data;
  const created = await recordError({
    discordGuildId: body.discord_guild_id,
    discordUserId: body.discord_user_id,
    command: body.command,
    route: body.route,
    errorCode: body.error_code,
    message: body.message,
    httpStatus: body.http_status,
    context: body.context,
  });

  res.status(201).json(serializeErrorLog(created));
});

export default router;