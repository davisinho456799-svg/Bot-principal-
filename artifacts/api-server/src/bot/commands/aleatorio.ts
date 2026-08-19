import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { cleanDescription, translateToPtBr, statusLabel, buildAlternativeTitles } from "../anilist.js";
import { buildScanLinksExternal } from "./search.js";

const ANILIST_API = "https://graphql.anilist.co";

const RANDOM_QUERY = `
query RandomManhwa($page: Int) {
  Page(page: $page, perPage: 1) {
    media(
      type: MANGA
      countryOfOrigin: KR
      sort: SCORE_DESC
      averageScore_greater: 75
      status_not: NOT_YET_RELEASED
    ) {
      id
      title { romaji english native }
      synonyms
      description(asHtml: false)
      coverImage { large color }
      averageScore
      genres
      chapters
      status
      siteUrl
      startDate { year }
    }
  }
}
`;

interface AniListMedia {
  id: number;
  title: { romaji: string; english: string | null; native: string | null };
  synonyms: string[];
  description: string | null;
  coverImage: { large: string; color: string | null };
  averageScore: number | null;
  genres: string[];
  chapters: number | null;
  status: string | null;
  siteUrl: string;
  startDate: { year: number | null };
}

export const data = new SlashCommandBuilder()
  .setName("aleatorio")
  .setDescription("Retorna um manhwa aleatório bem avaliado para descobrir obras novas");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  try {
    const randomPage = Math.floor(Math.random() * 40) + 1;

    const res = await fetch(ANILIST_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: RANDOM_QUERY, variables: { page: randomPage } }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) throw new Error(`AniList error: ${res.status}`);
    const json = (await res.json()) as {
      data: { Page: { media: AniListMedia[] } };
      errors?: { message: string }[];
    };

    if (json.errors?.length) throw new Error(json.errors[0].message);
    const media = json.data.Page.media;

    if (!media?.length) {
      await interaction.editReply("❌ Não foi possível encontrar um manhwa. Tente novamente!");
      return;
    }

    const m = media[0];
    const title = m.title.english ?? m.title.romaji ?? m.title.native ?? "Sem título";
    const score = m.averageScore ? `⭐ ${(m.averageScore / 10).toFixed(1)}/10` : "⭐ N/A";
    const chapters = m.chapters ? `📖 ${m.chapters} capítulos` : "📖 Desconhecido";
    const status = `📌 ${statusLabel(m.status)}`;
    const genres = m.genres.slice(0, 6).join(" • ") || "Sem gêneros";
    const color = m.coverImage.color
      ? parseInt(m.coverImage.color.replace("#", ""), 16)
      : 0x7b68ee;

    const rawDesc = cleanDescription(m.description);
    const synopsis = await translateToPtBr(rawDesc);

    const altTitles = buildAlternativeTitles(m as Parameters<typeof buildAlternativeTitles>[0]);

    const embed = new EmbedBuilder()
      .setTitle(`🎲 ${title}`)
      .setURL(m.siteUrl)
      .setDescription(synopsis || "Sem sinopse disponível.")
      .setThumbnail(m.coverImage.large)
      .setColor(color)
      .addFields(
        { name: "Avaliação", value: score, inline: true },
        { name: "Capítulos", value: chapters, inline: true },
        { name: "Status", value: status, inline: true },
        { name: "Gêneros", value: genres, inline: false },
      );

    if (altTitles) {
      embed.addFields({ name: "Títulos alternativos", value: altTitles, inline: false });
    }
    if (m.startDate?.year) {
      embed.addFields({ name: "Ano de início", value: String(m.startDate.year), inline: true });
    }

    embed.addFields({
      name: "🔎 Buscar nos sites BR",
      value: buildScanLinksExternal(title),
      inline: false,
    });

    embed.setFooter({ text: "🎲 Manhwa aleatório • Fonte: AniList • Sinopse traduzida automaticamente" });

    await interaction.editReply({ embeds: [embed] });
  } catch {
    await interaction.editReply("❌ Erro ao buscar manhwa aleatório. Tente novamente!");
  }
}
