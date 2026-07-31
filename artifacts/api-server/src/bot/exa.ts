const BASE = "https://api.exa.ai";

interface ExaResultItem {
  id: string;
  url: string;
  title: string;
  score: number;
  publishedDate?: string;
  highlights?: string[];
  text?: string;
}

interface ExaSearchResponse {
  results: ExaResultItem[];
  autopromptString?: string;
}

export interface ExaHit {
  url: string;
  title: string;
  snippet: string | null;
  anilistId: number | null;
  mangadexId: string | null;
}

function extractAnilistId(url: string): number | null {
  const m = url.match(/anilist\.co\/manga\/(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function extractMangadexId(url: string): string | null {
  const m = url.match(/mangadex\.org\/title\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

const DIRECT_SCAN_SITES = [
  { name: "BlackoutComics", domain: "blackoutcomics.com", fallbackUrl: null, fallbackLabel: null },
  { name: "TiaManhwa", domain: "tiamanhwa.com", fallbackUrl: null, fallbackLabel: null },
  { name: "Hiper.cool", domain: "hiper.cool", fallbackUrl: null, fallbackLabel: null },
  { name: "MangaLivre", domain: "mangalivre.net", fallbackUrl: null, fallbackLabel: null },
  { name: "SeitaManga", domain: "seitamanga.com", fallbackUrl: null, fallbackLabel: null },
  { name: "SlimeRead", domain: "slimeread.com.br", fallbackUrl: null, fallbackLabel: null },
];

export interface DirectScanLink {
  name: string;
  domain: string;
  url: string;
  direct: boolean;
  fallbackLabel: string | null;
}

// ─── Rate limiter em memória ──────────────────────────────────────────────────
// Evita custos inesperados limitando chamadas por hora.

interface HourlyBucket {
  count: number;
  resetAt: number; // timestamp em ms
}

function makeBucket(): HourlyBucket {
  return { count: 0, resetAt: Date.now() + 3_600_000 };
}

const _buckets: Record<string, HourlyBucket> = {};

function checkLimit(key: string, maxPerHour: number): boolean {
  const now = Date.now();
  if (!_buckets[key] || now > _buckets[key].resetAt) {
    _buckets[key] = makeBucket();
  }
  const b = _buckets[key];
  if (b.count >= maxPerHour) return false;
  b.count++;
  return true;
}

// Limites conservadores — ajustar conforme uso real
const EXA_SEMANTIC_MAX = 8;   // searchExaManhwa: busca semântica (caro)
const EXA_LINKS_MAX = 25;     // findDirectLinks: keyword search (mais leve)
const EXA_DESCRIPTION_MAX = 6; // searchByDescription: busca semântica por sinopse

// ─── Funções públicas ─────────────────────────────────────────────────────────

export async function findDirectLinks(title: string): Promise<DirectScanLink[]> {
  const apiKey = process.env.EXA_API_KEY;

  const makeFallback = (s: (typeof DIRECT_SCAN_SITES)[number]): DirectScanLink => ({
    name: s.name,
    domain: s.domain,
    url: s.fallbackUrl ?? `https://${s.domain}/?s=${encodeURIComponent(title)}`,
    direct: false,
    fallbackLabel: s.fallbackLabel,
  });

  const fallbacks: DirectScanLink[] = DIRECT_SCAN_SITES.map(makeFallback);

  if (!apiKey) return fallbacks;
  if (!checkLimit("findDirectLinks", EXA_LINKS_MAX)) return fallbacks;

  try {
    const res = await fetch(`${BASE}/search`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: title,
        numResults: 18,
        type: "keyword",
        includeDomains: DIRECT_SCAN_SITES.map((s) => s.domain),
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return fallbacks;
    const json = (await res.json()) as ExaSearchResponse;
    const hits = json.results ?? [];

    return DIRECT_SCAN_SITES.map((site) => {
      const match = hits.find((h) => {
        try {
          return new URL(h.url).hostname.replace(/^www\./, "") === site.domain;
        } catch {
          return false;
        }
      });

      if (match) {
        return { name: site.name, domain: site.domain, url: match.url, direct: true, fallbackLabel: null };
      }
      return makeFallback(site);
    });
  } catch {
    return fallbacks;
  }
}

export async function searchExaManhwa(query: string): Promise<ExaHit[]> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) return [];
  if (!checkLimit("searchExaManhwa", EXA_SEMANTIC_MAX)) return [];

  const res = await fetch(`${BASE}/search`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: `${query} manhwa manga`,
      numResults: 6,
      type: "neural",
      useAutoprompt: true,
      includeDomains: ["anilist.co", "mangadex.org"],
      contents: {
        text: { maxCharacters: 400 },
        highlights: { numSentences: 2, highlightsPerUrl: 1 },
      },
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`Exa search error: ${res.status}`);
  const json = (await res.json()) as ExaSearchResponse;

  return (json.results ?? []).map((r) => ({
    url: r.url,
    title: r.title ?? "",
    snippet: r.highlights?.[0] ?? r.text?.slice(0, 300) ?? null,
    anilistId: extractAnilistId(r.url),
    mangadexId: extractMangadexId(r.url),
  }));
}

export async function searchByDescription(description: string): Promise<ExaHit[]> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) return [];
  if (!checkLimit("searchByDescription", EXA_DESCRIPTION_MAX)) return [];

  const res = await fetch(`${BASE}/search`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: `manhwa manhwa: ${description}`,
      numResults: 8,
      type: "neural",
      useAutoprompt: true,
      includeDomains: ["anilist.co", "mangadex.org", "myanimelist.net"],
      contents: {
        text: { maxCharacters: 500 },
        highlights: { numSentences: 2, highlightsPerUrl: 1 },
      },
    }),
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) throw new Error(`Exa description search error: ${res.status}`);
  const json = (await res.json()) as ExaSearchResponse;

  return (json.results ?? []).map((r) => ({
    url: r.url,
    title: r.title ?? "",
    snippet: r.highlights?.[0] ?? r.text?.slice(0, 300) ?? null,
    anilistId: extractAnilistId(r.url),
    mangadexId: extractMangadexId(r.url),
  }));
}
