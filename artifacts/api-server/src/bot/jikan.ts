/**
 * Jikan API v4 — wrapper para MyAnimeList (MAL)
 * Gratuito, sem autenticação. Rate limit: ~3 req/seg (60/min).
 * Docs: https://docs.api.jikan.moe/
 */

const BASE = "https://api.jikan.moe/v4";

interface JikanTitle {
  type: string; // "Default" | "Synonym" | "Japanese" | "English" | "Korean"
  title: string;
}

interface JikanImage {
  jpg: { image_url: string | null; large_image_url: string | null };
}

interface JikanGenre {
  mal_id: number;
  name: string;
}

interface JikanManga {
  mal_id: number;
  title: string;
  title_english: string | null;
  title_japanese: string | null;
  title_synonyms: string[];
  titles: JikanTitle[];
  type: string | null; // "Manhwa" | "Manga" | "Manhua" | "Novel" | etc.
  status: string | null;
  score: number | null;
  genres: JikanGenre[];
  images: JikanImage;
  url: string;
  published: { prop: { from: { year: number | null } } };
  chapters: number | null;
  synopsis: string | null;
}

interface JikanSearchResponse {
  data: JikanManga[];
  pagination: { has_next_page: boolean };
}

export interface JikanResult {
  malId: number;
  mainTitle: string;
  englishTitle: string | null;
  japaneseTitle: string | null;
  synonyms: string[];
  score: number | null;
  genres: string[];
  status: string | null;
  coverUrl: string | null;
  siteUrl: string;
  year: number | null;
  chapters: number | null;
  type: string | null;
  synopsis: string | null;
  /** Status original retornado pelo MAL, antes da normalização interna. */
  rawStatus: string | null;
}

function mapJikanStatus(status: string | null): string | null {
  if (!status) return null;
  const s = status.toLowerCase();
  if (s.includes("publishing") || s.includes("ongoing")) return "RELEASING";
  if (s.includes("finished")) return "FINISHED";
  if (s.includes("hiatus")) return "HIATUS";
  if (s.includes("discontinued")) return "CANCELLED";
  return null;
}

function extractJikanSynonyms(manga: JikanManga): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  const mainNorm = manga.title.toLowerCase();
  seen.add(mainNorm);
  if (manga.title_english) seen.add(manga.title_english.toLowerCase());

  for (const t of manga.titles ?? []) {
    if (!t.title) continue;
    const norm = t.title.toLowerCase();
    if (!seen.has(norm)) {
      seen.add(norm);
      result.push(t.title);
    }
  }

  for (const s of manga.title_synonyms ?? []) {
    if (!s) continue;
    const norm = s.toLowerCase();
    if (!seen.has(norm)) {
      seen.add(norm);
      result.push(s);
    }
  }

  return result.slice(0, 8);
}

function toJikanResult(manga: JikanManga): JikanResult {
  const mainTitle = manga.title_english ?? manga.title;
  const synonyms = extractJikanSynonyms(manga);

  // manga.score pode ser 0 (falsy), por isso usamos != null em vez de check booleano
  const score = manga.score != null ? Math.round(manga.score * 10) : null;

  return {
    malId: manga.mal_id,
    mainTitle,
    englishTitle: manga.title_english ?? null,
    japaneseTitle: manga.title_japanese ?? null,
    synonyms,
    score,
    genres: (manga.genres ?? []).map((g) => g.name),
    status: mapJikanStatus(manga.status),
    coverUrl: manga.images?.jpg?.large_image_url ?? manga.images?.jpg?.image_url ?? null,
    siteUrl: manga.url,
    year: manga.published?.prop?.from?.year ?? null,
    chapters: manga.chapters ?? null,
    type: manga.type ?? null,
    synopsis: manga.synopsis ?? null,
    rawStatus: manga.status ?? null,
  };
}

// O MAL/Jikan aplica rate limit e pode responder 429 durante buscas paralelas.
let lastJikanCall = 0;
async function throttle(): Promise<void> {
  const wait = 350 - (Date.now() - lastJikanCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastJikanCall = Date.now();
}

const JIKAN_RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const jikanAnimeCache = new Map<string, { expiresAt: number; results: JikanAnimeResult[] }>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJikanJson<T>(path: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await throttle();
      const res = await fetch(`${BASE}${path}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return (await res.json()) as T;
      const retryAfter = Number(res.headers.get("retry-after"));
      if (!JIKAN_RETRYABLE.has(res.status) || attempt === 2) {
        throw new Error(`Jikan API error: ${res.status}`);
      }
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 5000) : 500 * 2 ** attempt);
    } catch (err) {
      lastError = err;
      if (attempt === 2) throw err;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Falha ao consultar o Jikan");
}

/**
 * Busca manhwas no Jikan (MAL).
 * @param type "manhwa" filtra apenas manhwa; omitir = qualquer tipo
 */
export async function searchJikan(
  query: string,
  type?: "manhwa" | "manhua" | "manga"
): Promise<JikanResult[]> {
  await throttle();

  const params = new URLSearchParams({ q: query, limit: "10", order_by: "relevance" });
  if (type) params.set("type", type);

  const res = await fetch(`${BASE}/manga?${params}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Jikan API error: ${res.status}`);

  const json = (await res.json()) as JikanSearchResponse;
  return (json.data ?? []).map(toJikanResult);
}

/**
 * Busca sem filtro de tipo — para pegar manhwas classificados incorretamente
 * como "Manga" ou "Novel" no MAL.
 */
export async function searchJikanAny(query: string): Promise<JikanResult[]> {
  try {
    return await searchJikan(query);
  } catch {
    return [];
  }
}


/**
 * Busca um manga/manhwa pelo MAL ID no Jikan.
 */
export async function getJikanMangaById(malId: number): Promise<JikanResult | null> {
  try {
    await throttle();
    const res = await fetch(`${BASE}/manga/${malId}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data: JikanManga };
    if (!json.data?.mal_id) return null;
    return toJikanResult(json.data);
  } catch {
    return null;
  }
}

// ─── Anime ────────────────────────────────────────────────────────────────────

interface JikanAnime {
  mal_id: number;
  title: string;
  title_english: string | null;
  title_japanese: string | null;
  titles: JikanTitle[];
  type: string | null; // "TV" | "Movie" | "OVA" | "ONA" | "Special" | "Music"
  status: string | null; // "Finished Airing" | "Currently Airing" | "Not yet aired"
  score: number | null;
  genres: JikanGenre[];
  themes: JikanGenre[];
  demographics: JikanGenre[];
  studios: Array<{ mal_id: number; name: string }>;
  images: JikanImage;
  url: string;
  aired: { prop: { from: { year: number | null } } };
  episodes: number | null;
  season: string | null; // "winter" | "spring" | "summer" | "fall"
  year: number | null;
  synopsis: string | null;
}

interface JikanAnimeSearchResponse {
  data: JikanAnime[];
  pagination: { has_next_page: boolean };
}

export interface JikanAnimeResult {
  malId: number;
  mainTitle: string;
  englishTitle: string | null;
  japaneseTitle: string | null;
  synonyms: string[];
  score: number | null;
  genres: string[];
  status: string | null;
  coverUrl: string | null;
  siteUrl: string;
  year: number | null;
  episodes: number | null;
  type: string | null;
  season: string | null;
  studios: string[];
  synopsis: string | null;
}

function mapJikanAnimeStatus(status: string | null): string | null {
  if (!status) return null;
  const s = status.toLowerCase();
  if (s.includes("currently airing")) return "RELEASING";
  if (s.includes("finished airing")) return "FINISHED";
  if (s.includes("not yet aired")) return "NOT_YET_RELEASED";
  return null;
}

function extractAnimeSynonyms(anime: JikanAnime): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const mainNorm = anime.title.toLowerCase();
  seen.add(mainNorm);
  if (anime.title_english) seen.add(anime.title_english.toLowerCase());

  for (const t of anime.titles ?? []) {
    if (!t.title) continue;
    const norm = t.title.toLowerCase();
    if (!seen.has(norm)) { seen.add(norm); result.push(t.title); }
  }
  return result.slice(0, 8);
}

function toJikanAnimeResult(anime: JikanAnime): JikanAnimeResult {
  const mainTitle = anime.title_english ?? anime.title;
  const allGenres = [
    ...(anime.genres ?? []),
    ...(anime.themes ?? []),
    ...(anime.demographics ?? []),
  ].map((g) => g.name);

  return {
    malId: anime.mal_id,
    mainTitle,
    englishTitle: anime.title_english ?? null,
    japaneseTitle: anime.title_japanese ?? null,
    synonyms: extractAnimeSynonyms(anime),
    // anime.score pode ser 0 (falsy), por isso usamos != null em vez de check booleano
    score: anime.score != null ? Math.round(anime.score * 10) : null,
    genres: [...new Set(allGenres)],
    status: mapJikanAnimeStatus(anime.status),
    coverUrl: anime.images?.jpg?.large_image_url ?? anime.images?.jpg?.image_url ?? null,
    siteUrl: anime.url,
    year: anime.year ?? anime.aired?.prop?.from?.year ?? null,
    episodes: anime.episodes ?? null,
    type: anime.type ?? null,
    season: anime.season ? anime.season.charAt(0).toUpperCase() + anime.season.slice(1) : null,
    studios: (anime.studios ?? []).map((s) => s.name),
    synopsis: anime.synopsis ?? null,
  };
}

/**
 * Busca animes no Jikan (MAL).
 */
export async function searchJikanAnime(
  query: string,
  type?: "tv" | "movie" | "ova" | "ona" | "special"
): Promise<JikanAnimeResult[]> {
  const cacheKey = `${query.trim().toLowerCase()}|${type ?? "all"}`;
  const cached = jikanAnimeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.results;

  const params = new URLSearchParams({ q: query.trim(), limit: "25", order_by: "relevance" });
  if (type) params.set("type", type);
  const json = await fetchJikanJson<JikanAnimeSearchResponse>(`/anime?${params}`);
  const results = (json.data ?? []).map(toJikanAnimeResult);
  jikanAnimeCache.set(cacheKey, { expiresAt: Date.now() + 60_000, results });
  return results;
}

/**
 * Busca anime sem filtro de tipo.
 */
export async function searchJikanAnimeAny(query: string): Promise<JikanAnimeResult[]> {
  try {
    return await searchJikanAnime(query);
  } catch {
    return [];
  }
}

/**
 * Retorna um anime por MAL ID (endpoint GET /anime/{id}).
 */
export async function getJikanAnimeById(malId: number): Promise<JikanAnimeResult | null> {
  try {
    const json = await fetchJikanJson<{ data: JikanAnime | null }>(`/anime/${malId}`);
    if (!json.data?.mal_id) return null;
    return toJikanAnimeResult(json.data);
  } catch {
    return null;
  }
}
