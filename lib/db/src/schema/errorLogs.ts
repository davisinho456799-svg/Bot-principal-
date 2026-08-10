import { json, pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";

// Histórico persistente de falhas do bot, mantido no Neon.
export const errorLogsTable = pgTable("error_logs", {
  id: serial("id").primaryKey(),
  discordGuildId: text("discord_guild_id"),
  discordUserId: text("discord_user_id"),
  command: text("command"),
  source: text("source").notNull(),
  errorCode: text("error_code").notNull(),
  message: text("message").notNull(),
  context: json("context").$type<Record<string, unknown> | null>(),
  httpStatus: integer("http_status"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ErrorLog = typeof errorLogsTable.$inferSelect;