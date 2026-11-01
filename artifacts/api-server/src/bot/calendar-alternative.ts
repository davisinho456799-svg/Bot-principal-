import { genresOfTenrai } from "./tenrai-fallback.js";
import { calendarAnimeTitles, fetchCalendarAnimeCatalog, type CalendarCatalogAnime } from "./calendar-catalog.js";
import { CalendarCache } from "./calendar-cache.js";
import type { CalendarEntry } from "./calendar-data.js";
import { isCalendarAnimeDurationAllowed } from "./calendar-anime-policy.js";

interface ScheduleItem {
  id: string;
  title: string;
  title_english?: string | null;
  title_candidates?: string[];
  mal_id?: number | null;
  external_ids?: { mal?: number | string; anilist?: number | string };
  episode_number: number;
  episode_date: string;
  delayed_until?: string;
  is_on_break?: boolean;
  airing_status?: string;
}

const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "")
  .toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

const schedules = new CalendarCache<ScheduleItem[]>(5 * 60_000, 5 * 60_000);
export function clearAlternativeCalendarCache() { schedules.clear(); }

function isoWeek(date: Date) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const year = day.getUTCFullYear();
  const week = Math.ceil(((day.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return { year, week };
}

function scheduledTime(value?: string) {
  if (!value || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const timestamp = Math.floor(Date.parse(value) / 1000);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

/** A documented public API, not AnimeSchedule's undocumented private endpoints. */
export async function fetchAlternativeCalendar(
  adult: boolean, range: { start: number; end: number },
): Promise<CalendarEntry[]> {
  const metadata = await fetchCalendarAnimeCatalog();
  const identified = (item: ScheduleItem): CalendarCatalogAnime | null => {
    const identifiers = new Set([item.external_ids?.mal, item.mal_id].map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0));
    if (identifiers.size > 1) return null;
    if (identifiers.size === 1) {
      return metadata.find((anime) => anime.mal_id === [...identifiers][0]) ?? null;
    }
    const titles = new Set([item.title, item.title_english, ...(item.title_candidates ?? [])]
      .filter((title): title is string => typeof title === "string" && Boolean(title.trim()))
      .map(normalize));
    const matches = metadata.filter((anime) => calendarAnimeTitles(anime)
      .some((title) => titles.has(normalize(title))));
    return matches.length === 1 ? matches[0] : null;
  };
  const weeks = new Map<string, { year: number; week: number }>();
  for (let cursor = range.start; cursor <= range.end; cursor += 86_400) {
    const week = isoWeek(new Date((cursor - 3 * 3600) * 1000));
    weeks.set(`${week.year}:${week.week}`, week);
  }
  const entries: CalendarEntry[] = [];
  let hasClassifiedEpisode = false;
  for (const { year, week } of weeks.values()) {
    const params = new URLSearchParams({
      type: "raw", year: String(year), week: String(week), tz: "America/Sao_Paulo",
    });
    const scheduled = await schedules.get(`${year}:${week}`, async () => {
      const response = await fetch(`https://asunatracks.space/public/api/anime-schedule?${params}`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`Asunatracks calendar HTTP ${response.status}`);
      const body = await response.json() as {
        configured?: boolean; items?: ScheduleItem[];
        filters?: { year?: number; week?: number; air_type?: string }; stale?: boolean;
      };
      if (body.configured !== true || !Array.isArray(body.items) || body.stale === true ||
          body.filters?.year !== year || body.filters.week !== week || body.filters.air_type !== "raw") {
        throw new Error("Asunatracks calendar response invalid or stale");
      }
      return body.items;
    });
    for (const item of scheduled.value) {
      if (!item || typeof item.id !== "string" || typeof item.title !== "string" ||
          !Number.isFinite(item.episode_number) || item.episode_number <= 0) continue;
      const delayed = scheduledTime(item.delayed_until);
      if ((item.is_on_break || item.airing_status === "delayed") && !delayed) continue;
      const timestamp = delayed ?? scheduledTime(item.episode_date);
      if (timestamp === null || timestamp < range.start || timestamp > range.end) continue;
      const anime = identified(item);
      if (!anime || !Number.isSafeInteger(anime.mal_id)) continue;
      const genres = genresOfTenrai(anime);
      const explicitAdultRating = /^Rx\b/i.test(anime.rating ?? "");
      if ((!anime.genres?.length || !genres.length) && !explicitAdultRating) continue;
      const isAdult = explicitAdultRating || genres.some((genre) => /^(hentai|erotica|adult)$/i.test(genre));
      if (isAdult !== adult) continue;
      hasClassifiedEpisode = true;
      if (!isCalendarAnimeDurationAllowed(anime.duration)) continue;
      const date = new Date(timestamp * 1000).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
      entries.push({
        id: item.id, source: "animeschedule", title: item.title_english || item.title,
        siteUrl: `https://animeschedule.net/anime/${encodeURIComponent(item.id)}`,
        timestamp, episode: item.episode_number,
        details: `Ep ${item.episode_number} — ${date} • ${genres.slice(0, 3).join(", ")}`,
        subscription: { source: "tenrai", id: String(anime.mal_id) },
      });
    }
  }
  if (!entries.length && !hasClassifiedEpisode) {
    throw new Error("Agenda alternativa sem obras identificadas com segurança");
  }
  return entries.sort((a, b) => a.timestamp! - b.timestamp!);
}
