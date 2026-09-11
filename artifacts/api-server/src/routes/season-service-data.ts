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

function currentSeason() {
  const month = new Date().getUTCMonth() + 1;
  return { season: month <= 3 ? "winter" : month <= 6 ? "spring" : month <= 9 ? "summer" : "fall", year: new Date().getUTCFullYear() };
}

const ANILIST_API = "https://graphql.anilist.co";
const SEASON_QUERY = `
query CurrentSeason($season: MediaSeason!, $seasonYear: Int!) {
  anime: Page(page: 1, perPage: 25) {
    media(
      season: $season
      seasonYear: $seasonYear
      type: ANIME
      sort: POPULARITY_DESC
      isAdult: false
    ) {
      id
      title { romaji english }
      siteUrl
      coverImage { large }
      averageScore
      episodes
      description(asHtml: false)
      genres
      status
    }
  }
  manga: Page(page: 1, perPage: 20) {
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

type SeasonResponse = {
  data?: {
    anime?: { media?: AniListItem[] };
    manga?: { media?: AniListItem[] };
  };
  errors?: Array<{ message?: string }>;
};

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

async function fetchSeasonFromAniList(season: string, year: number) {
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
        body: JSON.stringify({
          query: SEASON_QUERY,
          variables: { season: season.toUpperCase(), seasonYear: year },
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error(`AniList returned ${response.status}`);
      const json = (await response.json()) as SeasonResponse;
      if (json.errors?.length) {
        throw new Error(json.errors[0]?.message ?? "AniList returned a GraphQL error");
      }
      const anime = json.data?.anime?.media ?? [];
      const manga = json.data?.manga?.media ?? [];
      if (!anime.length && !manga.length) throw new Error("AniList returned an empty catalog");
      return { anime, manga };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("AniList request failed");
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
      }
    }
  }
  throw lastError ?? new Error("AniList request failed");
}

async function fetchSeasonFromTenrai(season: string, year: number): Promise<TenraiAnime[]> {
  const response = await fetch(
    `https://api.tenrai.org/v1/seasons/${year}/${season}?limit=25`,
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
  return anime;
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

function mapTenraiAnime(item: TenraiAnime): SeasonDataItem {
  const status = item.status?.toLowerCase() ?? "";
  return {
    id: item.mal_id,
    title: item.title_english || item.title || "Sem título",
    kind: "anime",
    status: status.includes("not yet") || status.includes("upcoming") ? "upcoming" : "airing",
    imageUrl: item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || "",
    url: item.url || `https://myanimelist.net/anime/${item.mal_id}`,
    score: item.score == null ? null : item.score,
    episodes: item.episodes ?? null,
    volumes: null,
    synopsis: item.synopsis ?? null,
    genres: (item.genres ?? [])
      .map((genre) => genre.name ?? "")
      .filter(Boolean),
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
  const { season, year } = currentSeason();
  let anime: SeasonDataItem[];
  let manga: SeasonDataItem[];

  try {
    const result = await fetchSeasonFromAniList(season, year);
    anime = result.anime.map((item) =>
      map(item, "anime", item.status === "NOT_YET_RELEASED" ? "upcoming" : "airing"),
    );
    manga = result.manga.map((item) => map(item, "manga", "publishing"));
  } catch (error) {
    logger.warn(
      { err: error, season, year },
      "AniList indisponível; usando catálogo sazonal reserva do Tenrai",
    );
    const fallbackAnime = await fetchSeasonFromTenrai(season, year);
    anime = fallbackAnime.map(mapTenraiAnime);
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