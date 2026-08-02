/**
 * IQDB — reverse image search focado em anime/manga/arte.
 * Site: https://iqdb.org
 *
 * Não há API JSON oficial. A resposta é HTML parseado via regex.
 * Sem necessidade de chave — endpoint público gratuito.
 *
 * Fluxo:
 *   1. Envia a imagem (URL ou upload multipart) para iqdb.org
 *   2. Parseia o HTML para extrair similaridade, fonte e tags de copyright
 *   3. Se a fonte for Danbooru, consulta a API JSON pública para pegar
 *      as tags de copyright (ex: "attack_on_titan") com mais precisão
 */

const IQDB_URL = "https://iqdb.org/";
const DANBOORU_API = "https://danbooru.donmai.us/posts";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface IQDBResult {
  /** Similaridade 0–1 */
  similarity: number;
  /** Nome do site de origem (ex: "Danbooru", "Gelbooru") */
  sourceName: string;
  /** URL do post na fonte */
  sourceUrl: string;
  /** Thumbnail da imagem no IQDB */
  thumbnail: string | null;
  /**
   * Tags de copyright extraídas — identificam a obra.
   * Ex: ["attack_on_titan", "shingeki_no_kyojin"]
   * Convertidas para título de busca: "attack on titan"
   */
  copyrightTags: string[];
  /** Título sugerido para pesquisa (derivado das copyrightTags) */
  suggestedTitle: string | null;
  /** É conteúdo adulto? */
  isAdult: boolean;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const cache = new Map<string, { result: IQDBResult[]; expires: number }>();
const CACHE_TTL = 60_000;

// ─── Parser HTML ──────────────────────────────────────────────────────────────

/**
 * Converte tag de underscore para título legível.
 * "attack_on_titan" → "attack on titan"
 */
function tagToTitle(tag: string): string {
  return tag.replace(/_/g, " ").trim();
}

/**
 * Extrai tags de copyright do atributo title do <img> do IQDB.
 * Formato: "Post #123 – character: ... copyright: attack_on_titan ..."
 */
function extractCopyrightFromImgTitle(imgTitle: string): string[] {
  const match = imgTitle.match(/copyright:\s*([^–\n"]+)/i);
  if (!match) return [];
  return match[1]!
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Determina se o rating é adulto.
 * Ratings do IQDB: [safe], [questionable], [explicit]
 */
function isAdultRating(text: string): boolean {
  return /\[(explicit|questionable)\]/i.test(text);
}

/**
 * Parseia o HTML do IQDB e retorna lista de resultados.
 */
function parseIQDBHtml(html: string): IQDBResult[] {
  const results: IQDBResult[] = [];

  // Extrai cada bloco de resultado (<table> dentro de #pages)
  const tableRegex = /<table[\s\S]*?<\/table>/g;
  const tables = html.match(tableRegex) ?? [];

  for (const table of tables) {
    // Ignora tabela de upload / cabeçalho
    if (table.includes('id="query"') || table.includes("Your image")) continue;
    // Ignora "No relevant matches" 
    if (table.includes("No relevant matches") || table.includes("No matches")) continue;

    // Similaridade
    const simMatch = table.match(/(\d+)%\s*similarity/i);
    if (!simMatch) continue;
    const similarity = parseInt(simMatch[1]!, 10) / 100;
    if (similarity < 0.5) continue;

    // URL da fonte
    const hrefMatch = table.match(/href="\/\/([^"]+)"/);
    if (!hrefMatch) continue;
    const sourceUrl = `https://${hrefMatch[1]}`;
    const sourceName = new URL(sourceUrl).hostname
      .replace("www.", "")
      .split(".")[0]!;
    const sourceNameCapitalized =
      sourceName.charAt(0).toUpperCase() + sourceName.slice(1);

    // Thumbnail
    const thumbMatch = table.match(/src="(\/\/iqdb\.org\/[^"]+)"/);
    const thumbnail = thumbMatch ? `https:${thumbMatch[1]}` : null;

    // Rating (adulto?)
    const ratingMatch = table.match(/\[(safe|questionable|explicit)\]/i);
    const adult = ratingMatch ? isAdultRating(ratingMatch[0]) : false;

    // Copyright via atributo title do <img>
    const imgTitleMatch = table.match(/title="([^"]+)"/);
    const copyrightTags = imgTitleMatch
      ? extractCopyrightFromImgTitle(imgTitleMatch[1]!)
      : [];

    // Título sugerido (pega a primeira tag de copyright)
    const suggestedTitle = copyrightTags.length
      ? tagToTitle(copyrightTags[0]!)
      : null;

    results.push({
      similarity,
      sourceName: sourceNameCapitalized,
      sourceUrl,
      thumbnail,
      copyrightTags,
      suggestedTitle,
      isAdult: adult,
    });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results;
}

// ─── Enriquecimento via Danbooru API ─────────────────────────────────────────

/**
 * Se a fonte é Danbooru, busca as tags de copyright pela API JSON pública.
 * Danbooru tem API gratuita: GET /posts/ID.json
 */
async function enrichFromDanbooru(result: IQDBResult): Promise<void> {
  if (!result.sourceUrl.includes("danbooru.donmai.us")) return;

  const postIdMatch = result.sourceUrl.match(/\/posts\/(\d+)/);
  if (!postIdMatch) return;

  try {
    const res = await fetch(`${DANBOORU_API}/${postIdMatch[1]!}.json`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return;

    const post = (await res.json()) as {
      tag_string_copyright?: string;
      rating?: string;
    };

    if (post.tag_string_copyright) {
      const tags = post.tag_string_copyright.trim().split(/\s+/).filter(Boolean);
      if (tags.length) {
        result.copyrightTags = tags;
        result.suggestedTitle = tagToTitle(tags[0]!);
      }
    }

    if (post.rating === "e" || post.rating === "q") {
      result.isAdult = true;
    }
  } catch {
    // opcional — ignora se falhar
  }
}

// ─── Chamada ao IQDB ──────────────────────────────────────────────────────────

async function postAndParse(form: FormData): Promise<IQDBResult[]> {
  const res = await fetch(IQDB_URL, {
    method: "POST",
    body: form,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AnimeBot/1.0)" },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) throw new Error(`IQDB error ${res.status}`);
  const html = await res.text();
  const results = parseIQDBHtml(html);

  // Enriquece o melhor resultado via Danbooru se disponível
  if (results[0]) await enrichFromDanbooru(results[0]);

  return results;
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Busca via URL pública.
 */
export async function searchByUrlIQDB(imageUrl: string): Promise<IQDBResult[]> {
  const cached = cache.get(imageUrl);
  if (cached && cached.expires > Date.now()) return cached.result;

  const form = new FormData();
  form.append("url", imageUrl);

  const result = await postAndParse(form);
  cache.set(imageUrl, { result, expires: Date.now() + CACHE_TTL });
  return result;
}

/**
 * Busca via upload multipart (mais confiável para URLs do Discord).
 */
export async function searchByUploadIQDB(imageUrl: string): Promise<IQDBResult[]> {
  const cacheKey = `upload:${imageUrl}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.result;

  const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15_000) });
  if (!imgRes.ok) throw new Error(`Erro ao baixar imagem: ${imgRes.status}`);
  const blob = await imgRes.blob();

  const form = new FormData();
  form.append("file", blob, "image.jpg");

  const result = await postAndParse(form);
  cache.set(cacheKey, { result, expires: Date.now() + CACHE_TTL });
  return result;
}
