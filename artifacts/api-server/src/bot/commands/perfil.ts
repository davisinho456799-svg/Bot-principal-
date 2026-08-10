import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { db, favoritosTable, listaLeituraTable, usageLogsTable } from "@workspace/db";
import { STATUS_LABELS, type StatusLeitura } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";

export const data = new SlashCommandBuilder()
  .setName("perfil")
  .setDescription("Exibe suas estatísticas de leitura no bot")
  .addUserOption((o) =>
    o.setName("usuario").setDescription("Ver perfil de outro usuário (opcional)").setRequired(false)
  );

const SOURCE_LABELS: Record<string, string> = {
  anilist: "AniList",
  mangadex: "MangaDex",
  comick: "Comick",
  mangaupdates: "MangaUpdates",
  "anilist-anime": "AniList Anime",
  jikan: "MyAnimeList",
  kitsu: "Kitsu",
  anidb: "AniDB",
  vndb: "VNDB",
  erogamescape: "Erogamescape",
};

const SEARCH_COMMANDS = ["anime", "buscar", "manga", "search", "vn", "filme"];

// ─── Conquistas ───────────────────────────────────────────────────────────────

function calcularConquistas(opts: {
  totalUnicos: number;
  totalFavoritos: number;
  totalPesquisas: number;
  totalFontes: number;
  totalConcluidos: number;
}): string[] {
  const conquistas: string[] = [];
  const { totalUnicos, totalFavoritos, totalPesquisas, totalFontes, totalConcluidos } = opts;

  if (totalFavoritos >= 1) conquistas.push("⭐ Colecionador Iniciante");
  if (totalFavoritos >= 10) conquistas.push("💎 Colecionador");
  if (totalFavoritos >= 50) conquistas.push("👑 Grande Colecionador");

  if (totalPesquisas >= 10) conquistas.push("🔍 Explorador");
  if (totalPesquisas >= 100) conquistas.push("🔥 Leitor Ativo");
  if (totalPesquisas >= 500) conquistas.push("🚀 Viciado em Mangá");

  if (totalConcluidos >= 5) conquistas.push("✅ Maratonista");
  if (totalConcluidos >= 25) conquistas.push("🏆 Mestre das Histórias");

  if (totalFontes >= 3) conquistas.push("🌐 Explorador de Fontes");

  if (totalUnicos >= 20) conquistas.push("📚 Biblioteca Pessoal");

  return conquistas;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const alvo = interaction.options.getUser("usuario") ?? interaction.user;
  const userId = alvo.id;

  // Busca todos os dados em paralelo
  const [favoritos, lista, statsLog] = await Promise.all([
    db.select().from(favoritosTable).where(eq(favoritosTable.discordUserId, userId)),
    db.select().from(listaLeituraTable).where(eq(listaLeituraTable.discordUserId, userId)),
    // Stats de pesquisa do usage_logs
    db
      .select({
        command: usageLogsTable.command,
        query: usageLogsTable.query,
        createdAt: usageLogsTable.createdAt,
      })
      .from(usageLogsTable)
      .where(eq(usageLogsTable.discordUserId, userId))
      .orderBy(desc(usageLogsTable.createdAt))
      .limit(500),
  ]);

  if (!favoritos.length && !lista.length && !statsLog.length) {
    await interaction.editReply(
      `📭 **${alvo.displayName}** ainda não tem favoritos nem lista de leitura.\n` +
      `Use \`/favoritos adicionar\` ou \`/lista\` para começar!`
    );
    return;
  }

  // ─── Gêneros top ─────────────────────────────────────────────────────────────
  const genreCount: Record<string, number> = {};
  for (const f of [...favoritos, ...lista]) {
    const gs = f.genres?.split(",").map((g) => g.trim()).filter(Boolean) ?? [];
    for (const g of gs) genreCount[g] = (genreCount[g] ?? 0) + 1;
  }
  const topGenres = Object.entries(genreCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([g]) => g);

  // ─── Nota média ──────────────────────────────────────────────────────────────
  const scores = [...favoritos, ...lista]
    .map((f) => parseFloat(f.score ?? ""))
    .filter((s) => !isNaN(s));
  const avgScore =
    scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null;

  // ─── Status de leitura ───────────────────────────────────────────────────────
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

  // ─── Títulos únicos ──────────────────────────────────────────────────────────
  const totalUnicos = new Set([
    ...favoritos.map((f) => f.manhwaId),
    ...lista.map((l) => l.manhwaId),
  ]).size;

  // ─── Fontes usadas ───────────────────────────────────────────────────────────
  const sourceCount: Record<string, number> = {};
  for (const f of [...favoritos, ...lista]) {
    const src = f.source ?? "desconhecido";
    sourceCount[src] = (sourceCount[src] ?? 0) + 1;
  }
  const topSources = Object.entries(sourceCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([src, count]) => `${SOURCE_LABELS[src] ?? src}: **${count}**`)
    .join(" • ");
  const totalFontes = Object.keys(sourceCount).length;

  // ─── Título mais recente ──────────────────────────────────────────────────────
  const allByDate = [...favoritos, ...lista].sort(
    (a, b) => new Date(b.addedAt ?? 0).getTime() - new Date(a.addedAt ?? 0).getTime()
  );
  const maisRecente = allByDate[0];
  const maisRecenteLabel = maisRecente
    ? `[${maisRecente.title?.slice(0, 40) ?? "—"}](${maisRecente.siteUrl ?? "#"})`
    : null;

  // ─── Membro desde ─────────────────────────────────────────────────────────────
  const oldest = allByDate.at(-1);
  const membroDesde = oldest?.addedAt
    ? new Date(oldest.addedAt).toLocaleDateString("pt-BR", { month: "long", year: "numeric" })
    : null;

  // ─── Stats de pesquisa ────────────────────────────────────────────────────────
  const pesquisas = statsLog.filter((r) => SEARCH_COMMANDS.includes(r.command));
  const totalPesquisas = pesquisas.length;

  // Título mais pesquisado
  const queryCount: Record<string, number> = {};
  for (const r of pesquisas) {
    if (r.query?.trim()) {
      const k = r.query.trim().toLowerCase();
      queryCount[k] = (queryCount[k] ?? 0) + 1;
    }
  }
  const topQuery = Object.entries(queryCount).sort((a, b) => b[1] - a[1])[0];
  const tituloCampeao = topQuery && topQuery[1] > 1
    ? `**${topQuery[0].slice(0, 40)}** (${topQuery[1]}x)`
    : null;

  // Última pesquisa
  const ultimaPesquisa = pesquisas[0];
  const ultimaPesquisaLabel = ultimaPesquisa
    ? `${ultimaPesquisa.query ? `*${ultimaPesquisa.query.slice(0, 35)}*` : `/${ultimaPesquisa.command}`} — <t:${Math.floor(new Date(ultimaPesquisa.createdAt ?? 0).getTime() / 1000)}:R>`
    : null;

  // ─── Conquistas ───────────────────────────────────────────────────────────────
  const conquistas = calcularConquistas({
    totalUnicos,
    totalFavoritos: favoritos.length,
    totalPesquisas,
    totalFontes,
    totalConcluidos: statusCount["concluido"] ?? 0,
  });

  // ─── Embed ────────────────────────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setTitle(`📊 Perfil de ${alvo.displayName}`)
    .setThumbnail(alvo.displayAvatarURL())
    .setColor(0x9b59b6)
    .addFields(
      { name: "📚 Títulos únicos", value: `**${totalUnicos}**`, inline: true },
      { name: "🤍 Favoritos", value: `**${favoritos.length}**`, inline: true },
      { name: "⭐ Nota média", value: avgScore ? `**${avgScore}** / 10` : "N/A", inline: true },
      { name: "🔍 Pesquisas feitas", value: `**${totalPesquisas}**`, inline: true },
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

  if (topSources) {
    embed.addFields({ name: "🔗 Fontes usadas", value: topSources, inline: false });
  }

  if (tituloCampeao) {
    embed.addFields({ name: "🔥 Título mais pesquisado", value: tituloCampeao, inline: true });
  }

  if (ultimaPesquisaLabel) {
    embed.addFields({ name: "🕐 Última pesquisa", value: ultimaPesquisaLabel, inline: true });
  }

  if (maisRecenteLabel) {
    embed.addFields({ name: "🆕 Adicionado recentemente", value: maisRecenteLabel, inline: false });
  }

  if (conquistas.length) {
    embed.addFields({
      name: "🏅 Conquistas",
      value: conquistas.join("  "),
      inline: false,
    });
  }

  if (membroDesde) {
    embed.addFields({ name: "📅 Usando o bot desde", value: membroDesde, inline: true });
  }

  embed.setFooter({ text: "Use /historico para ver suas pesquisas • /lista e /favoritos para gerenciar sua coleção" });

  await interaction.editReply({ embeds: [embed] });
}
