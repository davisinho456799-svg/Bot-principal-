import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ComponentType,
} from "discord.js";
import { translateToPtBr, statusLabel } from "../anilist.js";
import { buildScanLinksExternal } from "./search.js";

const ANILIST_API = "https://graphql.anilist.co";

const GENRES = [
  { label: "⚔️ Ação", value: "Action" },
  { label: "🗺️ Aventura", value: "Adventure" },
  { label: "😂 Comédia", value: "Comedy" },
  { label: "😢 Drama", value: "Drama" },
  { label: "🧙 Fantasia", value: "Fantasy" },
  { label: "😱 Horror", value: "Horror" },
  { label: "🔍 Mistério", value: "Mystery" },
  { label: "🧠 Psicológico", value: "Psychological" },
  { label: "💕 Romance", value: "Romance" },
  { label: "🚀 Ficção Científica", value: "Sci-Fi" },
  { label: "☕ Slice of Life", value: "Slice of Life" },
  { label: "👻 Sobrenatural", value: "Supernatural" },
  { label: "😰 Thriller", value: "Thriller" },
  { label: "🏆 Esportes", value: "Sports" },
  { label: "🤖 Mecha", value: "Mecha" },
  { label: "🎵 Música", value: "Music" },
  { label: "🌟 Mahou Shoujo", value: "Mahou Shoujo" },
  { label: "🔞 Ecchi", value: "Ecchi" },
  { label: "🦸 Super Poder", value: "Super Power" },
  { label: "🩸 Gore", value: "Gore" },
  { label: "⏰ Reencarnação", value: "Reincarnation" },
  { label: "🎮 Game", value: "Video Games" },
  { label: "🧟 Zumbi", value: "Zombies" },
  { label: "🗡️ Survival", value: "Survival" },
  { label: "🏫 Escola", value: "School Life" },
];

const RECOMMEND_QUERY = `
query RecommendManhwa($genres: [String], $page: Int) {
  Page(page: $page, perPage: 6) {
    media(
      type: MANGA
      countryOfOrigin: KR
      genre_in: $genres
      sort: SCORE_DESC
      averageScore_greater: 70
    ) {
      id
      title { romaji english native }
      description(asHtml: false)
      coverImage { large color }
      averageScore
      genres
      chapters
      status
      siteUrl
      startDate { year month day }
    }
  }
}
`;

interface AniListMedia {
  id: number;
  title: { romaji: string; english: string | null; native: string | null };
  description: string | null;
  coverImage: { large: string; color: string | null };
  averageScore: number | null;
  genres: string[];
  chapters: number | null;
  status: string | null;
  siteUrl: string;
  startDate: { year: number | null };
}

function cleanDesc(raw: string | null): string {
  if (!raw) return "";
  return raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .trim();
}

async function fetchRecommendations(genres: string[]): Promise<AniListMedia[]> {
  const res = await fetch(ANILIST_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: RECOMMEND_QUERY, variables: { genres, page: 1 } }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`AniList error: ${res.status}`);
  const json = (await res.json()) as {
    data: { Page: { media: AniListMedia[] } };
    errors?: { message: string }[];
  };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data.Page.media ?? [];
}

async function buildRecommendEmbed(
  results: AniListMedia[],
  selectedGenres: string[]
): Promise<EmbedBuilder> {
  const genreLabels = selectedGenres
    .map((g) => GENRES.find((x) => x.value === g)?.label ?? g)
    .join(", ");

  const lines = await Promise.all(
    results.map(async (m) => {
      const title = m.title.english ?? m.title.romaji ?? "Sem título";
      const score = m.averageScore ? `⭐ ${(m.averageScore / 10).toFixed(1)}` : "⭐ N/A";
      const chapters = m.chapters ? `📖 ${m.chapters} caps` : "";
      const status = statusLabel(m.status);
      const rawDesc = cleanDesc(m.description);
      const desc = rawDesc ? await translateToPtBr(rawDesc.slice(0, 200)) : "Sem sinopse.";
      const shortDesc = desc.slice(0, 120) + (desc.length > 120 ? "..." : "");
      const scanLinks = buildScanLinksExternal(title);
      return `**[${title}](${m.siteUrl})** — ${score} ${chapters ? `| ${chapters}` : ""} | ${status}\n> ${shortDesc}\n> 🔎 ${scanLinks}`;
    })
  );

  return new EmbedBuilder()
    .setTitle("📚 Recomendações de Manhwa")
    .setDescription(
      `**Gêneros selecionados:** ${genreLabels}\n\n${lines.join("\n\n")}`
    )
    .setColor(0x7b68ee)
    .setFooter({ text: "Fonte: AniList • Sinopses traduzidas automaticamente" });
}

export const data = new SlashCommandBuilder()
  .setName("recomendar")
  .setDescription("Recomenda manhwas por gênero — selecione até 5 gêneros");

export async function execute(interaction: ChatInputCommandInteraction) {
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("genre_select")
      .setPlaceholder("Selecione de 1 a 5 gêneros")
      .setMinValues(1)
      .setMaxValues(5)
      .addOptions(GENRES)
  );

  await interaction.reply({
    content: "🎭 Escolha os gêneros para receber recomendações de manhwa:",
    components: [row],
    ephemeral: false,
  });

  const collector = interaction.channel?.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: (i) => i.customId === "genre_select" && i.user.id === interaction.user.id,
    time: 45_000,
    max: 1,
  });

  collector?.on("collect", async (selectInteraction: StringSelectMenuInteraction) => {
    await selectInteraction.deferUpdate();

    const selected = selectInteraction.values;

    await interaction.editReply({
      content: `⏳ Buscando recomendações para os gêneros selecionados...`,
      components: [],
    });

    try {
      const results = await fetchRecommendations(selected);

      if (!results.length) {
        await interaction.editReply({
          content: "❌ Nenhum manhwa encontrado para essa combinação de gêneros. Tente outros!",
        });
        return;
      }

      const embed = await buildRecommendEmbed(results, selected);
      await interaction.editReply({ content: null, embeds: [embed] });
    } catch {
      await interaction.editReply({
        content: "❌ Erro ao buscar recomendações. Tente novamente.",
      });
    }
  });

  collector?.on("end", async (_collected, reason) => {
    if (reason === "time") {
      await interaction.editReply({
        content: "⏱️ Tempo esgotado. Use `/recomendar` novamente.",
        components: [],
      });
    }
  });
}
