import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from "discord.js";

const ANILIST_API = "https://graphql.anilist.co";

const TOP_QUERY = `
query TopManhwa($page: Int) {
  Page(page: $page, perPage: 10) {
    media(type: MANGA, countryOfOrigin: KR, sort: SCORE_DESC, status_not: NOT_YET_RELEASED) {
      id
      title { romaji english }
      averageScore
      genres
      chapters
      status
      siteUrl
      coverImage { color }
    }
  }
}
`;

export const data = new SlashCommandBuilder()
  .setName("topmanhwa")
  .setDescription("Lista os 10 manhwas mais bem avaliados no AniList");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  try {
    const res = await fetch(ANILIST_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: TOP_QUERY, variables: { page: 1 } }),
    });

    if (!res.ok) throw new Error(`AniList error: ${res.status}`);
    const json = (await res.json()) as {
      data: { Page: { media: { id: number; title: { romaji: string; english: string | null }; averageScore: number | null; genres: string[]; chapters: number | null; status: string | null; siteUrl: string }[] } };
    };

    const list = json.data.Page.media;

    const description = list
      .map((m, i) => {
        const title = m.title.english ?? m.title.romaji;
        const score = m.averageScore ? `⭐ ${(m.averageScore / 10).toFixed(1)}` : "⭐ N/A";
        const chapters = m.chapters ? `📖 ${m.chapters} caps` : "";
        const genres = m.genres.slice(0, 2).join(", ");
        return `**${i + 1}.** [${title}](${m.siteUrl}) — ${score} ${chapters ? `| ${chapters}` : ""}\n> ${genres}`;
      })
      .join("\n\n");

    const embed = new EmbedBuilder()
      .setTitle("🏆 Top 10 Manhwas — AniList")
      .setDescription(description)
      .setColor(0x7b68ee)
      .setFooter({ text: "Fonte: AniList • Ordenado por nota média" });

    await interaction.editReply({ embeds: [embed] });
  } catch {
    await interaction.editReply("❌ Erro ao buscar os top manhwas. Tente novamente.");
  }
}
