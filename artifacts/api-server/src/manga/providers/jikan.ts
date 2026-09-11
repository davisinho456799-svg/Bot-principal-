import { asNullableNumber, fetchJson, uniqueTitles } from "../http";
import type { MangaRecord } from "../types";

const API_BASE = "https://api.jikan.moe/v4";

interface JikanManga {
  mal_id?: number;
  url?: string;
  title?: string;
  titles?: Array<{ type?: string; title?: string }>;
  images?: { jpg?: { large_image_url?: string; image_url?: string } };
  synopsis?: string | null;
  score?: number | null;
  genres?: Array<{ name?: string }>;
  status?: string | null;
  chapters?: number | null;
  published?: { from?: string | null };
}

function toRecord(item: JikanManga): MangaRecord | null {
  if (item.mal_id == null || !item.title) return null;
  return {
    source: "jikan",
    id: String(item.mal_id),
    title: item.title,
    alternativeTitles: uniqueTitles(
      (item.titles ?? [])
        .filter((title) => title.title !== item.title)
        .map((title) => title.title),
    ),
    description: item.synopsis ?? null,
    coverUrl: item.images?.jpg?.large_image_url ?? item.images?.jpg?.image_url ?? null,
    score: item.score ?? null,
    genres: (item.genres ?? []).map((genre) => genre.name?.trim() ?? "").filter(Boolean),
    status: item.status?.toUpperCase() ?? null,
    chapters: item.chapters ?? null,
    year: asNullableNumber(item.published?.from?.slice(0, 4)),
    country: "JP",
    url: item.url ?? `https://myanimelist.net/manga/${item.mal_id}`,
  };
}

export async function searchJikan(query: string): Promise<MangaRecord[]> {
  const params = new URLSearchParams({ q: query, limit: "10", sfw: "true" });
  const response = await fetchJson<{ data?: JikanManga[] }>(
    `${API_BASE}/manga?${params.toString()}`,
    { headers: { Accept: "application/json" } },
    12000,
  );
  return (response.data ?? [])
    .map(toRecord)
    .filter((item): item is MangaRecord => item !== null);
}