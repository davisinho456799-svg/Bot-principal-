import { asNullableNumber, fetchJson, uniqueTitles } from "../http";
import type {
  MangaUpdatesGroup,
  MangaUpdatesRelease,
  MangaUpdatesSeries,
  MangaUpdatesTrackingSnapshot,
} from "../types";

const API_BASE = "https://api.mangaupdates.com/v1";

interface MangaUpdatesImage {
  url?: {
    original?: string;
    thumb?: string;
  };
}

interface MangaUpdatesGenre {
  genre?: string;
}

interface MangaUpdatesName {
  name?: string;
  url?: string | null;
}

interface MangaUpdatesGroupPayload {
  name?: string;
  group_id?: number | string | null;
  url?: string | null;
}

interface MangaUpdatesSeriesPayload {
  series_id?: number | string;
  title?: string;
  url?: string;
  description?: string | null;
  image?: MangaUpdatesImage | null;
  type?: string | null;
  year?: string | number | null;
  bayesian_rating?: number | null;
  rating?: { rating?: number | null } | null;
  genres?: MangaUpdatesGenre[];
  status?: string | null;
  latest_chapter?: number | string | null;
  last_updated?: string | null;
  associated_names?: Array<string | MangaUpdatesName> | null;
  groups?: MangaUpdatesGroupPayload[] | null;
  authors?: MangaUpdatesName[] | null;
  artists?: MangaUpdatesName[] | null;
}

interface MangaUpdatesSearchResponse {
  results?: Array<{ record?: MangaUpdatesSeriesPayload }>;
}

interface MangaUpdatesReleasePayload {
  id?: number | string;
  title?: string;
  volume?: string | number | null;
  chapter?: string | number | null;
  groups?: MangaUpdatesGroupPayload[];
  release_date?: string | null;
  time_added?: { as_rfc3339?: string | null } | null;
}

interface MangaUpdatesReleaseResponse {
  results?: Array<{ record?: MangaUpdatesReleasePayload }>;
}

const TYPE_TO_COUNTRY: Record<string, string | null> = {
  Manhwa: "KR",
  Manhua: "CN",
  Manga: "JP",
  Doujinshi: "JP",
};

function cleanDescription(description: string | null | undefined): string | null {
  if (!description) return null;
  return description
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\r\n/g, "\n")
    .trim() || null;
}

function normalizeStatus(status: string | null | undefined): string | null {
  if (!status) return null;
  const normalized = status.toLowerCase();
  if (normalized.includes("ongoing") || normalized.includes("publishing")) return "RELEASING";
  if (normalized.includes("complete")) return "FINISHED";
  if (normalized.includes("hiatus")) return "HIATUS";
  if (normalized.includes("cancel")) return "CANCELLED";
  return null;
}

function scoreOf(payload: MangaUpdatesSeriesPayload): number | null {
  const raw = payload.bayesian_rating ?? payload.rating?.rating ?? null;
  return raw == null ? null : Math.round(raw * 10);
}

function groupOf(payload: MangaUpdatesGroupPayload): MangaUpdatesGroup | null {
  const name = payload.name?.trim();
  if (!name) return null;
  return {
    id: payload.group_id == null ? null : String(payload.group_id),
    name,
    url: payload.url ?? null,
  };
}

function groupsOf(payload: MangaUpdatesGroupPayload[] | null | undefined): MangaUpdatesGroup[] {
  return (payload ?? [])
    .map(groupOf)
    .filter((group): group is MangaUpdatesGroup => group !== null);
}

function alternativeTitlesOf(payload: MangaUpdatesSeriesPayload): string[] {
  const values = [
    ...(payload.associated_names ?? []).map((name) =>
      typeof name === "string" ? name : name.name,
    ),
    ...(payload.authors ?? []).map(() => null),
  ];
  return uniqueTitles(values);
}

function toSeries(payload: MangaUpdatesSeriesPayload): MangaUpdatesSeries | null {
  if (payload.series_id == null || !payload.title || !payload.url) return null;

  const seriesId = String(payload.series_id);
  const year = asNullableNumber(payload.year);
  const latestChapter = asNullableNumber(payload.latest_chapter);

  return {
    source: "mangaupdates",
    sourceRole: "metadata-and-releases",
    id: seriesId,
    title: payload.title,
    alternativeTitles: alternativeTitlesOf(payload),
    description: cleanDescription(payload.description),
    coverUrl: payload.image?.url?.original ?? null,
    score: scoreOf(payload),
    genres: (payload.genres ?? [])
      .map((genre) => genre.genre?.trim() ?? "")
      .filter(Boolean),
    status: normalizeStatus(payload.status),
    chapters: latestChapter,
    latestChapter,
    statusText: payload.status ?? null,
    year,
    country: TYPE_TO_COUNTRY[payload.type ?? ""] ?? null,
    url: payload.url,
    groups: groupsOf(payload.groups),
    lastUpdated: payload.last_updated ?? null,
  };
}

function toRelease(payload: MangaUpdatesReleasePayload): MangaUpdatesRelease | null {
  if (payload.id == null || !payload.title || payload.chapter == null) return null;
  const id = String(payload.id);
  return {
    id,
    title: payload.title,
    volume: payload.volume == null ? null : String(payload.volume),
    chapter: String(payload.chapter),
    groups: groupsOf(payload.groups),
    releaseDate: payload.release_date ?? null,
    addedAt: payload.time_added?.as_rfc3339 ?? null,
    url: `https://www.mangaupdates.com/releases.html?title=${encodeURIComponent(payload.title)}`,
  };
}

export async function searchMangaUpdates(query: string): Promise<MangaUpdatesSeries[]> {
  const response = await fetchJson<MangaUpdatesSearchResponse>(
    `${API_BASE}/series/search`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ search: query, perpage: 10 }),
    },
  );

  return (response.results ?? [])
    .map((entry) => (entry.record ? toSeries(entry.record) : null))
    .filter((series): series is MangaUpdatesSeries => series !== null);
}

export async function getMangaUpdatesSeries(id: string): Promise<MangaUpdatesSeries | null> {
  const payload = await fetchJson<MangaUpdatesSeriesPayload>(
    `${API_BASE}/series/${encodeURIComponent(id)}`,
    { headers: { Accept: "application/json" } },
  );
  return toSeries(payload);
}

export async function searchMangaUpdatesReleases(
  query: string,
  limit = 20,
): Promise<MangaUpdatesRelease[]> {
  const response = await fetchJson<MangaUpdatesReleaseResponse>(
    `${API_BASE}/releases/search`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ search: query, perpage: Math.min(Math.max(limit, 1), 100) }),
    },
  );

  return (response.results ?? [])
    .map((entry) => (entry.record ? toRelease(entry.record) : null))
    .filter((release): release is MangaUpdatesRelease => release !== null);
}

export async function getMangaUpdatesTrackingSnapshot(
  id: string,
): Promise<MangaUpdatesTrackingSnapshot | null> {
  const series = await getMangaUpdatesSeries(id);
  if (!series) return null;

  return {
    source: "mangaupdates",
    seriesId: series.id,
    title: series.title,
    latestChapter: series.latestChapter,
    status: series.status,
    statusText: series.statusText,
    lastUpdated: series.lastUpdated,
    checkedAt: new Date().toISOString(),
    chaptersAreOfficialSource: false,
  };
}