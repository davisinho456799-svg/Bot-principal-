import { fetchTenraiSeasonAnime, genresOfTenrai, type TenraiAnime } from "./tenrai-fallback.js";
import type { CalendarEntry } from "./calendar-data.js";

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
  const metadata = await fetchTenraiSeasonAnime();
  const identified = (item: ScheduleItem): TenraiAnime | null => {
    const malId = Number(item.external_ids?.mal ?? item.mal_id);
    if (Number.isSafeInteger(malId) && malId > 0) {
      return metadata.find((anime) => anime.mal_id === malId) ?? null;
    }
    const titles = new Set([item.title, item.title_english, ...(item.title_candidates ?? [])]
      .filter((title): title is string => typeof title === "string" && Boolean(title.trim()))
      .map(normalize));
    const matches = metadata.filter((anime) => [anime.title, anime.title_english]
      .some((title) => typeof title === "string" && titles.has(normalize(title))));
    return matches.length === 1 ? matches[0] : null;
  };
  const weeks = new Map<string, { year: number; week: number }>();
  for (let cursor = range.start; cursor <= range.end; cursor += 86_400) {
    const week = isoWeek(new Date((cursor - 3 * 3600) * 1000));
    weeks.set(`${week.year}:${week.week}`, week);
  }
  const entries: CalendarEntry[] = [];
  for (const { year, week } of weeks.values()) {
    const params = new URLSearchParams({
      type: "raw", year: String(year), week: String(week), tz: "America/Sao_Paulo",
    });
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
    for (const item of body.items) {
      if (!item || typeof item.id !== "string" || typeof item.title !== "string" ||
          !Number.isFinite(item.episode_number) || item.episode_number <= 0) continue;
      const delayed = scheduledTime(item.delayed_until);
      if ((item.is_on_break || item.airing_status === "delayed") && !delayed) continue;
      const timestamp = delayed ?? scheduledTime(item.episode_date);
      if (timestamp === null || timestamp < range.start || timestamp > range.end) continue;
      const anime = identified(item);
      if (!anime || !Number.isSafeInteger(anime.mal_id) || !anime.genres?.length) continue;
      const genres = genresOfTenrai(anime);
      if (!genres.length || genres.some((genre) => /^(hentai|erotica|adult)$/i.test(genre)) !== adult) continue;
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
  if (!entries.length) throw new Error("Agenda alternativa sem obras identificadas com segurança");
  return entries.sort((a, b) => a.timestamp! - b.timestamp!);
}
