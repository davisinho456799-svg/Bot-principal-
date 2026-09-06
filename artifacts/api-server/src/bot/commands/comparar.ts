import {
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ComponentType,
} from "discord.js";
import { searchAllSources, type UnifiedResult } from "../unified.js";
import { statusLabel } from "../anilist.js";
import { respondAutocomplete } from "../autocomplete.js";

export const data = new SlashCommandBuilder()
  .setName("comparar")
  .setDescription("Compara dois manhwas lado a lado para ajudar a decidir qual ler")
  .addStringOption((opt) =>
    opt.setName("manhwa1").setDescription("Primeiro manhwa").setRequired(true).setAutocomplete(true)
  )
  .addStringOption((opt) =>
    opt.setName("manhwa2").setDescription("Segundo manhwa").setRequired(true).setAutocomplete(true)
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused();
  await respondAutocomplete(interaction, focused);
}

type PickedResult = UnifiedResult | null;

async function pickOne(
  query: string,
  interaction: ChatInputCommandInteraction,
  slot: 1 | 2,
  customId: string
): Promise<PickedResult> {
  let results: UnifiedResult[];
  try {
    results = await searchAllSources(query);
  } catch {
    return null;
  }
  if (!results.length) return null;
  if (results.length === 1) return results[0];

  const SOURCE_ICONS: Record<string, string> = { anilist: "🟣", mangadex: "🟠", comick: "🟢", mangaupdates: "🔵" };
  const SOURCE_LABELS: Record<string, string> = { anilist: "AniList", mangadex: "MangaDex", comick: "Comick", mangaupdates: "MangaUpdates" };
  const options = results.slice(0, 8).map((r) => {
    const icon = SOURCE_ICONS[r.source] ?? "🔵";
    return {
      label: r.mainTitle.slice(0, 100),
      description: `${icon} ${SOURCE_LABELS[r.source] ?? r.source} • ${r.genres.slice(0, 2).join(", ") || "Sem gêneros"}`.slice(0, 100),
      value: `${r.source}:${r.id}`,
    };
  });

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(`Selecione o manhwa ${slot} correto`)
      .addOptions(options)
  );

  await interaction.editReply({
    content: `🔍 Vários resultados para o **manhwa ${slot}** ("${query}"). Selecione o correto:`,
    components: [row],
    embeds: [],
  });

  return new Promise((resolve) => {
    const collector = interaction.channel?.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      filter: (i) => i.customId === customId && i.user.id === interaction.user.id,
      time: 30_000,
      max: 1,
    });

    collector?.on("collect", async (sel: StringSelectMenuInteraction) => {
      await sel.deferUpdate();
      const [source, ...idParts] = sel.values[0].split(":");
      const id = idParts.join(":");
      const found = results.find((r) => r.source === source && r.id === id) ?? null;
      resolve(found);
    });

    collector?.on("end", (_c, reason) => {
      if (reason === "time") resolve(null);
    });
  });
}

function scoreBar(score: number | null): string {
  if (!score) return "▱▱▱▱▱▱▱▱▱▱ N/A";
  const filled = Math.round(score / 10);
  return "▰".repeat(filled) + "▱".repeat(10 - filled) + ` ${(score / 10).toFixed(1)}`;
}

function winner(a: number | null, b: number | null): [string, string] {
  if (a === null && b === null) return ["", ""];
  if (a === null) return ["", "🏆"];
  if (b === null) return ["🏆", ""];
  if (a > b) return ["🏆", ""];
  if (b > a) return ["", "🏆"];
  return ["🤝", "🤝"];
}

function buildCompareEmbed(a: UnifiedResult, b: UnifiedResult): EmbedBuilder {
  const titleA = a.mainTitle;
  const titleB = b.mainTitle;

  const [wScore1, wScore2] = winner(a.score, b.score);
  const [wCh1, wCh2] = winner(a.chapters, b.chapters);

  const scoreA = `${scoreBar(a.score)} ${wScore1}`;
  const scoreB = `${scoreBar(b.score)} ${wScore2}`;

  const chapA = `${a.chapters ? `📖 ${a.chapters} caps` : "📖 Desconhecido"} ${wCh1}`;
  const chapB = `${b.chapters ? `📖 ${b.chapters} caps` : "📖 Desconhecido"} ${wCh2}`;

  const statusA = `📌 ${statusLabel(a.status)}`;
  const statusB = `📌 ${statusLabel(b.status)}`;

  const genresA = a.genres.slice(0, 4).join(" • ") || "—";
  const genresB = b.genres.slice(0, 4).join(" • ") || "—";

  const yearA = a.year ? String(a.year) : "—";
  const yearB = b.year ? String(b.year) : "—";

  const sourceA = a.source === "anilist" ? "🟣 AniList" : "🟠 MangaDex";
  const sourceB = b.source === "anilist" ? "🟣 AniList" : "🟠 MangaDex";

  const embed = new EmbedBuilder()
    .setTitle("⚔️ Comparação de Manhwas")
    .setColor(0x7b68ee)
    .setDescription(
      `Comparando **[${titleA}](${a.siteUrl})** vs **[${titleB}](${b.siteUrl})**\n\n` +
        `> 🏆 = melhor nesse critério &nbsp;|&nbsp; 🤝 = empatados`
    )
    .addFields(
      {
        name: `1️⃣ ${titleA}`,
        value:
          `**Avaliação:** ${scoreA}\n` +
          `**Capítulos:** ${chapA}\n` +
          `**Status:** ${statusA}\n` +
          `**Gêneros:** ${genresA}\n` +
          `**Ano:** ${yearA}\n` +
          `**Fonte:** ${sourceA}`,
        inline: true,
      },
      {
        name: `2️⃣ ${titleB}`,
        value:
          `**Avaliação:** ${scoreB}\n` +
          `**Capítulos:** ${chapB}\n` +
          `**Status:** ${statusB}\n` +
          `**Gêneros:** ${genresB}\n` +
          `**Ano:** ${yearB}\n` +
          `**Fonte:** ${sourceB}`,
        inline: true,
      }
    );

  const geneShared = a.genres.filter((g) => b.genres.includes(g));
  if (geneShared.length) {
    embed.addFields({
      name: "🔗 Gêneros em comum",
      value: geneShared.join(" • "),
      inline: false,
    });
  }

  if (a.coverUrl) embed.setThumbnail(a.coverUrl);
  embed.setFooter({ text: "Dados via AniList e MangaDex" });

  return embed;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const query1 = interaction.options.getString("manhwa1", true);
  const query2 = interaction.options.getString("manhwa2", true);

  await interaction.deferReply();
  await interaction.editReply({ content: "⏳ Buscando os dois manhwas..." });

  const [results1, results2] = await Promise.all([
    searchAllSources(query1).catch(() => [] as UnifiedResult[]),
    searchAllSources(query2).catch(() => [] as UnifiedResult[]),
  ]);

  if (!results1.length) {
    await interaction.editReply(`❌ Nenhum resultado para **${query1}**.`);
    return;
  }
  if (!results2.length) {
    await interaction.editReply(`❌ Nenhum resultado para **${query2}**.`);
    return;
  }

  let manhwa1: PickedResult = results1.length === 1 ? results1[0] : null;
  let manhwa2: PickedResult = results2.length === 1 ? results2[0] : null;

  if (!manhwa1) {
    manhwa1 = await pickOne(query1, interaction, 1, "compare_select_1");
    if (!manhwa1) {
      await interaction.editReply({ content: "⏱️ Tempo esgotado ou erro. Tente novamente.", components: [] });
      return;
    }
  }

  if (!manhwa2) {
    manhwa2 = await pickOne(query2, interaction, 2, "compare_select_2");
    if (!manhwa2) {
      await interaction.editReply({ content: "⏱️ Tempo esgotado ou erro. Tente novamente.", components: [] });
      return;
    }
  }

  const embed = buildCompareEmbed(manhwa1, manhwa2);
  await interaction.editReply({ content: null, embeds: [embed], components: [] });
}
