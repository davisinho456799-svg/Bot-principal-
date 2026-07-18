import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ComponentType,
} from "discord.js";
import { db, favoritosTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { searchAllSources } from "../unified.js";
import { buildScanLinksExternal } from "./search.js";

export const data = new SlashCommandBuilder()
  .setName("favoritos")
  .setDescription("Gerencie sua lista de manhwas favoritos")
  .addSubcommand((sub) =>
    sub
      .setName("adicionar")
      .setDescription("Adiciona um manhwa aos seus favoritos")
      .addStringOption((opt) =>
        opt.setName("titulo").setDescription("Nome do manhwa").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName("listar").setDescription("Mostra sua lista de manhwas favoritos")
  )
  .addSubcommand((sub) =>
    sub
      .setName("remover")
      .setDescription("Remove um manhwa dos seus favoritos")
      .addStringOption((opt) =>
        opt.setName("titulo").setDescription("Nome ou parte do título do manhwa").setRequired(true)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === "listar") {
    await handleListar(interaction);
  } else if (sub === "adicionar") {
    await handleAdicionar(interaction);
  } else if (sub === "remover") {
    await handleRemover(interaction);
  }
}

async function handleListar(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const userId = interaction.user.id;
  const lista = await db
    .select()
    .from(favoritosTable)
    .where(eq(favoritosTable.discordUserId, userId))
    .orderBy(favoritosTable.addedAt);

  if (!lista.length) {
    await interaction.editReply({
      content: "📭 Você ainda não tem nenhum favorito! Use `/favoritos adicionar` para começar.",
    });
    return;
  }

  const lines = lista.map((fav, i) => {
    const score = fav.score ? `⭐ ${fav.score}` : "⭐ N/A";
    const genres = fav.genres ? fav.genres.split(",").slice(0, 2).join(", ") : "—";
    const source = fav.source === "anilist" ? "🟣" : "🟠";
    return `**${i + 1}.** ${source} [${fav.title}](${fav.siteUrl}) — ${score}\n> 🏷️ ${genres}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`⭐ Favoritos de ${interaction.user.displayName}`)
    .setDescription(lines.join("\n\n"))
    .setColor(0xf1c40f)
    .setFooter({ text: `${lista.length} manhwa(s) na lista` });

  await interaction.editReply({ embeds: [embed] });
}

async function handleAdicionar(interaction: ChatInputCommandInteraction) {
  const titulo = interaction.options.getString("titulo", true);
  await interaction.deferReply({ ephemeral: true });

  let results;
  try {
    results = await searchAllSources(titulo);
  } catch {
    await interaction.editReply("❌ Erro ao buscar o manhwa. Tente novamente.");
    return;
  }

  if (!results.length) {
    await interaction.editReply(`❌ Nenhum manhwa encontrado para **${titulo}**.`);
    return;
  }

  const userId = interaction.user.id;
  const existingIds = new Set(
    (await db.select({ manhwaId: favoritosTable.manhwaId })
      .from(favoritosTable)
      .where(eq(favoritosTable.discordUserId, userId)))
      .map((r) => r.manhwaId)
  );

  const available = results.filter((r) => !existingIds.has(r.id));

  if (!available.length) {
    await interaction.editReply("⚠️ Todos os resultados já estão nos seus favoritos!");
    return;
  }

  if (available.length === 1) {
    const m = available[0];
    await db.insert(favoritosTable).values({
      discordUserId: userId,
      manhwaId: m.id,
      source: m.source,
      title: m.mainTitle,
      coverUrl: m.coverUrl,
      siteUrl: m.siteUrl,
      genres: m.genres.join(","),
      score: m.score ? (m.score / 10).toFixed(1) : null,
    });

    await interaction.editReply({
      content: `✅ **${m.mainTitle}** adicionado aos seus favoritos!`,
    });
    return;
  }

  const options = available.slice(0, 8).map((r) => {
    const icon = r.source === "anilist" ? "🟣" : "🟠";
    return {
      label: r.mainTitle.slice(0, 100),
      description: `${icon} ${r.source === "anilist" ? "AniList" : "MangaDex"} • ${r.genres.slice(0, 2).join(", ") || "Sem gêneros"}`.slice(0, 100),
      value: `${r.source}:${r.id}`,
    };
  });

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("fav_add_select")
      .setPlaceholder("Selecione o manhwa para adicionar")
      .addOptions(options)
  );

  await interaction.editReply({
    content: `🔍 Encontrei **${available.length}** resultados para **${titulo}**. Selecione qual adicionar:`,
    components: [row],
  });

  const collector = interaction.channel?.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: (i) => i.customId === "fav_add_select" && i.user.id === interaction.user.id,
    time: 30_000,
    max: 1,
  });

  collector?.on("collect", async (sel: StringSelectMenuInteraction) => {
    await sel.deferUpdate();
    const [source, ...idParts] = sel.values[0].split(":");
    const id = idParts.join(":");
    const m = available.find((r) => r.source === source && r.id === id);
    if (!m) {
      await interaction.editReply({ content: "❌ Erro ao selecionar. Tente novamente.", components: [] });
      return;
    }

    await db.insert(favoritosTable).values({
      discordUserId: userId,
      manhwaId: m.id,
      source: m.source,
      title: m.mainTitle,
      coverUrl: m.coverUrl,
      siteUrl: m.siteUrl,
      genres: m.genres.join(","),
      score: m.score ? (m.score / 10).toFixed(1) : null,
    });

    await interaction.editReply({
      content: `✅ **${m.mainTitle}** adicionado aos seus favoritos!`,
      components: [],
    });
  });

  collector?.on("end", async (_c, reason) => {
    if (reason === "time") {
      await interaction.editReply({ content: "⏱️ Tempo esgotado.", components: [] });
    }
  });
}

async function handleRemover(interaction: ChatInputCommandInteraction) {
  const titulo = interaction.options.getString("titulo", true).toLowerCase();
  await interaction.deferReply({ ephemeral: true });

  const userId = interaction.user.id;
  const lista = await db
    .select()
    .from(favoritosTable)
    .where(eq(favoritosTable.discordUserId, userId));

  const matches = lista.filter((fav) => fav.title.toLowerCase().includes(titulo));

  if (!matches.length) {
    await interaction.editReply(
      `❌ Nenhum favorito encontrado com **${titulo}**. Use \`/favoritos listar\` para ver sua lista.`
    );
    return;
  }

  if (matches.length === 1) {
    await db
      .delete(favoritosTable)
      .where(
        and(
          eq(favoritosTable.discordUserId, userId),
          eq(favoritosTable.id, matches[0].id)
        )
      );
    await interaction.editReply(`🗑️ **${matches[0].title}** removido dos seus favoritos.`);
    return;
  }

  const options = matches.slice(0, 8).map((fav) => {
    const icon = fav.source === "anilist" ? "🟣" : "🟠";
    return {
      label: fav.title.slice(0, 100),
      description: `${icon} ${fav.genres.split(",").slice(0, 2).join(", ") || "Sem gêneros"}`.slice(0, 100),
      value: String(fav.id),
    };
  });

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("fav_remove_select")
      .setPlaceholder("Selecione qual remover")
      .addOptions(options)
  );

  await interaction.editReply({
    content: `⚠️ Encontrei **${matches.length}** favoritos com esse nome. Qual remover?`,
    components: [row],
  });

  const collector = interaction.channel?.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: (i) => i.customId === "fav_remove_select" && i.user.id === interaction.user.id,
    time: 30_000,
    max: 1,
  });

  collector?.on("collect", async (sel: StringSelectMenuInteraction) => {
    await sel.deferUpdate();
    const favId = parseInt(sel.values[0], 10);
    const fav = matches.find((f) => f.id === favId);
    if (!fav) {
      await interaction.editReply({ content: "❌ Erro ao remover. Tente novamente.", components: [] });
      return;
    }
    await db.delete(favoritosTable).where(
      and(eq(favoritosTable.discordUserId, userId), eq(favoritosTable.id, favId))
    );
    await interaction.editReply({
      content: `🗑️ **${fav.title}** removido dos seus favoritos.`,
      components: [],
    });
  });

  collector?.on("end", async (_c, reason) => {
    if (reason === "time") {
      await interaction.editReply({ content: "⏱️ Tempo esgotado.", components: [] });
    }
  });
}
