import { db, errorLogsTable } from "@workspace/db";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Request } from "express";

const RETENTION_DAYS = 30;
const MAX_ERRORS_PER_GUILD = 500;

export type ErrorLogInput = {
  discordGuildId?: string | null;
  discordUserId?: string | null;
  command?: string | null;
  route?: string | null;
  errorCode: string;
  message: string;
  httpStatus?: number | null;
  context?: Record<string, unknown> | null;
};

export async function recordError(input: ErrorLogInput) {
  const [created] = await db
    .insert(errorLogsTable)
    .values({
      discordGuildId: input.discordGuildId ?? null,
      discordUserId: input.discordUserId ?? null,
      command: input.command ?? null,
      route: input.route ?? null,
      errorCode: input.errorCode,
      message: input.message,
      httpStatus: input.httpStatus ?? null,
      context: input.context ?? null,
    })
    .returning();

  // Keep the history useful without allowing it to grow forever.
  await db
    .delete(errorLogsTable)
    .where(
      lt(
        errorLogsTable.createdAt,
        sql`now() - interval '30 days'`,
      ),
    );

  if (created.discordGuildId) {
    const guildErrors = await db
      .select({ id: errorLogsTable.id })
      .from(errorLogsTable)
      .where(eq(errorLogsTable.discordGuildId, created.discordGuildId))
      .orderBy(sql`${errorLogsTable.createdAt} desc`)
      .offset(MAX_ERRORS_PER_GUILD);

    if (guildErrors.length > 0) {
      await db.delete(errorLogsTable).where(
        sql`${errorLogsTable.id} in (${sql.join(
          guildErrors.map((error) => sql`${error.id}`),
          sql`, `,
        )})`,
      );
    }
  }

  return created;
}

export function requestErrorContext(req: Request) {
  const body = req.body as Record<string, unknown> | undefined;
  return {
    discordGuildId:
      typeof body?.discord_guild_id === "string"
        ? body.discord_guild_id
        : null,
    discordUserId:
      typeof body?.discord_user_id === "string" ? body.discord_user_id : null,
    command: typeof body?.command === "string" ? body.command : null,
    route: req.path,
  };
}

export function serializeErrorLog(error: typeof errorLogsTable.$inferSelect) {
  return {
    id: error.id,
    discord_guild_id: error.discordGuildId,
    discord_user_id: error.discordUserId,
    command: error.command,
    route: error.route,
    error_code: error.errorCode,
    message: error.message,
    http_status: error.httpStatus,
    context: error.context,
    created_at: error.createdAt,
  };
}