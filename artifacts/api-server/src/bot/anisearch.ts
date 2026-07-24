/**
 * AniSearch — principal banco de dados de anime da Europa (anisearch.com).
 * Não tem API pública documentada; usa scraping do HTML de busca e página de detalhe.
 * Encoding: UTF-8. Idioma preferido: inglês (parâmetro lang=2).
 */

const BASE = "https://www.anisearch.com";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AniSearchResult {
  id: string;
  mainTitle: string;
  nativeTitle: string | null;
  coverUrl: string | null;
  type: string | null;          // "TV Series" | "Movie" | "OVA" | "ONA" | "Special"
  year: number | null;
  score: number | null;         // 1–10 scale
  episodes: number | null;
  genres: string[];
  description: string | null;
  siteUrl: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; DiscordBot/1.0)",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ─── Autosuggest JSON (tentativa 1 — mais rápido) ─────────────────────────────

interface AutosuggestEntry {
  id?: number | string;
  title?: string;
  name?: string;
  image?: string;
  type?: string;
  year?: number | string;
  rating?: number | string;
}

async function tryAutosuggest(query: string): Promise<AniSearchResult[]> {
  const endpoints = [
    `${BASE}/ajax/autosuggest?q=${encodeURIComponent(query)}&type=anime`,
    `${BASE}/ajax/autosuggest?q=${encodeURIComponent(query)}&types=4`,
    `${BASE}/ajax/search?q=${encodeURIComponent(query)}&type=anime`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
        headers: {
          "Accept": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent": "Mozilla/5.0 (compatible; DiscordBot/1.0)",
        },
      });
      if (!res.ok) continue;

      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("json")) continue;

      const data = (await res.json()) as AutosuggestEntry[] | { results?: AutosuggestEntry[]; data?: AutosuggestEntry[] };
      const entries: AutosuggestEntry[] = Array.isArray(data)
        ? data
        : (data.results ?? data.data ?? []);

      if (!entries.length) continue;

      return entries.slice(0, 10).flatMap((e): AniSearchResult[] => {
        const rawId = String(e.id ?? "");
        if (!rawId) return [];
        const title = e.title ?? e.name ?? "";
        if (!title) return [];
        const score = e.rating ? Math.round(parseFloat(String(e.rating)) * 10) / 10 : null;
        const year  = e.year   ? parseInt(String(e.year), 10) || null : null;
        return [{
          id: rawId,
          mainTitle: title,
          nativeTitle: null,
          coverUrl: e.image ?? null,
          type: e.type ?? null,
          year,
          score,
          episodes: null,
          genres: [],
          description: null,
          siteUrl: `${BASE}/anime/${rawId}`,
        }];
      });
    } catch {
      // tenta próximo endpoint
    }
  }
  return [];
}

// ─── HTML search (tentativa 2 — scraping) ────────────────────────────────────

function parseSearchHtml(html: string): AniSearchResult[] {
  const results: AniSearchResult[] = [];
  const seen = new Set<string>();

  // Extrai blocos de resultados — cada <li> ou <div class="..."> contém um anime
  // Padrões: href="/anime/ID,slug" no link de detalhe
  const entryRe = /<(?:li|div)[^>]*>([\s\S]*?)<\/(?:li|div)>/gi;
  const linkRe  = /href="\/anime\/(\d+)[^"]*"[^>]*>([^<]+)<\/a>/;
  const imgRe   = /src="([^"]+(?:thumb|cover|poster)[^"]*\.(jpg|png|webp))"/i;
  const scoreRe = /(?:class="[^"]*rating[^"]*"[^>]*>|<span[^>]*>)\s*([\d.]+)\s*(?:<|\/)/i;
  const yearRe  = /\b(19\d{2}|20\d{2})\b/;
  const typeRe  = /\b(TV(?:\s*Series)?|Movie|OVA|ONA|Special|Film|Película)\b/i;
  const epRe    = /(\d+)\s*(?:Episodes?|Eps?\.?)\b/i;

  let block: RegExpExecArray | null;
  while ((block = entryRe.exec(html)) !== null && results.length < 15) {
    const chunk = block[1];
    if (!chunk) continue;

    const linkMatch = linkRe.exec(chunk);
    if (!linkMatch) continue;
    const [, id, rawTitle] = linkMatch;
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const title = stripHtml(rawTitle).trim();
    if (!title || title.length < 2) continue;

    const scoreM = scoreRe.exec(chunk);
    const yearM  = yearRe.exec(chunk);
    const typeM  = typeRe.exec(chunk);
    const epM    = epRe.exec(chunk);
    const imgM   = imgRe.exec(chunk);

    results.push({
      id,
      mainTitle: title,
      nativeTitle: null,
      coverUrl: imgM ? imgM[1] : null,
      type: typeM ? typeM[1] : null,
      year: yearM ? parseInt(yearM[1], 10) : null,
      score: scoreM ? parseFloat(scoreM[1]) : null,
      episodes: epM ? parseInt(epM[1], 10) : null,
      genres: [],
      description: null,
      siteUrl: `${BASE}/anime/${id}`,
    });
  }

  // Fallback: extrai links diretos se o parser de blocos não encontrou nada
  if (!results.length) {
    const directRe = /href="\/anime\/(\d+),([^"]+)"[^>]*>([^<]+)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = directRe.exec(html)) !== null && results.length < 10) {
      const [, id, slug, rawTitle] = m;
      if (!id || seen.has(id) || !rawTitle) continue;
      seen.add(id);
      const title = stripHtml(rawTitle).trim();
      if (!title || title.includes("http")) continue;
      results.push({
        id,
        mainTitle: title,
        nativeTitle: null,
        coverUrl: null,
        type: null,
        year: null,
        score: null,
        episodes: null,
        genres: [],
        description: null,
        siteUrl: `${BASE}/anime/${id},${slug}`,
      });
    }
  }

  return results;
}

// ─── Detail scraping ─────────────────────────────────────────────────────────

export async function getAniSearchById(id: string): Promise<AniSearchResult | null> {
  try {
    const html = await fetchHtml(`${BASE}/anime/${id}?lang=2`);

    // Título principal (og:title ou <h1>)
    const ogTitleM = /property="og:title"\s+content="([^"]+)"/i.exec(html);
    const h1M      = /<h1[^>]*>([^<]+)<\/h1>/i.exec(html);
    const mainTitle = ogTitleM
      ? stripHtml(ogTitleM[1])
      : h1M ? stripHtml(h1M[1]) : null;
    if (!mainTitle) return null;

    // Título nativo (japonês)
    const nativeM = /(?:Japanese|Original)\s*[Tt]itle[^:]*:\s*<[^>]+>([^<]+)/i.exec(html)
      ?? /lang="ja"[^>]*>([^<]+)</i.exec(html);
    const nativeTitle = nativeM ? stripHtml(nativeM[1]).trim() : null;

    // Cover
    const coverM = /property="og:image"\s+content="([^"]+)"/i.exec(html)
      ?? /class="[^"]*cover[^"]*"[^>]*src="([^"]+)"/i.exec(html);
    const coverUrl = coverM ? coverM[1] : null;

    // Score (rating médio em escala 10)
    const scoreM = /(?:class="[^"]*rating[^"]*"[^>]*>|itemprop="ratingValue"[^>]*>)\s*([\d.]+)/i.exec(html);
    const score  = scoreM ? parseFloat(scoreM[1]) : null;

    // Tipo (TV, Movie, etc.)
    const typeM = /\b(TV(?:\s*Series)?|Movie|OVA|ONA|Special|Film)\b/i.exec(html);
    const type  = typeM ? typeM[1] : null;

    // Ano
    const yearM = /(?:Start|Year|Premiered|aired)[^<]*(\b(?:19|20)\d{2}\b)/i.exec(html);
    const year  = yearM ? parseInt(yearM[1], 10) : null;

    // Episódios
    const epM     = /(\d+)\s*Episode/i.exec(html);
    const episodes = epM ? parseInt(epM[1], 10) : null;

    // Gêneros
    const genreSection = /(?:Genre|Gênero|Genres?)[^<]*<\/[^>]+>([\s\S]{0,600})(?:Theme|Studio|Source)/i.exec(html);
    const genres: string[] = [];
    if (genreSection) {
      const genreRe = /<a[^>]*>([^<]{2,30})<\/a>/gi;
      let gm: RegExpExecArray | null;
      while ((gm = genreRe.exec(genreSection[1])) !== null && genres.length < 8) {
        const g = stripHtml(gm[1]).trim();
        if (g) genres.push(g);
      }
    }

    // Sinopse
    const descM = /(?:itemprop="description"|class="[^"]*desc[^"]*")[^>]*>([\s\S]{10,2000}?)<\/(?:p|div)/i.exec(html)
      ?? /property="og:description"\s+content="([^"]{20,})"/i.exec(html);
    const description = descM ? stripHtml(descM[1]).slice(0, 800) : null;

    return {
      id,
      mainTitle,
      nativeTitle,
      coverUrl,
      type,
      year,
      score,
      episodes,
      genres,
      description,
      siteUrl: `${BASE}/anime/${id}`,
    };
  } catch {
    return null;
  }
}

// ─── Public search ────────────────────────────────────────────────────────────

export async function searchAniSearch(query: string): Promise<AniSearchResult[]> {
  // 1. Tenta autosuggest JSON (rápido)
  try {
    const json = await tryAutosuggest(query);
    if (json.length > 0) return json;
  } catch { /* ignora */ }

  // 2. Scraping HTML
  try {
    const url  = `${BASE}/anime/index?char=all&q=${encodeURIComponent(query)}&synq=1&lang=2`;
    const html = await fetchHtml(url);
    return parseSearchHtml(html);
  } catch {
    return [];
  }
}
