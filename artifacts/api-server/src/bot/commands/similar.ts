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
import { searchAllSources } from "../unified.js";
import { statusLabel } from "../anilist.js";
import { buildScanLinksExternal } from "./search.js";
import { respondAutocomplete } from "../autocomplete.js";

const ANILIST_API = "https://graphql.anilist.co";

const SIMILAR_QUERY = `
query Similar($id: Int!) {
  Media(id: $id, type: MANGA) {
    title { romaji english }
    recommendations(sort: RATING_DESC, perPage: 8) {
      nodes {
        mediaRecommendation {
          id
          title { romaji english }
          averageScore
          genres
          chapters
          status
          siteUrl
          countryOfOrigin
          coverImage { large color }
        }
      }
    }
  }
}
`;

const GENRE_SIMILAR_QUERY = `
query SimilarByGenre($genres: [String], $notId: Int!) {
  Page(page: 1, perPage: 8) {
    media(type: MANGA, countryOfOrigin: KR, genre_in: $genres, sort: SCORE_DESC, id_not: $notId, averageScore_greater: 65) {
      id
      title { romaji english }
      averageScore
      genres
      chapters
      status
      siteUrl
      coverImage { large color }
    }
  }
}
`;

interface MediaNode {
  id: number;
  title: { romaji: string; english: string | null };
  averageScore: number | null;
  genres: string[];
  chapters: number | null;
  status: string | null;
  siteUrl: string;
  countryOfOrigin?: string | null;
  coverImage: { large: string; color: string | null };
}

async function anilistFetch<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ANILIST_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`AniList ${res.status}`);
  const json = (await res.json()) as { data: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

function buildLine(m: MediaNode, sourceTitle: string): string {
  const title = m.title.english ?? m.title.romaji;
  const score = m.averageScore ? `⭐ ${(m.averageScore / 10).toFixed(1)}` : "⭐ N/A";
  const chapters = m.chapters ? `📖 ${m.chapters} caps` : "📖 Em andamento";
  const status = statusLabel(m.status);
  const genres = m.genres.slice(0, 3).join(", ") || "—";
  const scanLinks = buildScanLinksExternal(title);
  return (
    `**[${title}](${m.siteUrl})**\n` +
    `> ${score} | ${chapters} | ${status}\n` +
    `> 🏷️ ${genres}\n` +
    `> 🔎 ${scanLinks}`
  );
}

export const data = new SlashCommandBuilder()
  .setName("similar")
  .setDescription("Encontra manhwas parecidos com um que você gosta")
  .addStringOption((o) =>
    o.setName("titulo").setDescription("Nome do manhwa de referência").setRequired(true).setAutocomplete(true)
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused();
  await respondAutocomplete(interaction, focused);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const titulo = interaction.options.getString("titulo", true);
  await interaction.deferReply();
  await interaction.editReply({ content: `🔍 Buscando **${titulo}**...` });

  const results = await searchAllSources(titulo).catch(() => []);
  const anilistResults = results.filter((r) => r.source === "anilist");

  if (!anilistResults.length) {
    await interaction.editReply(`❌ Nenhum resultado encontrado para **${titulo}** no AniList.`);
    return;
  }

  let chosenId: number;
  let chosenTitle: string;
  let chosenGenres: string[];

  if (anilistResults.length === 1) {
    chosenId = parseInt(anilistResults[0].id, 10);
    chosenTitle = anilistResults[0].mainTitle;
    chosenGenres = anilistResults[0].genres;
  } else {
    const options = anilistResults.slice(0, 8).map((r) => ({
      label: r.mainTitle.slice(0, 100),
      description: (r.genres.slice(0, 3).join(", ") || "Sem gênero").slice(0, 100),
      value: `${r.id}|${r.mainTitle}|${r.genres.join(",")}`,
    }));

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("similar_select")
        .setPlaceholder("Selecione o manhwa de referência")
        .addOptions(options)
    );

    await interaction.editReply({
      content: `📋 Encontrei **${anilistResults.length}** resultados. Qual é o de referência?`,
      components: [row],
    });

    const chosen = await new Promise<{ id: number; title: string; genres: string[] } | null>((resolve) => {
      const collector = interaction.channel?.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: (i) => i.customId === "similar_select" && i.user.id === interaction.user.id,
        time: 30_000,
        max: 1,
      });
      collector?.on("collect", async (sel: StringSelectMenuInteraction) => {
        await sel.deferUpdate();
        const [id, title, genresStr] = sel.values[0].split("|");
        resolve({ id: parseInt(id, 10), title, genres: genresStr.split(",").filter(Boolean) });
      });
      collector?.on("end", (_c, reason) => { if (reason === "time") resolve(null); });
    });

    if (!chosen) {
      await interaction.editReply({ content: "⏱️ Tempo esgotado.", components: [] });
      return;
    }
    chosenId = chosen.id;
    chosenTitle = chosen.title;
    chosenGenres = chosen.genres;
  }

  await interaction.editReply({ content: `⏳ Buscando similares a **${chosenTitle}**...`, components: [] });

  let similarList: MediaNode[] = [];

  try {
    const data = await anilistFetch<{
      Media: { recommendations: { nodes: { mediaRecommendation: MediaNode | null }[] } };
    }>(SIMILAR_QUERY, { id: chosenId });

    similarList = data.Media.recommendations.nodes
      .map((n) => n.mediaRecommendation)
      .filter((m): m is MediaNode => !!m);
  } catch {
    // ignore
  }

  if (similarList.length < 3 && chosenGenres.length > 0) {
    try {
      const genreData = await anilistFetch<{ Page: { media: MediaNode[] } }>(
        GENRE_SIMILAR_QUERY,
        { genres: chosenGenres.slice(0, 3), notId: chosenId }
      );
      const extra = genreData.Page.media.filter(
        (m) => !similarList.some((s) => s.id === m.id)
      );
      similarList = [...similarList, ...extra].slice(0, 8);
    } catch {
      // ignore
    }
  }

  if (!similarList.length) {
    await interaction.editReply(`❌ Não encontrei similares para **${chosenTitle}** no AniList.`);
    return;
  }

  const lines = similarList.slice(0, 8).map((m) => buildLine(m, chosenTitle));

  const embed = new EmbedBuilder()
    .setTitle(`🎯 Similares a: ${chosenTitle}`)
    .setDescription(lines.join("\n\n"))
    .setColor(0x1abc9c)
    .setFooter({ text: `${similarList.length} recomendações • Fonte: AniList` });

  if (similarList[0].coverImage.large) embed.setThumbnail(similarList[0].coverImage.large);

  await interaction.editReply({ content: null, embeds: [embed], components: [] });
}
