const BASE = "https://api.comick.io";
const COVER_BASE = "https://meo.comick.pictures";

interface ComickTitle {
  title: string;
  lang: string | null;
}

interface ComickCover {
  b2key: string;
  vol: string | null;
  w: number;
  h: number;
}

interface ComickGenre {
  name: string;
}

export interface ComickResult {
  hid: string;
  slug: string;
  title: string;
  md_titles: ComickTitle[];
  status: number | null;
  rating: string | null;
  genres: ComickGenre[];
  country: string | null;
  year: number | null;
  md_covers: ComickCover[];
  last_chapter: number | null;
  desc: string | null;
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

export function comickCoverUrl(result: ComickResult): string | null {
  const cover = result.md_covers?.[0];
  if (!cover?.b2key) return null;
  return `${COVER_BASE}/${cover.b2key}`;
}

export function comickStatus(status: number | null): string | null {
  return status !== null ? (STATUS_MAP[status] ?? null) : null;
}

export function comickCountry(country: string | null): string | null {
  return country ? (COUNTRY_MAP[country] ?? null) : null;
}

const BROWSER_HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://comick.io/",
};

export async function searchComick(query: string): Promise<ComickResult[]> {
  const params = new URLSearchParams({ q: query, limit: "8", country: "ko" });
  const res = await fetch(`${BASE}/v1.0/search?${params}`, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(8000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Comick search error: ${res.status}`);
  const json = (await res.json()) as ComickResult[];
  return Array.isArray(json) ? json : [];
}

export async function searchComickAny(query: string): Promise<ComickResult[]> {
  const params = new URLSearchParams({ q: query, limit: "8" });
  const res = await fetch(`${BASE}/v1.0/search?${params}`, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(8000),
    redirect: "follow",
  });
  if (!res.ok) return [];
  const json = (await res.json()) as ComickResult[];
  return Array.isArray(json) ? json : [];
}

export async function getComickBySlug(slug: string): Promise<ComickResult | null> {
  try {
    const res = await fetch(`${BASE}/comic/${slug}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { comic?: ComickResult } | ComickResult;
    // API pode retornar { comic: {...} } ou o objeto diretamente
    const comic = (json as { comic?: ComickResult }).comic ?? (json as ComickResult);
    if (!comic?.hid) return null;
    return comic;
  } catch {
    return null;
  }
}
