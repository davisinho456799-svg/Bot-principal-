type JikanItem = {
  mal_id: number;
  title?: string;
  title_english?: string | null;
  url?: string;
  images?: { jpg?: { large_image_url?: string } };
  score?: number | null;
  episodes?: number | null;
  volumes?: number | null;
  synopsis?: string | null;
  genres?: Array<{ name: string }>;
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

async function fetchPage(path: string) {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`https://api.jikan.moe/v4${path}`);
      if (!response.ok) throw new Error(`Jikan returned ${response.status}`);
      return (await response.json() as { data: JikanItem[] }).data;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Jikan request failed");
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error("Jikan request failed");
}

function map(item: JikanItem, kind: SeasonDataItem["kind"], status: SeasonDataItem["status"]): SeasonDataItem {
  return { id: item.mal_id, title: item.title_english || item.title || "Sem título", kind, status, imageUrl: item.images?.jpg?.large_image_url || "", url: item.url || `https://myanimelist.net/${kind}/${item.mal_id}`, score: item.score ?? null, episodes: item.episodes ?? null, volumes: item.volumes ?? null, synopsis: item.synopsis ?? null, genres: item.genres?.map((genre) => genre.name) ?? [] };
}

export async function getCurrentSeasonData(): Promise<SeasonCatalog> {
  const { season, year } = currentSeason();
  const results = await Promise.allSettled([
    fetchPage(`/seasons/${year}/${season}?limit=25&sfw=true`),
    fetchPage("/seasons/upcoming?limit=15&sfw=true"),
    fetchPage("/manga?status=publishing&order_by=score&sort=desc&limit=20&sfw=true"),
  ]);
  const [airingResult, upcomingResult, mangaResult] = results;
  const airing = airingResult.status === "fulfilled" ? airingResult.value : [];
  const upcoming = upcomingResult.status === "fulfilled" ? upcomingResult.value : [];
  const manga = mangaResult.status === "fulfilled" ? mangaResult.value : [];
  if (!airing.length && !upcoming.length && !manga.length) {
    throw new Error("Jikan is temporarily unavailable");
  }
  return { season, year, anime: [...airing.map((item) => map(item, "anime", "airing")), ...upcoming.map((item) => map(item, "anime", "upcoming"))], manga: manga.map((item) => map(item, "manga", "publishing")), updatedAt: new Date() };
}