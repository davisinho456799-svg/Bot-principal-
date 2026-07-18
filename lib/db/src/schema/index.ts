import { pgTable, text, serial, timestamp, real, json, unique } from "drizzle-orm/pg-core";

// ─── Status de leitura ───────────────────────────────────────────────────────

export const STATUS_OPCOES = ["lendo", "concluido", "planejo", "pausado", "abandonado"] as const;
export type StatusLeitura = (typeof STATUS_OPCOES)[number];

export const STATUS_LABELS: Record<StatusLeitura, string> = {
  lendo: "📖 Lendo",
  concluido: "✅ Concluído",
  planejo: "🔖 Planejo Ler",
  pausado: "⏸️ Pausado",
  abandonado: "🗑️ Abandonado",
};

// ─── Tabela: favoritos ────────────────────────────────────────────────────────

export const favoritosTable = pgTable("favoritos", {
  id: serial("id").primaryKey(),
  discordUserId: text("discord_user_id").notNull(),
  manhwaId: text("manhwa_id").notNull(),
  source: text("source").notNull(),
  title: text("title").notNull(),
  coverUrl: text("cover_url"),
  siteUrl: text("site_url").notNull(),
  genres: text("genres").notNull().default(""),
  score: text("score"),
  addedAt: timestamp("added_at").notNull().defaultNow(),
});

export type Favorito = typeof favoritosTable.$inferSelect;
export type InsertFavorito = typeof favoritosTable.$inferInsert;

// ─── Tabela: notificacao_canais ───────────────────────────────────────────────

export const notificacaoCanaisTable = pgTable("notificacao_canais", {
  guildId: text("guild_id").primaryKey(),
  channelId: text("channel_id").notNull(),
  configuredAt: timestamp("configured_at").notNull().defaultNow(),
});

export type NotificacaoCanal = typeof notificacaoCanaisTable.$inferSelect;

// ─── Tabela: capitulos_rastreados ─────────────────────────────────────────────

export const capitulosRastreados = pgTable("capitulos_rastreados", {
  id: serial("id").primaryKey(),
  manhwaId: text("manhwa_id").notNull().unique(),
  source: text("source").notNull(),
  title: text("title").notNull(),
  coverUrl: text("cover_url"),
  siteUrl: text("site_url").notNull(),
  lastChapters: real("last_chapters"),
  lastChecked: timestamp("last_checked").notNull().defaultNow(),
});

export type CapituloRastreado = typeof capitulosRastreados.$inferSelect;

// ─── Tabela: lista_leitura ────────────────────────────────────────────────────

export const listaLeituraTable = pgTable("lista_leitura", {
  id: serial("id").primaryKey(),
  discordUserId: text("discord_user_id").notNull(),
  manhwaId: text("manhwa_id").notNull(),
  source: text("source").notNull(),
  title: text("title").notNull(),
  coverUrl: text("cover_url"),
  siteUrl: text("site_url").notNull(),
  genres: text("genres"),
  score: text("score"),
  status: text("status").notNull().default("planejo"),
  addedAt: timestamp("added_at").notNull().defaultNow(),
});

export type ListaLeitura = typeof listaLeituraTable.$inferSelect;
export type InsertListaLeitura = typeof listaLeituraTable.$inferInsert;

// ─── Tabela: search_cache ─────────────────────────────────────────────────────
// Cache de resultados de busca por 24h para reduzir chamadas às APIs externas.

export const searchCache = pgTable("search_cache", {
  query: text("query").primaryKey(),
  results: json("results").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── Tabela: title_aliases ────────────────────────────────────────────────────
// Mapeia títulos alternativos (aliases) para o título canônico de uma obra.

export const titleAliases = pgTable(
  "title_aliases",
  {
    id: serial("id").primaryKey(),
    canonicalTitle: text("canonical_title").notNull(),
    alias: text("alias").notNull(),
    source: text("source").notNull(),
  },
  (t) => [unique().on(t.canonicalTitle, t.alias)]
);

// ─── Tabela: description_matches ─────────────────────────────────────────────
// Aprendizado histórico: associa hashes de descrições a títulos encontrados.

export const descriptionMatches = pgTable(
  "description_matches",
  {
    id: serial("id").primaryKey(),
    descriptionHash: text("description_hash").notNull(),
    descriptionSnippet: text("description_snippet"),
    canonicalTitle: text("canonical_title").notNull(),
    source: text("source").notNull(),
    similarityScore: real("similarity_score").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [unique().on(t.descriptionHash, t.canonicalTitle)]
);
