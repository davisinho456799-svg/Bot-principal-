import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from "discord.js";

const ANILIST_API = "https://graphql.anilist.co";

const LANCAMENTOS_QUERY = `
query LancamentosManhwa($page: Int) {
  Page(page: $page, perPage: 10) {
    media(
      type: MANGA
      countryOfOrigin: KR
      status: RELEASING
      sort: POPULARITY_DESC
    ) {
      id
      title { romaji english }
      averageScore
      genres
      chapters
      popularity
      siteUrl
      coverImage { color }
      startDate { year }
    }
  }
}
`;

interface AniListMedia {
  id: number;
  title: { romaji: string; english: string | null };
  averageScore: number | null;
  genres: string[];
  chapters: number | null;
  popularity: number;
  siteUrl: string;
  coverImage: { color: string | null };
  startDate: { year: number | null };
}

export const data = new SlashCommandBuilder()
  .setName("lancamentos")
  .setDescription("Lista os manhwas mais populares que estão em lançamento agora");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  try {
    const res = await fetch(ANILIST_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: LANCAMENTOS_QUERY, variables: { page: 1 } }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) throw new Error(`AniList error: ${res.status}`);
    const json = (await res.json()) as {
      data: { Page: { media: AniListMedia[] } };
      errors?: { message: string }[];
    };

    if (json.errors?.length) throw new Error(json.errors[0].message);
    const list = json.data.Page.media ?? [];

    if (!list.length) {
      await interaction.editReply("❌ Não foi possível obter os lançamentos agora. Tente novamente!");
      return;
    }

    const description = list
      .map((m, i) => {
        const title = m.title.english ?? m.title.romaji;
        const score = m.averageScore ? `⭐ ${(m.averageScore / 10).toFixed(1)}` : "⭐ N/A";
        const chapters = m.chapters ? `📖 ${m.chapters} caps` : "📖 Em andamento";
        const genres = m.genres.slice(0, 2).join(", ") || "—";
        const year = m.startDate?.year ? `(${m.startDate.year})` : "";
        return `**${i + 1}.** [${title}](${m.siteUrl}) ${year} — ${score} | ${chapters}\n> 🏷️ ${genres}`;
      })
      .join("\n\n");

    const embed = new EmbedBuilder()
      .setTitle("📡 Manhwas em Lançamento")
      .setDescription(description)
      .setColor(0x2ecc71)
      .setFooter({ text: "Fonte: AniList • Ordenado por popularidade • Status: Em lançamento" });

    await interaction.editReply({ embeds: [embed] });
  } catch {
    await interaction.editReply("❌ Erro ao buscar lançamentos. Tente novamente!");
  }
}
