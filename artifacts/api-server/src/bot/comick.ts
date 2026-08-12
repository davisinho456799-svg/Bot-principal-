const BASE = (process.env.COMICK_API_BASE ?? "https://api.comick.dev").replace(/\/+$/, "");
const COVER_BASE = "https://meo.comick.pictures";

interface ComickTitle {
  title?: string;
  lang?: string | null;
}

interface ComickCover {
  b2key?: string;
  vol?: string | null;
  w?: number;
  h?: number;
}

interface ComickGenre {
  name?: string;
}

export interface ComickResult {
  hid?: string;
  slug?: string;
  title?: string;
  md_titles?: ComickTitle[];
  status?: number | null;
  rating?: string | null;
  genres?: Array<ComickGenre | number>;
  country?: string | null;
  year?: number | null;
  md_covers?: ComickCover[];
  last_chapter?: number | null;
  desc?: string | null;
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
    "MangaAggregator/1.0 (+https://comick.dev)",
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
    const res = await fetch(`${BASE}/comic/${encodeURIComponent(slug)}`, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      comic?: ComickResult;
      genres?: ComickGenre[];
      md_covers?: ComickCover[];
    } | ComickResult;

    // API retorna { comic: {...}, genres: [...], md_covers: [...] } no endpoint de detalhes
    const comic = (json as { comic?: ComickResult }).comic ?? (json as ComickResult);
    if (!comic?.hid) return null;

    // genres e md_covers ficam na raiz da resposta de detalhes, não dentro de comic
    const topGenres = (json as { genres?: ComickGenre[] }).genres;
    const topCovers = (json as { md_covers?: ComickCover[] }).md_covers;

    if (topGenres && topGenres.length > 0) {
      comic.genres = topGenres;
    }
    if (topCovers && topCovers.length > 0) {
      comic.md_covers = topCovers;
    }
    // Garante que genres nunca seja undefined
    if (!comic.genres) comic.genres = [];

    return comic;
  } catch {
    return null;
  }
}
