/**
 * Comando /temporada — exibe os animes da temporada atual, próxima ou anterior.
 * Fonte: AniList (season query).
 */

import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ComponentType,
} from "discord.js";

const ANILIST_API = "https://graphql.anilist.co";

const SEASON_QUERY = `
query SeasonAnime($season: MediaSeason!, $seasonYear: Int!, $page: Int) {
  Page(page: $page, perPage: 20) {
    pageInfo { hasNextPage currentPage }
    media(
      season: $season
      seasonYear: $seasonYear
      type: ANIME
      sort: POPULARITY_DESC
      isAdult: false
    ) {
      id
      title { romaji english }
      averageScore
      genres
      episodes
      status
      siteUrl
      coverImage { color }
      studios(isMain: true) { nodes { name } }
      startDate { month day }
      nextAiringEpisode { episode airingAt }
    }
  }
}
`;

interface SeasonMedia {
  id: number;
  title: { romaji: string; english: string | null };
  averageScore: number | null;
  genres: string[];
  episodes: number | null;
  status: string;
  siteUrl: string;
  coverImage: { color: string | null };
  studios: { nodes: { name: string }[] };
  startDate: { month: number | null; day: number | null };
  nextAiringEpisode: { episode: number; airingAt: number } | null;
}

// ─── Temporada ────────────────────────────────────────────────────────────────

const SEASON_NAMES: Record<string, string> = {
  WINTER: "Inverno",
  SPRING: "Primavera",
  SUMMER: "Verão",
  FALL: "Outono",
};

const SEASON_EMOJI: Record<string, string> = {
  WINTER: "❄️",
  SPRING: "🌸",
  SUMMER: "☀️",
  FALL: "🍂",
};

function getCurrentSeason(offsetMonths = 0): { season: string; year: number } {
  const now = new Date();
  const month = ((now.getMonth() + offsetMonths) % 12 + 12) % 12 + 1;
  const yearAdj = Math.floor((now.getMonth() + offsetMonths) / 12);
  const year = now.getFullYear() + yearAdj;
  let season: string;
  if (month <= 3) season = "WINTER";
  else if (month <= 6) season = "SPRING";
  else if (month <= 9) season = "SUMMER";
  else season = "FALL";
  return { season, year };
}

const STATUS_PT: Record<string, string> = {
  RELEASING: "🟢 Airing",
  FINISHED: "✅ Finalizado",
  NOT_YET_RELEASED: "🔜 Em breve",
  CANCELLED: "❌ Cancelado",
  HIATUS: "⏸️ Hiato",
};

// ─── Busca ────────────────────────────────────────────────────────────────────

async function fetchSeason(season: string, year: number, page = 1): Promise<SeasonMedia[]> {
  const res = await fetch(ANILIST_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: SEASON_QUERY, variables: { season, seasonYear: year, page } }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`AniList ${res.status}`);
  const json = (await res.json()) as {
    data: { Page: { media: SeasonMedia[]; pageInfo: { hasNextPage: boolean } } };
    errors?: { message: string }[];
  };
  if (json.errors?.length) throw new Error(json.errors[0]!.message);
  return json.data.Page.media ?? [];
}

// ─── Embed ────────────────────────────────────────────────────────────────────

function buildSeasonEmbed(list: SeasonMedia[], season: string, year: number, page: number): EmbedBuilder {
  const emoji = SEASON_EMOJI[season] ?? "🎌";
  const seasonName = SEASON_NAMES[season] ?? season;

  const color = list[0]?.coverImage.color
    ? parseInt(list[0].coverImage.color.replace("#", ""), 16)
    : 0x02a9ff;

  const lines = list.map((m, i) => {
    const title = m.title.english ?? m.title.romaji;
    const score = m.averageScore ? `⭐ ${(m.averageScore / 10).toFixed(1)}` : "⭐ N/A";
    const eps = m.episodes ? `📺 ${m.episodes} eps` : m.nextAiringEpisode ? `📺 Ep ${m.nextAiringEpisode.episode}` : "📺 ?";
    const studio = m.studios.nodes[0]?.name ?? "—";
    const status = STATUS_PT[m.status] ?? m.status;
    const genres = m.genres.slice(0, 2).join(", ") || "—";
    return `**${(page - 1) * 20 + i + 1}.** [${title}](${m.siteUrl})\n> ${score} | ${eps} | ${status}\n> 🏢 ${studio} • 🏷️ ${genres}`;
  });

  return new EmbedBuilder()
    .setTitle(`${emoji} Temporada ${seasonName} ${year}`)
    .setDescription(lines.join("\n\n").slice(0, 4000))
    .setColor(color)
    .setFooter({ text: `Página ${page} • Ordenado por popularidade • Fonte: AniList` });
}

// ─── Comando ──────────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName("temporada")
  .setDescription("Exibe os animes da temporada atual, próxima ou anterior")
  .addStringOption((opt) =>
    opt
      .setName("periodo")
      .setDescription("Qual temporada ver")
      .setRequired(false)
      .addChoices(
        { name: "Atual", value: "atual" },
        { name: "Próxima", value: "proxima" },
        { name: "Anterior", value: "anterior" },
      )
  )
  .addIntegerOption((opt) =>
    opt
      .setName("ano")
      .setDescription("Ano específico (ex: 2025)")
      .setRequired(false)
      .setMinValue(1990)
      .setMaxValue(2030)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const periodo = interaction.options.getString("periodo") ?? "atual";
  const anoOpt = interaction.options.getInteger("ano");

  await interaction.deferReply();

  let seasonInfo: { season: string; year: number };
  if (anoOpt) {
    const base = getCurrentSeason(0);
    seasonInfo = { season: base.season, year: anoOpt };
  } else {
    switch (periodo) {
      case "proxima":  seasonInfo = getCurrentSeason(3);  break;
      case "anterior": seasonInfo = getCurrentSeason(-3); break;
      default:         seasonInfo = getCurrentSeason(0);  break;
    }
  }

  const { season, year } = seasonInfo;

  try {
    const list = await fetchSeason(season, year, 1);

    if (!list.length) {
      const seasonName = SEASON_NAMES[season] ?? season;
      await interaction.editReply(`❌ Nenhum anime encontrado para a temporada **${seasonName} ${year}**.`);
      return;
    }

    const embed = buildSeasonEmbed(list, season, year, 1);
    const seasonName = SEASON_NAMES[season] ?? season;
    const emoji = SEASON_EMOJI[season] ?? "🎌";

    // Se houver mais que 10 resultados, oferece navegação por select
    if (list.length >= 10) {
      const pageOptions = [
        { label: `${emoji} Página 1 (1–20)`, value: "1" },
        { label: `${emoji} Página 2 (21–40)`, value: "2" },
      ];
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("temporada_page")
          .setPlaceholder("Ver mais animes da temporada")
          .addOptions(pageOptions)
      );

      await interaction.editReply({ embeds: [embed], components: [row] });

      const collector = interaction.channel?.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: (i) => i.customId === "temporada_page" && i.user.id === interaction.user.id,
        time: 60_000,
        max: 3,
      });

      collector?.on("collect", async (sel: StringSelectMenuInteraction) => {
        await sel.deferUpdate();
        const pg = parseInt(sel.values[0]!, 10);
        try {
          const nextList = await fetchSeason(season, year, pg);
          const nextEmbed = buildSeasonEmbed(nextList, season, year, pg);
          await interaction.editReply({ embeds: [nextEmbed], components: [row] });
        } catch {
          await interaction.followUp({ content: "❌ Erro ao carregar a próxima página.", ephemeral: true });
        }
      });

      collector?.on("end", async (_c, reason) => {
        if (reason === "time") {
          await interaction.editReply({ components: [] }).catch(() => null);
        }
      });
    } else {
      await interaction.editReply({ embeds: [embed] });
    }
  } catch {
    const seasonName = SEASON_NAMES[season] ?? season;
    await interaction.editReply(`❌ Erro ao buscar a temporada **${seasonName} ${year}**. Tente novamente.`);
  }
}
