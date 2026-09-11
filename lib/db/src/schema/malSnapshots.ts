import {
  pgTable,
  text,
  serial,
  integer,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { subscriptionsTable } from "./subscriptions";

export const malSnapshotsTable = pgTable("mal_snapshots", {
  id: serial("id").primaryKey(),
  subscriptionId: integer("subscription_id")
    .notNull()
    .references(() => subscriptionsTable.id, { onDelete: "cascade" }),
  synopsis: text("synopsis"),
  score: numeric("score", { precision: 4, scale: 2 }),
  status: text("status"),
  chapters: integer("chapters"),
  checkedAt: timestamp("checked_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertMalSnapshotSchema = createInsertSchema(
  malSnapshotsTable,
).omit({ id: true, checkedAt: true });

export type InsertMalSnapshot = z.infer<typeof insertMalSnapshotSchema>;
export type MalSnapshot = typeof malSnapshotsTable.$inferSelect;
