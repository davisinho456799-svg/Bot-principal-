import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { statusLabel } from "../anilist.js";
import { buildScanLinksExternal } from "./search.js";

const ANILIST_API = "https://graphql.anilist.co";

const BUSCAR_QUERY = `
query BuscarFiltros(
  $genre: String
  $status: MediaStatus
  $yearGreater: FuzzyDateInt
  $yearLesser: FuzzyDateInt
  $scoreGreater: Int
  $countryOfOrigin: CountryCode
  $page: Int
) {
  Page(page: $page, perPage: 10) {
    pageInfo { total hasNextPage }
    media(
      type: MANGA
      countryOfOrigin: $countryOfOrigin
      genre: $genre
      status: $status
      startDate_greater: $yearGreater
      startDate_lesser: $yearLesser
      averageScore_greater: $scoreGreater
      sort: SCORE_DESC
    ) {
      id
      title { romaji english }
      averageScore
      genres
      chapters
      status
      siteUrl
      startDate { year }
      coverImage { large color }
      countryOfOrigin
    }
  }
}
`;

interface MediaItem {
  id: number;
  title: { romaji: string; english: string | null };
  averageScore: number | null;
  genres: string[];
  chapters: number | null;
  status: string | null;
  siteUrl: string;
  startDate: { year: number | null };
  coverImage: { large: string; color: string | null };
  countryOfOrigin: string | null;
}

const COUNTRY_LABEL: Record<string, string> = {
  KR: "🇰🇷 Manhwa",
  CN: "🇨🇳 Manhua",
  JP: "🇯🇵 Manga",
};

const GENEROS = [
  "Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror",
  "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life",
  "Supernatural", "Thriller", "Sports", "Mecha", "Reincarnation",
  "Survival", "School Life", "Video Games", "Zombies",
];

const GENEROS_PT: Record<string, string> = {
  Action: "Ação", Adventure: "Aventura", Comedy: "Comédia",
  Drama: "Drama", Fantasy: "Fantasia", Horror: "Horror",
  Mystery: "Mistério", Psychological: "Psicológico", Romance: "Romance",
  "Sci-Fi": "Ficção Científica", "Slice of Life": "Slice of Life",
  Supernatural: "Sobrenatural", Thriller: "Thriller", Sports: "Esportes",
  Mecha: "Mecha", Reincarnation: "Reencarnação", Survival: "Survival",
  "School Life": "Escola", "Video Games": "Game", Zombies: "Zumbi",
};

export const data = new SlashCommandBuilder()
  .setName("buscar")
  .setDescription("Busca manhwas com filtros avançados combinados")
  .addStringOption((o) =>
    o
      .setName("genero")
      .setDescription("Filtrar por gênero")
      .setRequired(false)
      .addChoices(
        ...GENEROS.map((g) => ({ name: GENEROS_PT[g] ?? g, value: g }))
      )
  )
  .addStringOption((o) =>
    o
      .setName("status")
      .setDescription("Filtrar por status de publicação")
      .setRequired(false)
      .addChoices(
        { name: "📡 Em lançamento", value: "RELEASING" },
        { name: "✅ Finalizado", value: "FINISHED" },
        { name: "⏸️ Pausado / Hiato", value: "HIATUS" },
        { name: "❌ Cancelado", value: "CANCELLED" },
      )
  )
  .addIntegerOption((o) =>
    o
      .setName("ano_min")
      .setDescription("Ano mínimo de início (ex: 2018)")
      .setRequired(false)
      .setMinValue(1990)
      .setMaxValue(2030)
  )
  .addIntegerOption((o) =>
    o
      .setName("ano_max")
      .setDescription("Ano máximo de início (ex: 2023)")
      .setRequired(false)
      .setMinValue(1990)
      .setMaxValue(2030)
  )
  .addIntegerOption((o) =>
    o
      .setName("nota_min")
      .setDescription("Nota mínima de 1 a 10 (ex: 7 = nota 7.0+)")
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(10)
  )
  .addStringOption((o) =>
    o
      .setName("tipo")
      .setDescription("Tipo de origem (padrão: Manhwa coreano)")
      .setRequired(false)
      .addChoices(
        { name: "🇰🇷 Manhwa (Coreano)", value: "KR" },
        { name: "🇨🇳 Manhua (Chinês)", value: "CN" },
        { name: "🇯🇵 Manga (Japonês)", value: "JP" },
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const genero = interaction.options.getString("genero");
  const status = interaction.options.getString("status");
  const anoMin = interaction.options.getInteger("ano_min");
  const anoMax = interaction.options.getInteger("ano_max");
  const notaMin = interaction.options.getInteger("nota_min");
  const tipo = interaction.options.getString("tipo") ?? "KR";

  await interaction.deferReply();

  const filtrosAtivos: string[] = [];
  if (genero) filtrosAtivos.push(`🏷️ ${GENEROS_PT[genero] ?? genero}`);
  if (status) {
    const statusMap: Record<string, string> = {
      RELEASING: "📡 Em lançamento",
      FINISHED: "✅ Finalizado",
      HIATUS: "⏸️ Pausado",
      CANCELLED: "❌ Cancelado",
    };
    filtrosAtivos.push(statusMap[status] ?? status);
  }
  if (anoMin) filtrosAtivos.push(`📅 A partir de ${anoMin}`);
  if (anoMax) filtrosAtivos.push(`📅 Até ${anoMax}`);
  if (notaMin) filtrosAtivos.push(`⭐ Nota ${notaMin}.0+`);
  filtrosAtivos.push(COUNTRY_LABEL[tipo] ?? tipo);

  const variables: Record<string, unknown> = {
    countryOfOrigin: tipo,
    page: 1,
  };
  if (genero) variables["genre"] = genero;
  if (status) variables["status"] = status;
  if (anoMin) variables["yearGreater"] = parseInt(`${anoMin}0000`, 10);
  if (anoMax) variables["yearLesser"] = parseInt(`${anoMax}1231`, 10);
  if (notaMin) variables["scoreGreater"] = notaMin * 10 - 1;

  let results: MediaItem[];
  let total = 0;

  try {
    const res = await fetch(ANILIST_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: BUSCAR_QUERY, variables }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`AniList ${res.status}`);
    const json = (await res.json()) as {
      data: { Page: { pageInfo: { total: number }; media: MediaItem[] } };
      errors?: { message: string }[];
    };
    if (json.errors?.length) throw new Error(json.errors[0].message);
    results = json.data.Page.media ?? [];
    total = json.data.Page.pageInfo.total ?? results.length;
  } catch {
    await interaction.editReply("❌ Erro ao buscar no AniList. Tente novamente.");
    return;
  }

  if (!results.length) {
    await interaction.editReply(
      `❌ Nenhum resultado com os filtros:\n${filtrosAtivos.map((f) => `> ${f}`).join("\n")}\n\nTente combinações menos restritivas.`
    );
    return;
  }

  const lines = results.map((m, i) => {
    const title = m.title.english ?? m.title.romaji;
    const score = m.averageScore ? `⭐ ${(m.averageScore / 10).toFixed(1)}` : "⭐ N/A";
    const chapters = m.chapters ? `📖 ${m.chapters} caps` : "📖 Em andamento";
    const st = statusLabel(m.status);
    const year = m.startDate?.year ? `(${m.startDate.year})` : "";
    const genres = m.genres.slice(0, 3).join(", ") || "—";
    const scanLinks = buildScanLinksExternal(title);
    return (
      `**${i + 1}.** **[${title}](${m.siteUrl})** ${year}\n` +
      `> ${score} | ${chapters} | ${st}\n` +
      `> 🏷️ ${genres}\n` +
      `> 🔎 ${scanLinks}`
    );
  });

  const thumbnail = results[0].coverImage.large;
  const cor = results[0].coverImage.color
    ? parseInt(results[0].coverImage.color.replace("#", ""), 16)
    : 0x3498db;

  const embed = new EmbedBuilder()
    .setTitle("🔎 Resultado da Busca Avançada")
    .setDescription(lines.join("\n\n"))
    .setColor(cor)
    .addFields({
      name: "Filtros aplicados",
      value: filtrosAtivos.join("  •  "),
      inline: false,
    })
    .setFooter({
      text: `Exibindo 10 de ${total} resultado(s) • Ordenados por nota`,
    });

  if (thumbnail) embed.setThumbnail(thumbnail);

  await interaction.editReply({ content: null, embeds: [embed] });
}
