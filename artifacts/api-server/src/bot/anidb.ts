/**
 * AniDB — título dump + HTTP API opcional.
 *
 * Busca via title dump (gratuita, sem auth).
 * Detalhes via HTTP API requerem credenciais opcionais:
 *   ANIDB_CLIENT     – nome do client registrado em https://anidb.net/software/add
 *   ANIDB_CLIENT_VER – versão do client (padrão "1")
 *
 * Sem credenciais: retorna títulos + link para AniDB. Com credenciais: retorna
 * sinopse, episódios, score, capa, etc.
 */

import { gunzipSync } from "node:zlib";

const TITLE_DUMP_URL = "https://anidb.net/api/anime-titles.xml.gz";
const HTTP_API_BASE = "http://api.anidb.net:9001/httpapi";
const CDN_BASE = "https://cdn.anidb.net/images/main/";
const DUMP_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// ─── Title dump cache ─────────────────────────────────────────────────────────

export interface AniDBEntry {
  aid: number;
  mainTitle: string;
  englishTitle: string | null;
  romajiTitle: string | null;  // x-jat
  titles: string[];
}

interface DumpCache {
  entries: AniDBEntry[];
  loadedAt: number;
}

let dumpCache: DumpCache | null = null;
let dumpFetchPromise: Promise<AniDBEntry[]> | null = null;

function parseXMLTitles(xml: string): AniDBEntry[] {
  const entries: AniDBEntry[] = [];
  // Split by <anime …>…</anime>
  const animeBlocks = xml.matchAll(/<anime aid="(\d+)">([\s\S]*?)<\/anime>/g);

  for (const block of animeBlocks) {
    const aid = parseInt(block[1] ?? "0", 10);
    if (!aid) continue;

    const body = block[2] ?? "";
    const titleTags = body.matchAll(
      /<title xml:lang="([^"]+)"\s+type="([^"]+)">([^<]+)<\/title>/g
    );

    let mainTitle: string | null = null;
    let englishTitle: string | null = null;
    let romajiTitle: string | null = null;
    const allTitles: string[] = [];

    for (const tag of titleTags) {
      const lang = tag[1] ?? "";
      const type = tag[2] ?? "";
      const title = decodeXMLEntities(tag[3] ?? "");
      if (!title) continue;

      allTitles.push(title);

      if (type === "main") mainTitle = title;
      if (lang === "en" && (type === "official" || type === "main")) englishTitle = title;
      if (lang === "x-jat" && type === "main") romajiTitle = title;
    }

    if (!mainTitle && romajiTitle) mainTitle = romajiTitle;
    if (!mainTitle && englishTitle) mainTitle = englishTitle;
    if (!mainTitle && allTitles[0]) mainTitle = allTitles[0];
    if (!mainTitle) continue;

    entries.push({
      aid,
      mainTitle,
      englishTitle,
      romajiTitle,
      titles: [...new Set(allTitles)],
    });
  }

  return entries;
}

function decodeXMLEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

async function loadTitleDump(): Promise<AniDBEntry[]> {
  if (dumpCache && Date.now() - dumpCache.loadedAt < DUMP_TTL_MS) {
    return dumpCache.entries;
  }
  if (dumpFetchPromise) return dumpFetchPromise;

  dumpFetchPromise = (async () => {
    try {
      const res = await fetch(TITLE_DUMP_URL, {
        headers: { "User-Agent": "anidb-discord-bot/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`AniDB dump error: ${res.status}`);

      const buf = Buffer.from(await res.arrayBuffer());
      const xml = gunzipSync(buf).toString("utf-8");
      const entries = parseXMLTitles(xml);

      dumpCache = { entries, loadedAt: Date.now() };
      return entries;
    } finally {
      dumpFetchPromise = null;
    }
  })();

  return dumpFetchPromise;
}

// ─── Search ───────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\u3000-\u9fff\uac00-\ud7a3]/g, " ").trim();
}

function score(entry: AniDBEntry, query: string): number {
  const q = normalize(query);
  const mainNorm = normalize(entry.mainTitle);
  if (mainNorm === q) return 100;

  let best = 0;
  for (const t of entry.titles) {
    const tn = normalize(t);
    if (tn === q) return 100;
    if (tn.startsWith(q) || q.startsWith(tn)) best = Math.max(best, 80);
    else if (tn.includes(q) || q.includes(tn)) best = Math.max(best, 60);
    else {
      // word overlap
      const qWords = new Set(q.split(/\s+/));
      const tWords = tn.split(/\s+/);
      const overlap = tWords.filter((w) => qWords.has(w)).length;
      if (qWords.size > 0) best = Math.max(best, Math.round((overlap / qWords.size) * 50));
    }
  }
  return best;
}

export async function searchAniDB(query: string): Promise<AniDBEntry[]> {
  const entries = await loadTitleDump();
  const scored = entries
    .map((e) => ({ entry: e, s: score(e, query) }))
    .filter((x) => x.s >= 40)
    .sort((a, b) => b.s - a.s);
  return scored.slice(0, 10).map((x) => x.entry);
}

// ─── HTTP API (requer credenciais) ────────────────────────────────────────────

export interface AniDBAnimeDetail {
  aid: number;
  type: string | null;
  episodeCount: number | null;
  startDate: string | null;
  endDate: string | null;
  description: string | null;
  score: number | null;
  coverUrl: string | null;
  mainTitle: string;
  englishTitle: string | null;
  romajiTitle: string | null;
  titles: string[];
  siteUrl: string;
  year: number | null;
  status: string | null;
}

let httpApiThrottle = 0;

function canUseHttpApi(): boolean {
  return !!process.env["ANIDB_CLIENT"];
}

function getAniDBApiParams(aid: number): URLSearchParams {
  const client = process.env["ANIDB_CLIENT"] ?? "";
  const ver = process.env["ANIDB_CLIENT_VER"] ?? "1";
  return new URLSearchParams({
    client,
    clientver: ver,
    protover: "1",
    request: "anime",
    aid: String(aid),
  });
}

function parseAnimeXML(xml: string, aid: number): AniDBAnimeDetail | null {
  if (xml.includes("<error>") || xml.includes("<banned/>")) return null;

  const extract = (tag: string) => xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`))?.[1]?.trim() ?? null;

  const type = extract("type");
  const episodeCount = extract("episodecount") ? parseInt(extract("episodecount")!, 10) : null;
  const startDate = extract("startdate");
  const endDate = extract("enddate");
  const description = extract("description");
  const picture = extract("picture");
  const coverUrl = picture ? `${CDN_BASE}${picture}` : null;

  const ratingMatch = xml.match(/<permanent[^>]*>([0-9.]+)<\/permanent>/);
  const rawScore = ratingMatch ? parseFloat(ratingMatch[1]!) : null;
  const scoreVal = rawScore ? Math.round(rawScore * 10) : null; // 0–100

  const year = startDate ? parseInt(startDate.slice(0, 4), 10) || null : null;

  const mapType = (t: string | null) => {
    if (!t) return null;
    if (t.includes("Movie")) return "FINISHED";
    if (t.includes("TV Series")) return year && year <= new Date().getFullYear() ? "FINISHED" : "NOT_YET_RELEASED";
    return null;
  };

  // Titles from HTTP API response
  const titleTags = xml.matchAll(/<title xml:lang="([^"]+)"\s+type="([^"]+)">([^<]+)<\/title>/g);
  let mainTitle: string | null = null;
  let englishTitle: string | null = null;
  let romajiTitle: string | null = null;
  const allTitles: string[] = [];

  for (const tag of titleTags) {
    const lang = tag[1] ?? "";
    const tt = tag[2] ?? "";
    const title = decodeXMLEntities(tag[3] ?? "");
    if (!title) continue;
    allTitles.push(title);
    if (tt === "main") mainTitle = title;
    if (lang === "en" && (tt === "official" || tt === "main")) englishTitle = title;
    if (lang === "x-jat" && tt === "main") romajiTitle = title;
  }

  if (!mainTitle) mainTitle = romajiTitle ?? englishTitle ?? allTitles[0] ?? "Unknown";

  return {
    aid,
    type,
    episodeCount: isNaN(episodeCount!) ? null : (episodeCount ?? null),
    startDate,
    endDate,
    description: description ? decodeXMLEntities(description) : null,
    score: scoreVal,
    coverUrl,
    mainTitle,
    englishTitle,
    romajiTitle,
    titles: [...new Set(allTitles)],
    siteUrl: `https://anidb.net/anime/${aid}`,
    year,
    status: mapType(type),
  };
}

export async function getAniDBById(aid: number): Promise<AniDBAnimeDetail | null> {
  if (!canUseHttpApi()) return null;

  // Throttle: AniDB allows 1 request per 2 seconds
  const wait = httpApiThrottle + 2100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  httpApiThrottle = Date.now();

  try {
    const params = getAniDBApiParams(aid);
    const res = await fetch(`${HTTP_API_BASE}?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const xml = await res.text();
    return parseAnimeXML(xml, aid);
  } catch {
    return null;
  }
}

/** Retorna true se as credenciais HTTP API estão configuradas. */
export function anidbHasCredentials(): boolean {
  return canUseHttpApi();
}
