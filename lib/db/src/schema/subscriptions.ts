import { pgTable, text, serial, timestamp, unique, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ─── Tabela canônica de assinaturas ─────────────────────────────────────────
// O bot e o serviço de notificações usam esta tabela. A tabela legada
// `subscriptions` não é recriada nem migrada: o alias abaixo mantém os nomes
// antigos do código sem introduzir uma segunda tabela no Neon.
export const assinaturasTable = pgTable(
  "assinaturas",
  {
    id: serial("id").primaryKey(),
    discordUserId: text("discord_user_id").notNull(),
    guildId: text("guild_id").notNull(),
    manhwaId: text("manhwa_id").notNull(),
    source: text("source").notNull(),
    title: text("title").notNull(),
    coverUrl: text("cover_url"),
    siteUrl: text("site_url").notNull(),
    /** "anime" | "manga" | "manhwa" */
    tipo: text("tipo").notNull().default("manhwa"),
    /** true = conteúdo adulto (+18) */
    adult: boolean("adult").notNull().default(false),
    addedAt: timestamp("added_at").notNull().defaultNow(),
  },
  (t) => [
    unique("assinaturas_discord_user_id_manhwa_id_guild_id_key").on(
      t.discordUserId,
      t.manhwaId,
      t.guildId,
    ),
  ],
);

export const insertAssinaturaSchema = createInsertSchema(assinaturasTable).omit({
  id: true,
  addedAt: true,
});

export type InsertAssinatura = z.infer<typeof insertAssinaturaSchema>;
export type Assinatura = typeof assinaturasTable.$inferSelect;

/** Compatibilidade de importação; aponta para `assinaturas`, não para outra tabela. */
export const subscriptionsTable = assinaturasTable;
export const insertSubscriptionSchema = insertAssinaturaSchema;
export type InsertSubscription = InsertAssinatura;
export type Subscription = Assinatura;
