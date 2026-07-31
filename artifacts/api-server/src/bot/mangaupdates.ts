const BASE = "https://api.mangaupdates.com/v1";

interface MUImage {
  url: { original: string; thumb: string };
}

interface MUGenre {
  genre: string;
}

// Estrutura real retornada pela API do MangaUpdates
// O campo de nota é `bayesian_rating` (float, escala 0-10), não `rating.rating`
interface MUSeriesResult {
  series_id: number;
  title: string;
  url: string;
  description: string | null;
  image: MUImage | null;
  type: string | null;
  year: string | null;
  // Endpoint de detalhe usa bayesian_rating (número direto)
  bayesian_rating: number | null;
  // Endpoint de busca pode retornar rating aninhado — suportamos os dois
  rating?: { rating: number | null } | null;
  genres: MUGenre[];
  // status pode estar ausente no endpoint de detalhe
  status: string | null;
}

interface MUSearchResponse {
  total_hits: number;
  results: { record: MUSeriesResult }[];
}

const TYPE_TO_COUNTRY: Record<string, string | null> = {
  Manhwa: "KR",
  Manhua: "CN",
  Manga: "JP",
  Doujinshi: "JP",
};

function muStatusToAnilist(status: string | null): string | null {
  if (!status) return null;
  const s = status.toLowerCase();
  if (s.includes("ongoing") || s.includes("publishing")) return "RELEASING";
  if (s.includes("complete")) return "FINISHED";
  if (s.includes("hiatus")) return "HIATUS";
  if (s.includes("cancel")) return "CANCELLED";
  return null;
}

/** Extrai a nota numérica da resposta, suportando bayesian_rating e rating.rating */
function extractScore(r: MUSeriesResult): number | null {
  const raw = r.bayesian_rating ?? r.rating?.rating ?? null;
  if (!raw) return null;
  // bayesian_rating está em escala 0-10; converte para 0-100 (padrão interno)
  return Math.round(raw * 10);
}

/** Remove tags HTML e normaliza espaços em descrições do MangaUpdates */
function cleanMUDescription(desc: string | null): string | null {
  if (!desc) return null;
  return desc
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

export interface MangaUpdatesResult {
  id: string;
  title: string;
  url: string;
  description: string | null;
  coverUrl: string | null;
  score: number | null;
  genres: string[];
  status: string | null;
  year: number | null;
  country: string | null;
}

export async function getMangaUpdatesById(id: string): Promise<MangaUpdatesResult | null> {
  try {
    const res = await fetch(`${BASE}/series/${id}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const r = (await res.json()) as MUSeriesResult;
    if (!r?.series_id) return null;
    return {
      id: String(r.series_id),
      title: r.title,
      url: r.url,
      description: cleanMUDescription(r.description),
      coverUrl: r.image?.url?.original ?? null,
      score: extractScore(r),
      genres: (r.genres ?? []).map((g) => g.genre),
      status: muStatusToAnilist(r.status),
      year: r.year ? parseInt(r.year, 10) : null,
      country: TYPE_TO_COUNTRY[r.type ?? ""] ?? null,
    };
  } catch {
    return null;
  }
}

export async function searchMangaUpdates(
  query: string,
  type?: "Manhwa" | "Manhua" | "Manga"
): Promise<MangaUpdatesResult[]> {
  const body: Record<string, unknown> = { search: query, perpage: 10 };
  if (type) body["type"] = type;

  const res = await fetch(`${BASE}/series/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`MangaUpdates error: ${res.status}`);
  const json = (await res.json()) as MUSearchResponse;

  return (json.results ?? []).map(({ record: r }) => ({
    id: String(r.series_id),
    title: r.title,
    url: r.url,
    description: cleanMUDescription(r.description),
    coverUrl: r.image?.url?.original ?? null,
    score: extractScore(r),
    genres: (r.genres ?? []).map((g) => g.genre),
    status: muStatusToAnilist(r.status),
    year: r.year ? parseInt(r.year, 10) : null,
    country: TYPE_TO_COUNTRY[r.type ?? ""] ?? null,
  }));
}
