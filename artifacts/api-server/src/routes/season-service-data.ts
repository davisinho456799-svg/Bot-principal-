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
  };
}

export async function getCurrentSeasonData(): Promise<SeasonCatalog> {
  const { season, year } = currentSeason();
  const result = await fetchSeasonFromAniList(season, year);
  const anime = result.anime.map((item) =>
    map(item, "anime", item.status === "NOT_YET_RELEASED" ? "upcoming" : "airing"),
  );
  return {
    season,
    year,
    anime,
    manga: result.manga.map((item) => map(item, "manga", "publishing")),
    updatedAt: new Date(),
  };
}