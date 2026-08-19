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
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
};

// ─── Helpers de comparação para recuperação de 404 ───────────────────────────

/** Normaliza uma string para comparação: remove acentos, minúsculas, só alfanumérico. */
function normalizeForComparison(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Converte um slug do Comick em uma query de busca legível.
 * Ex: "solo-leveling-2" → "solo leveling 2"
 */
function slugToQuery(slug: string): string {
  return slug.replace(/[-_]+/g, " ").trim();
}

/**
 * Pontua um candidato de busca contra o termo original.
 * Retorna um valor entre 0 e 4 (quanto maior, mais confiável).
 * 0 = sem correspondência utilizável.
 */
function scoreCandidate(candidate: ComickResult, originalSlug: string): number {
  const normSlug = normalizeForComparison(originalSlug);
  if (!normSlug) return 0;

  // Slug exato (renomeação não aconteceu, obra diferente estava na URL)
  if (candidate.slug && normalizeForComparison(candidate.slug) === normSlug) return 4;

  const allTitles: string[] = [];
  if (candidate.title) allTitles.push(candidate.title);
  for (const t of candidate.md_titles ?? []) {
    if (t.title) allTitles.push(t.title);
  }

  const normTitles = allTitles.map(normalizeForComparison).filter(Boolean);
  const normQuery = normalizeForComparison(slugToQuery(originalSlug));

  // Título principal ou alternativo exato (após normalização)
  if (normTitles.some((t) => t === normQuery)) return 3;

  // Slug do candidato contém o slug original (variação com sufixo de volume/revisão)
  if (
    candidate.slug &&
    normSlug.length >= 6 &&
    normalizeForComparison(candidate.slug).includes(normSlug)
  ) return 2;

  // Algum título contém a query normalizada como substring (mínimo 6 chars)
  if (
    normQuery.length >= 6 &&
    normTitles.some((t) => t.includes(normQuery) || normQuery.includes(t))
  ) return 1;

  return 0;
}

// ─── Fetch do detalhe de uma obra pelo slug (reutilizado internamente) ────────

async function fetchComicDetail(
  identifier: string,
): Promise<ComickResult | null> {
  const res = await fetch(`${BASE}/comic/${encodeURIComponent(identifier)}`, {
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

  if (topGenres && topGenres.length > 0) comic.genres = topGenres;
  if (topCovers && topCovers.length > 0) comic.md_covers = topCovers;
  if (!comic.genres) comic.genres = [];

  return comic;
}

// ─── API pública ──────────────────────────────────────────────────────────────

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

    // Recuperação após 404: o slug pode ter mudado por renomeação da obra.
    // Tenta localizar a obra via busca e confirma o resultado pelo título/slug.
    if (res.status === 404) {
      const query = slugToQuery(slug);
      const candidates = await searchComickAny(query);

      // Pontua cada candidato e escolhe o mais provável
      let bestScore = 0;
      let bestCandidate: ComickResult | null = null;
      for (const candidate of candidates) {
        const score = scoreCandidate(candidate, slug);
        if (score > bestScore) {
          bestScore = score;
          bestCandidate = candidate;
        }
      }

      // Exige pontuação mínima de 2 para evitar falsos positivos
      if (bestScore < 2 || !bestCandidate?.slug) return null;

      // Consulta o detalhe completo usando o slug/hid atualizado
      return await fetchComicDetail(bestCandidate.hid ?? bestCandidate.slug);
    }

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
