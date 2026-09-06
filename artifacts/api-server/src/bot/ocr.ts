/**
 * OCR — extrai texto de imagens.
 * Usa OCR.Space (https://ocr.space/OCRAPI) quando OCR_SPACE_API_KEY estiver configurado.
 * Sem chave: tenta a API pública gratuita com limite severo de uso.
 *
 * Após extração, o texto é limpo para remover:
 * - Emojis e símbolos Unicode
 * - Marcas d'água do TikTok / Reels / YouTube Shorts
 * - Hashtags, menções, URLs
 * - Palavras comuns de redes sociais (PT + EN)
 * - Tokens muito curtos ou puramente numéricos
 */

const OCR_SPACE_API = "https://api.ocr.space/parse/imageurl";
const OCR_SPACE_UPLOAD = "https://api.ocr.space/parse/image";

// ─── Cache simples ────────────────────────────────────────────────────────────

const cache = new Map<string, { text: string; expires: number }>();
const CACHE_TTL = 120_000; // 2 min

// ─── Lista de stop-words a remover após OCR ───────────────────────────────────

const SOCIAL_STOPWORDS = new Set([
  // TikTok / Reels UI
  "tiktok", "reels", "instagram", "youtube", "shorts",
  "follow", "like", "share", "comment", "subscribe", "save",
  "seguir", "curtir", "compartilhar", "comentar", "salvar", "inscrever",
  "duet", "stitch", "remix",
  // UI labels comuns
  "sound", "trending", "fyp", "foryou", "foryoupage",
  "paravocê", "parati",
  // Ações
  "watch", "ver", "assistir", "click", "tap", "swipe",
  "link", "bio", "check",
  // Watermark text
  "capcut", "inshot", "filmora",
]);

// Padrões de emoji Unicode (ranges amplos)
const EMOJI_REGEX =
  /[\u{1F300}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FEFF}]/gu;

// ─── Limpeza de texto ─────────────────────────────────────────────────────────

export function cleanOCRText(raw: string): string {
  let text = raw;

  // Remove emojis
  text = text.replace(EMOJI_REGEX, " ");

  // Remove URLs
  text = text.replace(/https?:\/\/\S+/g, " ");

  // Remove hashtags e menções
  text = text.replace(/[@#]\S+/g, " ");

  // Remove símbolos de pontuação excessivos (mantém letras, números, espaço)
  text = text.replace(/[^\p{L}\p{N}\s]/gu, " ");

  // Normaliza espaços
  text = text.replace(/\s+/g, " ").trim();

  // Filtra tokens
  const tokens = text.split(" ").filter((token) => {
    const t = token.toLowerCase();
    if (t.length < 2) return false;              // muito curto
    if (/^\d+$/.test(t)) return false;           // só números
    if (SOCIAL_STOPWORDS.has(t)) return false;   // stop-word de redes sociais
    return true;
  });

  return tokens.join(" ");
}

// ─── OCR.Space ────────────────────────────────────────────────────────────────

interface OCRSpaceResponse {
  ParsedResults?: Array<{
    ParsedText: string;
    ErrorMessage: string | null;
    ExitCode: number;
  }>;
  IsErroredOnProcessing: boolean;
  ErrorMessage?: string | string[];
}

function getApiKey(): string | null {
  return process.env["OCR_SPACE_API_KEY"] ?? null;
}

async function parseOCRResponse(res: Response): Promise<string> {
  if (!res.ok) throw new Error(`OCR.Space error ${res.status}`);
  const json = (await res.json()) as OCRSpaceResponse;
  if (json.IsErroredOnProcessing) {
    const msg = Array.isArray(json.ErrorMessage)
      ? json.ErrorMessage.join("; ")
      : (json.ErrorMessage ?? "Erro desconhecido");
    throw new Error(`OCR.Space: ${msg}`);
  }
  return (json.ParsedResults ?? []).map((r) => r.ParsedText ?? "").join("\n");
}

/**
 * Extrai texto de uma URL de imagem pública.
 * Retorna string vazia se OCR não estiver disponível ou falhar.
 */
export async function extractTextFromUrl(imageUrl: string): Promise<string> {
  const cached = cache.get(imageUrl);
  if (cached && cached.expires > Date.now()) return cached.text;

  const apiKey = getApiKey();

  try {
    const params = new URLSearchParams({
      url: imageUrl,
      language: "jpn,eng,por",
      isOverlayRequired: "false",
      detectOrientation: "true",
      scale: "true",
      OCREngine: "2",
    });
    if (apiKey) params.set("apikey", apiKey);

    const res = await fetch(`${OCR_SPACE_API}?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });

    const raw = await parseOCRResponse(res);
    const text = cleanOCRText(raw);
    cache.set(imageUrl, { text, expires: Date.now() + CACHE_TTL });
    return text;
  } catch (err) {
    // OCR falhou — retorna vazio para não bloquear o pipeline
    console.error("[OCR] extractTextFromUrl falhou:", err);
    return "";
  }
}

/**
 * Extrai texto fazendo upload do arquivo (mais confiável para imagens do Discord).
 * Retorna string vazia se OCR não estiver disponível ou falhar.
 */
export async function extractTextFromUpload(imageUrl: string): Promise<string> {
  const cacheKey = `upload:${imageUrl}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.text;

  const apiKey = getApiKey();

  try {
    // Baixa a imagem
    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15_000) });
    if (!imgRes.ok) throw new Error(`Erro ao baixar imagem: ${imgRes.status}`);
    const blob = await imgRes.blob();

    const form = new FormData();
    form.append("file", blob, "image.jpg");
    form.append("language", "jpn,eng,por");
    form.append("isOverlayRequired", "false");
    form.append("detectOrientation", "true");
    form.append("scale", "true");
    form.append("OCREngine", "2");
    if (apiKey) form.append("apikey", apiKey);

    const res = await fetch(OCR_SPACE_UPLOAD, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(25_000),
    });

    const raw = await parseOCRResponse(res);
    const text = cleanOCRText(raw);
    cache.set(cacheKey, { text, expires: Date.now() + CACHE_TTL });
    return text;
  } catch (err) {
    console.error("[OCR] extractTextFromUpload falhou:", err);
    return "";
  }
}
