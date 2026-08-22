import {
  searchManhwa,
  searchManhwaAny,
  getManhwaById,
  searchAnime,
  getAnimeById,
  searchAnimeByFilters,
  type ManhwaResult,
  type AnimeResult,
} from "./anilist.js";
import {
  searchMangaDex,
  searchMangaDexAny,
  getMangaDexById,
  hasPtBrChapters,
  findMangaDexIdByTitle,
  type MangaDexResult,
} from "./mangadex.js";
import {
  searchComick,
  searchComickAny,
  getComickBySlug,
  comickCoverUrl,
  comickStatus,
  type ComickResult,
} from "./comick.js";
import { searchMangaUpdates, getMangaUpdatesById, type MangaUpdatesResult } from "./mangaupdates.js";
import {
  searchJikan,
  searchJikanAny,
  searchJikanAnimeAny,
  getJikanMangaById,
  getJikanAnimeById,
  type JikanResult,
  type JikanAnimeResult,
} from "./jikan.js";
import { searchKitsu, getKitsuById, type KitsuResult } from "./kitsu.js";
import {
  searchAniDB,
  getAniDBById,
  type AniDBEntry,
  type AniDBAnimeDetail,
} from "./anidb.js";
import { searchVNDB, getVNDBById, type VNDBResult } from "./vndb.js";
import { searchErogamescape, getErogamescapeDetail, type ErogamescapeResult } from "./erogamescape.js";
import { searchAniSearch, getAniSearchById, type AniSearchResult } from "./anisearch.js";
import {
  searchAnimeByConceptsPtBr,
  scoreAnimeCandidate,
  extractAnimeConcepts,
} from "./description-search-anime.js";
import { searchExaManhwa } from "./exa.js";
import {
  searchByDescriptionEnhanced,
  type DescriptionSearchResult,
} from "./description-search.js";
import { db } from "@workspace/db";
import { searchCache, titleAliases } from "@workspace/db";
import { eq, or, sql } from "drizzle-orm";

export interface UnifiedResult {
  source: "anilist" | "anilist-anime" | "mangadex" | "comick" | "mangaupdates" | "jikan" | "kitsu" | "anidb" | "vndb" | "erogamescape" | "anisearch";
  id: string;
  mainTitle: string;
  nativeTitle: string | null;
  romajiTitle: string | null;
  synonyms: string[];
  description: string | null;
  coverUrl: string | null;
  accentColor: number;
  score: number | null;
  genres: string[];
  chapters: number | null;
  status: string | null;
  siteUrl: string;
  year: number | null;
  ptBrUrl: string | null;
  // ── Campos específicos de anime (opcionais) ──────────────────────────────────
  mediaType?: "manga" | "anime";
  episodes?: number | null;
  animeType?: string | null;     // "TV" | "Movie" | "OVA" | "ONA" | "Special"
  season?: string | null;        // "Spring" | "Summer" | "Fall" | "Winter"
  seasonYear?: number | null;
  studios?: string[];
  streamingLinks?: Array<{ site: string; url: string }>;
  trailerUrl?: string | null;
}

// ─── Converters ──────────────────────────────────────────────────────────────

function anilistToUnified(m: ManhwaResult): UnifiedResult {
  return {
    source: "anilist",
    id: String(m.id),
    mainTitle: m.title.english ?? m.title.romaji ?? m.title.native ?? "Sem título",
    nativeTitle: m.title.native ?? null,
    romajiTitle: m.title.romaji ?? null,
    synonyms: m.synonyms ?? [],
    description: m.description,
    coverUrl: m.coverImage.large,
    accentColor: m.coverImage.color
      ? parseInt(m.coverImage.color.replace("#", ""), 16)
      : 0x7b68ee,
    score: m.averageScore,
    genres: m.genres,
    chapters: m.chapters,
    status: m.status,
    siteUrl: m.siteUrl,
    year: m.startDate?.year ?? null,
    ptBrUrl: null,
  };
}

function mangadexToUnified(m: MangaDexResult): UnifiedResult {
  return {
    source: "mangadex",
    id: m.id,
    mainTitle: m.mainTitle,
    nativeTitle: m.nativeTitle,
    romajiTitle: m.romajiTitle,
    synonyms: m.synonyms,
    description: m.description,
    coverUrl: m.coverUrl,
    accentColor: 0xe6813a,
    score: null,
    genres: m.genres,
    chapters: m.chapters,
    status: m.status,
    siteUrl: m.siteUrl,
    year: m.year,
    ptBrUrl: null,
  };
}

function comickToUnified(m: ComickResult): UnifiedResult {
  const allTitles = (m.md_titles ?? [])
    .map((t) => t.title?.trim() ?? "")
    .filter(Boolean);
  const genres = (m.genres ?? [])
    .filter((genre): genre is { name?: string } =>
      typeof genre === "object" && genre !== null,
    )
    .map((genre) => genre.name?.trim() ?? "")
    .filter(Boolean);
  return {
    source: "comick",
    id: m.slug ?? m.hid ?? "",
    mainTitle: m.title ?? "Sem título",
    nativeTitle: null,
    romajiTitle: null,
    synonyms: allTitles,
    description: m.desc ?? null,
    coverUrl: comickCoverUrl(m),
    accentColor: 0x26a69a,
    score: m.rating ? Math.round(parseFloat(m.rating) * 10) : null,
    genres,
    chapters: m.last_chapter ?? null,
    status: comickStatus(m.status ?? null),
    siteUrl: `https://comick.dev/comic/${m.slug ?? m.hid ?? ""}`,
    year: m.year ?? null,
    ptBrUrl: null,
  };
}

function mangaupdatesToUnified(m: MangaUpdatesResult): UnifiedResult {
  return {
    source: "mangaupdates",
    id: m.id,
    mainTitle: m.title,
    nativeTitle: null,
    romajiTitle: null,
    synonyms: [],
    description: m.description,
    coverUrl: m.coverUrl,
    accentColor: 0x1565c0,
    score: m.score,
    genres: m.genres,
    chapters: null,
    status: m.status,
    siteUrl: m.url,
    year: m.year,
    ptBrUrl: null,
  };
}

function jikanToUnified(m: JikanResult): UnifiedResult {
  return {
    source: "jikan",
    id: String(m.malId),
    mainTitle: m.mainTitle,
    nativeTitle: m.japaneseTitle,
    romajiTitle: null,
    synonyms: m.synonyms,
    description: null, // Jikan search não retorna sinopse; obtida ao carregar detalhes
    coverUrl: m.coverUrl,
    accentColor: 0x2e51a2, // cor MAL
    score: m.score,
    genres: m.genres,
    chapters: m.chapters,
    status: m.status,
    siteUrl: m.siteUrl,
    year: m.year,
    ptBrUrl: null,
  };
}

// ─── Anime converters ────────────────────────────────────────────────────────

const STREAMING_SITES = new Set([
  "Crunchyroll", "Funimation", "Netflix", "Hulu", "Amazon", "HIDIVE",
  "VRV", "Wakanim", "Bilibili", "iQIYI", "Disney Plus", "HBO Max",
  "AnimeLab", "Adult Swim", "Tubi",
]);

export function animeResultToUnified(m: AnimeResult): UnifiedResult {
  const streamingLinks = (m.externalLinks ?? [])
    .filter((l) => STREAMING_SITES.has(l.site) || l.type === "STREAMING")
    .map((l) => ({ site: l.site, url: l.url }))
    .slice(0, 6);

  return {
    source: "anilist-anime",
    id: String(m.id),
    mainTitle: m.title.english ?? m.title.romaji ?? m.title.native ?? "Sem título",
    nativeTitle: m.title.native ?? null,
    romajiTitle: m.title.romaji ?? null,
    synonyms: m.synonyms ?? [],
    description: m.description ?? null,
    coverUrl: m.coverImage.large,
    accentColor: m.coverImage.color
      ? parseInt(m.coverImage.color.replace("#", ""), 16)
      : 0xe8564a,
    score: m.averageScore,
    genres: m.genres,
    chapters: null,
    status: m.status,
    siteUrl: m.siteUrl,
    year: m.startDate?.year ?? m.seasonYear ?? null,
    ptBrUrl: null,
    mediaType: "anime",
    episodes: m.episodes,
    animeType: m.type,
    season: m.season,
    seasonYear: m.seasonYear,
    studios: (m.studios?.nodes ?? []).map((s) => s.name),
    streamingLinks,
  };
}

export function jikanAnimeToUnified(m: JikanAnimeResult): UnifiedResult {
  return {
    source: "jikan",
    id: String(m.malId),
    mainTitle: m.mainTitle,
    nativeTitle: m.japaneseTitle,
    romajiTitle: null,
    synonyms: m.synonyms,
    description: m.synopsis,
    coverUrl: m.coverUrl,
    accentColor: 0x2e51a2,
    score: m.score,
    genres: m.genres,
    chapters: null,
    status: m.status,
    siteUrl: m.siteUrl,
    year: m.year,
    ptBrUrl: null,
    mediaType: "anime",
    episodes: m.episodes,
    animeType: m.type,
    season: m.season,
    studios: m.studios,
  };
}

export function kitsuToUnified(m: KitsuResult): UnifiedResult {
  return {
    source: "kitsu",
    id: m.kitsuId,
    mainTitle: m.mainTitle,
    nativeTitle: m.japaneseTitle,
    romajiTitle: null,
    synonyms: m.synonyms,
    description: m.synopsis,
    coverUrl: m.coverUrl,
    accentColor: 0x51b8e0,
    score: m.score,
    genres: [],
    chapters: null,
    status: m.status,
    siteUrl: m.siteUrl,
    year: m.year,
    ptBrUrl: null,
    mediaType: "anime",
    episodes: m.episodes,
    animeType: m.subtype,
    trailerUrl: m.trailerUrl,
  };
}

export function anidbEntryToUnified(m: AniDBEntry): UnifiedResult {
  return {
    source: "anidb",
    id: String(m.aid),
    mainTitle: m.englishTitle ?? m.romajiTitle ?? m.mainTitle,
    nativeTitle: null,
    romajiTitle: m.romajiTitle,
    synonyms: m.titles,
    description: null,
    coverUrl: null,
    accentColor: 0x2a6496,
    score: null,
    genres: [],
    chapters: null,
    status: null,
    siteUrl: `https://anidb.net/anime/${m.aid}`,
    year: null,
    ptBrUrl: null,
    mediaType: "anime",
  };
}

export function anidbDetailToUnified(m: AniDBAnimeDetail): UnifiedResult {
  return {
    source: "anidb",
    id: String(m.aid),
    mainTitle: m.englishTitle ?? m.romajiTitle ?? m.mainTitle,
    nativeTitle: null,
    romajiTitle: m.romajiTitle,
    synonyms: m.titles,
    description: m.description,
    coverUrl: m.coverUrl,
    accentColor: 0x2a6496,
    score: m.score,
    genres: [],
    chapters: null,
    status: m.status,
    siteUrl: `https://anidb.net/anime/${m.aid}`,
    year: m.year,
    ptBrUrl: null,
    mediaType: "anime",
    episodes: m.episodeCount,
    animeType: m.type,
  };
}

export function vndbToUnified(m: VNDBResult): UnifiedResult {
  return {
    source: "vndb",
    id: m.vnId,
    mainTitle: m.mainTitle,
    nativeTitle: m.altTitle ?? null,
    romajiTitle: null,
    synonyms: m.synonyms,
    description: m.description,
    coverUrl: m.coverUrl,
    accentColor: 0x337ab7,
    score: m.score,
    genres: m.tags.slice(0, 6),
    chapters: null,
    status: null,
    siteUrl: m.siteUrl,
    year: m.year,
    ptBrUrl: null,
    mediaType: undefined,
  };
}

export function anisearchToUnified(m: AniSearchResult): UnifiedResult {
  return {
    source: "anisearch",
    id: m.id,
    mainTitle: m.mainTitle,
    nativeTitle: m.nativeTitle ?? null,
    romajiTitle: null,
    synonyms: [],
    description: m.description ?? null,
    coverUrl: m.coverUrl ?? null,
    accentColor: 0x1a73e8,           // azul AniSearch
    score: m.score != null ? Math.round(m.score * 10) : null, // converte 8.5 → 85
    genres: m.genres,
    chapters: null,
    status: null,
    siteUrl: m.siteUrl,
    year: m.year,
    ptBrUrl: null,
    mediaType: "anime",
    episodes: m.episodes ?? null,
    animeType: m.type ?? null,
  };
}

export function erogamescapeToUnified(m: ErogamescapeResult): UnifiedResult {
  return {
    source: "erogamescape",
    id: m.gameId,
    mainTitle: m.mainTitle,
    nativeTitle: m.altTitle ?? null,
    romajiTitle: null,
    synonyms: [],
    description: null,
    coverUrl: m.coverUrl,
    accentColor: 0xc0392b,
    score: m.score,
    genres: m.tags,
    chapters: null,
    status: null,
    siteUrl: m.siteUrl,
    year: m.year,
    ptBrUrl: null,
    mediaType: undefined,
  };
}

// ─── Enrich PT-BR ────────────────────────────────────────────────────────────

async function enrichWithPtBr(result: UnifiedResult): Promise<UnifiedResult> {
  try {
    let mangadexId: string | null = null;
    if (result.source === "mangadex") {
      mangadexId = result.id;
    } else {
      mangadexId = await findMangaDexIdByTitle(result.mainTitle);
    }
    if (!mangadexId) return result;
    const hasPtBr = await hasPtBrChapters(mangadexId);
    if (!hasPtBr) return result;
    return { ...result, ptBrUrl: `https://mangadex.org/title/${mangadexId}` };
  } catch {
    return result;
  }
}

// ─── Translation ─────────────────────────────────────────────────────────────

async function translateToEnglish(query: string): Promise<string | null> {
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(query)}&langpair=auto|en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      responseStatus: number;
      responseData: { translatedText: string };
    };
    if (json.responseStatus !== 200) return null;
    const translated = json.responseData.translatedText?.trim();
    if (!translated || translated.toLowerCase() === query.toLowerCase()) return null;
    return translated;
  } catch {
    return null;
  }
}

// ─── Relevance scoring (tiered) ───────────────────────────────────────────────

/** Remove diacritics and special chars for fuzzy comparison */
function normalizeForCompare(t: string): string {
  return t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9\u0080-\uFFFF]/g, "").trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const val = a[i - 1] === b[j - 1] ? dp[j - 1] : Math.min(dp[j - 1], dp[j], prev) + 1;
      dp[j - 1] = prev;
      prev = val;
    }
    dp[b.length] = prev;
  }
  return dp[b.length];
}

function titleSimilarity(query: string, title: string): number {
  const q = normalizeForCompare(query);
  const t = normalizeForCompare(title);
  if (!q || !t) return 0;
  if (t === q) return 1.0;
  if (t.startsWith(q) || q.startsWith(t)) return 0.92;
  if (t.includes(q) || q.includes(t)) return 0.78;

  // Word overlap
  const qWords = q.split(" ").filter((w) => w.length > 1);
  const tWords = t.split(" ").filter((w) => w.length > 1);
  if (qWords.length > 0 && tWords.length > 0) {
    const tSet = new Set(tWords);
    const hits = qWords.filter((w) => tSet.has(w)).length;
    const overlap = hits / Math.max(qWords.length, tWords.length);
    if (overlap > 0) return overlap * 0.85;
  }

  // Fuzzy edit distance for short queries (≤ 20 chars)
  if (q.length <= 20 && t.length <= 30) {
    const dist = levenshtein(q, t.slice(0, q.length + 5));
    const maxLen = Math.max(q.length, Math.min(t.length, q.length + 5));
    const fuzzy = 1 - dist / maxLen;
    if (fuzzy > 0.7) return fuzzy * 0.7;
  }

  return 0;
}

/**
 * Scoring tiered:
 * - Match no mainTitle recebe +15% sobre o mesmo score num sinônimo
 * - Match no nativeTitle ou romajiTitle recebe +8%
 * - Isso garante que "título exato" > "alias exato" > "título parcial" no ranking
 */
function scoreResult(query: string, r: UnifiedResult): number {
  let best = 0;

  // mainTitle — prioridade máxima (+15%)
  const mainScore = titleSimilarity(query, r.mainTitle) * 1.15;
  if (mainScore > best) best = mainScore;

  // nativeTitle e romajiTitle — prioridade alta (+8%)
  if (r.nativeTitle) {
    const s = titleSimilarity(query, r.nativeTitle) * 1.08;
    if (s > best) best = s;
  }
  if (r.romajiTitle) {
    const s = titleSimilarity(query, r.romajiTitle) * 1.08;
    if (s > best) best = s;
  }

  // Sinônimos — prioridade padrão (sem multiplicador)
  for (const syn of r.synonyms) {
    const s = titleSimilarity(query, syn);
    if (s > best) best = s;
  }

  return best;
}

function isDuplicate(existing: UnifiedResult[], candidate: UnifiedResult): boolean {
  const candidateKey = normalizeTitle(candidate.mainTitle);
  for (const r of existing) {
    if (normalizeTitle(r.mainTitle) === candidateKey) return true;
    for (const syn of r.synonyms) {
      if (normalizeTitle(syn) === candidateKey) return true;
    }
    for (const syn of candidate.synonyms) {
      if (normalizeTitle(r.mainTitle) === normalizeTitle(syn)) return true;
    }
  }
  return false;
}

const MIN_RELEVANCE = 0.15;

/**
 * Ordena por relevância e filtra.
 * Quando há poucos resultados (< 3 após filtro), inclui todos retornados pelas APIs —
 * as próprias APIs já fazem busca por títulos alternativos internamente.
 */
function rankAndFilter(
  query: string,
  results: UnifiedResult[],
  minScore = MIN_RELEVANCE
): UnifiedResult[] {
  const withScores = results.map((r) => ({ r, score: scoreResult(query, r) }));

  const sorted = [...withScores].sort((a, b) => b.score - a.score);

  const filtered = sorted.filter(({ score }) => score >= minScore);

  // Se poucos passaram no filtro, confiar nos resultados das APIs diretamente
  if (filtered.length < 3 && sorted.length > 0) {
    return sorted.slice(0, 10).map(({ r }) => r);
  }

  return filtered.map(({ r }) => r);
}

// ─── Search tiers ─────────────────────────────────────────────────────────────

/** Tier 1 — só manhwa/manhwa coreano (mais estrito) */
async function runSearchKorean(query: string): Promise<UnifiedResult[]> {
  // Comick é a fonte principal para manga/manhwa. As demais fontes continuam
  // como complemento e fallback para ampliar a cobertura.
  const [comickRaw, anilistRaw, mangadexRaw, muRaw, jikanRaw] = await Promise.allSettled([
    fetchSource("comick-kr", query, () => searchComick(query), []),
    fetchSource("anilist-kr", query, () => searchManhwa(query), []),
    fetchSource("mangadex-kr", query, () => searchMangaDex(query), []),
    fetchSource("mangaupdates-kr", query, () => searchMangaUpdates(query, "Manhwa"), []),
    fetchSource("jikan-kr", query, () => searchJikan(query, "manhwa"), []),
  ]);
  return dedupeRaw([
    ...(comickRaw.status === "fulfilled" ? comickRaw.value.map(comickToUnified) : []),
    ...(anilistRaw.status === "fulfilled" ? anilistRaw.value.map(anilistToUnified) : []),
    ...(mangadexRaw.status === "fulfilled" ? mangadexRaw.value.map(mangadexToUnified) : []),
    ...(muRaw.status === "fulfilled" ? muRaw.value.map(mangaupdatesToUnified) : []),
    ...(jikanRaw.status === "fulfilled" ? jikanRaw.value.map(jikanToUnified) : []),
  ]);
}

/**
 * Tier 2 — sem filtro de país nem de tipo.
 * Pega manhwas mal classificados (ex: catalogados como "Manga" no MangaUpdates ou MAL)
 * e títulos de outros países que são estilo manhwa.
 */
async function runSearchAny(query: string): Promise<UnifiedResult[]> {
  const [comickRaw, anilistRaw, muRaw, jikanRaw, mangadexRaw] = await Promise.allSettled([
    fetchSource("comick-any", query, () => searchComickAny(query), []),
    fetchSource("anilist-any", query, () => searchManhwaAny(query), []),
    fetchSource("mangaupdates-any", query, () => searchMangaUpdates(query), []),
    fetchSource("jikan-any", query, () => searchJikanAny(query), []),
    fetchSource("mangadex-any", query, () => searchMangaDexAny(query), []),
  ]);
  return dedupeRaw([
    ...(comickRaw.status === "fulfilled" ? comickRaw.value.map(comickToUnified) : []),
    ...(anilistRaw.status === "fulfilled" ? anilistRaw.value.map(anilistToUnified) : []),
    ...(muRaw.status === "fulfilled" ? muRaw.value.map(mangaupdatesToUnified) : []),
    ...(jikanRaw.status === "fulfilled" ? jikanRaw.value.map(jikanToUnified) : []),
    ...(mangadexRaw.status === "fulfilled" ? mangadexRaw.value.map(mangadexToUnified) : []),
  ]);
}

function dedupeRaw(results: UnifiedResult[]): UnifiedResult[] {
  const out: UnifiedResult[] = [];
  for (const r of results) {
    if (!isDuplicate(out, r)) out.push(r);
  }
  return out;
}

/** Gera queries parciais de uma query longa para fallback */
function partialQueries(query: string): string[] {
  const words = query.trim().split(/\s+/);
  if (words.length < 3) return [];
  const variants: string[] = [];
  variants.push(words.slice(0, -1).join(" "));
  if (words.length > 3) variants.push(words.slice(0, 2).join(" "));
  return [...new Set(variants)];
}

// ─── Otimização 1: Timeout individual por fonte ────────────────────────────────

/** Tempo máximo que qualquer fonte externa pode demorar antes de ser descartada. */
// Tenrai/Jikan podem precisar de retry; não cortar a fonte em 3,5s.
const SOURCE_TIMEOUT_MS = 15000;

/**
 * Corre a promise contra um timer. Se o timer vencer, retorna `fallback` silenciosamente.
 * Isso garante que uma fonte lenta não trave toda a resposta do bot.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// ─── Otimização 3: Cache em memória por fonte ──────────────────────────────────

/**
 * Cache em memória (por processo) dos resultados brutos de cada fonte.
 * TTL de 30 min — cobre sessões de busca repetida sem re-chamar a mesma API.
 * Complementa o cache DB (24 h) que guarda o resultado final combinado.
 */
const SOURCE_CACHE_TTL_MS = 30 * 60 * 1000;
const _sourceCache = new Map<string, { data: unknown; ts: number }>();

function getSourceCache<T>(sourceKey: string, query: string): T | null {
  const key = `${sourceKey}:${query.toLowerCase().trim()}`;
  const entry = _sourceCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > SOURCE_CACHE_TTL_MS) {
    _sourceCache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setSourceCache<T>(sourceKey: string, query: string, data: T): void {
  const key = `${sourceKey}:${query.toLowerCase().trim()}`;
  _sourceCache.set(key, { data, ts: Date.now() });
  // Evitar vazamento de memória — limita o cache a 500 entradas
  if (_sourceCache.size > 500) {
    const oldest = [..._sourceCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) _sourceCache.delete(oldest[0]);
  }
}

/**
 * Wrapper que combina timeout + cache por fonte.
 * Se o cache tiver resultado recente, retorna imediatamente sem chamar a API.
 * Se não, chama a API com timeout — fonte lenta retorna `fallback` ao invés de travar.
 */
async function fetchSource<T>(
  sourceKey: string,
  query: string,
  fetcher: () => Promise<T>,
  fallback: T,
): Promise<T> {
  const cached = getSourceCache<T>(sourceKey, query);
  if (cached !== null) return cached;
  const result = await withTimeout(fetcher(), SOURCE_TIMEOUT_MS, fallback);
  setSourceCache(sourceKey, query, result);
  return result;
}

// ─── Otimização 2: Cache de queries sem resultado ──────────────────────────────

/**
 * Guarda em memória as queries que retornaram 0 resultados.
 * TTL de 2 h — evita re-chamar todas as APIs para buscas que sabidamente não acham nada.
 * Mais curto que o cache de resultado (24 h) porque uma obra pode ser adicionada às bases.
 */
const EMPTY_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const _emptyQueryCache = new Map<string, number>(); // query → timestamp

function isKnownEmpty(query: string): boolean {
  const key = query.toLowerCase().trim();
  const ts = _emptyQueryCache.get(key);
  if (!ts) return false;
  if (Date.now() - ts > EMPTY_CACHE_TTL_MS) {
    _emptyQueryCache.delete(key);
    return false;
  }
  return true;
}

function markEmptyQuery(query: string): void {
  _emptyQueryCache.set(query.toLowerCase().trim(), Date.now());
}

// ─── Cache de resultados (DB) ──────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Evita servir resultados gravados antes da troca do provedor principal.
const SEARCH_CACHE_VERSION = "comick-primary-v1";
const normalizeQuery = (q: string) =>
  `${SEARCH_CACHE_VERSION}:${q.toLowerCase().trim().slice(0, 200)}`;

async function getCachedSearch(query: string): Promise<UnifiedResult[] | null> {
  try {
    const key = normalizeQuery(query);
    const rows = await db.select().from(searchCache).where(eq(searchCache.query, key)).limit(1);
    if (!rows.length) return null;
    const age = Date.now() - new Date(rows[0].createdAt).getTime();
    if (age > CACHE_TTL_MS) {
      await db.delete(searchCache).where(eq(searchCache.query, key));
      return null;
    }
    return rows[0].results as UnifiedResult[];
  } catch {
    return null;
  }
}

async function setCachedSearch(query: string, results: UnifiedResult[]): Promise<void> {
  try {
    const key = normalizeQuery(query);
    await db
      .insert(searchCache)
      .values({ query: key, results })
      .onConflictDoUpdate({
        target: searchCache.query,
        set: { results, createdAt: new Date() },
      });
  } catch {
    // non-fatal
  }
}

// ─── Memória de aliases ───────────────────────────────────────────────────────

/**
 * Verifica se a query é um alias conhecido de algum título canônico.
 * Se sim, retorna o título canônico para usar na busca em vez da query original.
 * Exemplo: query="Drama Queen" → retorna "Circles"
 */
async function lookupAlias(query: string): Promise<string | null> {
  try {
    const normalized = query.toLowerCase().trim();
    const rows = await db
      .select({ canonicalTitle: titleAliases.canonicalTitle })
      .from(titleAliases)
      .where(sql`lower(${titleAliases.alias}) = ${normalized}`)
      .limit(1);
    return rows[0]?.canonicalTitle ?? null;
  } catch {
    return null;
  }
}

// ─── Otimização 4: Limpeza periódica de aliases duplicados ────────────────────

/**
 * Remove entradas desnecessárias da tabela `title_aliases`:
 *  1. Auto-referências: linhas onde alias == canonicalTitle (inúteis para lookup)
 *  2. Aliases ambíguos: mesmo `alias` apontando para múltiplos canônicos —
 *     mantém apenas o ID mais alto (entrada mais recente) por alias.
 *
 * Seguro para rodar em qualquer momento — não apaga dados válidos.
 * Retorna quantas linhas foram removidas.
 */
export async function cleanupDuplicateAliases(): Promise<{ removed: number }> {
  try {
    // 1. Remove auto-referências
    const selfRef = await db.execute(
      sql`DELETE FROM title_aliases WHERE lower(alias) = lower(canonical_title)`
    );

    // 2. Para cada alias duplicado (mesmo alias → vários canônicos), mantém o mais recente
    const ambiguous = await db.execute(sql`
      DELETE FROM title_aliases
      WHERE id NOT IN (
        SELECT MAX(id)
        FROM title_aliases
        GROUP BY lower(alias)
      )
    `);

    const removed = (selfRef.rowCount ?? 0) + (ambiguous.rowCount ?? 0);
    return { removed };
  } catch {
    return { removed: 0 };
  }
}

/**
 * Salva aliases de um resultado no banco de dados.
 * Chamado de forma assíncrona (fire-and-forget) após obter resultados.
 */
async function saveAliasesFromResults(results: UnifiedResult[]): Promise<void> {
  for (const r of results) {
    const canonical = r.mainTitle;
    const aliases = [...new Set([
      r.nativeTitle,
      r.romajiTitle,
      ...r.synonyms,
    ].filter((a): a is string => Boolean(a) && a !== canonical))];

    if (aliases.length === 0) continue;

    for (const alias of aliases.slice(0, 10)) {
      try {
        await db
          .insert(titleAliases)
          .values({ canonicalTitle: canonical, alias, source: r.source })
          .onConflictDoNothing();
      } catch {
        // non-fatal — unique constraint já coberta pelo onConflictDoNothing
      }
    }
  }
}

// ─── API pública ───────────────────────────────────────────────────────────────

export async function searchAllSources(query: string): Promise<UnifiedResult[]> {
  // 1a. Cache de queries sem resultado (memória — 2h)
  if (isKnownEmpty(query)) return [];

  // 1b. Cache de resultado completo (DB — 24h)
  const cached = await getCachedSearch(query);
  if (cached && cached.length > 0) return cached;

  // 2. Memória de aliases — se a query for um alias conhecido, expandir para o título canônico
  const canonicalFromAlias = await lookupAlias(query);
  const effectiveQuery = canonicalFromAlias ?? query;

  // 3. Tier 1 (KR/manhwa filter) + tradução em paralelo
  const [tier1Raw, translatedQuery] = await Promise.all([
    runSearchKorean(effectiveQuery),
    translateToEnglish(effectiveQuery),
  ]);

  let merged = rankAndFilter(effectiveQuery, tier1Raw);

  // 4. Se traduzido for diferente, busca traduzida e mescla
  if (translatedQuery && translatedQuery.toLowerCase() !== effectiveQuery.toLowerCase()) {
    const tier1Translated = await runSearchKorean(translatedQuery);
    const translatedRanked = rankAndFilter(translatedQuery, tier1Translated, 0.12);
    for (const r of translatedRanked) {
      if (!isDuplicate(merged, r)) merged.push(r);
    }
  }

  // 5. Tier 2 — sem filtro de país, quando resultados insuficientes
  if (merged.length < 3) {
    const queriesForAny = [effectiveQuery];
    if (translatedQuery && translatedQuery.toLowerCase() !== effectiveQuery.toLowerCase()) {
      queriesForAny.push(translatedQuery);
    }
    const tier2Results = await Promise.all(queriesForAny.map(runSearchAny));
    for (const batch of tier2Results) {
      const ranked = rankAndFilter(effectiveQuery, batch, 0.12);
      for (const r of ranked) {
        if (!isDuplicate(merged, r)) merged.push(r);
      }
    }
  }

  // 6. Busca parcial — se ainda poucos resultados e query tem 3+ palavras
  if (merged.length < 2) {
    const partials = partialQueries(effectiveQuery);
    if (partials.length > 0) {
      const partialResults = await Promise.all(partials.map(runSearchKorean));
      for (const batch of partialResults) {
        const ranked = rankAndFilter(effectiveQuery, batch, 0.12);
        for (const r of ranked) {
          if (!isDuplicate(merged, r)) merged.push(r);
        }
      }
    }
  }

  // 7. Exa semântico — último recurso absoluto
  if (merged.length === 0) {
    try {
      const searchTerm = translatedQuery ?? effectiveQuery;
      const exaHits = await searchExaManhwa(searchTerm);
      const anilistIds = exaHits.map((h) => h.anilistId).filter((id): id is number => id !== null);
      const mangadexIds = exaHits.map((h) => h.mangadexId).filter((id): id is string => id !== null);

      const [anilistFull, mangadexFull] = await Promise.allSettled([
        Promise.all(anilistIds.slice(0, 5).map((id) => getManhwaById(id))),
        Promise.all(mangadexIds.slice(0, 5).map((id) => getMangaDexById(id))),
      ]);

      const exaResults: UnifiedResult[] = [
        ...(anilistFull.status === "fulfilled"
          ? anilistFull.value.flatMap((m) => (m ? [anilistToUnified(m)] : []))
          : []),
        ...(mangadexFull.status === "fulfilled"
          ? mangadexFull.value.flatMap((m) => (m ? [mangadexToUnified(m)] : []))
          : []),
      ];

      for (const r of exaResults) {
        if (!isDuplicate(merged, r)) merged.push(r);
      }
    } catch {
      // Exa falhou — sem problema
    }
  }

  const final = merged.slice(0, 10);

  if (final.length > 0) {
    // Salvar resultado em cache e aliases — ambos fire-and-forget
    void setCachedSearch(query, final);
    void saveAliasesFromResults(final);
  } else {
    // Cache de "sem resultado" — evita re-chamar todas as APIs para queries sem saída
    markEmptyQuery(query);
  }

  return final;
}

export type { DescriptionSearchResult };

export async function searchByDescriptionSemantic(
  description: string
): Promise<DescriptionSearchResult[]> {
  try {
    const results = await searchByDescriptionEnhanced(description);
    return results;
  } catch {
    return [];
  }
}

// ─── Anime search ─────────────────────────────────────────────────────────────

/**
 * Detecta se um pool de resultados representa conteúdo adulto (+18) ou obra de VN obscura.
 *
 * Critérios (qualquer um é suficiente):
 *  1. Algum resultado veio de Erogamescape (base exclusivamente de eroge/adultos)
 *  2. Algum resultado tem gênero/tag explicitamente adulto
 *  3. AniList não retornou nenhum resultado E VNDB retornou algum (obra obscura fora do mainstream)
 */
function detectAdultContent(
  anilistResults: UnifiedResult[],
  vndbResults: UnifiedResult[],
  erogeResults: UnifiedResult[],
  otherResults: UnifiedResult[],
): boolean {
  // Critério 1 — Erogamescape é, por natureza, uma base adulta
  if (erogeResults.length > 0) return true;

  // Critério 2 — gêneros/tags adultos em qualquer resultado
  const adultGenreSet = new Set([
    "hentai", "adult", "eroge", "ecchi", "+18", "18+",
    "explicit", "sexual content", "nudity", "mature", "sexual violence",
    "adult only", "pornography", "adult content",
  ]);
  const allResults = [...anilistResults, ...vndbResults, ...otherResults];
  for (const r of allResults) {
    for (const genre of r.genres) {
      if (adultGenreSet.has(genre.toLowerCase())) return true;
    }
  }

  // Critério 3 — obra obscura: VNDB encontrou mas AniList não
  if (anilistResults.length === 0 && vndbResults.length > 0) return true;

  return false;
}

/**
 * Busca um anime em todas as fontes gratuitas em paralelo e desduplicação.
 *
 * Para obras comuns, a prioridade é: AniList → Jikan → Kitsu → AniSearch → AniDB → VNDB → Erogamescape
 * Para obras +18 ou obscuras (detectadas automaticamente), a prioridade vira:
 *   VNDB → Erogamescape → AniList → AniDB → Kitsu → AniSearch → Jikan
 */
export async function searchAllAnimeSources(query: string): Promise<UnifiedResult[]> {
  // Atalho: query já conhecida como sem resultado
  if (isKnownEmpty(query)) return [];

  // Todas as fontes em paralelo — com timeout individual por fonte
  const [anilistRes, jikanRes, kitsuRes, anisearchRes, vndbRes, erogeRes] = await Promise.allSettled([
    fetchSource("anilist-anime", query, () => searchAnime(query), []),
    fetchSource("jikan-anime", query, () => searchJikanAnimeAny(query), []),
    fetchSource("kitsu-anime", query, () => searchKitsu(query), []),
    fetchSource("anisearch", query, () => searchAniSearch(query), []),
    fetchSource("vndb", query, () => searchVNDB(query), []),
    fetchSource("erogamescape", query, () => searchErogamescape(query), []),
  ]);

  const anilistResults: UnifiedResult[] =
    anilistRes.status === "fulfilled" ? anilistRes.value.map(animeResultToUnified) : [];
  const jikanResults: UnifiedResult[] =
    jikanRes.status === "fulfilled" ? jikanRes.value.map(jikanAnimeToUnified) : [];
  const kitsuResults: UnifiedResult[] =
    kitsuRes.status === "fulfilled" ? kitsuRes.value.map(kitsuToUnified) : [];
  const anisearchResults: UnifiedResult[] =
    anisearchRes.status === "fulfilled" ? anisearchRes.value.map(anisearchToUnified) : [];
  const vndbResults: UnifiedResult[] =
    vndbRes.status === "fulfilled" ? vndbRes.value.map(vndbToUnified) : [];
  const erogeResults: UnifiedResult[] =
    erogeRes.status === "fulfilled" ? erogeRes.value.map(erogamescapeToUnified) : [];

  // AniDB como fallback — só busca se fontes principais retornaram pouco
  let anidbResults: UnifiedResult[] = [];
  const mainCount = anilistResults.length + jikanResults.length + kitsuResults.length;
  if (mainCount < 3) {
    anidbResults = await fetchSource("anidb", query, () =>
      searchAniDB(query).then((rs) => rs.map(anidbEntryToUnified)), []
    );
  }

  // Detectar automaticamente se o conteúdo é adulto/obscuro
  const isAdult = detectAdultContent(anilistResults, vndbResults, erogeResults, [
    ...jikanResults, ...kitsuResults, ...anisearchResults, ...anidbResults,
  ]);

  // Prioridade por fonte conforme o tipo de conteúdo
  const srcOrder: Record<string, number> = isAdult
    ? { vndb: 0, erogamescape: 1, "anilist-anime": 2, anidb: 3, kitsu: 4, anisearch: 5, jikan: 6 }
    : { "anilist-anime": 0, jikan: 1, kitsu: 2, anisearch: 3, anidb: 4, vndb: 5, erogamescape: 6 };

  // Flatten todos os resultados, ordenar por prioridade de fonte → score
  const allFlat: UnifiedResult[] = [
    ...vndbResults, ...erogeResults,
    ...anilistResults, ...jikanResults, ...kitsuResults,
    ...anisearchResults, ...anidbResults,
  ];
  allFlat.sort((a, b) => {
    const so = (srcOrder[a.source] ?? 9) - (srcOrder[b.source] ?? 9);
    if (so !== 0) return so;
    return (b.score ?? 0) - (a.score ?? 0);
  });

  // Deduplicar preservando a ordem (fonte de maior prioridade ganha)
  const raw: UnifiedResult[] = [];
  for (const r of allFlat) {
    if (!raw.some((x) => titleOverlap(x.mainTitle, r.mainTitle))) {
      raw.push(r);
    }
  }

  const final = raw.slice(0, 10);

  // Cache de "sem resultado" — evita re-chamar todas as APIs para queries sem saída
  if (final.length === 0) {
    markEmptyQuery(query);
  }

  return final;
}

function titleOverlap(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalize(a) === normalize(b);
}

/**
 * Busca animes por descrição/sinopse em linguagem natural.
 * Usa as mesmas fontes de anime adaptadas.
 */
export async function searchAnimeByDescriptionEnhanced(
  description: string
): Promise<DescriptionSearchResult[]> {
  // Extrai conceitos PT-BR → gêneros/tags AniList (novo sistema de padrões)
  const concepts = extractAnimeConcepts(description);

  // Busca principal: busca por conceitos (AniList filtros) + busca textual
  const [conceptCandidates, textCandidates] = await Promise.all([
    searchAnimeByConceptsPtBr(description),
    // Fallback textual com tradução — garante cobertura mesmo sem padrão detectado
    (async () => {
      const translated = (await translateToEnglish(description)) ?? description;
      if (translated.toLowerCase() === description.toLowerCase()) return [];
      const results = await searchAllAnimeSources(translated);
      return results.map((r) => ({
        id: r.id,
        source: r.source as "anilist-anime" | "jikan" | "kitsu",
        mainTitle: r.mainTitle,
        synonyms: r.synonyms,
        description: r.description,
        genres: r.genres,
        coverUrl: r.coverUrl,
        score: r.score,
        status: r.status,
        siteUrl: r.siteUrl,
        year: r.year,
        episodes: r.episodes ?? null,
        raw: r,
      }));
    })(),
  ]);

  // Mesclar e desduplicar
  const seen = new Map<string, typeof conceptCandidates[0]>();
  for (const c of [...conceptCandidates, ...textCandidates]) {
    const key = `${c.source}:${c.id}`;
    if (!seen.has(key)) seen.set(key, c);
  }

  // Pontuar cada candidato
  const scored: DescriptionSearchResult[] = [];
  for (const candidate of seen.values()) {
    const cs = scoreAnimeCandidate(candidate, concepts, description);

    // Converter AnimeDescriptionCandidate → DescriptionSearchResult (via UnifiedResult)
    let unified: UnifiedResult | null = null;
    if (candidate.source === "anilist-anime" && candidate.raw) {
      unified = animeResultToUnified(candidate.raw);
    } else if (candidate.source === "jikan" && candidate.raw) {
      unified = jikanAnimeToUnified(candidate.raw);
    } else if (candidate.source === "kitsu" && candidate.raw) {
      unified = kitsuToUnified(candidate.raw);
    }
    if (!unified) continue;

    scored.push({ ...unified, compatibilityScore: cs } as DescriptionSearchResult);
  }

  return scored
    .filter((r) => r.compatibilityScore > 5)
    .sort((a, b) => b.compatibilityScore - a.compatibilityScore)
    .slice(0, 8);
}

/**
 * Busca detalhes de um anime pelo ID de uma fonte específica.
 */
export async function getUnifiedAnimeById(
  source: "anilist-anime" | "jikan" | "kitsu" | "anidb" | "vndb" | "erogamescape" | "anisearch",
  id: string
): Promise<UnifiedResult | null> {
  if (source === "anilist-anime") {
    const m = await getAnimeById(parseInt(id, 10));
    return m ? animeResultToUnified(m) : null;
  } else if (source === "kitsu") {
    const m = await getKitsuById(id);
    return m ? kitsuToUnified(m) : null;
  } else if (source === "jikan") {
    const m = await getJikanAnimeById(parseInt(id, 10));
    return m ? jikanAnimeToUnified(m) : null;
  } else if (source === "anidb") {
    const detail = await getAniDBById(parseInt(id, 10));
    if (detail) return anidbDetailToUnified(detail);
    const entries = await searchAniDB(`aid:${id}`).catch((): AniDBEntry[] => []);
    const entry = entries.find((e) => e.aid === parseInt(id, 10));
    return entry ? anidbEntryToUnified(entry) : null;
  } else if (source === "vndb") {
    const m = await getVNDBById(id);
    return m ? vndbToUnified(m) : null;
  } else if (source === "erogamescape") {
    const m = await getErogamescapeDetail(id);
    return m ? erogamescapeToUnified(m) : null;
  } else if (source === "anisearch") {
    const m = await getAniSearchById(id);
    return m ? anisearchToUnified(m) : null;
  }
  return null;
}

// ─── VN search ────────────────────────────────────────────────────────────────

export type { VNDBResult };
export type { ErogamescapeResult };

/**
 * Busca visual novels em todas as fontes (VNDB + Erogamescape).
 */
export async function searchAllVNSources(query: string): Promise<VNDBResult[]> {
  return searchVNDB(query).catch(() => []);
}

/**
 * Busca uma VN por ID no VNDB.
 */
export async function getUnifiedVNById(id: string): Promise<VNDBResult | null> {
  return getVNDBById(id).catch(() => null);
}

export async function getUnifiedById(
  source: "anilist" | "mangadex" | "comick" | "mangaupdates" | "jikan" | "vndb" | "erogamescape",
  id: string
): Promise<UnifiedResult | null> {
  let result: UnifiedResult | null = null;

  if (source === "anilist") {
    const m = await getManhwaById(parseInt(id, 10));
    result = m ? anilistToUnified(m) : null;
  } else if (source === "mangadex") {
    const m = await getMangaDexById(id);
    result = m ? mangadexToUnified(m) : null;
  } else if (source === "comick") {
    const m = await getComickBySlug(id);
    result = m ? comickToUnified(m) : null;
  } else if (source === "mangaupdates") {
    const m = await getMangaUpdatesById(id);
    result = m ? mangaupdatesToUnified(m) : null;
  } else if (source === "jikan") {
    const m = await getJikanMangaById(parseInt(id, 10));
    result = m ? jikanToUnified(m) : null;
  } else if (source === "vndb") {
    const m = await getVNDBById(id);
    result = m ? vndbToUnified(m) : null;
  } else if (source === "erogamescape") {
    const m = await getErogamescapeDetail(id);
    result = m ? erogamescapeToUnified(m) : null;
  }

  if (!result) return null;
  return enrichWithPtBr(result);
}
