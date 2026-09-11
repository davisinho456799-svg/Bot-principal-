import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  fetchTenraiPublishingManga,
  genresOfTenrai,
  hasBoysLoveGenre,
  searchTenraiManga,
  titleOfTenrai,
  type TenraiManga,
} from "../tenrai-fallback.js";
import {
  createPanelWatchEmbed,
  getWorkIdentity,
  PANEL_WATCH_COLORS,
  setPanelWatchFooter,
} from "../identity.js";

type QueryRow = Record<string, unknown>;

function rowsOf(result: unknown): QueryRow[] {
  if (!result || typeof result !== "object") return [];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? rows.filter((row): row is QueryRow => !!row && typeof row === "object") : [];
}

async function fetchWeeklyPopular(adult: boolean): Promise<QueryRow[]> {
  const adultFilter = adult
    ? sql`EXISTS (
        SELECT 1 FROM assinaturas adult_subscription
        WHERE lower(adult_subscription.title) = lower(e.title)
          AND adult_subscription.adult = true
      )`
    : sql`NOT EXISTS (
        SELECT 1 FROM assinaturas adult_subscription
        WHERE lower(adult_subscription.title) = lower(e.title)
          AND adult_subscription.adult = true
      )`;

  const result = await db.execute(sql`
    SELECT
      e.title,
      MAX(e.chapter) AS chapter,
      COUNT(DISTINCT e.event_key)::int AS releases,
      COALESCE((
        SELECT COUNT(DISTINCT subscribers.discord_user_id)::int
        FROM assinaturas subscribers
        WHERE lower(subscribers.title) = lower(e.title)
      ), 0) AS subscribers,
      MAX(source.site_url) AS site_url,
      MAX(source.cover_url) AS cover_url
    FROM notificacao_eventos e
    LEFT JOIN assinaturas source ON lower(source.title) = lower(e.title)
    WHERE e.sent_at IS NOT NULL
      AND e.sent_at >= now() - interval '7 days'
      AND ${adultFilter}
    GROUP BY e.title
    ORDER BY COUNT(DISTINCT e.event_key) DESC, MAX(e.sent_at) DESC
    LIMIT 10
  `);

  return rowsOf(result);
}

async function fetchTenraiFallback(adult: boolean): Promise<TenraiManga[]> {
  const rows = await fetchTenraiPublishingManga("manhwa", adult);
  return rows.filter((row) => !hasBoysLoveGenre(row));
}

function normalizeTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isTitleMatch(title: string, candidate: TenraiManga): boolean {
  const normalizedTitle = normalizeTitle(title);
  if (!normalizedTitle) return false;

  return [candidate.title, candidate.title_english ?? ""].some((value) => {
    const normalizedCandidate = normalizeTitle(value);
    return normalizedCandidate === normalizedTitle ||
      normalizedCandidate.includes(normalizedTitle) ||
      normalizedTitle.includes(normalizedCandidate);
  });
}

async function excludeBoysLoveRows(rows: QueryRow[]): Promise<QueryRow[]> {
  const decisions = await Promise.all(
    rows.map(async (row) => {
      const title = String(row.title ?? "").trim();
      if (!title) return { row, keep: true };

      try {
        const matches = await searchTenraiManga(title, "manhwa");
        const exactMatch = matches.find((candidate) => isTitleMatch(title, candidate));
        return { row, keep: !exactMatch || !hasBoysLoveGenre(exactMatch) };
      } catch {
        return { row, keep: true };
      }
    }),
  );

  return decisions.filter(({ keep }) => keep).map(({ row }) => row);
}

function formatWeeklyLines(rows: QueryRow[]): string {
  return rows.map((row, index) => {
    const title = String(row.title ?? "Título sem nome");
    const siteUrl = String(row.site_url ?? "");
    const link = siteUrl ? `[${title}](${siteUrl})` : title;
    const chapter = row.chapter == null ? "capítulo novo" : `cap. ${String(row.chapter)}`;
    return (
      `**${index + 1}.** ${link} — **${chapter}**\n` +
      `> 🔔 ${String(row.releases ?? 0)} lançamento(s) · 👥 ${String(row.subscribers ?? 0)} acompanhando`
    );
  }).join("\n\n");
}

function formatFallbackLines(rows: TenraiManga[]): string {
  return rows.map((row, index) => {
    const title = titleOfTenrai(row);
    const score = row.score ? `⭐ ${row.score.toFixed(1)}` : "⭐ N/A";
    const chapters = row.chapters ? `📖 ${row.chapters} caps` : "📖 Em andamento";
    const genres = genresOfTenrai(row).slice(0, 2).join(", ") || "—";
    const url = String(row.url ?? "");
    const link = url ? `[${title}](${url})` : title;
    return `**${index + 1}.** ${link} — ${score} | ${chapters}\n> 🏷️ ${genres}`;
  }).join("\n\n");
}

export const data = new SlashCommandBuilder()
  .setName("lancamentos")
  .setDescription("Lançamentos populares registrados na última semana")
  .addStringOption((option) =>
    option
      .setName("modo")
      .setDescription("Escolha o tipo de lançamento")
      .addChoices(
        { name: "Normal", value: "normal" },
        { name: "+18", value: "adulto" },
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const adult = interaction.options.getString("modo") === "adulto";

  try {
    let rows = await fetchWeeklyPopular(adult);
    if (rows.length) rows = await excludeBoysLoveRows(rows);
    const modeLabel = adult ? "🔞 +18" : "🛡️ Normal";

    if (!rows.length) {
      const fallbackRows = await fetchTenraiFallback(adult);
      if (fallbackRows.length) {
        await interaction.editReply({
          embeds: [
            createPanelWatchEmbed(adult ? PANEL_WATCH_COLORS.adult : PANEL_WATCH_COLORS.manhwa)
              .setTitle(`${adult ? "🔞" : "🔮"} Catálogo de lançamentos · ${adult ? "+18" : "Normal"}`)
              .setDescription(formatFallbackLines(fallbackRows))
              .setFooter({
                text: "Panel Watch • Catálogo Tenrai • Ainda não há histórico semanal suficiente",
              }),
          ],
        });
        return;
      }
    }

    const identity = getWorkIdentity("manhwa", adult);
    const embed = createPanelWatchEmbed(identity.color)
      .setTitle(`${identity.icon} Lançamentos populares da semana · ${modeLabel}`)
      .setDescription(formatWeeklyLines(rows))
    setPanelWatchFooter(embed, "Lançamentos populares • Radar da comunidade");

    const firstCover = rows.find((row) => row.cover_url)?.cover_url;
    if (firstCover) embed.setThumbnail(String(firstCover));
    await interaction.editReply({ embeds: [embed] });
  } catch {
    await interaction.editReply("❌ Não foi possível carregar os lançamentos agora. Tente novamente.");
  }
}