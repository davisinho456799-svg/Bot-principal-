import {
  createInsertSchema,
} from "drizzle-zod";
import { json, pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

// Histórico persistente de falhas do bot e da API, mantido no Neon.
export const errorLogsTable = pgTable("error_logs", {
  id: serial("id").primaryKey(),
  discordGuildId: text("discord_guild_id"),
  discordUserId: text("discord_user_id"),
  command: text("command"),
  source: text("source").notNull().default("api"),
  route: text("route"),
  errorCode: text("error_code").notNull(),
  message: text("message").notNull(),
  context: json("context").$type<Record<string, unknown> | null>(),
  httpStatus: integer("http_status"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertErrorLogSchema = createInsertSchema(errorLogsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertErrorLog = z.infer<typeof insertErrorLogSchema>;
export type ErrorLog = typeof errorLogsTable.$inferSelect;
