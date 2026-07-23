/**
 * Motor de identificação de imagens com fallback inteligente.
 *
 * Pipeline:
 *   1. Trace.moe   — screenshot de anime com timestamp (confiança ≥ 90%)
 *   2. SauceNAO    — identificação genérica de origem de imagem
 *   3. OCR + APIs  — extrai texto e pesquisa em AniList, MAL, Kitsu, AniDB, TMDB
 *   Fallback final: retorna melhor resultado do Trace.moe mesmo com baixa confiança
 */

import { searchByImageUpload, searchByImageUrl, formatTimestamp } from "./tracemoe.js";
import { searchByUploadSauceNAO, searchByUrlSauceNAO } from "./saucenao.js";
import { extractTextFromUpload, extractTextFromUrl } from "./ocr.js";
import { searchAnime, cleanDescription, translateToPtBr } from "./anilist.js";
import { searchJikanAnimeAny } from "./jikan.js";
import { searchKitsu } from "./kitsu.js";
import { searchAniDB } from "./anidb.js";
import { searchAnimeMovieTMDB } from "./tmdb.js";

// ─── Constantes ───────────────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = 0.90;
const OCR_SCORE_THRESHOLD  = 0.30;
const CACHE_TTL             = 60_000;

// ─── Cache ────────────────────────────────────────────────────────────────────

const cache = new Map<string, { result: IdentificationResult | null; expires: number }>();

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export type IdentificationMethod = "tracemoe" | "saucenao" | "ocr";

export interface IdentificationResult {
  method: IdentificationMethod;
  /** 0–1. Similaridade (Trace.moe / SauceNAO) ou pontuação de sobreposição (OCR). */
  confidence: number;
  /** Confiança suficiente para exibição direta, sem aviso de incerteza. */
  isHighConfidence: boolean;
  title: string;
  titleNative: string | null;
  titleRomaji: string | null;
  synopsis: string | null;
  mediaType: string | null;
  episode: string | null;
  timestampFrom: number | null;
  timestampTo: number | null;
  previewImageUrl: string | null;
  previewVideoUrl: string | null;
  anilistId: number | null;
  malId: number | null;
  anidbId: number | null;
  links: Array<{ label: string; url: string }>;
  isAdult: boolean;
  /** Texto extraído via OCR (exibido apenas quando method = "ocr"). */
  ocrText: string | null;
}

// ─── Scoring para OCR ─────────────────────────────────────────────────────────

function wordOverlapScore(query: string, target: string): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1);

  const qWords = norm(query);
  const tWords = new Set(norm(target));
  if (!qWords.length || !tWords.size) return 0;

  const overlap = qWords.filter((w) => tWords.has(w)).length;
  return overlap / Math.max(qWords.length, tWords.size);
}

function bestScore(ocrText: string, titles: (string | null | undefined)[]): number {
  return Math.max(0, ...titles.filter(Boolean).map((t) => wordOverlapScore(ocrText, t!)));
}

// ─── Helpers de link ──────────────────────────────────────────────────────────

function dedupLinks(links: Array<{ label: string; url: string }>) {
  const seen = new Set<string>();
  return links.filter(({ url }) => (seen.has(url) ? false : (seen.add(url), true)));
}

// ─── Etapa 1: Trace.moe (alta confiança) ─────────────────────────────────────

async function tryTraceMoe(
  imageUrl: string,
  isAttachment: boolean
): Promise<IdentificationResult | null> {
  try {
    const results = isAttachment
      ? await searchByImageUpload(imageUrl)
      : await searchByImageUrl(imageUrl);

    if (!results.length) return null;
    const top = results[0]!;
    if (top.similarity < CONFIDENCE_THRESHOLD) return null;

    const links: Array<{ label: string; url: string }> = [
      { label: "AniList", url: `https://anilist.co/anime/${top.anilistId}` },
    ];

    // Enriquece com sinopse e link MAL via AniList
    let synopsis: string | null = null;
    let mediaType: string | null = null;
    let malId: number | null = null;
    try {
      const { getAnimeById } = await import("./anilist.js");
      const detail = await getAnimeById(top.anilistId);
      if (detail) {
        const rawDesc = cleanDescription(detail.description ?? null);
        synopsis = rawDesc ? await translateToPtBr(rawDesc).catch(() => null) : null;
        mediaType = detail.type ?? null;
        const malLink = detail.externalLinks?.find((l) => l.site === "MyAnimeList");
        if (malLink) {
          links.push({ label: "MyAnimeList", url: malLink.url });
          const m = malLink.url.match(/anime\/(\d+)/);
          if (m) malId = parseInt(m[1]!, 10);
        }
      }
    } catch {
      // sinopse é opcional
    }

    return {
      method: "tracemoe",
      confidence: top.similarity,
      isHighConfidence: true,
      title: top.title,
      titleNative: top.titleNative,
      titleRomaji: null,
      synopsis,
      mediaType,
      episode: top.episode,
      timestampFrom: top.from,
      timestampTo: top.to,
      previewImageUrl: top.imageUrl,
      previewVideoUrl: top.videoUrl,
      anilistId: top.anilistId,
      malId,
      anidbId: null,
      links: dedupLinks(links),
      isAdult: top.isAdult,
      ocrText: null,
    };
  } catch (err) {
    console.error("[Engine] Trace.moe (alta) falhou:", err);
    return null;
  }
}

// ─── Etapa 1b: Trace.moe (baixa confiança — fallback final) ──────────────────

async function tryTraceMoeLowConfidence(
  imageUrl: string,
  isAttachment: boolean
): Promise<IdentificationResult | null> {
  try {
    const results = isAttachment
      ? await searchByImageUpload(imageUrl)
      : await searchByImageUrl(imageUrl);

    if (!results.length) return null;
    const top = results[0]!;

    return {
      method: "tracemoe",
      confidence: top.similarity,
      isHighConfidence: false,
      title: top.title,
      titleNative: top.titleNative,
      titleRomaji: null,
      synopsis: null,
      mediaType: null,
      episode: top.episode,
      timestampFrom: top.from,
      timestampTo: top.to,
      previewImageUrl: top.imageUrl,
      previewVideoUrl: top.videoUrl,
      anilistId: top.anilistId,
      malId: null,
      anidbId: null,
      links: [{ label: "AniList", url: `https://anilist.co/anime/${top.anilistId}` }],
      isAdult: top.isAdult,
      ocrText: null,
    };
  } catch {
    return null;
  }
}

// ─── Etapa 2: SauceNAO ───────────────────────────────────────────────────────

async function trySauceNAO(
  imageUrl: string,
  isAttachment: boolean
): Promise<IdentificationResult | null> {
  try {
    const results = isAttachment
      ? await searchByUploadSauceNAO(imageUrl)
      : await searchByUrlSauceNAO(imageUrl);

    if (!results.length) return null;
    const top = results[0]!;
    if (top.similarity < CONFIDENCE_THRESHOLD) return null;

    const links: Array<{ label: string; url: string }> = top.extUrls.map((url) => ({
      label: new URL(url).hostname.replace("www.", ""),
      url,
    }));
    if (top.anilistId)
      links.push({ label: "AniList", url: `https://anilist.co/anime/${top.anilistId}` });
    if (top.malId)
      links.push({ label: "MyAnimeList", url: `https://myanimelist.net/anime/${top.malId}` });
    if (top.anidbId)
      links.push({ label: "AniDB", url: `https://anidb.net/anime/${top.anidbId}` });

    return {
      method: "saucenao",
      confidence: top.similarity,
      isHighConfidence: true,
      title: top.title,
      titleNative: null,
      titleRomaji: null,
      synopsis: null,
      mediaType: null,
      episode: top.episode,
      timestampFrom: null,
      timestampTo: null,
      previewImageUrl: top.thumbnail,
      previewVideoUrl: null,
      anilistId: top.anilistId,
      malId: top.malId,
      anidbId: top.anidbId,
      links: dedupLinks(links),
      isAdult: top.isAdult,
      ocrText: null,
    };
  } catch (err) {
    console.error("[Engine] SauceNAO falhou:", err);
    return null;
  }
}

// ─── Etapa 3: OCR + multi-API ─────────────────────────────────────────────────

interface OCRCandidate {
  score: number;
  title: string;
  titleNative: string | null;
  titleRomaji: string | null;
  synopsis: string | null;
  mediaType: string | null;
  anilistId: number | null;
  malId: number | null;
  anidbId: number | null;
  links: Array<{ label: string; url: string }>;
  isAdult: boolean;
}

async function tryOCRSearch(
  imageUrl: string,
  isAttachment: boolean
): Promise<IdentificationResult | null> {
  // Extrai e limpa o texto
  const ocrText = isAttachment
    ? await extractTextFromUpload(imageUrl)
    : await extractTextFromUrl(imageUrl);

  if (!ocrText || ocrText.trim().length < 3) return null;

  // Busca em paralelo em todos os serviços
  const [anilistRes, jikanRes, kitsuRes, anidbRes, tmdbRes] =
    await Promise.allSettled([
      searchAnime(ocrText).catch(() => []),
      searchJikanAnimeAny(ocrText).catch(() => []),
      searchKitsu(ocrText).catch(() => []),
      searchAniDB(ocrText).catch(() => []),
      searchAnimeMovieTMDB(ocrText).catch(() => []),
    ]);

  const candidates: OCRCandidate[] = [];

  // ── AniList ────────────────────────────────────────────────────────────────
  if (anilistRes.status === "fulfilled") {
    for (const m of anilistRes.value.slice(0, 5)) {
      const score = bestScore(ocrText, [
        m.title.english,
        m.title.romaji,
        m.title.native,
        ...m.synonyms,
      ]);
      if (score < OCR_SCORE_THRESHOLD) continue;

      const rawDesc = cleanDescription(m.description ?? null);
      const synopsis = rawDesc
        ? await translateToPtBr(rawDesc).catch(() => null)
        : null;

      const links: Array<{ label: string; url: string }> = [
        { label: "AniList", url: m.siteUrl },
      ];
      const malLink = m.externalLinks?.find((l) => l.site === "MyAnimeList");
      if (malLink) links.push({ label: "MyAnimeList", url: malLink.url });

      candidates.push({
        score,
        title: m.title.english ?? m.title.romaji ?? m.title.native ?? "?",
        titleNative: m.title.native ?? null,
        titleRomaji: m.title.romaji ?? null,
        synopsis,
        mediaType: m.type ?? null,
        anilistId: m.id,
        malId: null,
        anidbId: null,
        links,
        isAdult: false,
      });
    }
  }

  // ── Jikan / MAL ────────────────────────────────────────────────────────────
  if (jikanRes.status === "fulfilled") {
    for (const m of jikanRes.value.slice(0, 5)) {
      const score = bestScore(ocrText, [
        m.mainTitle,
        m.englishTitle,
        m.japaneseTitle,
        ...m.synonyms,
      ]);
      if (score < OCR_SCORE_THRESHOLD) continue;

      const synopsis = m.synopsis
        ? await translateToPtBr(m.synopsis).catch(() => m.synopsis)
        : null;

      candidates.push({
        score,
        title: m.englishTitle ?? m.mainTitle ?? "?",
        titleNative: m.japaneseTitle ?? null,
        titleRomaji: m.mainTitle ?? null,
        synopsis,
        mediaType: m.type ?? null,
        anilistId: null,
        malId: m.malId,
        anidbId: null,
        links: [{ label: "MyAnimeList", url: m.siteUrl }],
        isAdult: false,
      });
    }
  }

  // ── Kitsu ──────────────────────────────────────────────────────────────────
  if (kitsuRes.status === "fulfilled") {
    for (const m of kitsuRes.value.slice(0, 5)) {
      const score = bestScore(ocrText, [
        m.mainTitle,
        m.englishTitle,
        m.japaneseTitle,
        ...m.synonyms,
      ]);
      if (score < OCR_SCORE_THRESHOLD) continue;

      const synopsis = m.synopsis
        ? await translateToPtBr(m.synopsis).catch(() => m.synopsis)
        : null;

      candidates.push({
        score,
        title: m.englishTitle ?? m.mainTitle ?? "?",
        titleNative: m.japaneseTitle ?? null,
        titleRomaji: m.mainTitle ?? null,
        synopsis,
        mediaType: m.subtype ?? null,
        anilistId: null,
        malId: null,
        anidbId: null,
        links: [{ label: "Kitsu", url: m.siteUrl }],
        isAdult: false,
      });
    }
  }

  // ── AniDB ──────────────────────────────────────────────────────────────────
  if (anidbRes.status === "fulfilled") {
    for (const m of anidbRes.value.slice(0, 5)) {
      const score = bestScore(ocrText, [
        m.mainTitle,
        m.englishTitle,
        m.romajiTitle,
        ...m.titles,
      ]);
      if (score < OCR_SCORE_THRESHOLD) continue;

      candidates.push({
        score,
        title: m.englishTitle ?? m.mainTitle ?? "?",
        titleNative: null,
        titleRomaji: m.romajiTitle ?? m.mainTitle ?? null,
        synopsis: null,
        mediaType: null,
        anilistId: null,
        malId: null,
        anidbId: m.aid,
        links: [{ label: "AniDB", url: `https://anidb.net/anime/${m.aid}` }],
        isAdult: false,
      });
    }
  }

  // ── TMDB ───────────────────────────────────────────────────────────────────
  if (tmdbRes.status === "fulfilled") {
    for (const m of tmdbRes.value.slice(0, 5)) {
      const score = bestScore(ocrText, [m.title, m.originalTitle]);
      if (score < OCR_SCORE_THRESHOLD) continue;

      const synopsis = m.overview
        ? await translateToPtBr(m.overview).catch(() => m.overview)
        : null;

      candidates.push({
        score,
        title: m.title ?? "?",
        titleNative: m.originalTitle !== m.title ? m.originalTitle : null,
        titleRomaji: null,
        synopsis,
        mediaType: "Movie",
        anilistId: null,
        malId: null,
        anidbId: null,
        links: [{ label: "TMDB", url: m.tmdbUrl }, ...(m.imdbUrl ? [{ label: "IMDb", url: m.imdbUrl }] : [])],
        isAdult: false,
      });
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0]!;

  return {
    method: "ocr",
    confidence: best.score,
    isHighConfidence: best.score >= 0.6,
    title: best.title,
    titleNative: best.titleNative,
    titleRomaji: best.titleRomaji,
    synopsis: best.synopsis,
    mediaType: best.mediaType,
    episode: null,
    timestampFrom: null,
    timestampTo: null,
    previewImageUrl: null,
    previewVideoUrl: null,
    anilistId: best.anilistId,
    malId: best.malId,
    anidbId: best.anidbId,
    links: dedupLinks(best.links),
    isAdult: best.isAdult,
    ocrText,
  };
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Identifica a imagem usando o pipeline completo com fallback inteligente.
 *
 * @param imageUrl     URL da imagem (Discord CDN ou URL externa)
 * @param isAttachment true = faz upload multipart; false = passa a URL direta
 */
export async function identifyImage(
  imageUrl: string,
  isAttachment: boolean
): Promise<IdentificationResult | null> {
  const cacheKey = `${isAttachment ? "att" : "url"}:${imageUrl}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.result;

  let lowConfFallback: IdentificationResult | null = null;

  // 1. Trace.moe (alta confiança)
  const traceResult = await tryTraceMoe(imageUrl, isAttachment);
  if (traceResult) {
    cache.set(cacheKey, { result: traceResult, expires: Date.now() + CACHE_TTL });
    return traceResult;
  }

  // Salva fallback de baixa confiança enquanto continua
  const [traceLow, sauceResult, ocrResult] = await Promise.all([
    tryTraceMoeLowConfidence(imageUrl, isAttachment),
    trySauceNAO(imageUrl, isAttachment),
    tryOCRSearch(imageUrl, isAttachment),
  ]);

  lowConfFallback = traceLow;

  // 2. SauceNAO (alta confiança)
  if (sauceResult) {
    cache.set(cacheKey, { result: sauceResult, expires: Date.now() + CACHE_TTL });
    return sauceResult;
  }

  // 3. OCR + APIs
  if (ocrResult) {
    cache.set(cacheKey, { result: ocrResult, expires: Date.now() + CACHE_TTL });
    return ocrResult;
  }

  // Fallback: Trace.moe com baixa confiança
  if (lowConfFallback) {
    cache.set(cacheKey, { result: lowConfFallback, expires: Date.now() + CACHE_TTL });
    return lowConfFallback;
  }

  cache.set(cacheKey, { result: null, expires: Date.now() + CACHE_TTL });
  return null;
}

export { formatTimestamp };
