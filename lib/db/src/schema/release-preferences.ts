import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const releasePreferencesTable = pgTable("release_preferences", {
  discordUserId: text("discord_user_id").primaryKey(),
  notificationsEnabled: boolean("notifications_enabled").notNull().default(true),
  adultEnabled: boolean("adult_enabled").notNull().default(false),
  digestMode: text("digest_mode").notNull().default("imediato"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ReleasePreferences = typeof releasePreferencesTable.$inferSelect;