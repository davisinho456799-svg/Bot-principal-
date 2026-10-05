import { CalendarCache } from "./calendar-cache.js";
import type { TenraiAnime } from "./tenrai-fallback.js";
import { logger } from "../lib/logger.js";

export interface CalendarCatalogAnime extends TenraiAnime {
  title_japanese?: string | null;
  title_synonyms?: string[];
  titles?: { title?: string }[];
  rating?: string | null;
  calendarTitles?: string[];
}

interface CatalogPage {
  items: CalendarCatalogAnime[];
  hasNextPage: boolean;
}
type CatalogScope = "season" | "airing";
const MAX_PAGES = 15;
const pages = new CalendarCache<CatalogPage>(30 * 60_000, 6 * 60 * 60_000);
let cooldownUntil = 0;
let cooldownError: Error | undefined;

export function clearCalendarCatalogCache() {
  pages.clear();
  cooldownUntil = 0;
  cooldownError = undefined;
}

export function calendarAnimeTitles(anime: CalendarCatalogAnime): string[] {
  return [...new Set([
    anime.title, anime.title_english, anime.title_japanese,
    ...(Array.isArray(anime.title_synonyms) ? anime.title_synonyms : []),
    ...(Array.isArray(anime.titles) ? anime.titles.map((title) => title?.title) : []),
    ...(anime.calendarTitles ?? []),
  ].filter((title): title is string => typeof title === "string" && Boolean(title.trim())))];
}

async function requestPage(scope: CatalogScope, page: number): Promise<CatalogPage> {
  if (Date.now() < cooldownUntil) throw cooldownError;
  const params = new URLSearchParams({ limit: "50", page: String(page) });
  if (scope === "airing") {
    params.set("status", "airing");
    params.set("order_by", "popularity");
    params.set("sort", "asc");
  }
  const endpoint = scope === "season" ? "seasons/now" : "anime";
  const response = await fetch(`https://api.tenrai.org/v1/${endpoint}?${params}`, {
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    const retry = response.headers?.get("retry-after");
    const delay = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000
      : retry ? Date.parse(retry) - Date.now() : response.status === 429 ? 60_000 : 30_000;
    const error = Object.assign(
      new Error(`Tenrai calendar catalog HTTP ${response.status} (${scope}, página ${page})`),
      { retryAfterMs: Math.min(300_000, Math.max(30_000, delay || 60_000)) },
    );
    if (response.status === 429) {
      cooldownUntil = Date.now() + error.retryAfterMs;
      cooldownError = error;
    }
    throw error;
  }
  const body = await response.json() as {
    data?: CalendarCatalogAnime[];
    pagination?: { has_next_page?: boolean; current_page?: number };
  };
  if (!Array.isArray(body.data) || typeof body.pagination?.has_next_page !== "boolean" ||
      body.pagination.current_page !== page) {
    throw new Error(`Tenrai calendar catalog pagination invalid (${scope}, página ${page})`);
  }
  return {
    items: body.data.filter((anime) => anime && Number.isSafeInteger(anime.mal_id) &&
      anime.mal_id > 0 && typeof anime.title === "string").map((anime) => ({
        ...anime, calendarTitles: undefined,
        genres: cleanGenres(anime.genres), themes: cleanGenres(anime.themes),
        rating: typeof anime.rating === "string" ? anime.rating : undefined,
      })),
    hasNextPage: body.pagination.has_next_page,
  };
}

function cleanGenres(value: unknown): { name: string }[] {
  return Array.isArray(value) ? value.flatMap((genre) =>
    genre && typeof genre.name === "string" && genre.name.trim()
      ? [{ name: genre.name.trim() }] : []) : [];
}

async function catalogScope(scope: CatalogScope): Promise<CalendarCatalogAnime[]> {
  const items: CalendarCatalogAnime[] = [];
  const month = new Date().toISOString().slice(0, 7);
  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const cached = await pages.get(`${month}:${scope}:${page}`, () => requestPage(scope, page));
      items.push(...cached.value.items);
      if (!cached.value.hasNextPage) return items;
    } catch (error) {
      logger.warn({ err: error, provider: "Tenrai", scope, page },
        "Catálogo do calendário incompleto; preservando obras já identificadas");
      if (!items.length) throw error;
      // Missing metadata reduces coverage, never changes actual episode dates.
      return items;
    }
  }
  logger.warn({ provider: "Tenrai", scope, maxPages: MAX_PAGES },
    "Catálogo do calendário atingiu o limite de páginas");
  return items;
}

/** Independent of adult filters: reuse metadata, then classify each consultation. */
export async function fetchCalendarAnimeCatalog(): Promise<CalendarCatalogAnime[]> {
  const results = await Promise.allSettled([catalogScope("season"), catalogScope("airing")]);
  const available = results.filter((result) => result.status === "fulfilled");
  if (!available.length) {
    throw new AggregateError(results.map((result) => result.status === "rejected" ? result.reason : null),
      "Catálogo de identificação do calendário indisponível");
  }
  const unique = new Map<number, CalendarCatalogAnime>();
  for (const result of available) {
    for (const anime of result.value) {
      const previous = unique.get(anime.mal_id);
      const combined = previous ? {
        ...previous, ...anime,
        genres: [...(previous.genres ?? []), ...(anime.genres ?? [])],
        themes: [...(previous.themes ?? []), ...(anime.themes ?? [])],
        rating: /^Rx\b/i.test(previous.rating ?? "") ? previous.rating : anime.rating,
      } : anime;
      unique.set(anime.mal_id, {
        ...combined, calendarTitles: [...new Set([
          ...(previous ? calendarAnimeTitles(previous) : []), ...calendarAnimeTitles(anime),
        ])],
      });
    }
  }
  return [...unique.values()];
}
