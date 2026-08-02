const ANILIST_API = "https://graphql.anilist.co";

interface AniListRelationEdge {
  relationType: string;
  node: { title: { romaji: string | null; native: string | null } };
}

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
  // Relações com outras obras — usadas para filtrar synonyms falsos
  relations?: { edges: AniListRelationEdge[] };
}

// Fragmento reutilizado em todas as queries de manga — inclui relations para filtrar synonyms
const MANGA_FIELDS = `
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
  relations { edges { relationType node { title { romaji native } } } }
`;

const SEARCH_QUERY = `
query SearchManhwa($search: String!, $page: Int) {
  Page(page: $page, perPage: 10) {
    media(search: $search, type: MANGA, countryOfOrigin: KR, isAdult: false, sort: SEARCH_MATCH) {
      ${MANGA_FIELDS}
    }
  }
}
`;

const SEARCH_QUERY_ANY = `
query SearchManga($search: String!, $page: Int) {
  Page(page: $page, perPage: 8) {
    media(search: $search, type: MANGA, isAdult: false, sort: SEARCH_MATCH) {
      ${MANGA_FIELDS}
    }
  }
}
`;

const ID_QUERY = `
query GetManhwa($id: Int!) {
  Media(id: $id, type: MANGA) {
    ${MANGA_FIELDS}
  }
}
`;

const SEARCH_BY_GENRE_TAG_QUERY = `
query SearchByFilters($genres: [String], $tags: [String], $page: Int) {
  Page(page: $page, perPage: 15) {
    media(type: MANGA, countryOfOrigin: KR, isAdult: false, genre_in: $genres, tag_in: $tags, sort: POPULARITY_DESC) {
      ${MANGA_FIELDS}
    }
  }
}
`;

const SEARCH_BY_KEYWORD_ANY_QUERY = `
query SearchKeywordAny($search: String!, $page: Int) {
  Page(page: $page, perPage: 10) {
    media(search: $search, type: MANGA, isAdult: false, sort: SEARCH_MATCH) {
      ${MANGA_FIELDS}
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

// ─── Filtros de qualidade de dados ───────────────────────────────────────────

/**
 * Detecta se uma descrição do AniList é na verdade um índice de capítulos/histórias
 * em vez de uma sinopse real. Ocorre em antologias onde o AniList preenche o campo
 * description com uma lista numerada das obras contidas.
 * Exemplo: "1-2. Kokonoe Senpai!...; Comic ExE 50\n3. Little Bad Bunny..."
 */
function isChapterIndex(raw: string | null): boolean {
  if (!raw) return false;
  // Remove HTML e verifica se começa com padrão "1.", "1-", "1-2." etc.
  const text = raw.replace(/<[^>]+>/g, "").trim();
  return /^\d+[\-\.]/.test(text);
}

/**
 * Filtra synonyms que são na verdade títulos de obras relacionadas (relationType OTHER).
 * O AniList frequentemente coloca os títulos dos capítulos/histórias de antologias
 * tanto em synonyms quanto em relations, tornando os "títulos alternativos" incorretos.
 */
function filterSynonyms(synonyms: string[], relations?: ManhwaResult["relations"]): string[] {
  if (!synonyms.length || !relations?.edges?.length) return synonyms;
  const relationTitles = new Set<string>();
  for (const edge of relations.edges) {
    const romaji = edge.node?.title?.romaji;
    const native = edge.node?.title?.native;
    if (romaji) relationTitles.add(romaji.toLowerCase().trim());
    if (native) relationTitles.add(native.toLowerCase().trim());
  }
  return synonyms.filter((s) => !relationTitles.has(s.toLowerCase().trim()));
}

/** Aplica todos os filtros de qualidade em um resultado do AniList */
function sanitizeManhwaResult(m: ManhwaResult): ManhwaResult {
  return {
    ...m,
    synonyms: filterSynonyms(m.synonyms, m.relations),
    description: isChapterIndex(m.description) ? null : m.description,
  };
}

export async function searchManhwa(search: string): Promise<ManhwaResult[]> {
  const data = await anilistRequest<{ Page: { media: ManhwaResult[] } }>(SEARCH_QUERY, {
    search,
    page: 1,
  });
  return (data.Page.media ?? []).map(sanitizeManhwaResult);
}

export async function searchManhwaAny(search: string): Promise<ManhwaResult[]> {
  try {
    const data = await anilistRequest<{ Page: { media: ManhwaResult[] } }>(SEARCH_QUERY_ANY, {
      search,
      page: 1,
    });
    return (data.Page.media ?? []).map(sanitizeManhwaResult);
  } catch {
    return [];
  }
}

export async function getManhwaById(id: number): Promise<ManhwaResult | null> {
  try {
    const data = await anilistRequest<{ Media: ManhwaResult }>(ID_QUERY, { id });
    return data.Media ? sanitizeManhwaResult(data.Media) : null;
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
    return (data.Page.media ?? []).map(sanitizeManhwaResult);
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
    return (data.Page.media ?? []).map(sanitizeManhwaResult);
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
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=pt-BR&dt=t&q=${encodeURIComponent(truncated)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error("Translate error");
    const json = (await res.json()) as unknown[][];
    const translated = (json[0] as unknown[][])
      .map((x: unknown[]) => String(x[0] ?? ""))
      .join("");
    return translated || truncated;
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
