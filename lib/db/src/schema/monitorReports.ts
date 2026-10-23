import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const monitorReportConfigsTable = pgTable("monitor_report_configs", {
  guildId: text("guild_id").primaryKey(),
  channelId: text("channel_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  nextReportAt: timestamp("next_report_at", { withTimezone: true }).notNull(),
  lastReportAt: timestamp("last_report_at", { withTimezone: true }),
  lastMessageId: text("last_message_id"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  leaseToken: text("lease_token"),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertMonitorReportConfigSchema = createInsertSchema(monitorReportConfigsTable)
  .pick({ guildId: true, channelId: true, enabled: true, nextReportAt: true });
export type MonitorReportConfig = typeof monitorReportConfigsTable.$inferSelect;
export type InsertMonitorReportConfig = z.infer<typeof insertMonitorReportConfigSchema>;
