/**
 * Trace.moe — identifica cenas de anime a partir de imagens.
 * Documentação: https://soruly.github.io/trace.moe-api/
 */

const TRACEMOE_API = "https://api.trace.moe";

interface TraceMoeAnimeInfo {
  id: number;
  idMal: number | null;
  title: {
    native: string | null;
    romaji: string | null;
    english: string | null;
  };
  isAdult: boolean;
}

interface TraceMoeRawResult {
  anilist: TraceMoeAnimeInfo | number;
  filename: string;
  episode: number | string | null;
  from: number;
  to: number;
  similarity: number;
  video: string;
  image: string;
}

export interface TraceMoeResult {
  anilistId: number;
  title: string;
  titleNative: string | null;
  filename: string;
  episode: string | null;
  from: number;
  to: number;
  similarity: number;
  videoUrl: string;
  imageUrl: string;
  isAdult: boolean;
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function parseAnilist(raw: TraceMoeAnimeInfo | number): {
  id: number;
  title: string;
  titleNative: string | null;
  isAdult: boolean;
} {
  if (typeof raw === "number") {
    return { id: raw, title: "Desconhecido", titleNative: null, isAdult: false };
  }
  const title =
    raw.title.english ?? raw.title.romaji ?? raw.title.native ?? "Desconhecido";
  return {
    id: raw.id,
    title,
    titleNative: raw.title.native ?? null,
    isAdult: raw.isAdult,
  };
}

/**
 * Busca por URL de imagem pública.
 */
export async function searchByImageUrl(
  imageUrl: string
): Promise<TraceMoeResult[]> {
  const params = new URLSearchParams({ url: imageUrl, anilistInfo: "1" });
  const res = await fetch(`${TRACEMOE_API}/search?${params.toString()}`, {
    signal: AbortSignal.timeout(20000),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Trace.moe error ${res.status}: ${text}`);
  }
  const json = (await res.json()) as {
    result: TraceMoeRawResult[];
    error?: string;
  };
  if (json.error) throw new Error(json.error);

  return json.result
    .filter((r) => r.similarity >= 0.85)
    .slice(0, 3)
    .map((r): TraceMoeResult => {
      const anime = parseAnilist(r.anilist);
      return {
        anilistId: anime.id,
        title: anime.title,
        titleNative: anime.titleNative,
        filename: r.filename,
        episode: r.episode != null ? String(r.episode) : null,
        from: r.from,
        to: r.to,
        similarity: r.similarity,
        videoUrl: r.video,
        imageUrl: r.image,
        isAdult: anime.isAdult,
      };
    });
}

export { formatTimestamp };
