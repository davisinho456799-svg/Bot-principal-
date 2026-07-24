/**
 * Erogamescape — scraping de jogos eroge/VN japoneses.
 * Site: https://erogamescape.dyndns.org
 * Encoding: EUC-JP (site japonês legado)
 * Conteúdo adulto (+18).
 */

const BASE = "https://erogamescape.dyndns.org/~ap2/ero/toukei_kaiseki";

export interface ErogamescapeResult {
  gameId: string;
  mainTitle: string;
  altTitle: string | null;
  developer: string | null;
  releaseDate: string | null;
  year: number | null;
  score: number | null;     // 0–100
  votecount: number | null;
  coverUrl: string | null;
  tags: string[];
  siteUrl: string;
}

// ─── Encoding helper ──────────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Bot/1.0)",
      "Accept": "text/html",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();

  // Erogamescape usa EUC-JP
  const encodings = ["euc-jp", "shift_jis", "utf-8"] as const;
  for (const enc of encodings) {
    try {
      const decoded = new TextDecoder(enc, { fatal: false }).decode(buf);
      const badChars = (decoded.match(/\ufffd/g) ?? []).length;
      if (badChars < 5) return decoded;
    } catch { /* tenta o próximo */ }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, "")
    .trim();
}

// ─── Calendar (recent releases) ──────────────────────────────────────────────

/**
 * Busca eroge lançados no mês/ano indicado (ou mês atual).
 * Tenta a URL de listagem mensal do Erogamescape; se falhar, usa a busca geral
 * filtrada por ano.
 */
export async function fetchErogamescapeCalendar(
  year?: number,
  month?: number,
): Promise<ErogamescapeResult[]> {
  const now = new Date();
  const y = year ?? now.getFullYear();
  const m = month ?? now.getMonth() + 1;

  // Tentativa 1 — página de lançamentos por mês
  const monthUrls = [
    `${BASE}/game_list.php?year=${y}&month=${m}&median=0&average=0`,
    `${BASE}/search_soft.php?year=${y}&month=${m}`,
    `${BASE}/new_soft.php?year=${y}&month=${m}`,
  ];

  for (const url of monthUrls) {
    try {
      const html = await fetchHtml(url);
      const results = extractGameLinksFromHtml(html);
      if (results.length > 0) {
        return await enrichTop(results);
      }
    } catch {
      // tenta próxima URL
    }
  }

  // Tentativa 2 — busca pelo ano como texto (ampla, mas melhor que nada)
  try {
    const url = `${BASE}/game_search.php?word=${y}&median=0&average=0`;
    const html = await fetchHtml(url);
    const results = extractGameLinksFromHtml(html);
    if (results.length > 0) {
      return await enrichTop(results);
    }
  } catch { /* silencioso */ }

  return [];
}

function extractGameLinksFromHtml(html: string): ErogamescapeResult[] {
  const results: ErogamescapeResult[] = [];
  const seen = new Set<string>();
  const linkRe = /href="game\.php\?game=(\d+)"[^>]*>([^<]+)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && results.length < 15) {
    const [, gameId, rawTitle] = m;
    if (!gameId || !rawTitle || seen.has(gameId)) continue;
    seen.add(gameId);
    const title = stripHtml(rawTitle).trim();
    if (!title || title.length < 2) continue;
    results.push({
      gameId,
      mainTitle: title,
      altTitle: null,
      developer: null,
      releaseDate: null,
      year: null,
      score: null,
      votecount: null,
      coverUrl: null,
      tags: [],
      siteUrl: `${BASE}/game.php?game=${gameId}`,
    });
  }
  return results;
}

async function enrichTop(results: ErogamescapeResult[]): Promise<ErogamescapeResult[]> {
  const top = results.slice(0, 5);
  const details = await Promise.allSettled(top.map((r) => getErogamescapeDetail(r.gameId)));
  details.forEach((d, i) => {
    if (d.status === "fulfilled" && d.value) results[i] = d.value;
  });
  return results.slice(0, 10);
}

// ─── Search ───────────────────────────────────────────────────────────────────

export async function searchErogamescape(query: string): Promise<ErogamescapeResult[]> {
  try {
    const url = `${BASE}/game_search.php?word=${encodeURIComponent(query)}&median=0&average=0`;
    const html = await fetchHtml(url);

    const results: ErogamescapeResult[] = [];
    const seen = new Set<string>();

    // Extrai links: href="game.php?game=ID">TITLE</a>
    const linkRe = /href="game\.php\?game=(\d+)"[^>]*>([^<]+)<\/a>/g;
    let m: RegExpExecArray | null;

    while ((m = linkRe.exec(html)) !== null && results.length < 10) {
      const [, gameId, rawTitle] = m;
      if (!gameId || !rawTitle || seen.has(gameId)) continue;
      seen.add(gameId);

      const title = stripHtml(rawTitle).trim();
      if (!title || title.length < 1) continue;

      results.push({
        gameId,
        mainTitle: title,
        altTitle: null,
        developer: null,
        releaseDate: null,
        year: null,
        score: null,
        votecount: null,
        coverUrl: null,
        tags: [],
        siteUrl: `${BASE}/game.php?game=${gameId}`,
      });
    }

    // Enriquece os top 3 com detalhes
    const top = results.slice(0, 3);
    const details = await Promise.allSettled(top.map((r) => getErogamescapeDetail(r.gameId)));
    details.forEach((d, i) => {
      if (d.status === "fulfilled" && d.value) results[i] = d.value;
    });

    return results;
  } catch {
    return [];
  }
}

// ─── Detail ───────────────────────────────────────────────────────────────────

export async function getErogamescapeDetail(gameId: string): Promise<ErogamescapeResult | null> {
  try {
    const url = `${BASE}/game.php?game=${gameId}`;
    const html = await fetchHtml(url);

    // Título — extrai do <title>
    const titleMatch = /<title>\s*([^<|／]+)/i.exec(html);
    const mainTitle = titleMatch ? stripHtml(titleMatch[1]).trim() : null;
    if (!mainTitle || mainTitle.toLowerCase().includes("erogamescape")) return null;

    // Score (中央値 = mediana)
    const scoreMatch = /中央値[\s\S]{0,300}?(\d{2,3}(?:\.\d+)?)/i.exec(html);
    const score = scoreMatch ? Math.min(100, Math.round(parseFloat(scoreMatch[1]))) : null;

    // Contagem de votos
    const voteMatch = /投票数[\s\S]{0,150}?(\d[\d,]+)/i.exec(html);
    const votecount = voteMatch ? parseInt(voteMatch[1].replace(/,/g, ""), 10) : null;

    // Desenvolvedor / Marca
    const devMatch = /ブランド[\s\S]{0,300}?<a[^>]*>([^<]+)<\/a>/i.exec(html);
    const developer = devMatch ? stripHtml(devMatch[1]).trim() : null;

    // Data de lançamento
    const dateMatch = /発売日[\s\S]{0,150}?(\d{4}[-\/年]\d{1,2}[-\/月]?\d{0,2})/i.exec(html);
    const releaseDate = dateMatch ? dateMatch[1].trim() : null;
    const year = releaseDate ? (parseInt(releaseDate.slice(0, 4), 10) || null) : null;

    // Capa
    const coverMatch =
      /src="(\/~ap2\/ero\/toukei_kaiseki\/image\/[^"]+)"/i.exec(html) ??
      /src="([^"]+\/package[^"]*\.(jpg|png|gif|webp))"/i.exec(html);
    const coverUrl = coverMatch
      ? coverMatch[1].startsWith("http")
        ? coverMatch[1]
        : `https://erogamescape.dyndns.org${coverMatch[1]}`
      : null;

    // Tags / Gêneros (分類)
    const tags: string[] = [];
    const tagSection = /分類([\s\S]{0,600}?)(?:発売日|ブランド|評価)/i.exec(html);
    if (tagSection) {
      const tagRe = /<a[^>]*>([^<]{2,30})<\/a>/gi;
      let tm: RegExpExecArray | null;
      while ((tm = tagRe.exec(tagSection[1])) !== null && tags.length < 8) {
        const tag = stripHtml(tm[1]).trim();
        if (tag && !tags.includes(tag)) tags.push(tag);
      }
    }

    return {
      gameId,
      mainTitle,
      altTitle: null,
      developer,
      releaseDate,
      year,
      score,
      votecount,
      coverUrl,
      tags,
      siteUrl: url,
    };
  } catch {
    return null;
  }
}
