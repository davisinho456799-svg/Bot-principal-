import { fetchVNDBCalendar } from "./vndb.js";
import {
  fetchTenraiPublishingManga, fetchTenraiSeasonAnime,
  genresOfTenrai, nextTenraiBroadcast, titleOfTenrai,
} from "./tenrai-fallback.js";
import type { CalendarPeriod, CalendarTab } from "./calendar-panel.js";
import { CalendarCache } from "./calendar-cache.js";
import { fetchAlternativeCalendar } from "./calendar-alternative.js";
import { logger } from "../lib/logger.js";

export interface CalendarEntry {
  id: string;
  source: "anilist" | "anilist-anime" | "tenrai" | "vndb" | "animeschedule";
  title: string;
  siteUrl: string;
  details: string;
  timestamp?: number;
  episode?: number;
  subscription?: { source: "anilist-anime" | "tenrai"; id: string };
  cachedAt?: number;
}

interface Media {
  id: number;
  title: { romaji: string; english: string | null };
  genres: string[];
  siteUrl: string;
  updatedAt?: number;
  nextAiringEpisode?: { episode: number; airingAt: number } | null;
  isAdult?: boolean;
}
interface Airing {
  airingAt: number;
  episode: number;
  media: Media;
}

const MEDIA_FIELDS = "id title { romaji english } genres siteUrl isAdult";
const AIRING_QUERY = `query CalendarAiring($page: Int, $start: Int, $end: Int) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage }
    airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) {
      airingAt episode media { ${MEDIA_FIELDS} }
    }
  }
}`;

const entriesCache = new CalendarCache<CalendarEntry[]>();
const airingCache = new CalendarCache<Airing[]>();
let anilistCooldownUntil = 0;
let anilistCooldownError: Error | undefined;

export function clearCalendarCache() {
  entriesCache.clear();
  airingCache.clear();
  anilistCooldownUntil = 0;
  anilistCooldownError = undefined;
}

class AniListCalendarError extends Error {
  constructor(message: string, readonly page: number, readonly httpStatus: number, readonly retryAfterMs = 30_000) {
    super(message);
  }
}
const ADULT_ANIME_QUERY = `query CalendarAdultAnime($page: Int) {
  Page(page: $page, perPage: 25) {
    media(type: ANIME, status: RELEASING, isAdult: true, sort: POPULARITY_DESC) {
      ${MEDIA_FIELDS} nextAiringEpisode { episode airingAt }
    }
  }
}`;
const COMIC_QUERY = `query CalendarComic($page: Int, $country: CountryCode, $adult: Boolean) {
  Page(page: $page, perPage: 25) {
    media(type: MANGA, status: RELEASING, countryOfOrigin: $country,
      isAdult: $adult, sort: UPDATED_AT_DESC) {
      ${MEDIA_FIELDS} updatedAt
    }
  }
}`;

// Resolve relative periods when clicked, never from the panel's creation date.
// UTC-3 is the current Brasília offset and has no daylight-saving transitions.
export function calendarRange(period: CalendarPeriod, now = new Date()) {
  const local = new Date(now.getTime() - 3 * 3_600_000);
  let start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 3);
  if (period === "amanha") start += 86_400_000;
  const end = period === "mes"
    ? Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1, 3)
    : start + (period === "semana" ? 7 : 1) * 86_400_000;
  return { start: Math.floor(start / 1000), end: Math.floor(end / 1000) - 1 };
}

function formatDate(timestamp: number, withTime = false) {
  return new Date(timestamp * 1000).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : { year: "numeric" }),
  });
}

async function anilistPages<T>(
  query: string, field: "media" | "airingSchedules", variables: Record<string, unknown>,
): Promise<T[]> {
  async function request(page: number) {
    if (Date.now() < anilistCooldownUntil) throw anilistCooldownError;
    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables: { ...variables, page } }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      const retryHeader = response.headers?.get("retry-after");
      const reset = Number(response.headers?.get("x-ratelimit-reset")) * 1000;
      const retryMs = retryHeader && /^\d+(?:\.\d+)?$/.test(retryHeader)
        ? Number(retryHeader) * 1000 : retryHeader ? Date.parse(retryHeader) - Date.now() : reset - Date.now();
      const error = new AniListCalendarError(`AniList HTTP ${response.status} (página ${page})`,
        page, response.status, Math.min(300_000, Math.max(30_000, retryMs || 60_000)));
      if (response.status === 429) {
        anilistCooldownUntil = Date.now() + error.retryAfterMs;
        anilistCooldownError = error;
      }
      throw error;
    }
    const body = await response.json() as {
      data?: { Page?: Partial<Record<typeof field, T[]>> & {
        pageInfo?: { hasNextPage: boolean };
      } }; errors?: unknown[];
    };
    const rows = body.data?.Page?.[field];
    if (body.errors?.length || !Array.isArray(rows)) throw new Error("AniList calendar response invalid");
    const hasNextPage = body.data?.Page?.pageInfo?.hasNextPage;
    if (field === "airingSchedules" && typeof hasNextPage !== "boolean") {
      throw new Error("AniList calendar pagination invalid");
    }
    return { rows, hasNextPage };
  }
  if (field === "airingSchedules") {
    const entries: T[] = [];
    // Follow provider pagination instead of silently cutting off at 75
    // episodes. Never return an incomplete list if a later request fails.
    for (let page = 1; page <= 100; page++) {
      const result = await request(page);
      entries.push(...result.rows);
      if (!result.hasNextPage) return entries;
    }
    throw new Error("AniList calendar pagination exceeds safety limit");
  }
  const pages = await Promise.all([1, 2, 3].map(request));
  return pages.flatMap((page) => page.rows);
}

function mediaEntry(media: Media, tab: CalendarTab, airing?: { episode: number; airingAt: number }): CalendarEntry {
  return {
    id: String(media.id), source: tab === "anime" ? "anilist-anime" : "anilist",
    title: media.title.english || media.title.romaji || "Sem título",
    siteUrl: media.siteUrl,
    timestamp: airing?.airingAt ?? media.updatedAt,
    episode: airing?.episode,
    details: [
      airing ? `Ep ${airing.episode} — ${formatDate(airing.airingAt, true)}`
        : tab === "anime" ? "Sem episódio agendado"
          : media.updatedAt ? `Atualizado: ${formatDate(media.updatedAt)}` : "Em lançamento",
      media.genres.slice(0, 3).join(", "),
    ].filter(Boolean).join(" • "),
  };
}

const isAdultGenre = (genres: string[]) =>
  genres.some((genre) => ["hentai", "erotica", "adult"].includes(genre.toLowerCase()));

async function animeEntries(adult: boolean, period: CalendarPeriod): Promise<CalendarEntry[]> {
  const range = calendarRange(period);
  let primaryFailure: unknown;
  try {
    if (adult && period === "todos") {
      const media = await anilistPages<Media>(ADULT_ANIME_QUERY, "media", {});
      if (media.length) return media.map((item) => mediaEntry(item, "anime", item.nextAiringEpisode ?? undefined))
        .filter((item) => period === "todos" ||
          (item.timestamp !== undefined && item.timestamp >= range.start && item.timestamp <= range.end))
        .sort((a, b) => (a.timestamp ?? Infinity) - (b.timestamp ?? Infinity));
    } else {
      // AniList's greater/lesser filters are exclusive; our range is inclusive.
      const cached = await airingCache.get(`${range.start}:${range.end}`, () =>
        anilistPages<Airing>(AIRING_QUERY, "airingSchedules", {
          start: range.start - 1, end: range.end + 1,
        }));
      return cached.value.filter((item) => Boolean(item.media.isAdult) === adult)
        .map((item) => mediaEntry(item.media, "anime", item))
        .map((item) => cached.stale ? { ...item, cachedAt: cached.fetchedAt } : item)
        .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    }
  } catch (error) {
    primaryFailure = error;
    logger.warn({ err: error, provider: "AniList", period }, "Fonte do calendário indisponível");
  }
  if (period === "mes") {
    try {
      return await fetchAlternativeCalendar(adult, range);
    } catch (error) {
      logger.warn({ err: error, provider: "AnimeSchedule/Asunatracks", period }, "Fonte alternativa do calendário indisponível");
      throw new Error("A agenda mensal de episódios está indisponível nas duas fontes", { cause: primaryFailure });
    }
  }
  const fallback = await fetchTenraiSeasonAnime();
  return fallback.flatMap((item): CalendarEntry[] => {
    const genres = genresOfTenrai(item);
    if (isAdultGenre(genres) !== adult) return [];
    const timestamp = nextTenraiBroadcast(item.broadcast);
    if ((!adult || period !== "todos") &&
      (!timestamp || timestamp < range.start || timestamp > range.end)) return [];
    return [{
      id: String(item.mal_id), source: "tenrai", title: titleOfTenrai(item),
      siteUrl: item.url ?? `https://myanimelist.net/anime/${item.mal_id}`,
      timestamp: timestamp ?? undefined,
      details: `${timestamp ? `Próxima exibição: ${formatDate(timestamp, true)}` : "Sem episódio agendado"} • ${genres.join(", ")}`,
    }];
  }).sort((a, b) => (a.timestamp ?? Infinity) - (b.timestamp ?? Infinity));
}

async function comicEntries(tab: "manga" | "manhwa", adult: boolean): Promise<CalendarEntry[]> {
  try {
    const media = await anilistPages<Media>(COMIC_QUERY, "media", {
      country: tab === "manhwa" ? "KR" : "JP", adult,
    });
    if (media.length) return media.map((item) => mediaEntry(item, tab));
  } catch {
    // Preserve Tenrai fallback and its correct provider IDs for subscriptions.
  }
  const fallback = await fetchTenraiPublishingManga(tab, adult);
  return fallback.filter((item) => isAdultGenre(genresOfTenrai(item)) === adult).map((item) => ({
    id: String(item.mal_id), source: "tenrai", title: titleOfTenrai(item),
    siteUrl: item.url ?? `https://myanimelist.net/manga/${item.mal_id}`,
    details: `Em lançamento • ${genresOfTenrai(item).join(", ")}`,
  }));
}

async function fetchCalendarEntries(adult: boolean, tab: CalendarTab, period: CalendarPeriod): Promise<CalendarEntry[]> {
  let entries: CalendarEntry[];
  if (tab === "anime") entries = await animeEntries(adult, period);
  else if (tab === "vn") {
    const vns = await fetchVNDBCalendar(adult, 2, 1);
    entries = vns.map((vn) => ({
      id: vn.vnId, source: "vndb", title: vn.mainTitle, siteUrl: vn.siteUrl,
      details: `Lançamento: ${vn.released ?? "Data desconhecida"} • ${vn.developers[0] ?? "Desenvolvedor desconhecido"}`,
    }));
  } else entries = await comicEntries(tab, adult);
  const seen = new Set<string>();
  return entries.filter((item) => {
    const key = `${item.source}:${item.id}:${item.timestamp ?? ""}:${item.episode ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function loadCalendarEntries(adult: boolean, tab: CalendarTab, period: CalendarPeriod): Promise<CalendarEntry[]> {
  const range = calendarRange(period);
  const cached = await entriesCache.get(`${adult}:${tab}:${period}:${range.start}:${range.end}`,
    () => fetchCalendarEntries(adult, tab, period));
  return cached.stale
    ? cached.value.map((entry) => ({ ...entry, cachedAt: entry.cachedAt ?? cached.fetchedAt }))
    : cached.value;
}
