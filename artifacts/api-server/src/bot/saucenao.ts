/**
 * SauceNAO — identifica origem de imagens (anime, manga, arte).
 * Documentação: https://saucenao.com/user.php?page=search-api
 *
 * Variável de ambiente opcional: SAUCENAO_API_KEY
 * Sem chave: 6 req/30s, 100 req/dia (plano free anônimo).
 * Com chave: limite superior conforme plano cadastrado.
 */

const SAUCENAO_API = "https://saucenao.com/search.php";

// Índices SauceNAO relevantes para anime/manga
const ANIME_INDEX_IDS = new Set([
  2,  // H-Anime (adulto — incluso para detecção)
  21, // Anime (AniDB)
  36, // AniDB (screenshots com timestamp)
  37, // Mangadex
  41, // Twitter (artes)
]);

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface SauceNAORawHeader {
  similarity: string;
  thumbnail: string;
  index_id: number;
  index_name: string;
  dupes: number;
}

interface SauceNAORawData {
  ext_urls?: string[];
  source?: string;
  part?: string;
  year?: string;
  est_time?: string;
  anidb_aid?: number;
  mal_id?: number;
  anilist_id?: number;
  // manga
  mu_id?: number;
  md_id?: string;
  // artes
  pixiv_id?: number;
  member_name?: string;
  title?: string;
  author?: string;
}

interface SauceNAORawResult {
  header: SauceNAORawHeader;
  data: SauceNAORawData;
}

interface SauceNAORawResponse {
  header: { status: number; message?: string };
  results?: SauceNAORawResult[];
}

export interface SauceNAOResult {
  /** Similaridade 0–1 */
  similarity: number;
  /** Título da obra */
  title: string;
  /** ID AniDB (se disponível) */
  anidbId: number | null;
  /** ID MyAnimeList (se disponível) */
  malId: number | null;
  /** ID AniList (se disponível) */
  anilistId: number | null;
  /** Episódio (se disponível) */
  episode: string | null;
  /** Timestamp estimado (ex: "00:05:23") */
  timestamp: string | null;
  /** Nome do índice usado (ex: "AniDB") */
  indexName: string;
  /** URLs externas retornadas pela API */
  extUrls: string[];
  /** Thumbnail da cena */
  thumbnail: string;
  /** É conteúdo adulto? */
  isAdult: boolean;
}

// ─── Cache simples com TTL ────────────────────────────────────────────────────

const cache = new Map<string, { result: SauceNAOResult[]; expires: number }>();
const CACHE_TTL = 60_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseResult(raw: SauceNAORawResult): SauceNAOResult | null {
  const sim = parseFloat(raw.header.similarity) / 100;
  if (sim < 0.5) return null;

  const d = raw.data;
  const title =
    d.source ?? d.title ?? d.member_name ?? "Desconhecido";

  return {
    similarity: sim,
    title: title.trim(),
    anidbId: d.anidb_aid ?? null,
    malId: d.mal_id ?? null,
    anilistId: d.anilist_id ?? null,
    episode: d.part ?? null,
    timestamp: d.est_time ?? null,
    indexName: raw.header.index_name,
    extUrls: d.ext_urls ?? [],
    thumbnail: raw.header.thumbnail,
    isAdult: raw.header.index_id === 2,
  };
}

async function callSauceNAO(params: URLSearchParams): Promise<SauceNAOResult[]> {
  const url = `${SAUCENAO_API}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (res.status === 429) throw new Error("SauceNAO: rate limit atingido.");
  if (!res.ok) throw new Error(`SauceNAO error ${res.status}`);

  const json = (await res.json()) as SauceNAORawResponse;
  if (json.header.status < 0) throw new Error(`SauceNAO: ${json.header.message}`);

  const results: SauceNAOResult[] = [];
  for (const raw of json.results ?? []) {
    const parsed = parseResult(raw);
    if (parsed) results.push(parsed);
  }

  // Ordena por similaridade descendente
  results.sort((a, b) => b.similarity - a.similarity);
  return results;
}

function baseParams(): URLSearchParams {
  const p = new URLSearchParams({
    output_type: "2",   // JSON
    db: "999",          // todos os bancos de dados
    numres: "6",
  });
  const key = process.env["SAUCENAO_API_KEY"];
  if (key) p.set("api_key", key);
  return p;
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Busca por URL de imagem pública.
 */
export async function searchByUrlSauceNAO(
  imageUrl: string
): Promise<SauceNAOResult[]> {
  const cached = cache.get(imageUrl);
  if (cached && cached.expires > Date.now()) return cached.result;

  const params = baseParams();
  params.set("url", imageUrl);

  const result = await callSauceNAO(params);
  cache.set(imageUrl, { result, expires: Date.now() + CACHE_TTL });
  return result;
}

/**
 * Busca via upload multipart (mais confiável para URLs do Discord com CDN).
 */
export async function searchByUploadSauceNAO(
  imageUrl: string
): Promise<SauceNAOResult[]> {
  const cacheKey = `upload:${imageUrl}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.result;

  // Baixa a imagem
  const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15_000) });
  if (!imgRes.ok) throw new Error(`Erro ao baixar imagem: ${imgRes.status}`);
  const blob = await imgRes.blob();

  const params = baseParams();
  const form = new FormData();
  // Adiciona todos os parâmetros ao form
  for (const [k, v] of params.entries()) form.append(k, v);
  form.append("file", blob, "image.jpg");

  const res = await fetch(SAUCENAO_API, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(25_000),
  });

  if (res.status === 429) throw new Error("SauceNAO: rate limit atingido.");
  if (!res.ok) throw new Error(`SauceNAO error ${res.status}`);

  const json = (await res.json()) as SauceNAORawResponse;
  if (json.header.status < 0) throw new Error(`SauceNAO: ${json.header.message}`);

  const results: SauceNAOResult[] = [];
  for (const raw of json.results ?? []) {
    const parsed = parseResult(raw);
    if (parsed) results.push(parsed);
  }
  results.sort((a, b) => b.similarity - a.similarity);

  cache.set(cacheKey, { result: results, expires: Date.now() + CACHE_TTL });
  return results;
}
