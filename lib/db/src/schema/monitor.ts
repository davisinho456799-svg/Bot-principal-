import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const monitoredWorksTable = pgTable("monitored_works", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  platform: text("platform").notNull(),
  listingUrl: text("listing_url").notNull(),
  active: boolean("active").notNull().default(true),
  chaptersSeen: integer("chapters_seen").notNull().default(0),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastPublishedAt: timestamp("last_published_at", { withTimezone: true }),
  lastStatus: text("last_status").notNull().default("Never checked"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const detectedChaptersTable = pgTable(
  "detected_chapters",
  {
    id: serial("id").primaryKey(),
    workId: integer("work_id")
      .notNull()
      .references(() => monitoredWorksTable.id, { onDelete: "cascade" }),
    chapterKey: text("chapter_key").notNull(),
    chapterNumber: text("chapter_number").notNull(),
    thumbnailUrl: text("thumbnail_url").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => ({
    workChapterUnique: uniqueIndex("detected_chapters_work_key").on(
      table.workId,
      table.chapterKey,
    ),
  }),
);

export const monitorActivityTable = pgTable("monitor_activity", {
  id: serial("id").primaryKey(),
  workId: integer("work_id")
    .notNull()
    .references(() => monitoredWorksTable.id, { onDelete: "cascade" }),
  chapterCount: integer("chapter_count").notNull().default(0),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const monitorConfigTable = pgTable("monitor_config", {
  id: integer("id").primaryKey().default(1),
  discordChannelId: text("discord_channel_id"),
  discordChannelName: text("discord_channel_name"),
  intervalMinutes: integer("interval_minutes").notNull().default(30),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertMonitoredWorkSchema = createInsertSchema(monitoredWorksTable)
  .omit({
    id: true,
    chaptersSeen: true,
    lastCheckedAt: true,
    lastPublishedAt: true,
    lastStatus: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    platform: z.enum(["lezhin", "toomics", "toptoon"]),
  });

export type MonitoredWork = typeof monitoredWorksTable.$inferSelect;
export type InsertMonitoredWork = z.infer<typeof insertMonitoredWorkSchema>;
export type DetectedChapter = typeof detectedChaptersTable.$inferSelect;