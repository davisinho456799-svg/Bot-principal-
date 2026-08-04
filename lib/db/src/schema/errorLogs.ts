import { createInsertSchema } from "drizzle-zod";
import { jsonb, pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const errorLogsTable = pgTable("error_logs", {
  id: serial("id").primaryKey(),
  discordGuildId: text("discord_guild_id"),
  discordUserId: text("discord_user_id"),
  command: text("command"),
  route: text("route"),
  errorCode: text("error_code").notNull(),
  message: text("message").notNull(),
  httpStatus: integer("http_status"),
  context: jsonb("context").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertErrorLogSchema = createInsertSchema(errorLogsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertErrorLog = z.infer<typeof insertErrorLogSchema>;
export type ErrorLog = typeof errorLogsTable.$inferSelect;