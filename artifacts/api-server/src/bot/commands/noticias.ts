import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from "discord.js";

const ANILIST_API = "https://graphql.anilist.co";

// Sites de notícias de anime (links de busca)
const NEWS_SITES = [
  { name: "AnimeNewsNetwork", url: "https://www.animenewsnetwork.com/search?q=" },
  { name: "Crunchyroll News", url: "https://www.crunchyroll.com/news?q=" },
  { name: "MyAnimeList", url: "https://myanimelist.net/search/all?q=" },
];

const UPCOMING_QUERY = `
query UpcomingAnime($page: Int, $season: MediaSeason, $seasonYear: Int) {
  Page(page: $page, perPage: 10) {
    media(
      type: ANIME
      season: $season
      seasonYear: $seasonYear
      sort: POPULARITY_DESC
      status_in: [NOT_YET_RELEASED, RELEASING]
    ) {
      id
      title { romaji english native }
      episodes
      status
      season
      seasonYear
      startDate { year month day }
      nextAiringEpisode { airingAt episode }
      coverImage { color }
      genres
      averageScore
      siteUrl
      externalLinks { url site type }
    }
  }
}
`;

const AIRING_SOON_QUERY = `
query AiringNext($airingAt_greater: Int, $airingAt_lesser: Int) {
  Page(page: 1, perPage: 10) {
    airingSchedules(
      airingAt_greater: $airingAt_greater
      airingAt_lesser: $airingAt_lesser
      sort: TIME
    ) {
      airingAt
      episode
      media {
        id
        title { romaji english }
        episodes
        status
        coverImage { color }
        genres
        averageScore
        siteUrl
        externalLinks { url site type }
      }
    }
  }
}
`;

interface ExternalLink {
  url: string;
  site: string;
  type: string;
}

interface AiringEpisode {
  airingAt: number;
  episode: number;
}

interface UpcomingMedia {
  id: number;
  title: { romaji: string; english: string | null; native: string | null };
  episodes: number | null;
  status: string | null;
  season: string | null;
  seasonYear: number | null;
  startDate: { year: number | null; month: number | null; day: number | null };
  nextAiringEpisode: AiringEpisode | null;
  coverImage: { color: string | null };
  genres: string[];
  averageScore: number | null;
  siteUrl: string;
  externalLinks: ExternalLink[];
}

interface AiringScheduleItem {
  airingAt: number;
  episode: number;
  media: UpcomingMedia;
}

function getCurrentSeason(): { season: string; year: number } {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  let season: string;
  if (month >= 1 && month <= 3) season = "WINTER";
  else if (month >= 4 && month <= 6) season = "SPRING";
  else if (month >= 7 && month <= 9) season = "SUMMER";
  else season = "FALL";
  return { season, year };
}

function getNextSeason(current: { season: string; year: number }): { season: string; year: number } {
  const order = ["WINTER", "SPRING", "SUMMER", "FALL"];
  const idx = order.indexOf(current.season);
  const nextIdx = (idx + 1) % 4;
  return {
    season: order[nextIdx],
    year: nextIdx === 0 ? current.year + 1 : current.year,
  };
}

function seasonLabel(season: string | null, year: number | null): string {
  const map: Record<string, string> = {
    WINTER: "Inverno", SPRING: "Primavera", SUMMER: "Verão", FALL: "Outono",
  };
  if (!season) return year ? String(year) : "—";
  return `${map[season] ?? season} ${year ?? ""}`;
}

function formatAiringDate(airingAt: number | null, startDate: { year: number | null; month: number | null; day: number | null } | null): string {
  if (airingAt) {
    const d = new Date(airingAt * 1000);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  }
  if (startDate?.year) {
    const parts = [startDate.day, startDate.month, startDate.year].filter(Boolean);
    if (parts.length === 3) return `${String(startDate.day).padStart(2, "0")}/${String(startDate.month).padStart(2, "0")}/${startDate.year}`;
    if (startDate.month) return `${String(startDate.month).padStart(2, "0")}/${startDate.year}`;
    return String(startDate.year);
  }
  return "Em breve";
}

function getStreamingLinks(links: ExternalLink[]): string {
  const streaming = links
    .filter((l) => l.type === "STREAMING" || ["Crunchyroll", "Funimation", "Netflix", "Disney Plus", "Amazon Prime Video", "HIDIVE", "Funimation"].includes(l.site))
    .slice(0, 3);
  if (!streaming.length) return "";
  return streaming.map((l) => `[${l.site}](${l.url})`).join(" • ");
}

function buildNewsLinks(title: string): string {
  const q = encodeURIComponent(title);
  return NEWS_SITES.map((s) => `[${s.name}](${s.url}${q})`).join(" • ");
}

async function fetchUpcoming(page: number): Promise<{ media: UpcomingMedia[]; totalPages: number }> {
  const current = getCurrentSeason();
  const next = getNextSeason(current);

  // Busca temporada atual + próxima
  const [resCurrent, resNext] = await Promise.all([
    fetch(ANILIST_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        query: UPCOMING_QUERY,
        variables: { page, season: current.season, seasonYear: current.year },
      }),
      signal: AbortSignal.timeout(10000),
    }),
    fetch(ANILIST_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        query: UPCOMING_QUERY,
        variables: { page: 1, season: next.season, seasonYear: next.year },
      }),
      signal: AbortSignal.timeout(10000),
    }),
  ]);

  const [jsonCurrent, jsonNext] = (await Promise.all([resCurrent.json(), resNext.json()])) as Array<{
    data: { Page: { media: UpcomingMedia[] } };
  }>;

  const currentMedia = jsonCurrent?.data?.Page?.media ?? [];
  const nextMedia = jsonNext?.data?.Page?.media ?? [];

  // Combina e deduplica
  const seen = new Set<number>();
  const combined: UpcomingMedia[] = [];
  for (const m of [...currentMedia, ...nextMedia]) {
    if (!seen.has(m.id)) { seen.add(m.id); combined.push(m); }
  }

  return { media: combined.slice(0, 10), totalPages: 3 };
}

async function fetchAiringSoon(): Promise<AiringScheduleItem[]> {
  const now = Math.floor(Date.now() / 1000);
  const inWeek = now + 7 * 24 * 60 * 60;

  const res = await fetch(ANILIST_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      query: AIRING_SOON_QUERY,
      variables: { airingAt_greater: now, airingAt_lesser: inWeek },
    }),
    signal: AbortSignal.timeout(10000),
  });

  const json = (await res.json()) as { data: { Page: { airingSchedules: AiringScheduleItem[] } } };
  return json?.data?.Page?.airingSchedules ?? [];
}

function buildUpcomingEmbed(media: UpcomingMedia[], page: number): EmbedBuilder {
  const current = getCurrentSeason();
  const next = getNextSeason(current);

  const lines = media.map((m, i) => {
    const title = m.title.english ?? m.title.romaji;
    const date = formatAiringDate(m.nextAiringEpisode?.airingAt ?? null, m.startDate);
    const eps = m.episodes ? `${m.episodes} eps` : "? eps";
    const score = m.averageScore ? `⭐ ${(m.averageScore / 10).toFixed(1)}` : "";
    const season = seasonLabel(m.season, m.seasonYear);
    const genres = m.genres.slice(0, 2).join(", ") || "—";
    const streaming = getStreamingLinks(m.externalLinks);
    const newsLinks = buildNewsLinks(title);

    let line = `**${i + 1}.** [${title}](${m.siteUrl}) — 📅 ${date} | ${eps}`;
    if (score) line += ` | ${score}`;
    line += `\n> 🎬 ${season} • 🏷️ ${genres}`;
    if (streaming) line += `\n> 📺 ${streaming}`;
    line += `\n> 📰 ${newsLinks}`;
    return line;
  });

  return new EmbedBuilder()
    .setTitle("📡 Notícias de Animes — Lançamentos")
    .setDescription(
      `**Temporadas:** ${seasonLabel(current.season, current.year)} + ${seasonLabel(next.season, next.year)}\n\n${lines.join("\n\n")}`.slice(0, 4000)
    )
    .setColor(0x3498db)
    .setFooter({ text: `Fonte: AniList • Página ${page} • Ordenado por popularidade` });
}

function buildAiringEmbed(schedules: AiringScheduleItem[]): EmbedBuilder {
  const lines = schedules.map((s) => {
    const m = s.media;
    const title = m.title.english ?? m.title.romaji;
    const date = formatAiringDate(s.airingAt, null);
    const streaming = getStreamingLinks(m.externalLinks);
    const newsLinks = buildNewsLinks(title);
    const score = m.averageScore ? `⭐ ${(m.averageScore / 10).toFixed(1)}` : "";

    let line = `**Ep ${s.episode}** — [${title}](${m.siteUrl}) — 📅 ${date}`;
    if (score) line += ` | ${score}`;
    if (streaming) line += `\n> 📺 ${streaming}`;
    line += `\n> 📰 ${newsLinks}`;
    return line;
  });

  return new EmbedBuilder()
    .setTitle("⏰ Episódios que Estreiam Essa Semana")
    .setDescription((lines.join("\n\n") || "Nenhum episódio encontrado para os próximos 7 dias.").slice(0, 4000))
    .setColor(0xe67e22)
    .setFooter({ text: "Fonte: AniList • Próximos 7 dias" });
}

function buildModeRow(mode: "lancamentos" | "semana"): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("noticias_lancamentos")
      .setLabel("📡 Lançamentos da Temporada")
      .setStyle(mode === "lancamentos" ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("noticias_semana")
      .setLabel("⏰ Estreias desta Semana")
      .setStyle(mode === "semana" ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );
}

function buildNavRow(page: number, totalPages: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("noticias_prev")
      .setLabel("◀ Anterior")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId("noticias_next")
      .setLabel("Próxima ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages)
  );
}

export const data = new SlashCommandBuilder()
  .setName("noticias")
  .setDescription("Mostra animes que vão lançar com links de notícias e streaming");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  let mode: "lancamentos" | "semana" = "lancamentos";
  let page = 1;
  const totalPages = 3;

  try {
    const { media } = await fetchUpcoming(page);

    if (!media.length) {
      await interaction.editReply("❌ Nenhum anime encontrado. Tente novamente!");
      return;
    }

    await interaction.editReply({
      embeds: [buildUpcomingEmbed(media, page)],
      components: [buildModeRow(mode), buildNavRow(page, totalPages)],
    });

    const collector = interaction.channel?.createMessageComponentCollector({
      componentType: ComponentType.Button,
      filter: (i) =>
        ["noticias_lancamentos", "noticias_semana", "noticias_prev", "noticias_next"].includes(i.customId) &&
        i.user.id === interaction.user.id,
      time: 120_000,
    });

    collector?.on("collect", async (btn) => {
      await btn.deferUpdate();

      if (btn.customId === "noticias_lancamentos") {
        mode = "lancamentos";
        page = 1;
        const { media: newMedia } = await fetchUpcoming(page);
        await interaction.editReply({
          embeds: [buildUpcomingEmbed(newMedia, page)],
          components: [buildModeRow(mode), buildNavRow(page, totalPages)],
        });
      } else if (btn.customId === "noticias_semana") {
        mode = "semana";
        const schedules = await fetchAiringSoon();
        await interaction.editReply({
          embeds: [buildAiringEmbed(schedules)],
          components: [buildModeRow(mode)],
        });
      } else if (btn.customId === "noticias_prev" && mode === "lancamentos") {
        page = Math.max(1, page - 1);
        const { media: newMedia } = await fetchUpcoming(page);
        await interaction.editReply({
          embeds: [buildUpcomingEmbed(newMedia, page)],
          components: [buildModeRow(mode), buildNavRow(page, totalPages)],
        });
      } else if (btn.customId === "noticias_next" && mode === "lancamentos") {
        page = Math.min(totalPages, page + 1);
        const { media: newMedia } = await fetchUpcoming(page);
        await interaction.editReply({
          embeds: [buildUpcomingEmbed(newMedia, page)],
          components: [buildModeRow(mode), buildNavRow(page, totalPages)],
        });
      }
    });

    collector?.on("end", async (_col, reason) => {
      if (reason === "time") {
        await interaction.editReply({ components: [] }).catch(() => null);
      }
    });
  } catch (err) {
    console.error("[noticias] Erro:", err);
    await interaction.editReply("❌ Erro ao buscar notícias de animes. Tente novamente!");
  }
}
