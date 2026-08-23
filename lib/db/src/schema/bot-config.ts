import { boolean, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const botConfigTable = pgTable("bot_config", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id"),
  channelId: text("channel_id"),
  messageId: text("message_id"),
  intervalMinutes: integer("interval_minutes").notNull().default(60),
  includeAnime: boolean("include_anime").notNull().default(true),
  includeManga: boolean("include_manga").notNull().default(true),
  enabled: boolean("enabled").notNull().default(false),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
});

export type BotConfig = typeof botConfigTable.$inferSelect;