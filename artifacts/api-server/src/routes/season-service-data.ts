import { logger } from "../lib/logger";

type AniListItem = {
  id: number;
  title: { romaji?: string | null; english?: string | null };
  siteUrl?: string | null;
  coverImage?: { large?: string | null };
  averageScore?: number | null;
  episodes?: number | null;
  volumes?: number | null;
  description?: string | null;
  genres?: string[];
  status?: string | null;
};

export type SeasonDataItem = {
  id: number;
  title: string;
  kind: "anime" | "manga";
  status: "airing" | "upcoming" | "publishing";
  imageUrl: string;
  url: string;
  score: number | null;
  episodes: number | null;
  volumes: number | null;
  synopsis: string | null;
  genres: string[];
  category?: "manga" | "manhwa";
};

export type SeasonCatalog = { season: string; year: number; anime: SeasonDataItem[]; manga: SeasonDataItem[]; updatedAt: Date };

export type SeasonAnimeItem = {
  id: number;
  title: { romaji: string; english: string | null };
  averageScore: number | null;
  genres: string[];
  episodes: number | null;
  status: string;
  siteUrl: string;
  coverImage: { color: string | null; large: string | null };
  description: string | null;
  studios: { nodes: { name: string }[] };
  startDate: { month: number | null; day: number | null };
  nextAiringEpisode: { episode: number; airingAt: number } | null;
  source: string;
};

export function getSeasonInfo(offsetMonths = 0): { season: string; year: number } {
  const now = new Date();
  const month = ((now.getUTCMonth() + offsetMonths) % 12 + 12) % 12 + 1;
  const year = now.getUTCFullYear() + Math.floor((now.getUTCMonth() + offsetMonths) / 12);
  return {
    season: month <= 3 ? "winter" : month <= 6 ? "spring" : month <= 9 ? "summer" : "fall",
    year,
  };
}

const ANILIST_API = "https://graphql.anilist.co";
const SEASON_ANIME_QUERY = `
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
      coverImage { color large }
      description(asHtml: false)
      studios(isMain: true) { nodes { name } }
      startDate { month day }
      nextAiringEpisode { episode airingAt }
    }
  }
}`;

const CURRENT_MANGA_QUERY = `
query CurrentManga {
  Page(page: 1, perPage: 20) {
    media(
      type: MANGA
      status: RELEASING
      sort: UPDATED_AT_DESC
      isAdult: false
    ) {
      id
      title { romaji english }
      siteUrl
      coverImage { large }
      averageScore
      volumes
      description(asHtml: false)
      genres
      status
    }
  }
}`;

type TenraiAnime = {
  mal_id: number;
  title: string;
  title_english?: string | null;
  url?: string | null;
  images?: { jpg?: { large_image_url?: string | null; image_url?: string | null } };
  score?: number | null;
  episodes?: number | null;
  synopsis?: string | null;
  genres?: Array<{ name?: string | null }>;
  status?: string | null;
};

type TenraiManga = {
  mal_id: number;
  title: string;
  title_english?: string | null;
  type?: string | null;
  url?: string | null;
  images?: { jpg?: { large_image_url?: string | null; image_url?: string | null } };
  score?: number | null;
  chapters?: number | null;
  volumes?: number | null;
  synopsis?: string | null;
  genres?: Array<{ name?: string | null }>;
};

async function fetchAniList<T>(
  query: string,
  variables: Record<string, string | number>,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(ANILIST_API, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`AniList returned ${response.status}`);
      const json = await response.json() as T & { errors?: Array<{ message?: string }> };
      if (json.errors?.length) {
        throw new Error(json.errors[0]?.message ?? "AniList returned a GraphQL error");
      }
      return json;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("AniList request failed");
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error("AniList request failed");
}

async function fetchSeasonAnimeFromAniList(
  season: string,
  year: number,
  page: number,
): Promise<SeasonAnimeItem[]> {
  const json = await fetchAniList<{
    data?: { Page?: { media?: Omit<SeasonAnimeItem, "source">[] } };
  }>(SEASON_ANIME_QUERY, { season: season.toUpperCase(), seasonYear: year, page });
  const anime = json.data?.Page?.media ?? [];
  if (!anime.length) throw new Error("AniList returned an empty seasonal anime catalog");
  return anime.map((item) => ({ ...item, source: "AniList" }));
}

async function fetchSeasonAnimeFromTenrai(
  season: string,
  year: number,
  page: number,
): Promise<SeasonAnimeItem[]> {
  const response = await fetch(
    `https://api.tenrai.org/v1/seasons/${year}/${season.toLowerCase()}?limit=20&page=${page}`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Tenrai returned ${response.status}`);
  }

  const json = (await response.json()) as { data?: TenraiAnime[] };
  const anime = json.data ?? [];
  if (!anime.length) throw new Error("Tenrai returned an empty seasonal catalog");
  return anime.map((item) => {
    const status = item.status?.toLowerCase() ?? "";
    return {
      id: item.mal_id,
      title: { romaji: item.title, english: item.title_english ?? null },
      averageScore: item.score == null ? null : item.score * 10,
      genres: (item.genres ?? []).map((genre) => genre.name ?? "").filter(Boolean),
      episodes: item.episodes ?? null,
      status: status.includes("not yet") || status.includes("upcoming")
        ? "NOT_YET_RELEASED"
        : "RELEASING",
      siteUrl: item.url ?? `https://myanimelist.net/anime/${item.mal_id}`,
      coverImage: {
        color: null,
        large: item.images?.jpg?.large_image_url ?? item.images?.jpg?.image_url ?? null,
      },
      description: item.synopsis ?? null,
      studios: { nodes: [] },
      startDate: { month: null, day: null },
      nextAiringEpisode: null,
      source: "MAL/Tenrai",
    };
  });
}

export async function getSeasonAnimePage(
  season: string,
  year: number,
  page = 1,
): Promise<SeasonAnimeItem[]> {
  try {
    return await fetchSeasonAnimeFromAniList(season, year, page);
  } catch (error) {
    logger.warn({ err: error, season, year, page }, "AniList indisponível na temporada; usando Tenrai");
    return fetchSeasonAnimeFromTenrai(season, year, page);
  }
}

async function fetchCurrentMangaFromAniList(): Promise<AniListItem[]> {
  const json = await fetchAniList<{
    data?: { Page?: { media?: AniListItem[] } };
  }>(CURRENT_MANGA_QUERY, {});
  const manga = json.data?.Page?.media ?? [];
  if (!manga.length) throw new Error("AniList returned an empty manga catalog");
  return manga;
}

async function fetchPublishingMangaFromTenrai(): Promise<TenraiManga[]> {
  const types = ["manga", "manhwa"];
  const results = await Promise.allSettled(
    types.map(async (type) => {
      const params = new URLSearchParams({
        status: "publishing",
        type,
        limit: "10",
        order_by: "popularity",
        sort: "asc",
      });
      const response = await fetch(`https://api.tenrai.org/v1/manga?${params}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`Tenrai manga (${type}) returned ${response.status}`);
      const json = (await response.json()) as { data?: TenraiManga[] };
      return json.data ?? [];
    }),
  );

  const manga = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  if (!manga.length) {
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    throw errors[0] instanceof Error
      ? errors[0]
      : new Error("Tenrai returned an empty publishing manga catalog");
  }
  return manga;
}

function map(item: AniListItem, kind: SeasonDataItem["kind"], status: SeasonDataItem["status"]): SeasonDataItem {
  return {
    id: item.id,
    title: item.title.english || item.title.romaji || "Sem título",
    kind,
    status,
    imageUrl: item.coverImage?.large || "",
    url: item.siteUrl || `https://anilist.co/${kind}/${item.id}`,
    score: item.averageScore == null ? null : item.averageScore / 10,
    episodes: item.episodes ?? null,
    volumes: item.volumes ?? null,
    synopsis: item.description ?? null,
    genres: item.genres ?? [],
    category: kind === "manga" ? "manga" : undefined,
  };
}

function mapTenraiManga(item: TenraiManga): SeasonDataItem {
  return {
    id: item.mal_id,
    title: item.title_english || item.title || "Sem título",
    kind: "manga",
    status: "publishing",
    imageUrl: item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || "",
    url: item.url || `https://myanimelist.net/manga/${item.mal_id}`,
    score: item.score == null ? null : item.score,
    episodes: null,
    volumes: item.volumes ?? null,
    synopsis: item.synopsis ?? null,
    genres: (item.genres ?? [])
      .map((genre) => genre.name ?? "")
      .filter(Boolean),
    category: item.type?.toLowerCase() === "manhwa" ? "manhwa" : "manga",
  };
}

export async function getCurrentSeasonData(): Promise<SeasonCatalog> {
  const { season, year } = getSeasonInfo();
  let anime: SeasonDataItem[];
  let manga: SeasonDataItem[];

  const [animeResult, mangaResult] = await Promise.allSettled([
    getSeasonAnimePage(season, year, 1),
    fetchCurrentMangaFromAniList(),
  ]);

  if (animeResult.status === "fulfilled") {
    anime = animeResult.value.map(mapSeasonAnime);
  } else {
    logger.warn({ err: animeResult.reason, season, year }, "Catálogo de anime indisponível");
    anime = [];
  }

  if (mangaResult.status === "fulfilled") {
    manga = mangaResult.value.map((item) => map(item, "manga", "publishing"));
  } else {
    logger.warn({ err: mangaResult.reason }, "AniList indisponível para mangás; usando Tenrai");
    try {
      const fallbackManga = await fetchPublishingMangaFromTenrai();
      manga = fallbackManga.map(mapTenraiManga);
    } catch (mangaError) {
      logger.warn({ err: mangaError }, "Catálogo reserva de mangás indisponível");
      manga = [];
    }
  }

  return {
    season,
    year,
    anime,
    manga,
    updatedAt: new Date(),
  };
}

function mapSeasonAnime(item: SeasonAnimeItem): SeasonDataItem {
  return {
    id: item.id,
    title: item.title.english || item.title.romaji || "Sem título",
    kind: "anime",
    status: item.status === "NOT_YET_RELEASED" ? "upcoming" : "airing",
    imageUrl: item.coverImage.large || "",
    url: item.siteUrl,
    score: item.averageScore == null ? null : item.averageScore / 10,
    episodes: item.episodes ?? null,
    volumes: null,
    synopsis: item.description,
    genres: item.genres,
  };
}