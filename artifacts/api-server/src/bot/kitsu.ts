/**
 * Kitsu API — anime e manga.
 * Completamente gratuita, sem autenticação. Boa cobertura de anime.
 * Docs: https://kitsu.docs.apiary.io/
 */

const BASE = "https://kitsu.io/api/edge";

const HEADERS = {
  "Accept": "application/vnd.api+json",
  "Content-Type": "application/vnd.api+json",
};

interface KitsuPosterImage {
  tiny?: string;
  small?: string;
  medium?: string;
  large?: string;
  original?: string;
}

interface KitsuAnimeAttrs {
  slug: string;
  synopsis: string | null;
  description: string | null;
  canonicalTitle: string;
  titles: Record<string, string | undefined>;
  abbreviatedTitles: string[] | null;
  averageRating: string | null; // "84.82"
  startDate: string | null; // "1998-04-03"
  endDate: string | null;
  subtype: string | null; // "TV" | "movie" | "OVA" | "ONA" | "special" | "music"
  status: string | null; // "current" | "finished" | "tba" | "unreleased" | "upcoming"
  posterImage: KitsuPosterImage | null;
  coverImage: KitsuPosterImage | null;
  episodeCount: number | null;
  episodeLength: number | null;
  showType: string | null;
  youtubeVideoId: string | null;
  nsfw: boolean;
}

interface KitsuAnimeItem {
  id: string;
  type: "anime";
  attributes: KitsuAnimeAttrs;
}

interface KitsuSearchResponse {
  data: KitsuAnimeItem[];
  meta: { count: number };
}

export interface KitsuResult {
  kitsuId: string;
  slug: string;
  mainTitle: string;
  englishTitle: string | null;
  japaneseTitle: string | null;
  synonyms: string[];
  synopsis: string | null;
  coverUrl: string | null;
  score: number | null; // 0–100
  status: string | null; // AniList-style: RELEASING | FINISHED | etc.
  subtype: string | null; // "TV" | "movie" | "OVA" | "ONA" | "special"
  episodes: number | null;
  episodeLength: number | null;
  year: number | null;
  siteUrl: string;
  trailerUrl: string | null;
}

function mapKitsuStatus(status: string | null): string | null {
  if (!status) return null;
  const s = status.toLowerCase();
  if (s === "current") return "RELEASING";
  if (s === "finished") return "FINISHED";
  if (s === "tba" || s === "upcoming") return "NOT_YET_RELEASED";
  if (s === "unreleased") return "NOT_YET_RELEASED";
  return null;
}

function mapKitsuSubtype(subtype: string | null): string | null {
  if (!subtype) return null;
  const s = subtype.toLowerCase();
  if (s === "tv") return "TV";
  if (s === "movie") return "Movie";
  if (s === "ova") return "OVA";
  if (s === "ona") return "ONA";
  if (s === "special") return "Special";
  if (s === "music") return "Music";
  return subtype;
}

function toKitsuResult(item: KitsuAnimeItem): KitsuResult {
  const attrs = item.attributes;

  const mainTitle = attrs.titles["en"] ?? attrs.titles["en_jp"] ?? attrs.canonicalTitle;
  const japaneseTitle = attrs.titles["ja_jp"] ?? null;
  const synonyms: string[] = [];
  const seen = new Set<string>([mainTitle.toLowerCase()]);

  for (const [, v] of Object.entries(attrs.titles)) {
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      synonyms.push(v);
    }
  }
  for (const abbr of attrs.abbreviatedTitles ?? []) {
    if (abbr && !seen.has(abbr.toLowerCase())) {
      seen.add(abbr.toLowerCase());
      synonyms.push(abbr);
    }
  }

  const ratingStr = attrs.averageRating;
  const score = ratingStr ? Math.round(parseFloat(ratingStr)) : null;

  const year = attrs.startDate ? parseInt(attrs.startDate.split("-")[0] ?? "", 10) || null : null;

  const coverUrl =
    attrs.posterImage?.large ??
    attrs.posterImage?.medium ??
    attrs.posterImage?.original ??
    null;

  const trailerUrl = attrs.youtubeVideoId
    ? `https://www.youtube.com/watch?v=${attrs.youtubeVideoId}`
    : null;

  return {
    kitsuId: item.id,
    slug: attrs.slug,
    mainTitle,
    englishTitle: attrs.titles["en"] ?? null,
    japaneseTitle,
    synonyms: synonyms.slice(0, 8),
    synopsis: attrs.synopsis ?? attrs.description ?? null,
    coverUrl,
    score,
    status: mapKitsuStatus(attrs.status),
    subtype: mapKitsuSubtype(attrs.subtype),
    episodes: attrs.episodeCount,
    episodeLength: attrs.episodeLength,
    year,
    siteUrl: `https://kitsu.io/anime/${attrs.slug}`,
    trailerUrl,
  };
}

// Rate limit simples: 250ms entre chamadas
let lastKitsuCall = 0;
async function throttle(): Promise<void> {
  const wait = 250 - (Date.now() - lastKitsuCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastKitsuCall = Date.now();
}

/**
 * Busca animes no Kitsu.
 */
export async function searchKitsu(query: string): Promise<KitsuResult[]> {
  await throttle();

  const params = new URLSearchParams({
    "filter[text]": query,
    "page[limit]": "10",
    "fields[anime]":
      "slug,synopsis,description,canonicalTitle,titles,abbreviatedTitles,averageRating,startDate,endDate,subtype,status,posterImage,episodeCount,episodeLength,showType,youtubeVideoId",
  });

  const res = await fetch(`${BASE}/anime?${params}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Kitsu API error: ${res.status}`);

  const json = (await res.json()) as KitsuSearchResponse;
  return (json.data ?? []).map(toKitsuResult);
}

/**
 * Busca um anime por ID no Kitsu.
 */
export async function getKitsuById(id: string): Promise<KitsuResult | null> {
  try {
    await throttle();
    const res = await fetch(`${BASE}/anime/${id}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data: KitsuAnimeItem };
    return toKitsuResult(json.data);
  } catch {
    return null;
  }
}
