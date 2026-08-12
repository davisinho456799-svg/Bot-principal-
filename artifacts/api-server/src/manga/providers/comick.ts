import { asNullableNumber, fetchJson, uniqueTitles } from "../http";
import type { ChapterRecord, MangaRecord } from "../types";

const API_BASE = (process.env.COMICK_API_BASE ?? "https://api.comick.dev").replace(/\/+$/, "");
const COVER_BASE = "https://meo.comick.pictures";

interface ComickTitle {
  title?: string;
  lang?: string | null;
}

interface ComickCover {
  b2key?: string;
}

interface ComickSearchItem {
  hid?: string;
  slug?: string;
  title?: string;
  md_titles?: ComickTitle[];
  status?: number | null;
  rating?: string | null;
  genres?: Array<{ name?: string } | number>;
  country?: string | null;
  year?: number | null;
  md_covers?: ComickCover[];
  last_chapter?: number | null;
  desc?: string | null;
}

interface ComickChapter {
  hid?: string;
  chap?: string | number | null;
  vol?: string | number | null;
  title?: string | null;
  lang?: string | null;
  created_at?: string | null;
  published_at?: string | null;
  publish_at?: string | null;
}

interface ComickChapterResponse {
  chapters?: ComickChapter[];
}

const STATUS_MAP: Record<number, string> = {
  1: "RELEASING",
  2: "FINISHED",
  3: "CANCELLED",
  4: "HIATUS",
};

const COUNTRY_MAP: Record<string, string> = {
  ko: "KR",
  cn: "CN",
  jp: "JP",
};

const headers = {
  Accept: "application/json",
  "User-Agent": "MangaAggregator/1.0",
};

function coverUrl(item: ComickSearchItem): string | null {
  const key = item.md_covers?.[0]?.b2key;
  return key ? `${COVER_BASE}/${key}` : null;
}

function toRecord(item: ComickSearchItem): MangaRecord | null {
  if (!item.hid || !item.slug || !item.title) return null;

  return {
    source: "comick",
    id: item.slug,
    title: item.title,
    alternativeTitles: uniqueTitles((item.md_titles ?? []).map((title) => title.title)),
    description: item.desc ?? null,
    coverUrl: coverUrl(item),
    score: asNullableNumber(item.rating),
    genres: (item.genres ?? [])
      .filter((genre): genre is { name?: string } => typeof genre === "object")
      .map((genre) => genre.name?.trim() ?? "")
      .filter(Boolean),
    status: item.status == null ? null : STATUS_MAP[item.status] ?? null,
    chapters: asNullableNumber(item.last_chapter),
    year: item.year ?? null,
    country: item.country ? COUNTRY_MAP[item.country] ?? item.country.toUpperCase() : null,
    url: `https://comick.dev/comic/${item.slug}`,
  };
}

export async function searchComick(query: string): Promise<MangaRecord[]> {
  const params = new URLSearchParams({ q: query, limit: "10" });
  const response = await fetchJson<ComickSearchItem[]>(
    `${API_BASE}/v1.0/search?${params.toString()}`,
    { headers },
  );

  return response.map(toRecord).filter((item): item is MangaRecord => item !== null);
}

export async function getComickChapters(
  identifier: string,
  options: { language?: string; limit?: number } = {},
): Promise<ChapterRecord[]> {
  const detail = await fetchJson<{ comic?: { hid?: string } }>(
    `${API_BASE}/comic/${encodeURIComponent(identifier)}`,
    { headers },
  );
  const hid = detail.comic?.hid;
  if (!hid) {
    throw new Error("Comick comic detail did not include a hid");
  }

  const params = new URLSearchParams({
    lang: options.language ?? "en",
    limit: String(Math.min(Math.max(options.limit ?? 100, 1), 300)),
    "date-order": "1",
  });
  const response = await fetchJson<ComickChapterResponse>(
    `${API_BASE}/comic/${encodeURIComponent(hid)}/chapters?${params.toString()}`,
    { headers },
  );

  return (response.chapters ?? [])
    .filter((chapter) => chapter.hid && chapter.chap != null)
    .map((chapter) => ({
      id: chapter.hid as string,
      chapter: String(chapter.chap),
      volume: chapter.vol == null ? null : String(chapter.vol),
      title: chapter.title ?? null,
      language: chapter.lang ?? options.language ?? null,
      publishedAt: chapter.publish_at ?? chapter.published_at ?? chapter.created_at ?? null,
      url: `https://comick.dev/chapter/${chapter.hid}`,
      group: null,
      source: "comick" as const,
    }));
}