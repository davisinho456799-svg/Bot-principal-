const ANILIST_API = "https://graphql.anilist.co";

export interface ManhwaResult {
  id: number;
  title: {
    romaji: string;
    english: string | null;
    native: string | null;
  };
  synonyms: string[];
  description: string | null;
  coverImage: {
    large: string;
    color: string | null;
  };
  averageScore: number | null;
  genres: string[];
  chapters: number | null;
  status: string | null;
  siteUrl: string;
  startDate: {
    year: number | null;
    month: number | null;
    day: number | null;
  };
}

const SEARCH_QUERY = `
query SearchManhwa($search: String!, $page: Int) {
  Page(page: $page, perPage: 10) {
    media(search: $search, type: MANGA, countryOfOrigin: KR, sort: SEARCH_MATCH) {
      id
      title { romaji english native }
      synonyms
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

const SEARCH_QUERY_ANY = `
query SearchManga($search: String!, $page: Int) {
  Page(page: $page, perPage: 8) {
    media(search: $search, type: MANGA, sort: SEARCH_MATCH) {
      id
      title { romaji english native }
      synonyms
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

const ID_QUERY = `
query GetManhwa($id: Int!) {
  Media(id: $id, type: MANGA) {
    id
    title { romaji english native }
    synonyms
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
`;

const SEARCH_BY_GENRE_TAG_QUERY = `
query SearchByFilters($genres: [String], $tags: [String], $page: Int) {
  Page(page: $page, perPage: 15) {
    media(type: MANGA, countryOfOrigin: KR, genre_in: $genres, tag_in: $tags, sort: POPULARITY_DESC) {
      id
      title { romaji english native }
      synonyms
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

const SEARCH_BY_KEYWORD_ANY_QUERY = `
query SearchKeywordAny($search: String!, $page: Int) {
  Page(page: $page, perPage: 10) {
    media(search: $search, type: MANGA, sort: SEARCH_MATCH) {
      id
      title { romaji english native }
      synonyms
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

async function anilistRequest<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ANILIST_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`AniList API error: ${res.status}`);
  const json = (await res.json()) as { data: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

export async function searchManhwa(search: string): Promise<ManhwaResult[]> {
  const data = await anilistRequest<{ Page: { media: ManhwaResult[] } }>(SEARCH_QUERY, {
    search,
    page: 1,
  });
  return data.Page.media ?? [];
}

export async function searchManhwaAny(search: string): Promise<ManhwaResult[]> {
  try {
    const data = await anilistRequest<{ Page: { media: ManhwaResult[] } }>(SEARCH_QUERY_ANY, {
      search,
      page: 1,
    });
    return data.Page.media ?? [];
  } catch {
    return [];
  }
}

export async function getManhwaById(id: number): Promise<ManhwaResult | null> {
  try {
    const data = await anilistRequest<{ Media: ManhwaResult }>(ID_QUERY, { id });
    return data.Media ?? null;
  } catch {
    return null;
  }
}

/**
 * Busca manhwas por gênero e/ou tag no AniList.
 * Usado pela busca semântica por descrição.
 * genres e tags são ANDados pelo AniList, então passamos só um conjunto por vez.
 */
export async function searchManhwaByFilters(
  genres: string[],
  tags: string[]
): Promise<ManhwaResult[]> {
  try {
    const variables: Record<string, unknown> = { page: 1 };
    if (genres.length > 0) variables["genres"] = genres;
    if (tags.length > 0) variables["tags"] = tags;
    if (!variables["genres"] && !variables["tags"]) return [];

    const data = await anilistRequest<{ Page: { media: ManhwaResult[] } }>(
      SEARCH_BY_GENRE_TAG_QUERY,
      variables
    );
    return data.Page.media ?? [];
  } catch {
    return [];
  }
}

/**
 * Busca qualquer manga/manhwa por keyword (sem filtro de país).
 * Para busca por descrição traduzida para EN.
 */
export async function searchManhwaKeywordAny(search: string): Promise<ManhwaResult[]> {
  try {
    const data = await anilistRequest<{ Page: { media: ManhwaResult[] } }>(
      SEARCH_BY_KEYWORD_ANY_QUERY,
      { search, page: 1 }
    );
    return data.Page.media ?? [];
  } catch {
    return [];
  }
}

export function cleanDescription(raw: string | null): string {
  if (!raw) return "";
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .trim();
}

export async function translateToPtBr(text: string): Promise<string> {
  if (!text) return "Sem sinopse disponível.";

  const truncated = text.slice(0, 500);

  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(truncated)}&langpair=en|pt-BR`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error("MyMemory error");
    const json = (await res.json()) as {
      responseStatus: number;
      responseData: { translatedText: string };
    };
    if (json.responseStatus !== 200) throw new Error("Translation failed");
    const translated = json.responseData.translatedText;
    return (text.length > 500 ? translated + "..." : translated);
  } catch {
    return truncated.slice(0, 400) + (text.length > 400 ? "..." : "");
  }
}

export function statusLabel(status: string | null): string {
  const map: Record<string, string> = {
    FINISHED: "Finalizado",
    RELEASING: "Em lançamento",
    NOT_YET_RELEASED: "Ainda não lançado",
    CANCELLED: "Cancelado",
    HIATUS: "Em hiato",
  };
  return status ? (map[status] ?? status) : "Desconhecido";
}

// ─── Anime ────────────────────────────────────────────────────────────────────

export interface AnimeResult {
  id: number;
  title: { romaji: string; english: string | null; native: string | null };
  synonyms: string[];
  description: string | null;
  coverImage: { large: string; color: string | null };
  averageScore: number | null;
  genres: string[];
  episodes: number | null;
  status: string | null;
  siteUrl: string;
  startDate: { year: number | null; month: number | null };
  season: string | null;
  seasonYear: number | null;
  studios: { nodes: Array<{ name: string }> };
  externalLinks: Array<{ url: string; site: string; type: string }>;
  type: string;
}

const SEARCH_ANIME_QUERY = `
query SearchAnime($search: String!, $page: Int) {
  Page(page: $page, perPage: 10) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
      id
      title { romaji english native }
      synonyms
      description(asHtml: false)
      coverImage { large color }
      averageScore
      genres
      episodes
      status
      siteUrl
      startDate { year month }
      season
      seasonYear
      studios(isMain: true) { nodes { name } }
      externalLinks { url site type }
      type
    }
  }
}
`;

const GET_ANIME_BY_ID_QUERY = `
query GetAnime($id: Int!) {
  Media(id: $id, type: ANIME) {
    id
    title { romaji english native }
    synonyms
    description(asHtml: false)
    coverImage { large color }
    averageScore
    genres
    episodes
    status
    siteUrl
    startDate { year month }
    season
    seasonYear
    studios(isMain: true) { nodes { name } }
    externalLinks { url site type }
    type
  }
}
`;

const SEARCH_ANIME_BY_GENRE_TAG_QUERY = `
query SearchAnimeByFilters($genres: [String], $tags: [String], $page: Int) {
  Page(page: $page, perPage: 15) {
    media(type: ANIME, genre_in: $genres, tag_in: $tags, sort: POPULARITY_DESC) {
      id
      title { romaji english native }
      synonyms
      description(asHtml: false)
      coverImage { large color }
      averageScore
      genres
      episodes
      status
      siteUrl
      startDate { year month }
      season
      seasonYear
      studios(isMain: true) { nodes { name } }
      externalLinks { url site type }
      type
    }
  }
}
`;

export async function searchAnime(search: string): Promise<AnimeResult[]> {
  try {
    const data = await anilistRequest<{ Page: { media: AnimeResult[] } }>(SEARCH_ANIME_QUERY, {
      search,
      page: 1,
    });
    return data.Page.media ?? [];
  } catch {
    return [];
  }
}

export async function getAnimeById(id: number): Promise<AnimeResult | null> {
  try {
    const data = await anilistRequest<{ Media: AnimeResult }>(GET_ANIME_BY_ID_QUERY, { id });
    return data.Media ?? null;
  } catch {
    return null;
  }
}

export async function searchAnimeByFilters(
  genres: string[],
  tags: string[]
): Promise<AnimeResult[]> {
  try {
    const variables: Record<string, unknown> = { page: 1 };
    if (genres.length > 0) variables["genres"] = genres;
    if (tags.length > 0) variables["tags"] = tags;
    if (!variables["genres"] && !variables["tags"]) return [];
    const data = await anilistRequest<{ Page: { media: AnimeResult[] } }>(
      SEARCH_ANIME_BY_GENRE_TAG_QUERY,
      variables
    );
    return data.Page.media ?? [];
  } catch {
    return [];
  }
}

export function buildAlternativeTitles(m: ManhwaResult): string | null {
  const titles = new Set<string>();

  if (m.title.english) titles.add(m.title.english);
  if (m.title.romaji) titles.add(m.title.romaji);
  if (m.title.native) titles.add(m.title.native);
  for (const s of m.synonyms ?? []) {
    if (s) titles.add(s);
  }

  const mainTitle = m.title.english ?? m.title.romaji ?? m.title.native ?? "";
  titles.delete(mainTitle);

  if (titles.size === 0) return null;
  return [...titles].slice(0, 6).join("\n");
}
