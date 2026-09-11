/**
 * Adaptadores leves para a API Tenrai (compatível com os dados públicos do MAL).
 * AniList continua sendo a fonte primária; estes métodos são usados quando ele
 * está indisponível ou retorna uma resposta vazia.
 */

const TENRAI_API = "https://api.tenrai.org/v1";

export interface TenraiGenre {
  name?: string | null;
}

export interface TenraiAnime {
  mal_id: number;
  title: string;
  title_english?: string | null;
  url?: string | null;
  score?: number | null;
  episodes?: number | null;
  synopsis?: string | null;
  genres?: TenraiGenre[];
  themes?: TenraiGenre[];
  status?: string | null;
  broadcast?: {
    day?: string | null;
    time?: string | null;
    timezone?: string | null;
  } | null;
}

export interface TenraiManga {
  mal_id: number;
  title: string;
  title_english?: string | null;
  type?: string | null;
  url?: string | null;
  score?: number | null;
  chapters?: number | null;
  synopsis?: string | null;
  genres?: TenraiGenre[];
  published?: { from?: string | null } | null;
}

async function tenraiRequest<T>(path: string): Promise<T[]> {
  const response = await fetch(`${TENRAI_API}/${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Tenrai returned ${response.status}`);
  const json = (await response.json()) as { data?: T[] };
  return json.data ?? [];
}

async function tenraiRequestOne<T>(path: string): Promise<T | null> {
  const response = await fetch(`${TENRAI_API}/${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Tenrai returned ${response.status}`);
  const json = (await response.json()) as { data?: T | null };
  return json.data ?? null;
}

export async function searchTenraiAnime(query: string): Promise<TenraiAnime[]> {
  return tenraiRequest<TenraiAnime>(
    `anime?q=${encodeURIComponent(query.trim())}&limit=25&order_by=score&sort=desc`,
  );
}

export async function getTenraiAnimeById(malId: number): Promise<TenraiAnime | null> {
  return tenraiRequestOne<TenraiAnime>(`anime/${malId}`);
}

export async function fetchTenraiSeasonAnime(): Promise<TenraiAnime[]> {
  return tenraiRequest<TenraiAnime>("seasons/now?limit=25");
}

export async function fetchTenraiPublishingManga(
  type: "manga" | "manhwa",
  adult = false,
): Promise<TenraiManga[]> {
  const params = new URLSearchParams({
    type,
    status: "publishing",
    limit: "25",
    order_by: "score",
    sort: "desc",
  });
  // 49 = Erotica no catálogo do MAL/Tenrai. O filtro evita misturar conteúdo
  // adulto com o calendário comum quando o modo +18 está ativo.
  if (adult) params.set("genres", "49");
  return tenraiRequest<TenraiManga>(`manga?${params.toString()}`);
}

export function titleOfTenrai(item: { title?: string; title_english?: string | null }): string {
  return item.title_english?.trim() || item.title?.trim() || "Sem título";
}

export function genresOfTenrai(item: {
  genres?: TenraiGenre[];
  themes?: TenraiGenre[];
}): string[] {
  return [...new Set(
    [...(item.genres ?? []), ...(item.themes ?? [])]
      .map((genre) => genre.name?.trim())
      .filter((name): name is string => Boolean(name)),
  )];
}

/**
 * Converte o horário semanal informado em JST/UTC para o próximo timestamp.
 * Se a fonte não informa a grade, retorna null em vez de inventar um horário.
 */
export function nextTenraiBroadcast(
  broadcast: TenraiAnime["broadcast"],
  now = new Date(),
): number | null {
  if (!broadcast?.day || !broadcast.time) return null;
  const weekday: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };
  const dayName = broadcast.day.toLowerCase().replace(/s$/, "");
  const targetDay = weekday[dayName];
  const match = /^(\d{1,2}):(\d{2})$/.exec(broadcast.time);
  if (targetDay == null || !match) return null;

  // A API normalmente fornece JST. Para outras zonas, o deslocamento local
  // não é confiável no servidor; JST é a convenção do calendário de anime.
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const candidateJst = new Date(Date.UTC(
    jstNow.getUTCFullYear(),
    jstNow.getUTCMonth(),
    jstNow.getUTCDate() + ((targetDay - jstNow.getUTCDay() + 7) % 7),
    hour,
    minute,
  ));
  let candidate = candidateJst.getTime() - 9 * 60 * 60 * 1000;
  if (candidate <= now.getTime()) candidate += 7 * 86_400_000;
  return Math.floor(candidate / 1000);
}
