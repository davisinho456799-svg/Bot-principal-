import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { db, favoritosTable, listaLeituraTable } from "@workspace/db";
import { STATUS_LABELS, type StatusLeitura } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

export const data = new SlashCommandBuilder()
  .setName("perfil")
  .setDescription("Exibe suas estatísticas de leitura no bot")
  .addUserOption((o) =>
    o.setName("usuario").setDescription("Ver perfil de outro usuário (opcional)").setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const alvo = interaction.options.getUser("usuario") ?? interaction.user;
  const userId = alvo.id;

  const [favoritos, lista] = await Promise.all([
    db.select().from(favoritosTable).where(eq(favoritosTable.discordUserId, userId)),
    db.select().from(listaLeituraTable).where(eq(listaLeituraTable.discordUserId, userId)),
  ]);

  if (!favoritos.length && !lista.length) {
    await interaction.editReply(
      `📭 **${alvo.displayName}** ainda não tem favoritos nem lista de leitura.`
    );
    return;
  }

  const genreCount: Record<string, number> = {};
  for (const f of [...favoritos, ...lista]) {
    const gs = f.genres?.split(",").map((g) => g.trim()).filter(Boolean) ?? [];
    for (const g of gs) genreCount[g] = (genreCount[g] ?? 0) + 1;
  }
  const topGenres = Object.entries(genreCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([g]) => g);

  const scores = [...favoritos, ...lista]
    .map((f) => parseFloat(f.score ?? ""))
    .filter((s) => !isNaN(s));
  const avgScore =
    scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null;

  const statusCount: Partial<Record<StatusLeitura, number>> = {};
  for (const l of lista) {
    const s = l.status as StatusLeitura;
    statusCount[s] = (statusCount[s] ?? 0) + 1;
  }

  const statusOrder: StatusLeitura[] = ["lendo", "concluido", "planejo", "pausado", "abandonado"];
  const listaResumo = statusOrder
    .filter((s) => statusCount[s])
    .map((s) => `${STATUS_LABELS[s]}: **${statusCount[s]}**`)
    .join("\n");

  const totalUnicos = new Set([
    ...favoritos.map((f) => f.manhwaId),
    ...lista.map((l) => l.manhwaId),
  ]).size;

  const embed = new EmbedBuilder()
    .setTitle(`📊 Perfil de ${alvo.displayName}`)
    .setThumbnail(alvo.displayAvatarURL())
    .setColor(0x9b59b6)
    .addFields(
      {
        name: "📚 Total de títulos",
        value: `**${totalUnicos}** manhwa(s) únicos`,
        inline: true,
      },
      {
        name: "🤍 Favoritos",
        value: `**${favoritos.length}**`,
        inline: true,
      },
      {
        name: "⭐ Nota média",
        value: avgScore ? `**${avgScore}** / 10` : "N/A",
        inline: true,
      }
    );

  if (listaResumo) {
    embed.addFields({ name: "📋 Lista de leitura", value: listaResumo, inline: false });
  }

  if (topGenres.length) {
    embed.addFields({
      name: "🏷️ Gêneros favoritos",
      value: topGenres.join(" • "),
      inline: false,
    });
  }

  embed.setFooter({ text: "Use /lista e /favoritos para gerenciar sua coleção" });

  await interaction.editReply({ embeds: [embed] });
}
