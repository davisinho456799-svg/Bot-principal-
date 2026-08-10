import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const subscriptionsTable = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  discordUserId: text("discord_user_id").notNull(),
  discordChannelId: text("discord_channel_id").notNull(),
  discordGuildId: text("discord_guild_id").notNull(),
  malItemId: integer("mal_item_id").notNull(),
  malItemType: text("mal_item_type", { enum: ["manga", "anime"] })
    .notNull()
    .default("manga"),
  itemName: text("item_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertSubscriptionSchema = createInsertSchema(
  subscriptionsTable,
).omit({ id: true, createdAt: true });

export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptionsTable.$inferSelect;
