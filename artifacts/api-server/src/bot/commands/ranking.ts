import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { db, favoritosTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { buildScanLinksExternal } from "./search.js";

export const data = new SlashCommandBuilder()
  .setName("ranking")
  .setDescription("Top 10 manhwas mais favoritados pelos membros deste servidor");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const rows = await db
    .select({
      manhwaId: favoritosTable.manhwaId,
      title: favoritosTable.title,
      siteUrl: favoritosTable.siteUrl,
      coverUrl: favoritosTable.coverUrl,
      genres: favoritosTable.genres,
      score: favoritosTable.score,
      total: sql<number>`cast(count(*) as int)`,
    })
    .from(favoritosTable)
    .groupBy(
      favoritosTable.manhwaId,
      favoritosTable.title,
      favoritosTable.siteUrl,
      favoritosTable.coverUrl,
      favoritosTable.genres,
      favoritosTable.score
    )
    .orderBy(sql`count(*) desc`)
    .limit(10);

  if (!rows.length) {
    await interaction.editReply(
      "📭 Ainda ninguém adicionou favoritos. Use `/favoritos adicionar` para começar!"
    );
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];

  const lines = rows.map((r, i) => {
    const medal = medals[i] ?? `**${i + 1}.**`;
    const score = r.score ? `⭐ ${parseFloat(r.score).toFixed(1)}` : "";
    const genres = r.genres?.split(",").slice(0, 2).join(", ") || "";
    const scanLinks = buildScanLinksExternal(r.title);
    return (
      `${medal} **[${r.title}](${r.siteUrl})** — 🤍 ${r.total} favorito(s)\n` +
      `> ${[score, genres].filter(Boolean).join(" | ")}\n` +
      `> 🔎 ${scanLinks}`
    );
  });

  const thumbnail = rows[0].coverUrl ?? null;

  const embed = new EmbedBuilder()
    .setTitle("🏆 Ranking — Manhwas Mais Favoritos")
    .setDescription(lines.join("\n\n"))
    .setColor(0xf1c40f)
    .setFooter({ text: `Top ${rows.length} • Baseado nos favoritos de todos os usuários` });

  if (thumbnail) embed.setThumbnail(thumbnail);

  await interaction.editReply({ embeds: [embed] });
}
